import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { extractCreditFactorySnapshotDetails } from "@/lib/credit-factory-snapshot";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { matchWelcomeVoiceIdentity, matchWelcomeVoiceApplicationIdentity, matchesWelcomeVoiceApplicationName, normalizeWelcomeVoiceDocument, normalizeWelcomeVoiceName,
  safeDaptaWelcomeVoiceUrl } from "@/lib/credit-welcome-voice-core";
import { creditWelcomeVoiceSchemaStatements } from "@/scripts/credit-welcome-voice-schema.mjs";
import { buildWelcomeVoiceFinancialSpeech, type WelcomeVoiceFinancialSpeech } from "@/lib/credit-welcome-voice-speech";
import { classifyVoiceCampaignResult, getVoiceReviewCampaignSlot } from "@/lib/credit-voice-review-campaign-core";
import { parseWelcomeVoiceSpokenDocument } from "@/lib/credit-welcome-voice-document";

export type CreditWelcomeVoiceSource = "NORMAL" | "INDIVIDUAL_IMPORT" | "CONTROLLED_TEST" | "SCHEDULED_CAMPAIGN";
export type CreditWelcomeVoiceStatus = "PENDING" | "DISPATCHING" | "ACCEPTED" | "COMPLETED" |
  "FAILED" | "UNKNOWN" | "CANCELLED" | "SKIPPED";
export type CreditWelcomeVoiceSnapshot = {
  creditId: number; folio: string; name: string; spokenName?: string; document: string; phone: string;
  equipmentReference?: string | null;
  initialPayment: number; installmentCount: number; installmentAmount: number;
  installmentsEqual: boolean; installmentAmounts: number[];
  frequency: string; firstDueDate: string; calendar: string[];
};
export type VoiceFinancialSnapshot = Omit<CreditWelcomeVoiceSnapshot, "document" | "phone"> & { speech: WelcomeVoiceFinancialSpeech | null };
export type VoiceDispatchClaim = { eventId: string; creditId: number; snapshot: CreditWelcomeVoiceSnapshot };
export type WelcomeVoiceIdentityRecoveryResponse = {
  code: "IDENTITY_NOT_CONFIRMED" | "DOCUMENT_NOT_UNDERSTOOD" | null;
  nextAction: "ASK_NAME" | "ASK_DOCUMENT" | "REVIEW" | "CONTINUE";
  remainingAttempts: number; question: string | null; mayEndCall: boolean;
};
type IdentityRecoveryState = { askedName: boolean; askedDocument: boolean; reviewRequired: boolean };
export type CreditWelcomeVoiceResultPayload = {
  eventId: string; creditId: number; providerCallId: string; status: "COMPLETED" | "FAILED";
  recordingUrl?: string | null; summary?: string | null; transcript?: string | null; doubts?: string | null;
  durationSeconds?: number | null; completedAt?: string | null; resultCode?: string | null;
  communicationOutcome?: string | null; disconnectionReason?: string | null;
};
export type VoiceCallRecord = {
  id: string; creditId: number; source: CreditWelcomeVoiceSource; status: CreditWelcomeVoiceStatus;
  providerCallId: string | null; createdAt: string; dispatchedAt: string | null; completedAt: string | null;
  durationSeconds: number | null; identityVerified: boolean; summary: string | null; doubts: string | null;
  recordingUrl: string | null; audioStorage: "DAPTA_PRIVATE_LINK" | "UNAVAILABLE"; resultCode: string | null;
};
export class CreditWelcomeVoiceStoreError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export type WelcomeVoiceTransaction = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe" | "credito">;
type StoreDatabase = Pick<typeof prisma, "$transaction" | "$queryRawUnsafe" | "$executeRawUnsafe" | "credito">;

let schemaReady: Promise<void> | null = null;
/** Called before the credit transaction, and only when this feature is enabled. */
export async function ensureCreditWelcomeVoiceSchema() {
  if (!schemaReady) {
    schemaReady = prisma.$transaction(async db => {
      await db.$executeRawUnsafe("SET LOCAL lock_timeout='10s'");
      await db.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-welcome-voice-schema'))::text");
      for (const statement of creditWelcomeVoiceSchemaStatements) await db.$executeRawUnsafe(statement);
    }, { timeout: 30_000 }).catch(error => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

const creditSelect = {
  id: true, folio: true, clienteNombre: true, clienteDocumento: true, clienteTelefono: true,
  referenciaEquipo: true, equipoMarca: true, equipoModelo: true,
  estado: true, pazYSalvoEmitidoAt: true, cuotaInicial: true, montoCredito: true, valorCuota: true,
  plazoMeses: true, frecuenciaPago: true, fechaPrimerPago: true, fechaProximoPago: true,
  contratoSnapshot: true, planCapitalVigente: true,
  abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true, estado: true } },
  amortizacion: { select: { numeroCuotas: true, cuotaComercial: true, frecuenciaPago: true,
    cuotas: { orderBy: { numero: "asc" }, select: { numero: true, fechaVencimiento: true, cuotaCobro: true } } } },
} as const;
type Credit = Prisma.CreditoGetPayload<{ select: typeof creditSelect }>;
type EventRow = {
  id: string; creditoId: number; source: CreditWelcomeVoiceSource; status: CreditWelcomeVoiceStatus;
  attemptNumber: number; repeatOf: string | null;
  snapshot: CreditWelcomeVoiceSnapshot | null; providerCallId: string | null; identityAttempts: number;
  identityVerifiedAt: Date | string | null; identityRecovery: unknown; resultHash: string | null;
  dispatchedAt: Date | string | null;
  campaignId: string | null; campaignSlot: string | null; resultCode: string | null;
  communicationOutcome: string | null; disconnectionReason: string | null;
};
const eventColumns = `"id"::text,"creditoId","source","status","attemptNumber","repeatOf"::text,"snapshot","providerCallId", "identityAttempts","identityVerifiedAt","identityRecovery","resultHash","dispatchedAt","campaignId","campaignSlot","resultCode","communicationOutcome","disconnectionReason"`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validCreditId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
const validCampaignId = (id: string) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
const validCampaignSlot = (slot: string) => typeof slot === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot) && calendarDay(slot) === slot.slice(0, 10);
type CampaignRow = { id: string; startDate: string; creditIds: number[] };
type CampaignMember = { campaignId: string; creditoId: number; state: "ACTIVE" | "CONTACTED" | "STOPPED" | "HELD";
  lastEventId: string | null; reviewRevision: number | null; reviewHash: string | null };
