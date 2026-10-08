import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { extractCreditFactorySnapshotDetails } from "@/lib/credit-factory-snapshot";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { matchWelcomeVoiceIdentity, normalizeWelcomeVoiceDocument, normalizeWelcomeVoiceName,
  safeDaptaWelcomeVoiceUrl } from "@/lib/credit-welcome-voice-core";
import { creditWelcomeVoiceSchemaStatements } from "@/scripts/credit-welcome-voice-schema.mjs";

export type CreditWelcomeVoiceSource = "NORMAL" | "INDIVIDUAL_IMPORT";
export type CreditWelcomeVoiceStatus = "PENDING" | "DISPATCHING" | "ACCEPTED" | "COMPLETED" |
  "FAILED" | "UNKNOWN" | "CANCELLED" | "SKIPPED";
export type CreditWelcomeVoiceSnapshot = {
  creditId: number; folio: string; name: string; document: string; phone: string;
  initialPayment: number; installmentCount: number; installmentAmount: number;
  installmentsEqual: boolean; installmentAmounts: number[];
  frequency: string; firstDueDate: string; calendar: string[];
};
export type VoiceFinancialSnapshot = Omit<CreditWelcomeVoiceSnapshot, "document" | "phone">;
export type VoiceDispatchClaim = { eventId: string; creditId: number; snapshot: CreditWelcomeVoiceSnapshot };
export type CreditWelcomeVoiceResultPayload = {
  eventId: string; creditId: number; providerCallId: string; status: "COMPLETED" | "FAILED";
  recordingUrl?: string | null; summary?: string | null; transcript?: string | null; doubts?: string | null;
  durationSeconds?: number | null; completedAt?: string | null; resultCode?: string | null;
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
      await db.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-welcome-voice-schema'))");
      for (const statement of creditWelcomeVoiceSchemaStatements) await db.$executeRawUnsafe(statement);
    }, { timeout: 30_000 }).catch(error => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

const creditSelect = {
  id: true, folio: true, clienteNombre: true, clienteDocumento: true, clienteTelefono: true,
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
  snapshot: CreditWelcomeVoiceSnapshot | null; providerCallId: string | null; identityAttempts: number;
  identityVerifiedAt: Date | string | null; resultHash: string | null;
};
const eventColumns = `"id"::text,"creditoId","source","status","snapshot","providerCallId", "identityAttempts","identityVerifiedAt","resultHash"`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validCreditId = (id: number) => Number.isSafeInteger(id) && id > 0;
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

/** Conditions come from the committed amortization/contract, never from caller input. */
export function buildCreditWelcomeVoiceSnapshot(credit: Credit): CreditWelcomeVoiceSnapshot | null {
  const name = normalizeWelcomeVoiceName(credit.clienteNombre);
  const document = normalizeWelcomeVoiceDocument(credit.clienteDocumento);
  const phone = normalizeColombianMobile(credit.clienteTelefono);
  const contractual = extractCreditFactorySnapshotDetails(credit.contratoSnapshot).paso2;
  const initialPayment = number(contractual.cuotaInicial ?? credit.cuotaInicial);
  const installmentCount = number(credit.amortizacion?.numeroCuotas ?? contractual.numeroCuotas ?? credit.plazoMeses);
  const installmentAmount = number(credit.amortizacion?.cuotaComercial ?? contractual.valorCuotaComercial ?? contractual.valorCuota ?? credit.valorCuota);
  const frequency = String(credit.amortizacion?.frecuenciaPago ?? contractual.frecuenciaPago ?? credit.frecuenciaPago).trim().toUpperCase();
  const firstDueDate = calendarDay(contractual.fechaPrimerPago ?? credit.fechaPrimerPago);
  if (!validCreditId(credit.id) || !credit.folio || !name || !document || !phone || initialPayment === null || initialPayment < 0 ||
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
  return { creditId: credit.id, folio: credit.folio, name, document, phone, initialPayment,
    installmentCount, installmentAmount, frequency, firstDueDate: calendar[0], calendar,
    installmentAmounts, installmentsEqual: installmentAmounts.every(amount => amount === installmentAmounts[0]) };
}
function financialConditions(snapshot: CreditWelcomeVoiceSnapshot): VoiceFinancialSnapshot {
  const { document: _document, phone: _phone, ...conditions } = snapshot;
  void _document; void _phone;
  return conditions;
}
function sameSnapshot(first: CreditWelcomeVoiceSnapshot, second: CreditWelcomeVoiceSnapshot) {
  // JSONB does not preserve object-key order. Compare the explicitly defined DTO.
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

export function createCreditWelcomeVoiceStore(deps: { database?: StoreDatabase; enabled?: () => boolean; now?: () => Date } = {}) {
  const database = deps.database ?? prisma;
  const enabled = deps.enabled ?? (() => process.env.DAPTA_WELCOME_VOICE_ENABLED === "true");
  const now = deps.now ?? (() => new Date());
  const readCredit = (db: WelcomeVoiceTransaction, id: number) => db.credito.findUnique({ where: { id }, select: creditSelect });
  async function readEvent(db: WelcomeVoiceTransaction, id: string, lock = true) {
    const rows = await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid ${lock ? "FOR UPDATE" : ""}`, id);
    return rows[0] || null;
  }
  async function exclude(db: WelcomeVoiceTransaction, row: EventRow, code: string) {
    const status = ["CREDIT_MISSING", "CREDIT_CLOSED", "CREDIT_PAID"].includes(code) ? "CANCELLED" : "SKIPPED";
    await db.$executeRawUnsafe(`UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2,"resultCode"=$3,"updatedAt"=$4
      WHERE "id"=$1::uuid AND "status" IN ('PENDING','DISPATCHING')`, row.id, status, code, now());
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
      ("id","creditoId","type","source","status","snapshot","resultCode","createdAt","updatedAt")
      VALUES ($1::uuid,$2,'BIENVENIDA_VOZ',$3,$4,$5::jsonb,$6,$7,$7)
      ON CONFLICT ("creditoId","type") DO NOTHING RETURNING "id"::text`, randomUUID(), input.creditId,
      input.source, exclusion ? "SKIPPED" : "PENDING", JSON.stringify(snapshot), exclusion, now());
    return rows[0] ? { eventId: rows[0].id } : null;
  }
  async function claimPendingCreditWelcomeVoice(options: { limit?: number } = {}): Promise<VoiceDispatchClaim[]> {
    if (!enabled()) return [];
    const limit = Math.max(1, Math.min(25, Math.trunc(options.limit || 5)));
    return database.$transaction(async db => {
      const pending = await db.$queryRawUnsafe<EventRow[]>(`SELECT ${eventColumns} FROM "CreditWelcomeVoiceEvent"
        WHERE "status"='PENDING' ORDER BY "createdAt","id" LIMIT $1 FOR UPDATE SKIP LOCKED`, limit);
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
  /** The worker calls this just before its one external request; it never claims an old dispatch. */
  async function prepareCreditWelcomeVoiceDispatch(eventId: string): Promise<VoiceDispatchClaim | null> {
    if (!enabled()) return null;
    requireEventIdentity(eventId);
    return database.$transaction(async db => {
      const event = await readEvent(db, eventId);
      if (!event || event.status !== "DISPATCHING") return null;
      const snapshot = await revalidate(db, event);
      return snapshot ? { eventId, creditId: event.creditoId, snapshot } : null;
    });
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
  async function verifyCreditWelcomeVoiceIdentity(input: { eventId: string; creditId: number; customerName: string; customerDocument: string }):
    Promise<{ verificado: false } | { verificado: true; condiciones: VoiceFinancialSnapshot }> {
    requireEventIdentity(input.eventId, input.creditId);
    return database.$transaction(async db => {
      const event = await readEvent(db, input.eventId);
      if (!event || event.creditoId !== input.creditId || !["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(event.status) || !event.snapshot) return { verificado: false };
      const correct = matchWelcomeVoiceIdentity({ name: input.customerName, document: input.customerDocument },
        { name: event.snapshot.name, document: event.snapshot.document });
      const credit = await readCredit(db, event.creditoId);
      const current = credit ? buildCreditWelcomeVoiceSnapshot(credit) : null;
      if (creditExclusion(credit, current) || !current || !sameSnapshot(current, event.snapshot)) return { verificado: false };
      // A verified retry can read the same conditions; a wrong identity never gets them.
      if (event.identityVerifiedAt) return correct ? { verificado: true, condiciones: financialConditions(event.snapshot) } : { verificado: false };
      if (event.identityAttempts >= 3) return { verificado: false };
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
    const completedAt = input.completedAt ? new Date(input.completedAt) : null;
    if (completedAt && !Number.isFinite(completedAt.getTime())) throw new CreditWelcomeVoiceStoreError("INVALID_RESULT", "Fecha inválida.", 400);
    const resultHash = createHash("sha256").update(JSON.stringify({ callId, status: input.status, recordingUrl, summary, transcript, doubts,
      duration, completedAt: completedAt?.toISOString() ?? null, resultCode })).digest("hex");
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
        "resultCode"=$10,"resultHash"=$11,"updatedAt"=$12 WHERE "id"=$1::uuid`, event.id, input.status, callId,
        completedAt ?? now(), duration, summary, transcript, doubts, recordingUrl, resultCode, resultHash, now());
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
  return { enqueueCreditWelcomeVoice, claimPendingCreditWelcomeVoice, prepareCreditWelcomeVoiceDispatch,
    markCreditWelcomeVoiceDispatchAccepted, markCreditWelcomeVoiceDispatchUnknown, markCreditWelcomeVoiceDispatchFailed,
    verifyCreditWelcomeVoiceIdentity, saveCreditWelcomeVoiceResult, listCreditWelcomeVoiceCallsForCredit };
}

const store = createCreditWelcomeVoiceStore();
export const enqueueCreditWelcomeVoice = store.enqueueCreditWelcomeVoice;
export const claimPendingCreditWelcomeVoice = store.claimPendingCreditWelcomeVoice;
export const prepareCreditWelcomeVoiceDispatch = store.prepareCreditWelcomeVoiceDispatch;
export const markCreditWelcomeVoiceDispatchAccepted = store.markCreditWelcomeVoiceDispatchAccepted;
export const markCreditWelcomeVoiceDispatchUnknown = store.markCreditWelcomeVoiceDispatchUnknown;
export const markCreditWelcomeVoiceDispatchFailed = store.markCreditWelcomeVoiceDispatchFailed;
export const verifyCreditWelcomeVoiceIdentity = store.verifyCreditWelcomeVoiceIdentity;
export const saveCreditWelcomeVoiceResult = store.saveCreditWelcomeVoiceResult;
export const listCreditWelcomeVoiceCallsForCredit = store.listCreditWelcomeVoiceCallsForCredit;