type ReviewRow = { status: string; revision: number; reviewHash: string | null };
function calendarDay(value: unknown): string | null {
  const day = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : "")
    : typeof value === "string" ? /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) ? value.slice(0, 10) : "" : "";
  if (!day) return null;
  const date = new Date(day + "T12:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}
function number(value: unknown): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function equipmentReferenceText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 240 || /[\p{Cc}\p{Cf}<>]/u.test(value)) return null;
  return value.trim().replace(/\s+/g, " ") || null;
}
function registeredEquipmentReference(contractual: string | null, credit: Credit): string | null {
  // A present contractual label is authoritative; an invalid one is omitted,
  // rather than replaced with a potentially different current purchase.
  const candidate = [contractual, credit.referenciaEquipo,
    [credit.equipoMarca, credit.equipoModelo].filter(value => typeof value === "string" && value.trim()).join(" ")]
    .find(value => typeof value === "string" && value.trim());
  return equipmentReferenceText(candidate);
}

/** Conditions come from the committed amortization/contract, never from caller input. */
export function buildCreditWelcomeVoiceSnapshot(credit: Credit): CreditWelcomeVoiceSnapshot | null {
  const name = normalizeWelcomeVoiceName(credit.clienteNombre);
  const spokenName = credit.clienteNombre.trim().replace(/\s+/g, " ");
  const document = normalizeWelcomeVoiceDocument(credit.clienteDocumento);
  const phone = normalizeColombianMobile(credit.clienteTelefono);
  const contractual = extractCreditFactorySnapshotDetails(credit.contratoSnapshot).paso2;
  const equipmentReference = registeredEquipmentReference(contractual.equipoReferencia, credit);
  const initialPayment = number(contractual.cuotaInicial ?? credit.cuotaInicial);
  const installmentCount = number(credit.amortizacion?.numeroCuotas ?? contractual.numeroCuotas ?? credit.plazoMeses);
  const installmentAmount = number(credit.amortizacion?.cuotaComercial ?? contractual.valorCuotaComercial ?? contractual.valorCuota ?? credit.valorCuota);
  const frequency = String(credit.amortizacion?.frecuenciaPago ?? contractual.frecuenciaPago ?? credit.frecuenciaPago).trim().toUpperCase();
  const firstDueDate = calendarDay(contractual.fechaPrimerPago ?? credit.fechaPrimerPago);
  if (!validCreditId(credit.id) || !credit.folio || !name || normalizeWelcomeVoiceName(spokenName) !== name ||
    !document || !phone || initialPayment === null || initialPayment < 0 ||
    installmentCount === null || !Number.isSafeInteger(installmentCount) || installmentCount < 1 || installmentCount > 1000 ||
    installmentAmount === null || installmentAmount <= 0 || !["QUINCENAL", "CATORCENAL", "MENSUAL"].includes(frequency)) return null;
  let rows: Array<{ numero: number; date: string | null; amount: number | null }>;
  if (credit.amortizacion?.cuotas?.length) {
    rows = credit.amortizacion.cuotas.map(row => ({ numero: row.numero,
      date: calendarDay(row.fechaVencimiento), amount: number(row.cuotaCobro) }));
  } else {
    if (!firstDueDate) return null;
    try {
      rows = buildCreditPaymentPlan({ montoCredito: Number(credit.montoCredito), valorCuota: installmentAmount,
        plazoMeses: installmentCount, frecuenciaPago: frequency, fechaPrimerPago: firstDueDate,
        abonos: [], today: firstDueDate }).installments.map(row => ({ numero: row.numero,
          date: calendarDay(row.fechaVencimiento), amount: number(row.valorProgramado) }));
    } catch { return null; }
  }
  if (rows.length !== installmentCount || rows.some((row, index) => row.numero !== index + 1 || !row.date ||
    row.amount === null || row.amount <= 0 || (index > 0 && row.date! <= rows[index - 1].date!))) return null;
  const calendar = rows.map(row => row.date!);
  const installmentAmounts = rows.map(row => row.amount!);
  if (firstDueDate && firstDueDate !== calendar[0]) return null;
  return { creditId: credit.id, folio: credit.folio, name, spokenName, document, phone, equipmentReference, initialPayment,
    installmentCount, installmentAmount, frequency, firstDueDate: calendar[0], calendar,
    installmentAmounts, installmentsEqual: installmentAmounts.every(amount => amount === installmentAmounts[0]) };
}
function financialConditions(snapshot: CreditWelcomeVoiceSnapshot): VoiceFinancialSnapshot {
  const { document: _document, phone: _phone, ...conditions } = snapshot;
  void _document; void _phone;
  return { ...conditions, speech: buildWelcomeVoiceFinancialSpeech(conditions) };
}
function sameSnapshot(first: CreditWelcomeVoiceSnapshot, second: CreditWelcomeVoiceSnapshot) {
  // JSONB does not preserve object-key order. Compare the explicitly defined DTO.
  // spokenName is display-only, validated against name; older snapshots omit it.
  if ([first, second].some(value => value.spokenName !== undefined && normalizeWelcomeVoiceName(value.spokenName) !== value.name)) return false;
  // Legacy snapshots omitted the label. Once recorded, purchase changes must
  // invalidate dispatch/repeat, including a label added to a recorded null.
  if ([first, second].some(value => value.equipmentReference !== undefined && value.equipmentReference !== null &&
    equipmentReferenceText(value.equipmentReference) !== value.equipmentReference)) return false;
  if (first.equipmentReference !== undefined && second.equipmentReference !== undefined &&
    first.equipmentReference !== second.equipmentReference) return false;
  const values = (value: CreditWelcomeVoiceSnapshot) => [value.creditId, value.folio, value.name, value.document, value.phone,
    value.initialPayment, value.installmentCount, value.installmentAmount, value.installmentsEqual,
    value.installmentAmounts, value.frequency, value.firstDueDate, value.calendar];
  return JSON.stringify(values(first)) === JSON.stringify(values(second));
}
function creditExclusion(credit: Credit | null, snapshot: CreditWelcomeVoiceSnapshot | null): string | null {
  if (!credit) return "CREDIT_MISSING";
  const state = String(credit.estado).trim().toUpperCase();
  if (isExcludedCarteraCreditState(state) || ["PAGADO", "PAZ_Y_SALVO"].includes(state) || credit.pazYSalvoEmitidoAt) return "CREDIT_CLOSED";
  if (!snapshot) return "INVALID_CONDITIONS";
  const amount = Number(credit.montoCredito);
  if (!Number.isFinite(amount) || amount <= 0) return "INVALID_CONDITIONS";
  try {
    const plan = buildCreditPaymentPlan({ planCapitalVigente: credit.planCapitalVigente,
      montoCredito: amount, valorCuota: Number(credit.valorCuota), plazoMeses: Number(credit.plazoMeses),
      frecuenciaPago: credit.frecuenciaPago, fechaPrimerPago: snapshot.firstDueDate,
      fechaProximoPago: calendarDay(credit.fechaProximoPago),
      abonos: credit.abonos.filter(row => row.estado !== "ANULADO").map(row => ({ valor: Number(row.valor), fechaAbono: row.fechaAbono })) });
    return plan.pendingCount > 0 && plan.saldoPendiente > 0 ? null : "CREDIT_PAID";
  } catch { return "INVALID_CONDITIONS"; }
}
function requireEventIdentity(eventId: string, creditId?: number) {
  if (!uuid.test(eventId) || (creditId !== undefined && !validCreditId(creditId))) {
    throw new CreditWelcomeVoiceStoreError("INVALID_EVENT", "Evento de bienvenida inválido.", 400);
  }
}
function boundedText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Resultado de llamada inválido.", 400);
  const text = value.trim();
  if (text.length > max) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Resultado de llamada demasiado extenso.", 400);
  return text || null;
}
function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)) {
    throw new CreditWelcomeVoiceStoreError("INVALID_CALL_ID", "Identificador de llamada inválido.", 400);
  }
  return value;
}
function identityRecoveryState(value: unknown): IdentityRecoveryState {
  const empty = { askedName: false, askedDocument: false, reviewRequired: false };
  if (value === undefined || value === null) return empty;
  if (typeof value !== "object" || Array.isArray(value)) return { ...empty, reviewRequired: true };
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["askedName", "askedDocument", "reviewRequired"].includes(key) || typeof fields[key] !== "boolean")) {
    return { ...empty, reviewRequired: true };
  }
  return { askedName: fields.askedName === true, askedDocument: fields.askedDocument === true, reviewRequired: fields.reviewRequired === true };
}
function recoveryResponse(nextAction: WelcomeVoiceIdentityRecoveryResponse["nextAction"], attempts: number,
  code: WelcomeVoiceIdentityRecoveryResponse["code"] = "IDENTITY_NOT_CONFIRMED"): WelcomeVoiceIdentityRecoveryResponse {
  return { code: nextAction === "CONTINUE" ? null : code, nextAction,
    remainingAttempts: nextAction === "REVIEW" ? 0 : Math.min(2, Math.max(0, 3 - attempts)),
    question: nextAction === "ASK_NAME" ? "¿Me repite su nombre completo, por favor?"
      : nextAction === "ASK_DOCUMENT" ? "¿Me repite su número de cédula, por favor?"
        : nextAction === "REVIEW" ? "No pude confirmar sus datos. Un asesor revisará su caso." : null,
    mayEndCall: nextAction === "REVIEW" };
}

export function createCreditWelcomeVoiceStore(deps: { database?: StoreDatabase; enabled?: () => boolean; now?: () => Date } = {}) {
  const database = deps.database ?? prisma;
  const enabled = deps.enabled ?? (() => process.env.DAPTA_WELCOME_VOICE_ENABLED === "true");
  const now = deps.now ?? (() => new Date());
  const readCredit = (db: WelcomeVoiceTransaction, id: number) => db.credito.findUnique({ where: { id }, select: creditSelect });
  async function readEvent(db: Pick<WelcomeVoiceTransaction, "$queryRawUnsafe">, id: string, lock = true) {
    const rows = await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid ${lock ? "FOR UPDATE" : ""}`, id);
    return rows[0] || null;
  }
  async function exclude(db: WelcomeVoiceTransaction, row: EventRow, code: string) {
    const status = ["CREDIT_MISSING", "CREDIT_CLOSED", "CREDIT_PAID"].includes(code) ? "CANCELLED" : "SKIPPED";
    await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2,"resultCode"=$3,"updatedAt"=$4
      WHERE "id"=$1::uuid AND "status" IN ('PENDING','DISPATCHING')`, row.id, status, code, now());
    if (row.campaignId) await setMemberState(db, row.campaignId, row.creditoId, status === "CANCELLED" ? "STOPPED" : "HELD", code);
  }
  async function setMemberState(db: WelcomeVoiceTransaction, campaignId: string, creditId: number,
    state: CampaignMember["state"], reason: string) {
    await db.$executeRawUnsafe(`UPDATE "VoiceReviewCampaignMember" SET "state"=$3,"stopReason"=$4,"updatedAt"=$5
      WHERE "campaignId"=$1 AND "creditoId"=$2 AND "state"='ACTIVE'`, campaignId, creditId, state, reason, now());
  }
  async function readCampaign(db: WelcomeVoiceTransaction, id: string, lock = false) {
    return (await db.$queryRawUnsafe<CampaignRow[]>(`SELECT "id","startDate"::text,"creditIds" FROM "VoiceReviewCampaign"
      WHERE "id"=$1 ${lock ? "FOR UPDATE" : ""}`, id))[0] ?? null;
  }
  async function readReview(db: WelcomeVoiceTransaction, creditId: number) {
    return (await db.$queryRawUnsafe<ReviewRow[]>(`SELECT "status","revision","reviewHash" FROM "CreditApprovalReview"
      WHERE "creditoId"=$1 FOR SHARE`, creditId))[0] ?? null;
  }
  async function checkCampaignReview(db: WelcomeVoiceTransaction, member: CampaignMember) {
    const review = await readReview(db, member.creditoId);
    if (!review || review.status !== "PENDING") {
      await setMemberState(db, member.campaignId, member.creditoId, "STOPPED", "REVIEW_NOT_PENDING");
      return false;
    }
    if (review.revision !== member.reviewRevision || review.reviewHash !== member.reviewHash) {
      await setMemberState(db, member.campaignId, member.creditoId, "HELD", "REVIEW_CHANGED");
      return false;
    }
    return true;
  }
  async function revalidate(db: WelcomeVoiceTransaction, event: EventRow): Promise<CreditWelcomeVoiceSnapshot | null> {
    const credit = await readCredit(db, event.creditoId);
    const current = credit ? buildCreditWelcomeVoiceSnapshot(credit) : null;
    const code = creditExclusion(credit, current);
    if (code) { await exclude(db, event, code); return null; }
    if (!event.snapshot || !current) { await exclude(db, event, "INVALID_CONDITIONS"); return null; }
    if (current.phone !== event.snapshot.phone || current.document !== event.snapshot.document || current.name !== event.snapshot.name) {
      await exclude(db, event, "CONTACT_CHANGED"); return null;
    }
    if (!sameSnapshot(current, event.snapshot)) { await exclude(db, event, "CONDITIONS_CHANGED"); return null; }
    return current;
  }
  async function enqueueCreditWelcomeVoice(db: WelcomeVoiceTransaction, input: { creditId: number; source: CreditWelcomeVoiceSource }) {
    if (!enabled()) return null;
    if (!validCreditId(input.creditId) || !["NORMAL", "INDIVIDUAL_IMPORT"].includes(input.source)) {
      throw new CreditWelcomeVoiceStoreError("INVALID_EVENT", "Evento de bienvenida inválido.", 400);
    }
    const credit = await readCredit(db, input.creditId);
    if (!credit) throw new CreditWelcomeVoiceStoreError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
    const snapshot = buildCreditWelcomeVoiceSnapshot(credit);
    const exclusion = creditExclusion(credit, snapshot);
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO "CreditWelcomeVoiceEvent"
      ("id","creditoId","type","source","attemptNumber","status","snapshot","resultCode","createdAt","updatedAt")
      VALUES ($1::uuid,$2,'BIENVENIDA_VOZ',$3,0,$4,$5::jsonb,$6,$7,$7)
      ON CONFLICT ("creditoId","type","attemptNumber") DO NOTHING RETURNING "id"::text`, randomUUID(), input.creditId,
      input.source, exclusion ? "SKIPPED" : "PENDING", JSON.stringify(snapshot), exclusion, now());
    return rows[0] ? { eventId: rows[0].id } : null;
  }
  async function claimPendingCreditWelcomeVoice(options: { limit?: number } = {}): Promise<VoiceDispatchClaim[]> {
    if (!enabled()) return [];
    const limit = Math.max(1, Math.min(25, Math.trunc(options.limit || 5)));
    return database.$transaction(async db => {
      const pending = await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent"
        WHERE "status"='PENDING' AND "attemptNumber"=0 ORDER BY "createdAt","id" LIMIT $1 FOR UPDATE SKIP LOCKED`, limit);
      const claims: VoiceDispatchClaim[] = [];
      for (const event of pending) {
        const snapshot = await revalidate(db, event);
        if (!snapshot) continue;
        await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"='DISPATCHING',"dispatchedAt"=$2,"updatedAt"=$2
          WHERE "id"=$1::uuid AND "status"='PENDING'`, event.id, now());
        claims.push({ eventId: event.id, creditId: event.creditoId, snapshot });
      }
      return claims;
    });
  }
  /** Cohort and review revision are frozen once; repeating configuration never replaces them. */
  async function ensureVoiceReviewCampaign(input: { id: string; startDate: string; creditIds: number[] }) {
    if (!enabled()) throw new CreditWelcomeVoiceStoreError("CAMPAIGN_DISABLED", "Campaña no habilitada.");
    if (!validCampaignId(input.id) || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || calendarDay(input.startDate) !== input.startDate ||
      !Array.isArray(input.creditIds) || input.creditIds.length < 1 || input.creditIds.length > 100 ||
      input.creditIds.some(id => !validCreditId(id)) || new Set(input.creditIds).size !== input.creditIds.length) {
      throw new CreditWelcomeVoiceStoreError("INVALID_CAMPAIGN", "Configuración de campaña inválida.", 400);
    }
    const creditIds = [...input.creditIds].sort((a, b) => a - b);
    return database.$transaction(async db => {
      const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds","createdAt")
        VALUES ($1,$2::date,$3::jsonb,$4) ON CONFLICT ("id") DO NOTHING RETURNING "id"`, input.id, input.startDate, JSON.stringify(creditIds), now());
      const campaign = await readCampaign(db, input.id, true);
      if (!campaign || campaign.startDate !== input.startDate || JSON.stringify(campaign.creditIds) !== JSON.stringify(creditIds)) {
        throw new CreditWelcomeVoiceStoreError("CAMPAIGN_CONFLICT", "La campaña ya tiene una cohorte o fecha diferente.");
      }
      // Only the winning first insert captures revisions. Existing members are never refreshed.
      if (inserted.length) for (const creditId of creditIds) {
        const review = await readReview(db, creditId);
        const active = review?.status === "PENDING";
        await db.$executeRawUnsafe(`INSERT INTO "VoiceReviewCampaignMember"
          ("campaignId","creditoId","state","stopReason","reviewRevision","reviewHash","updatedAt")
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, input.id, creditId, active ? "ACTIVE" : "STOPPED", active ? null : "REVIEW_NOT_PENDING",
          review?.revision ?? null, review?.reviewHash ?? null, now());
      }
      return { id: input.id, created: inserted.length > 0 };
    }, { timeout: 30_000 });
  }
  async function claimVoiceReviewCampaign(input: { campaignId: string; slot: string; limit?: number }): Promise<VoiceDispatchClaim[]> {
    if (!enabled()) return [];
    if (!validCampaignId(input.campaignId) || !validCampaignSlot(input.slot)) {
      throw new CreditWelcomeVoiceStoreError("INVALID_CAMPAIGN", "Campaña o franja inválida.", 400);
    }
    const limit = Math.max(1, Math.min(25, Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 5));
    return database.$transaction(async db => {
      const campaign = await readCampaign(db, input.campaignId);
      if (!campaign) throw new CreditWelcomeVoiceStoreError("CAMPAIGN_NOT_FOUND", "Campaña no encontrada.", 404);
      if (getVoiceReviewCampaignSlot(campaign, now()) !== input.slot) return [];
      const members = await db.$queryRawUnsafe<CampaignMember[]>(`SELECT "campaignId","creditoId","state","lastEventId"::text,"reviewRevision","reviewHash"
        FROM "VoiceReviewCampaignMember" m WHERE "campaignId"=$1 AND "state"='ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM "CreditWelcomeVoiceEvent" e WHERE e."campaignId"=m."campaignId" AND e."creditoId"=m."creditoId" AND e."campaignSlot"=$2)
        ORDER BY "creditoId" LIMIT 100 FOR UPDATE OF m SKIP LOCKED`, input.campaignId, input.slot);
      const claims: VoiceDispatchClaim[] = [];
      for (const member of members) {
        if (claims.length >= limit) break;
        await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),$2)::text`, input.campaignId, member.creditoId);
        await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, member.creditoId);
        if (!await checkCampaignReview(db, member)) continue;
        const credit = await readCredit(db, member.creditoId);
        const snapshot = credit ? buildCreditWelcomeVoiceSnapshot(credit) : null;
        const exclusion = creditExclusion(credit, snapshot);
        if (exclusion || !snapshot) {
          const code = exclusion ?? "INVALID_CONDITIONS";
          await setMemberState(db, input.campaignId, member.creditoId,
            ["CREDIT_MISSING", "CREDIT_CLOSED", "CREDIT_PAID"].includes(code) ? "STOPPED" : "HELD", code);
          continue;
        }
        const latest = (await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent"
          WHERE "campaignId"=$1 AND "creditoId"=$2 ORDER BY "attemptNumber" DESC LIMIT 1`, input.campaignId, member.creditoId))[0];
        if (latest) {
          // A missing/uncertain external response must never cause another call.
          if (["PENDING", "DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(latest.status)) continue;
          const decision = classifyVoiceCampaignResult(latest);
          if (decision !== "RETRY") {
            await setMemberState(db, input.campaignId, member.creditoId, decision,
              latest.communicationOutcome ?? latest.resultCode ?? decision);
            continue;
          }
          if (latest.campaignSlot && latest.campaignSlot >= input.slot) continue;
        }
        const inflight = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditWelcomeVoiceEvent"
          WHERE "creditoId"=$1 AND "source"<>'CONTROLLED_TEST' AND "status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') LIMIT 1`, member.creditoId);
        if (inflight.length) continue;
        const first = (await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent"
          WHERE "campaignId"=$1 AND "creditoId"=$2 ORDER BY "attemptNumber" ASC LIMIT 1`, input.campaignId, member.creditoId))[0];
        if (first && (!first.snapshot || !sameSnapshot(first.snapshot, snapshot))) {
          const changedContact = first.snapshot && (first.snapshot.phone !== snapshot.phone || first.snapshot.name !== snapshot.name || first.snapshot.document !== snapshot.document);
          await setMemberState(db, input.campaignId, member.creditoId, "HELD", changedContact ? "CONTACT_CHANGED" : "CONDITIONS_CHANGED");
          continue;
        }
        const attempts = await db.$queryRawUnsafe<Array<{ max: number }>>(`SELECT COALESCE(MAX("attemptNumber"),0) AS "max"
          FROM "CreditWelcomeVoiceEvent" WHERE "creditoId"=$1 AND "type"='BIENVENIDA_VOZ'`, member.creditoId);
        const attempt = attempts[0].max + 1;
        if (!Number.isSafeInteger(attempt) || attempt > 2_147_483_647) {
          await setMemberState(db, input.campaignId, member.creditoId, "HELD", "ATTEMPT_LIMIT"); continue;
        }
        const eventId = randomUUID(), time = now();
        await db.$executeRawUnsafe(`INSERT INTO "CreditWelcomeVoiceEvent"
          ("id","creditoId","source","attemptNumber","campaignId","campaignSlot","status","snapshot","dispatchedAt","createdAt","updatedAt")
          VALUES ($1::uuid,$2,'SCHEDULED_CAMPAIGN',$3,$4,$5,'DISPATCHING',$6::jsonb,$7,$7,$7)`,
          eventId, member.creditoId, attempt, input.campaignId, input.slot, JSON.stringify(first?.snapshot ?? snapshot), time);
        await db.$executeRawUnsafe(`UPDATE "VoiceReviewCampaignMember" SET "lastEventId"=$3::uuid,"updatedAt"=$4
          WHERE "campaignId"=$1 AND "creditoId"=$2`, input.campaignId, member.creditoId, eventId, time);
        claims.push({ eventId, creditId: member.creditoId, snapshot: first?.snapshot ?? snapshot });
      }
      return claims;
    }, { timeout: 30_000 });
  }
  /** Local operator helper only: never scans the queue or retries an attempted call. */
  async function prepareCreditWelcomeVoiceControlledTest(input: { creditId: number; expectedPhone: string; repeatOf?: string }): Promise<VoiceDispatchClaim> {
    const expectedPhone = normalizeColombianMobile(input.expectedPhone);
    if (!validCreditId(input.creditId) || !expectedPhone || (input.repeatOf !== undefined && !uuid.test(input.repeatOf))) {
      throw new CreditWelcomeVoiceStoreError("INVALID_CONTROLLED_TEST", "Crédito o número de prueba inválido.", 400);
    }
    if (!enabled()) throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_DISABLED", "La fábrica de prueba no está habilitada.");
    return database.$transaction(async db => {
      // Serializes preparation for this credit, including the first insert. No other credit is selected.
      await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, input.creditId);
      const credit = await readCredit(db, input.creditId);
      if (!credit) throw new CreditWelcomeVoiceStoreError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
      const snapshot = buildCreditWelcomeVoiceSnapshot(credit);
      if (creditExclusion(credit, snapshot) || !snapshot) {
        throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_INELIGIBLE", "El crédito no puede recibir la llamada de prueba.");
      }
      if (snapshot.phone !== expectedPhone) {
        throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_PHONE_MISMATCH", "El número del crédito no corresponde al autorizado para la prueba.");
      }
      if (input.repeatOf !== undefined) {
        const parent = await readEvent(db, input.repeatOf);
        if (!parent || parent.creditoId !== input.creditId || parent.source !== "CONTROLLED_TEST" ||
          parent.status !== "COMPLETED" || !parent.providerCallId || !parent.resultHash ||
          !Number.isSafeInteger(parent.attemptNumber) || parent.attemptNumber < 0 || parent.attemptNumber >= 2_147_483_647) {
          throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_REPEAT_NOT_ALLOWED", "La repetición requiere una llamada de prueba completada del mismo crédito.");
        }
        if (!parent.snapshot || !sameSnapshot(parent.snapshot, snapshot)) {
          throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_SNAPSHOT_CHANGED", "Los datos de la llamada anterior no corresponden al crédito vigente.");
        }
        const children = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditWelcomeVoiceEvent" WHERE "repeatOf"=$1::uuid`, parent.id);
        if (children.length) {
          throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_ALREADY_REPEATED", "Esa llamada ya tiene una repetición registrada; no se redespacha.");
        }
        // Scheduled calls share this sequence; the parent may no longer be the latest attempt.
        const attempts = await db.$queryRawUnsafe<Array<{ max: number }>>(`SELECT COALESCE(MAX("attemptNumber"),0) AS "max"
          FROM "CreditWelcomeVoiceEvent" WHERE "creditoId"=$1 AND "type"='BIENVENIDA_VOZ'`, input.creditId);
        const attempt = attempts[0].max + 1;
        if (!Number.isSafeInteger(attempt) || attempt > 2_147_483_647) {
          throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_REPEAT_NOT_ALLOWED", "No hay un número de intento disponible para la repetición.");
        }
        const eventId = randomUUID();
        await db.$executeRawUnsafe(`INSERT INTO "CreditWelcomeVoiceEvent"
          ("id","creditoId","type","source","attemptNumber","repeatOf","status","snapshot","dispatchedAt","createdAt","updatedAt")
          VALUES ($1::uuid,$2,'BIENVENIDA_VOZ','CONTROLLED_TEST',$3,$4::uuid,'DISPATCHING',$5::jsonb,$6,$6,$6)`,
        eventId, input.creditId, attempt, parent.id, JSON.stringify(snapshot), now());
        return { eventId, creditId: input.creditId, snapshot };
      }
      await db.$executeRawUnsafe(`INSERT INTO "CreditWelcomeVoiceEvent"
        ("id","creditoId","type","source","attemptNumber","status","snapshot","createdAt","updatedAt")
        VALUES ($1::uuid,$2,'BIENVENIDA_VOZ','CONTROLLED_TEST',0,'PENDING',$3::jsonb,$4,$4)
        ON CONFLICT ("creditoId","type","attemptNumber") DO NOTHING`, randomUUID(), input.creditId, JSON.stringify(snapshot), now());
      const rows = await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent"
        WHERE "creditoId"=$1 AND "type"='BIENVENIDA_VOZ' AND "attemptNumber"=0 FOR UPDATE`, input.creditId);
      const event = rows[0];
      if (!event || event.status !== "PENDING") {
        throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_ALREADY_ATTEMPTED", "El evento ya fue intentado o está cerrado; no se redespacha.");
      }
      if (!event.snapshot || event.snapshot.phone !== expectedPhone || !sameSnapshot(event.snapshot, snapshot)) {
        throw new CreditWelcomeVoiceStoreError("CONTROLLED_TEST_SNAPSHOT_CHANGED", "Los datos del evento no corresponden al crédito vigente.");
      }
      await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "source"='CONTROLLED_TEST',
        "status"='DISPATCHING',"dispatchedAt"=$2,"updatedAt"=$2 WHERE "id"=$1::uuid AND "status"='PENDING'`, event.id, now());
      return { eventId: event.id, creditId: input.creditId, snapshot };
    });
  }
  /** The worker calls this just before its one external request; it never claims an old dispatch. */
  async function prepareCreditWelcomeVoiceDispatch(eventId: string): Promise<VoiceDispatchClaim | null> {
    if (!enabled()) return null;
    requireEventIdentity(eventId);
    return database.$transaction(async db => {
      const event = await readEvent(db, eventId);
      if (!event || event.status !== "DISPATCHING") return null;
      if (event.source === "SCHEDULED_CAMPAIGN") {
        const member = (await db.$queryRawUnsafe<CampaignMember[]>(`SELECT "campaignId","creditoId","state","lastEventId"::text,"reviewRevision","reviewHash"
          FROM "VoiceReviewCampaignMember" WHERE "campaignId"=$1 AND "creditoId"=$2 FOR UPDATE`, event.campaignId, event.creditoId))[0];
        if (!member || member.state !== "ACTIVE" || member.lastEventId !== event.id) {
          await exclude(db, event, "CAMPAIGN_MEMBER_NOT_ACTIVE"); return null;
        }
        if (!await checkCampaignReview(db, member)) {
          await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"='CANCELLED',"resultCode"='REVIEW_NOT_PENDING',"updatedAt"=$2
            WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, event.id, now());
          return null;
        }
        const campaign = await readCampaign(db, member.campaignId);
        if (!campaign || getVoiceReviewCampaignSlot(campaign, now()) !== event.campaignSlot) {
          await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"='FAILED',"resultCode"='WINDOW_CLOSED_BEFORE_DISPATCH',"updatedAt"=$2
            WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, event.id, now());
          return null;
        }
      }
      const snapshot = await revalidate(db, event);
      return snapshot ? { eventId, creditId: event.creditoId, snapshot } : null;
    }, { timeout: 30_000 });
  }
  async function prepareVoiceReviewCampaign(eventId: string): Promise<VoiceDispatchClaim | null> {
    if (!enabled()) return null;
    requireEventIdentity(eventId);
    const event = await readEvent(database, eventId, false);
    if (!event || event.source !== "SCHEDULED_CAMPAIGN") return null;
    return prepareCreditWelcomeVoiceDispatch(eventId);
  }
  async function markCreditWelcomeVoiceDispatchAccepted(eventId: string, callId?: string | null) {
    requireEventIdentity(eventId);
    const id = callId ? providerId(callId) : null;
    return database.$transaction(async db => {
      const event = await readEvent(db, eventId);
      if (!event) throw new CreditWelcomeVoiceStoreError("EVENT_NOT_FOUND", "Evento no encontrado.", 404);
      if (id && event.providerCallId && id !== event.providerCallId) throw new CreditWelcomeVoiceStoreError("CALL_ID_CONFLICT", "La llamada no corresponde al evento.");
      if (event.status !== "DISPATCHING") return;
      await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"='ACCEPTED',"providerCallId"=COALESCE($2,"providerCallId"),
        "acceptedAt"=$3,"updatedAt"=$3 WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, eventId, id, now());
    });
  }
  async function markDispatch(eventId: string, status: "UNKNOWN" | "FAILED", code: string) {
    requireEventIdentity(eventId);
    if (!/^[A-Z0-9_]{1,64}$/.test(code)) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Código de resultado inválido.", 400);
    await database.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2,"resultCode"=$3,"updatedAt"=$4
      WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, eventId, status, code, now());
  }
  const markCreditWelcomeVoiceDispatchUnknown = (eventId: string, code = "DISPATCH_OUTCOME_UNKNOWN") => markDispatch(eventId, "UNKNOWN", code);
  const markCreditWelcomeVoiceDispatchFailed = (eventId: string, code = "DISPATCH_REJECTED") => markDispatch(eventId, "FAILED", code);
  async function verifyCreditWelcomeVoiceIdentity(input: { eventId: string; creditId?: number; requireFreshDispatch?: boolean; customerName: string; customerDocument: string }):
    Promise<({ verificado: false; condiciones?: null } | { verificado: true; condiciones: VoiceFinancialSnapshot }) & Partial<WelcomeVoiceIdentityRecoveryResponse>> {
    requireEventIdentity(input.eventId, input.creditId);
    const privateFlow = input.requireFreshDispatch === true;
    const denied = () => privateFlow ? { verificado: false as const, condiciones: null, ...recoveryResponse("REVIEW", 3) } : { verificado: false as const };
    if (input.creditId === undefined && input.requireFreshDispatch !== true) return { verificado: false };
    return database.$transaction(async db => {
      const event = await readEvent(db, input.eventId);
      if (!event || (input.creditId !== undefined && event.creditoId !== input.creditId) || !["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(event.status) || !event.snapshot) return denied();
      if (input.requireFreshDispatch) {
        const dispatchTime = event.dispatchedAt ? new Date(event.dispatchedAt).getTime() : NaN;
        const age = now().getTime() - dispatchTime;
        if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) return denied();
      }
      const document = privateFlow ? parseWelcomeVoiceSpokenDocument(input.customerDocument) : input.customerDocument;
      const nameAccepted = privateFlow && matchesWelcomeVoiceApplicationName(event.snapshot.name, input.customerName);
      const correct = (privateFlow ? matchWelcomeVoiceApplicationIdentity : matchWelcomeVoiceIdentity)({ name: event.snapshot.name, document: event.snapshot.document },
        { name: input.customerName, document: document ?? "" });
      const credit = await readCredit(db, event.creditoId);
      const current = credit ? buildCreditWelcomeVoiceSnapshot(credit) : null;
      if (creditExclusion(credit, current) || !current || !sameSnapshot(current, event.snapshot)) return denied();
      // A verified retry can read the same conditions; a wrong identity never gets them.
      if (event.identityVerifiedAt) return correct
        ? { verificado: true as const, condiciones: financialConditions(event.snapshot), ...(privateFlow ? recoveryResponse("CONTINUE", event.identityAttempts) : {}) }
        : denied();
      if (event.identityAttempts >= 3) return denied();
      const recovery = identityRecoveryState(event.identityRecovery);
      if (recovery.reviewRequired) return denied();
      if (privateFlow) {
        const attempts = event.identityAttempts + 1;
        let nextAction: WelcomeVoiceIdentityRecoveryResponse["nextAction"] = "CONTINUE";
        if (!correct) {
          nextAction = attempts >= 3 ? "REVIEW" : !document || nameAccepted ? recovery.askedDocument ? "REVIEW" : "ASK_DOCUMENT"
            : !recovery.askedName ? "ASK_NAME" : !recovery.askedDocument ? "ASK_DOCUMENT" : "REVIEW";
          if (nextAction === "ASK_NAME") recovery.askedName = true;
          if (nextAction === "ASK_DOCUMENT") recovery.askedDocument = true;
          if (nextAction === "REVIEW") recovery.reviewRequired = true;
        }
        await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "identityAttempts"=$2,"identityRecovery"=$3::jsonb,
          "identityVerifiedAt"=CASE WHEN $4 THEN $5 ELSE "identityVerifiedAt" END,"updatedAt"=$5 WHERE "id"=$1::uuid`,
          event.id, attempts, JSON.stringify(recovery), correct, now());
        const guidance = recoveryResponse(nextAction, attempts, document ? "IDENTITY_NOT_CONFIRMED" : "DOCUMENT_NOT_UNDERSTOOD");
        return correct ? { verificado: true as const, condiciones: financialConditions(event.snapshot), ...guidance }
          : { verificado: false as const, condiciones: null, ...guidance };
      }
      await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "identityAttempts"="identityAttempts"+1,
        "identityVerifiedAt"=CASE WHEN $2 THEN $3 ELSE "identityVerifiedAt" END,"updatedAt"=$3 WHERE "id"=$1::uuid`, event.id, correct, now());
      return correct ? { verificado: true, condiciones: financialConditions(event.snapshot) } : { verificado: false };
    });
  }
  async function saveCreditWelcomeVoiceResult(input: CreditWelcomeVoiceResultPayload) {
    requireEventIdentity(input.eventId, input.creditId);
    const callId = providerId(input.providerCallId);
    if (!["COMPLETED", "FAILED"].includes(input.status)) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Estado de llamada inválido.", 400);
    const recordingUrl = input.recordingUrl ? safeDaptaWelcomeVoiceUrl(input.recordingUrl) : null;
    if (input.recordingUrl && !recordingUrl) throw new CreditWelcomeVoiceStoreError("INVALID_RECORDING_URL", "Enlace privado de grabación inválido.", 400);
    const summary = boundedText(input.summary, 8000), transcript = boundedText(input.transcript, 80000), doubts = boundedText(input.doubts, 8000);
    const duration = input.durationSeconds ?? null;
    if (duration !== null && (!Number.isFinite(duration) || duration < 0 || duration > 86400)) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Duración inválida.", 400);
    const resultCode = input.resultCode ?? null;
    if (resultCode !== null && !/^[A-Z0-9_]{1,64}$/.test(resultCode)) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Código de resultado inválido.", 400);
    const communicationOutcome = input.communicationOutcome ?? null, disconnectionReason = input.disconnectionReason ?? null;
    if (communicationOutcome !== null && !["HUMAN_CONTACT", "NO_ANSWER", "OPT_OUT", "UNCERTAIN"].includes(communicationOutcome)) {
      throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Resultado de comunicación inválido.", 400);
    }
    if (disconnectionReason !== null && !/^[a-z0-9_]{1,64}$/.test(disconnectionReason)) {
      throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Motivo de desconexión inválido.", 400);
    }
    const completedAt = input.completedAt ? new Date(input.completedAt) : null;
    if (completedAt && !Number.isFinite(completedAt.getTime())) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Fecha inválida.", 400);
    const resultHash = createHash("sha256").update(JSON.stringify({ callId, status: input.status, recordingUrl, summary, transcript, doubts,
      duration, completedAt: completedAt?.toISOString() ?? null, resultCode,
      ...(Object.hasOwn(input, "communicationOutcome") ? { communicationOutcome } : {}),
      ...(Object.hasOwn(input, "disconnectionReason") ? { disconnectionReason } : {}) })).digest("hex");
    return database.$transaction(async db => {
      const event = await readEvent(db, input.eventId);
      if (!event || event.creditoId !== input.creditId) throw new CreditWelcomeVoiceStoreError("EVENT_NOT_FOUND", "Evento no encontrado.", 404);
      if (event.providerCallId && event.providerCallId !== callId) throw new CreditWelcomeVoiceStoreError("CALL_ID_CONFLICT", "La llamada no corresponde al evento.");
      if (event.resultHash) {
        if (event.resultHash !== resultHash) throw new CreditWelcomeVoiceStoreError("RESULT_CONFLICT", "Este evento ya tiene un resultado diferente.");
        return { eventId: event.id, unchanged: true };
      }
      if (!["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(event.status)) throw new CreditWelcomeVoiceStoreError("RESULT_NOT_ALLOWED", "Este evento no admite un resultado de llamada.");
      const linked = await db.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id"::text FROM "CreditWelcomeVoiceEvent" WHERE "providerCallId"=$1 AND "id"<>$2::uuid', callId, event.id);
      if (linked.length) throw new CreditWelcomeVoiceStoreError("CALL_ID_CONFLICT", "La llamada ya está vinculada a otro evento.");
      await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2,"providerCallId"=$3,
        "completedAt"=$4,"durationSeconds"=$5,"summary"=$6,"transcript"=$7,"doubts"=$8,"recordingUrl"=$9,
        "resultCode"=$10,"resultHash"=$11,"updatedAt"=$12,"communicationOutcome"=$13,"disconnectionReason"=$14 WHERE "id"=$1::uuid`, event.id, input.status, callId,
        completedAt ?? now(), duration, summary, transcript, doubts, recordingUrl, resultCode, resultHash, now(), communicationOutcome, disconnectionReason);
      return { eventId: event.id, unchanged: false };
    });
  }
  async function listCreditWelcomeVoiceCallsForCredit(creditId: number): Promise<VoiceCallRecord[]> {
    if (!validCreditId(creditId)) throw new CreditWelcomeVoiceStoreError("INVALID_CREDIT", "Crédito inválido.", 400);
    const rows = await database.$queryRawUnsafe<Array<Omit<VoiceCallRecord, "creditId" | "identityVerified" | "audioStorage"> & {
      creditoId: number; identityVerifiedAt: Date | string | null;
    }>>(`SELECT "id"::text,"creditoId","source","status","providerCallId","createdAt","dispatchedAt","completedAt", "durationSeconds",
      "identityVerifiedAt","summary","doubts","recordingUrl","resultCode" FROM "CreditWelcomeVoiceEvent" WHERE "creditoId"=$1 ORDER BY "createdAt" DESC,"id" DESC`, creditId);
    const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
    return rows.map(row => { const recordingUrl = row.recordingUrl ? safeDaptaWelcomeVoiceUrl(row.recordingUrl) : null;
      return { id: row.id, creditId: row.creditoId, source: row.source, status: row.status, providerCallId: row.providerCallId,
        createdAt: iso(row.createdAt)!, dispatchedAt: iso(row.dispatchedAt), completedAt: iso(row.completedAt),
        durationSeconds: row.durationSeconds, identityVerified: Boolean(row.identityVerifiedAt), summary: row.summary, doubts: row.doubts,
        recordingUrl, audioStorage: recordingUrl ? "DAPTA_PRIVATE_LINK" : "UNAVAILABLE", resultCode: row.resultCode };
    });
  }
  return { enqueueCreditWelcomeVoice, claimPendingCreditWelcomeVoice, prepareCreditWelcomeVoiceControlledTest, prepareCreditWelcomeVoiceDispatch,
    ensureVoiceReviewCampaign, claimVoiceReviewCampaign, prepareVoiceReviewCampaign,
    markCreditWelcomeVoiceDispatchAccepted, markCreditWelcomeVoiceDispatchUnknown, markCreditWelcomeVoiceDispatchFailed,
    verifyCreditWelcomeVoiceIdentity, saveCreditWelcomeVoiceResult, listCreditWelcomeVoiceCallsForCredit };
}

const store = createCreditWelcomeVoiceStore();
export const enqueueCreditWelcomeVoice = store.enqueueCreditWelcomeVoice;
export const claimPendingCreditWelcomeVoice = store.claimPendingCreditWelcomeVoice;
export const ensureVoiceReviewCampaign = store.ensureVoiceReviewCampaign;
export const claimVoiceReviewCampaign = store.claimVoiceReviewCampaign;
export const prepareVoiceReviewCampaign = store.prepareVoiceReviewCampaign;
export const prepareCreditWelcomeVoiceDispatch = store.prepareCreditWelcomeVoiceDispatch;
export const markCreditWelcomeVoiceDispatchAccepted = store.markCreditWelcomeVoiceDispatchAccepted;
export const markCreditWelcomeVoiceDispatchUnknown = store.markCreditWelcomeVoiceDispatchUnknown;
export const markCreditWelcomeVoiceDispatchFailed = store.markCreditWelcomeVoiceDispatchFailed;
export const verifyCreditWelcomeVoiceIdentity = store.verifyCreditWelcomeVoiceIdentity;
export const saveCreditWelcomeVoiceResult = store.saveCreditWelcomeVoiceResult;
export const listCreditWelcomeVoiceCallsForCredit = store.listCreditWelcomeVoiceCallsForCredit;
