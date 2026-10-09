import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { moraCreditSelect, moraCreditSummary, readMoraCredit } from "@/lib/analyst-mora-credit";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { listMoraSupports } from "@/lib/analyst-mora-support";
import { listMoraPortfolio } from "@/lib/analyst-mora-management";
import { colombiaDateKey } from "@/lib/colombia-date";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureMoraExceptionRequestSchema } from "@/lib/mora-exception-schema";
import { confirmedSadminNumber } from "@/lib/credit-display-number";
import type { MoraExceptionStatus as ExceptionStatus, MoraExceptionType as ExceptionType } from "@/lib/mora-exception-types";

export const MORA_EXCEPTION_TYPES = ["EXCEPCION", "PRORROGA"] as const;
export const MORA_EXCEPTION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "REPLACED", "CANCELLED"] as const;
export const MORA_COOLDOWN_BYPASS_PERMISSION = "MORA_COOLDOWN_BYPASS";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const dateKey = /^\d{4}-\d{2}-\d{2}$/;

type CreateInput = {
  creditoId: number;
  type: ExceptionType;
  expiresOn: string;
  promiseAmount: number;
  promiseDate: string;
  reason: string;
  observation: string;
  bypassCooldown: boolean;
  bypassReason: string | null;
  idempotencyKey: string;
};
type CentralCreateInput = {
  creditoId: number;
  type: ExceptionType;
  expiresOn: string | null;
  reason: string;
  observation: string;
  idempotencyKey: string;
  source: "CENTRAL_DIRECT";
};
type DecisionInput = {
  action: "APPROVE" | "REJECT" | "OBSERVE";
  version: number;
  reason: string;
  bypassCooldown: boolean;
  bypassReason: string | null;
  idempotencyKey: string;
};
type AmendmentInput = {
  action: "EDIT";
  version: number;
  expiresOn: string | null;
  reason: string;
  observation: string;
  promiseAmount?: number | null;
  promiseDate?: string | null;
  auditReason: string;
  idempotencyKey: string;
} | {
  action: "CANCEL";
  version: number;
  auditReason: string;
  idempotencyKey: string;
};
type RuleCredit = {
  montoCredito?: number | null;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  frecuenciaPago?: string | null;
  fechaPrimerPago?: Date | string | null;
  fechaProximoPago?: Date | string | null;
  planCapitalVigente?: unknown;
  pazYSalvoEmitidoAt?: Date | string | null;
  abonos?: Array<{ valor?: number | null; fechaAbono?: Date | string | null }>;
};
type StoredRequest = {
  id: string; creditoId: number; type: ExceptionType; status: ExceptionStatus; version: number;
  source: "ANALYST_REQUEST" | "CENTRAL_DIRECT";
  installmentNumber: number | null; installmentDueDate: Date | string | null; expiresOn: Date | string | null;
  promiseAmount: number | string | null; promiseDate: Date | string | null; reason: string; observation: string;
  createdByUserId: number; createdByName: string; submittedAt: Date | string;
  decidedByUserId: number | null; decidedByName: string | null; decidedAt: Date | string | null;
  decisionReason: string | null; cooldownBypassed: boolean; cooldownBypassReason: string | null;
  createdAt: Date | string; updatedAt: Date | string;
  folio?: string; clienteNombre?: string; clienteDocumento?: string | null; numeroSadmin?: string | null;
  paidTowardPromise?: number | string;
  createRequestHash?: string;
};
type StoredEvent = {
  id: string; requestId: string; creditoId: number; version: number; action: string;
  fromStatus: string | null; toStatus: string; payload: unknown; actorUserId: number | null;
  actorName: string; createdAt: Date | string; requestHash?: string;
};

function invalid(message = "Solicitud de excepción inválida.") {
  return new CreditApprovalError("INVALID_MORA_EXCEPTION", message);
}
function normalizedText(value: unknown, min: number, max: number, message: string) {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalid(message);
  const result = value.trim();
  if (result.length < min || result.length > max) throw invalid(message);
  return result;
}
function exactDate(value: unknown, message = "Selecciona una fecha válida.") {
  if (typeof value !== "string" || !dateKey.test(value)) throw invalid(message);
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(message);
  return value;
}
function toDateKey(value: Date | string) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function nullableDateKey(value: Date | string | null) {
  return value === null ? null : toDateKey(value);
}
function toIso(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export function addCalendarDays(value: string, days: number) {
  const parsed = new Date(`${exactDate(value)}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
function endOfColombiaDay(value: string) {
  return new Date(`${value}T23:59:59.999-05:00`);
}

export function parseMoraExceptionCreate(value: unknown): CreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  const allowed = ["creditoId","type","expiresOn","promiseAmount","promiseDate","reason","observation","bypassCooldown","bypassReason","idempotencyKey"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid("La solicitud contiene campos no permitidos.");
  const creditoId = Number(body.creditoId);
  const promiseAmount = Number(body.promiseAmount);
  if (!Number.isSafeInteger(creditoId) || creditoId < 1 || !MORA_EXCEPTION_TYPES.includes(body.type as ExceptionType) ||
    !Number.isFinite(promiseAmount) || promiseAmount <= 0 || Math.round(promiseAmount * 100) !== promiseAmount * 100 ||
    !uuid.test(String(body.idempotencyKey || ""))) throw invalid();
  const expiresOn = exactDate(body.expiresOn);
  const promiseDate = exactDate(body.promiseDate, "Selecciona una fecha válida para la promesa de pago.");
  const bypassCooldown = body.bypassCooldown === true;
  const bypassReason = body.bypassReason === null || body.bypassReason === undefined || body.bypassReason === ""
    ? null : normalizedText(body.bypassReason, 10, 1000, "Explica el permiso especial para omitir el enfriamiento.");
  if (promiseDate > expiresOn) throw invalid("La promesa de pago debe vencer a más tardar con la excepción.");
  if (bypassCooldown !== Boolean(bypassReason) || (body.type === "PRORROGA" && bypassCooldown))
    throw invalid("El permiso especial de enfriamiento no es válido.");
  return {
    creditoId,
    type: body.type as ExceptionType,
    expiresOn,
    promiseAmount,
    promiseDate,
    reason: normalizedText(body.reason, 5, 500, "Describe el motivo (5 a 500 caracteres)."),
    observation: normalizedText(body.observation, 5, 2000, "Agrega una observación (5 a 2000 caracteres)."),
    bypassCooldown,
    bypassReason,
    idempotencyKey: String(body.idempotencyKey),
  };
}

/** This payload never grants permission; the database role is checked again before writing. */
export function parseCentralMoraExceptionCreate(value: unknown): CentralCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  const allowed = ["creditoId", "type", "expiresOn", "reason", "observation", "idempotencyKey"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid("La excepción contiene campos no permitidos.");
  const creditoId = Number(body.creditoId);
  const type = body.type === undefined ? "EXCEPCION" : body.type;
  if (!Number.isSafeInteger(creditoId) || creditoId < 1 || !MORA_EXCEPTION_TYPES.includes(type as ExceptionType) ||
    !uuid.test(String(body.idempotencyKey || ""))) throw invalid();
  const expiresOn = body.expiresOn === null || body.expiresOn === undefined || body.expiresOn === ""
    ? null : exactDate(body.expiresOn);
  return {
    creditoId, type: type as ExceptionType, expiresOn,
    reason: body.reason === null || body.reason === undefined || body.reason === ""
      ? "Excepción autorizada por administrador central"
      : normalizedText(body.reason, 0, 500, "El motivo admite hasta 500 caracteres.") || "Excepción autorizada por administrador central",
    observation: body.observation === null || body.observation === undefined || body.observation === ""
      ? "" : normalizedText(body.observation, 0, 2000, "La observación admite hasta 2000 caracteres."),
    idempotencyKey: String(body.idempotencyKey), source: "CENTRAL_DIRECT",
  };
}

export function parseMoraExceptionDecision(value: unknown): DecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  const allowed = ["action","version","reason","bypassCooldown","bypassReason","idempotencyKey"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid("La acción contiene campos no permitidos.");
  if (!["APPROVE","REJECT","OBSERVE"].includes(String(body.action)) || !Number.isSafeInteger(body.version) ||
    Number(body.version) < 1 || !uuid.test(String(body.idempotencyKey || ""))) throw invalid();
  const bypassCooldown = body.bypassCooldown === true;
  const bypassReason = body.bypassReason === null || body.bypassReason === undefined || body.bypassReason === ""
    ? null : normalizedText(body.bypassReason, 10, 1000, "Explica el permiso especial para omitir el enfriamiento.");
  if (body.action !== "APPROVE" && (bypassCooldown || bypassReason)) throw invalid("Solo una aprobación puede omitir el enfriamiento.");
  if (bypassCooldown !== Boolean(bypassReason)) throw invalid("El permiso especial requiere un motivo auditado.");
  return {
    action: body.action as DecisionInput["action"],
    version: Number(body.version),
    reason: normalizedText(body.reason, 5, 1000, "Agrega una observación o motivo de decisión."),
    bypassCooldown,
    bypassReason,
    idempotencyKey: String(body.idempotencyKey),
  };
}

export function parseCentralMoraExceptionDecision(value: unknown): DecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  const defaultReason = body.action === "APPROVE" ? "Excepción aprobada por administrador central" :
      body.action === "REJECT" ? "Excepción rechazada por administrador central" : "Observación del administrador central";
  const reason = body.reason === undefined || body.reason === null
    ? defaultReason : normalizedText(body.reason, 0, 1000, "La observación admite hasta 1000 caracteres.") || defaultReason;
  return { ...parseMoraExceptionDecision({ ...body, reason: defaultReason }), reason };
}

/** Central corrections retain the original request and its financial conditions. */
export function parseCentralMoraExceptionAmendment(value: unknown): AmendmentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  const allowed = body.action === "EDIT"
    ? ["action", "version", "expiresOn", "reason", "observation", "promiseAmount", "promiseDate", "auditReason", "idempotencyKey"]
    : ["action", "version", "auditReason", "idempotencyKey"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid("La corrección contiene campos no permitidos.");
  if (!["EDIT", "CANCEL"].includes(String(body.action)) || !Number.isSafeInteger(body.version) || Number(body.version) < 1
    || !uuid.test(String(body.idempotencyKey || ""))) throw invalid();
  const auditReason = body.auditReason === undefined || body.auditReason === null || body.auditReason === ""
    ? body.action === "EDIT" ? "Editada por administrador central" : "Cancelada por administrador central"
    : normalizedText(body.auditReason, 1, 1000, "El motivo del cambio admite hasta 1000 caracteres.");
  const common = { version: Number(body.version), auditReason, idempotencyKey: String(body.idempotencyKey) };
  if (body.action === "CANCEL") return { action: "CANCEL", ...common };
  const expiresOn = body.expiresOn === undefined || body.expiresOn === null || body.expiresOn === ""
    ? null : exactDate(body.expiresOn);
  const reason = body.reason === undefined || body.reason === null || body.reason === ""
    ? "Excepción autorizada por administrador central"
    : normalizedText(body.reason, 0, 500, "El motivo admite hasta 500 caracteres.") || "Excepción autorizada por administrador central";
  const observation = body.observation === undefined || body.observation === null || body.observation === ""
    ? "" : normalizedText(body.observation, 0, 2000, "La observación admite hasta 2000 caracteres.");
  const input: AmendmentInput = { action: "EDIT", ...common, expiresOn, reason, observation };
  if (Object.hasOwn(body, "promiseAmount")) {
    if (body.promiseAmount !== null && typeof body.promiseAmount !== "number" && typeof body.promiseAmount !== "string")
      throw invalid("Ingresa un valor de compromiso válido.");
    const amount = body.promiseAmount === null || body.promiseAmount === "" ? null : Number(body.promiseAmount);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))
      || Math.round(amount * 100) / 100 !== amount)) throw invalid("Ingresa un valor de compromiso válido.");
    input.promiseAmount = amount;
  }
  if (Object.hasOwn(body, "promiseDate")) input.promiseDate = body.promiseDate === null || body.promiseDate === ""
    ? null : exactDate(body.promiseDate, "Selecciona una fecha válida para el compromiso de pago.");
  return input;
}

export function evaluateMoraExceptionRule(credit: RuleCredit, input: Pick<CreateInput, "type" | "expiresOn" | "promiseAmount" | "promiseDate">, now = new Date()) {
  const today = colombiaDateKey(now);
  const plan = buildCreditPaymentPlan({ ...credit, fechaProximoPago: null, today, settled: Boolean(credit.pazYSalvoEmitidoAt) });
  const installment = plan.installments.find(row => !row.eliminada && row.saldoPendiente > 0) || null;
  if (!installment || plan.estadoPago !== "MORA") throw new CreditApprovalError("NOT_OVERDUE", "El crédito no tiene una cuota regular vencida.", 409);
  if (input.promiseAmount > plan.saldoPendiente) throw invalid("El pago prometido no puede superar el saldo pendiente.");
  if (input.promiseDate < today || input.expiresOn < today) throw new CreditApprovalError("REQUEST_WINDOW_CLOSED", "La fecha solicitada ya venció.", 409);
  const dueDate = installment.fechaVencimiento;
  const maxExpiresOn = addCalendarDays(dueDate, 4);
  if (input.type === "PRORROGA") {
    const day = Number(dueDate.slice(8, 10));
    if (![2,17].includes(day) || today <= dueDate || today > maxExpiresOn || input.expiresOn > maxExpiresOn) {
      throw new CreditApprovalError("EXTENSION_WINDOW_CLOSED", "La prórroga solo se solicita después del vencimiento 02/17 y hasta el día 06/21.", 409);
    }
  }
  return {
    today,
    installmentNumber: installment.numero,
    installmentDueDate: dueDate,
    installmentBalance: installment.saldoPendiente,
    outstandingBalance: plan.saldoPendiente,
    maxExpiresOn: input.type === "PRORROGA" ? maxExpiresOn : null,
  };
}

export function moraCooldownEnabledOn(expiresOn: string) {
  return addCalendarDays(expiresOn, 21);
}

export function moraCooldownMessage(enabledOn: string) {
  const label = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Bogota" })
    .format(new Date(`${enabledOn}T12:00:00-05:00`));
  return `Este crédito tuvo una excepción vencida. Podrá solicitar una nueva excepción a partir del ${label}.`;
}

const requestColumns = `r."id"::text,r."creditoId",r."type",r."status",r."version",r."source",r."installmentNumber",
  r."installmentDueDate",r."expiresOn",r."promiseAmount",r."promiseDate",r."reason",r."observation",
  r."createdByUserId",r."createdByName",r."submittedAt",r."decidedByUserId",r."decidedByName",r."decidedAt",
  r."decisionReason",r."cooldownBypassed",r."cooldownBypassReason",r."createdAt",r."updatedAt",
  credit."folio",credit."clienteNombre",credit."clienteDocumento",
  COALESCE((SELECT SUM(payment."valor") FROM "CreditoAbono" payment
    WHERE payment."creditoId"=r."creditoId" AND UPPER(BTRIM(payment."estado"))<>'ANULADO'
      AND r."decidedAt" IS NOT NULL AND payment."fechaAbono">=(r."decidedAt" AT TIME ZONE 'UTC')
      AND payment."fechaAbono"<((r."promiseDate"+1)::timestamp + interval '5 hours')),0)::double precision AS "paidTowardPromise"`;
const requestFrom = ` FROM "CreditMoraExceptionRequest" r JOIN "Credito" credit ON credit."id"=r."creditoId"`;
// Only the read views need the display number. Mutation/idempotency queries retain their original joins.
const requestReadColumns = `${requestColumns},NULLIF(BTRIM(sadmin."numeroCredito"),'') AS "numeroSadmin"`;
const requestReadFrom = `${requestFrom} LEFT JOIN "CreditSadminRegistration" sadmin
  ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"=TRUE`;
function requestDto(row: StoredRequest, now = new Date()) {
  const paid = Number(row.paidTowardPromise || 0);
  const promise = row.promiseAmount === null ? null : Number(row.promiseAmount);
  const today = colombiaDateKey(now);
  const conditionStatus = row.source === "CENTRAL_DIRECT" || promise === null || row.promiseDate === null ||
    !["APPROVED","EXPIRED"].includes(row.status) ? "NOT_APPLICABLE"
    : paid >= promise ? "FULFILLED" : today > toDateKey(row.promiseDate) ? "BREACHED" : "PENDING";
  return {
    id: row.id, creditoId: row.creditoId, type: row.type, status: row.status, version: row.version,
    source: row.source || "ANALYST_REQUEST", centralDirect: row.source === "CENTRAL_DIRECT",
    installmentNumber: row.installmentNumber, installmentDueDate: nullableDateKey(row.installmentDueDate),
    expiresOn: nullableDateKey(row.expiresOn), promiseAmount: promise, promiseDate: nullableDateKey(row.promiseDate),
    reason: row.reason, observation: row.observation, createdByUserId: row.createdByUserId,
    createdByName: row.createdByName, submittedAt: toIso(row.submittedAt),
    decidedByUserId: row.decidedByUserId, decidedByName: row.decidedByName, decidedAt: toIso(row.decidedAt),
    decisionReason: row.decisionReason, cooldownBypassed: row.cooldownBypassed,
    cooldownBypassReason: row.cooldownBypassReason, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt),
    credit: row.folio ? { folio: row.folio, numeroSadmin: row.numeroSadmin || null,
      clienteNombre: row.clienteNombre, clienteDocumento: row.clienteDocumento } : undefined,
    paidTowardPromise: paid, conditionStatus,
  };
}
function eventDto(row: StoredEvent) {
  const { requestHash: _hash, ...event } = row;
  void _hash;
  return { ...event, createdAt: toIso(row.createdAt) };
}

async function ensureSchemas() {
  await ensureMoraExceptionRequestSchema();
  await ensureAnalystMoraSchema();
}
async function expireApproved(db: Pick<typeof prisma, "$queryRawUnsafe">, now = new Date(), creditoId?: number) {
  const today = colombiaDateKey(now);
  const rows = await db.$queryRawUnsafe<Array<{ id: string; creditoId: number; version: number }>>(`UPDATE "CreditMoraExceptionRequest"
    SET "status"='EXPIRED',"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "status"='APPROVED' AND "expiresOn"<$1::date AND ($2::integer IS NULL OR "creditoId"=$2)
    RETURNING "id"::text,"creditoId","version"`, today, creditoId || null);
  for (const row of rows) {
    const payload = { expiredOnReadAt: now.toISOString(), expiresBefore: today };
    const hash = createHash("sha256").update(JSON.stringify({ requestId: row.id, version: row.version, payload })).digest("hex");
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
      ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorName","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,$4,'EXPIRED','APPROVED','EXPIRED',$5::jsonb,'Sistema',$6)`,
    randomUUID(),row.id,row.creditoId,row.version,JSON.stringify(payload),hash);
  }
}
async function hasBypassPermission(db: Pick<typeof prisma, "$queryRawUnsafe">, actor: MoraActor) {
  if (!actor.centralAdmin) return false;
  const rows = await db.$queryRawUnsafe<Array<{ allowed: boolean }>>(`SELECT TRUE AS allowed
    FROM "CreditMoraSpecialPermission" WHERE "userId"=$1
      AND "permissionKey"='MORA_COOLDOWN_BYPASS' AND "active"=TRUE FOR SHARE`,actor.id);
  return Boolean(rows[0]?.allowed);
}
export async function latestExceptionExpiry(db: Pick<typeof prisma, "$queryRawUnsafe">, creditoId: number, excludeId?: string) {
  const rows = await db.$queryRawUnsafe<Array<{ expiresOn: Date | string }>>(`SELECT request."expiresOn" FROM "CreditMoraExceptionRequest" request
    WHERE request."creditoId"=$1 AND request."type"='EXCEPCION' AND request."status" IN ('APPROVED','EXPIRED')
      AND request."source"='ANALYST_REQUEST'
      AND ($2::uuid IS NULL OR request."id"<>$2::uuid)
      AND COALESCE((SELECT SUM(payment."valor") FROM "CreditoAbono" payment
        WHERE payment."creditoId"=request."creditoId" AND UPPER(BTRIM(payment."estado"))<>'ANULADO'
          AND payment."fechaAbono">=(request."decidedAt" AT TIME ZONE 'UTC')
          AND payment."fechaAbono"<((request."promiseDate"+1)::timestamp + interval '5 hours')),0)<request."promiseAmount"
    ORDER BY request."expiresOn" DESC,request."id" DESC LIMIT 1`,creditoId,excludeId || null);
  return rows[0] ? toDateKey(rows[0].expiresOn) : null;
}

export async function getMoraExceptionPreflight(creditoId: number, actor: MoraActor, now = new Date()) {
  await ensureSchemas();
  const credit = await readMoraCredit(creditoId);
  const [openRequest, lastExpiry, canBypassCooldown, centralAdmin] = await prisma.$transaction(async db => {
    const verified = await assertMoraActor(db,actor);
    await expireApproved(db,now);
    const rows = await db.$queryRawUnsafe<Array<{ exists: boolean }>>(`SELECT EXISTS(
      SELECT 1 FROM "CreditMoraExceptionRequest" WHERE "creditoId"=$1 AND "status" IN ('PENDING','APPROVED')) AS "exists"`,creditoId);
    return [Boolean(rows[0]?.exists),await latestExceptionExpiry(db,creditoId),await hasBypassPermission(db,verified),verified.centralAdmin] as const;
  });
  const today = colombiaDateKey(now);
  const plan = buildCreditPaymentPlan({ ...credit, fechaProximoPago: null, today, settled:Boolean(credit.pazYSalvoEmitidoAt) });
  const installment = plan.installments.find(row=>!row.eliminada&&row.saldoPendiente>0)||null;
  const dueDate = installment?.fechaVencimiento || null;
  const maxExpiresOn = dueDate ? addCalendarDays(dueDate,4) : null;
  const dueDay = dueDate ? Number(dueDate.slice(8,10)) : 0;
  const cooldownEnabledOn = lastExpiry ? moraCooldownEnabledOn(lastExpiry) : null;
  const commonBlocked = openRequest ? "Ya existe una solicitud pendiente o una excepción vigente para este crédito."
    : !installment || plan.estadoPago!=="MORA" ? "El crédito no tiene una cuota regular vencida." : null;
  const extensionBlocked = commonBlocked || (![2,17].includes(dueDay)||today<=String(dueDate)||today>String(maxExpiresOn)
    ? "La prórroga solo está disponible después del vencimiento 02/17 y hasta el día 06/21." : null);
  const cooldownBlocked = cooldownEnabledOn && today<cooldownEnabledOn
    ? moraCooldownMessage(cooldownEnabledOn) : null;
  return {
    credit:{...moraCreditSummary(credit,now),numeroSadmin:confirmedSadminNumber(credit.registroSadmin)},
    eligibility:{
      regularInstallment:installment?{number:installment.numero,dueDate,balance:installment.saldoPendiente}:null,
      maxExpiresOn:centralAdmin?null:maxExpiresOn,
      prorroga:{canRequest:centralAdmin||!extensionBlocked,blockedReason:centralAdmin?null:extensionBlocked},
      excepcion:{canRequest:centralAdmin||!(commonBlocked||cooldownBlocked),blockedReason:centralAdmin?null:commonBlocked||cooldownBlocked,cooldownEnabledOn:centralAdmin?null:cooldownEnabledOn},
      canBypassCooldown,
      promise:{amount:installment?Math.min(installment.saldoPendiente,Number(credit.valorCuota||installment.saldoPendiente)):0,date:today},
    },
  };
}

export async function searchMoraExceptionCredits(params: URLSearchParams, actor: MoraActor, now = new Date()) {
  const q = (params.get("q") || "").trim();
  if (q.length > 100) throw new CreditApprovalError("INVALID_FILTER", "Búsqueda demasiado extensa.");
  const verified = await prisma.$transaction(db => assertMoraActor(db,actor));
  if (!verified.centralAdmin) {
    const portfolio = await listMoraPortfolio(new URLSearchParams({ q }));
    return { items: portfolio.items, hasMore: portfolio.hasMore };
  }
  if (!q) return { items: [], hasMore: false };
  const credits = await prisma.credito.findMany({
    where: {
      estado: { notIn: ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"] },
      OR: [
        { folio: { contains: q, mode: "insensitive" } },
        { clienteNombre: { contains: q, mode: "insensitive" } },
        { clienteDocumento: { contains: q } },
        { imei: { contains: q } },
        { deviceUid: { contains: q } },
        { registroSadmin: { is: { numeroCredito: { contains: q } } } },
      ],
    },
    select: moraCreditSelect, orderBy: { createdAt: "desc" }, take: 26,
  });
  return { items: credits.slice(0,25).map(credit => moraCreditSummary(credit,now)), hasMore: credits.length > 25 };
}

function parseCursor(value: string | null) {
  if (!value) return null;
  try {
    if (value.length>256||!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    if(!parsed||Object.keys(parsed).sort().join(",")!=="createdAt,id"||!uuid.test(parsed.id)||
      typeof parsed.createdAt!=="string"||new Date(parsed.createdAt).toISOString()!==parsed.createdAt)throw new Error();
    return parsed as {createdAt:string;id:string};
  }catch{throw new CreditApprovalError("INVALID_CURSOR","Actualiza las solicitudes para continuar.");}
}
export async function listMoraExceptionRequests(params: URLSearchParams, actor: MoraActor, now = new Date()) {
  await ensureSchemas();
  const status=params.get("status"),type=params.get("type"),creditRaw=params.get("creditoId");
  if(status&&!MORA_EXCEPTION_STATUSES.includes(status as ExceptionStatus))throw invalid("Estado inválido.");
  if(type&&!MORA_EXCEPTION_TYPES.includes(type as ExceptionType))throw invalid("Tipo inválido.");
  const creditoId=creditRaw===null?null:Number(creditRaw);
  if(creditoId!==null&&(!Number.isSafeInteger(creditoId)||creditoId<1))throw invalid("Crédito inválido.");
  const q=normalizedText(params.get("q")||"",0,100,"Busca con hasta 100 caracteres.");
  const limit=Number(params.get("pageSize")||params.get("limit")||50);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid("Selecciona una página de hasta 100 solicitudes.");
  const cursor=parseCursor(params.get("cursor"));
  const page=Number(params.get("page")||1);
  const offset=cursor?0:(page-1)*limit;
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(offset))throw invalid("Selecciona una página válida.");
  if(cursor&&params.has("page"))throw invalid("Usa página o cursor para continuar, no ambos.");
  // Count and page share every business/search filter; the cursor never narrows the total.
  const filters=`WHERE ($1::text IS NULL OR r."status"=$1) AND ($2::text IS NULL OR r."type"=$2)
    AND ($3::integer IS NULL OR r."creditoId"=$3)
    AND ($4::text='' OR strpos(lower(COALESCE(credit."clienteNombre",'')),lower($4))>0
      OR strpos(COALESCE(credit."clienteDocumento",''),$4)>0
      OR ($5::text<>'' AND strpos(regexp_replace(COALESCE(credit."clienteDocumento",''),'[.[:space:]]','','g'),$5)>0)
      OR strpos(lower(COALESCE(credit."folio",'')),lower($4))>0
      OR strpos(lower(COALESCE(sadmin."numeroCredito",'')),lower($4))>0)`;
  const bindings=[status||null,type||null,creditoId,q,q.replace(/[.\s]/g,"")];
  const result=await prisma.$transaction(async db=>{
    await assertMoraActor(db,actor);
    await expireApproved(db,now);
    const totals=await db.$queryRawUnsafe<Array<{total:number}>>(`SELECT COUNT(*)::integer AS "total"${requestReadFrom} ${filters}`,...bindings);
    const rows=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestReadColumns}${requestReadFrom} ${filters}
        AND ($6::timestamptz IS NULL OR (r."createdAt",r."id")<($6::timestamptz,$7::uuid))
      ORDER BY r."createdAt" DESC,r."id" DESC LIMIT $8 OFFSET $9`,
    ...bindings,cursor?.createdAt||null,cursor?.id||null,limit+1,offset);
    return {rows,total:totals[0]?.total||0};
  });
  const items=result.rows.slice(0,limit).map(row=>requestDto(row,now));
  const last=result.rows.length>limit?items.at(-1):null;
  const nextCursor=last?Buffer.from(JSON.stringify({createdAt:last.createdAt,id:last.id})).toString("base64url"):null;
  const preflight=creditoId?await getMoraExceptionPreflight(creditoId,actor,now):null;
  return {items,total:result.total,page,pageSize:limit,totalPages:Math.ceil(result.total/limit),
    hasMore:result.rows.length>limit,nextCursor,...(preflight||{})};
}

export async function getMoraExceptionRequest(id: string, actor: MoraActor, now = new Date()) {
  if(!uuid.test(id))throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
  await ensureSchemas();
  const [rows,history]=await prisma.$transaction(async db=>{
    await assertMoraActor(db,actor);
    await expireApproved(db,now);
    return Promise.all([
      db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestReadColumns}${requestReadFrom} WHERE r."id"=$1::uuid`,id),
      db.$queryRawUnsafe<StoredEvent[]>(`SELECT "id"::text,"requestId"::text,"creditoId","version","action","fromStatus","toStatus",
        "payload","actorUserId","actorName","createdAt" FROM "CreditMoraExceptionEvent" WHERE "requestId"=$1::uuid ORDER BY "createdAt","id"`,id),
    ]);
  });
  if(!rows[0])throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
  const item=requestDto(rows[0],now);
  const [supports,preflight]=await Promise.all([
    listMoraSupports({creditoId:item.creditoId,subjectKind:"EXCEPCION",subjectId:id}),
    getMoraExceptionPreflight(item.creditoId,actor,now),
  ]);
  return {item:{...item,credit:{...preflight.credit,...item.credit}},history:history.map(eventDto),supports,...preflight};
}

export async function createMoraExceptionRequest(input: CreateInput | CentralCreateInput, actor: MoraActor, now = new Date()) {
  await ensureSchemas();
  const requestHash=createHash("sha256").update(JSON.stringify({input,actorId:actor.id})).digest("hex");
  return prisma.$transaction(async db=>{
    const verified=await assertMoraActor(db,actor);
    if ("source" in input && !verified.centralAdmin)
      throw new CreditApprovalError("FORBIDDEN","Solo el administrador central puede registrar una excepción directa.",403);
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`,input.creditoId);
    await expireApproved(db,now,input.creditoId);
    const prior=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom}
      WHERE r."createIdempotencyKey"=$1::uuid`,input.idempotencyKey);
    if(prior[0]){
      const hashes=await db.$queryRawUnsafe<Array<{createRequestHash:string}>>(`SELECT "createRequestHash" FROM "CreditMoraExceptionRequest" WHERE "id"=$1::uuid`,prior[0].id);
      if(hashes[0]?.createRequestHash!==requestHash)throw new CreditApprovalError("IDEMPOTENCY_CONFLICT","El envío ya corresponde a otra solicitud.",409);
      return {item:requestDto(prior[0],now),unchanged:true};
    }
    const credit=await db.credito.findUnique({where:{id:input.creditoId},select:moraCreditSelect});
    if(!credit || ["ANULADO","ANULADA","CANCELADO","CANCELADA"].includes(credit.estado.trim().toUpperCase()))
      throw new CreditApprovalError("CREDIT_NOT_FOUND","Crédito no encontrado.",404);
    if(verified.centralAdmin){
      if(input.expiresOn!==null && input.expiresOn<colombiaDateKey(now))
        throw invalid("La fecha de vencimiento ya pasó. Puedes dejarla vacía para registrar la excepción sin vencimiento.");
      const id=randomUUID();
      const previous=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT * FROM "CreditMoraExceptionRequest"
        WHERE "creditoId"=$1 AND "status" IN ('PENDING','APPROVED') ORDER BY "id" FOR UPDATE`,input.creditoId);
      for(const priorRequest of previous){
        const version=priorRequest.version+1;
        await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "status"='REPLACED',"version"=$2,
          "decidedByUserId"=COALESCE("decidedByUserId",$3),"decidedByName"=COALESCE("decidedByName",$4),
          "decidedAt"=COALESCE("decidedAt",CURRENT_TIMESTAMP),"decisionReason"=COALESCE("decisionReason",$5),
          "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,priorRequest.id,version,verified.id,verified.nombre,input.reason);
        const payload={replacedByRequestId:id,reason:input.reason,source:"CENTRAL_DIRECT"};
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
          ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","requestHash")
          VALUES ($1::uuid,$2::uuid,$3,$4,'REPLACED',$5,'REPLACED',$6::jsonb,$7,$8,$9)`,
        randomUUID(),priorRequest.id,input.creditoId,version,priorRequest.status,JSON.stringify(payload),verified.id,verified.nombre,requestHash);
      }
      await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionRequest"
        ("id","creditoId","type","status","version","source","expiresOn","reason","observation",
         "createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","decisionReason",
         "createIdempotencyKey","createRequestHash")
        VALUES ($1::uuid,$2,$3,'APPROVED',1,'CENTRAL_DIRECT',$4::date,$5,$6,$7,$8,$7,$8,CURRENT_TIMESTAMP,$5,$9::uuid,$10)`,
      id,input.creditoId,input.type,input.expiresOn,input.reason,input.observation,verified.id,verified.nombre,input.idempotencyKey,requestHash);
      const payload={source:"CENTRAL_DIRECT",type:input.type,expiresOn:input.expiresOn,reason:input.reason,
        observation:input.observation,replacedRequestIds:previous.map(row=>row.id)};
      await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
        ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","idempotencyKey","requestHash")
        VALUES ($1::uuid,$2::uuid,$3,1,'APPROVED',NULL,'APPROVED',$4::jsonb,$5,$6,$7::uuid,$8)`,
      randomUUID(),id,input.creditoId,JSON.stringify(payload),verified.id,verified.nombre,input.idempotencyKey,requestHash);
      const rows=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`,id);
      return {item:requestDto(rows[0],now),unchanged:false};
    }
    if("source" in input) throw new CreditApprovalError("FORBIDDEN","No tienes permiso para esta excepción.",403);
    const rule=evaluateMoraExceptionRule(credit,input,now);
    const open=await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT "id"::text FROM "CreditMoraExceptionRequest"
      WHERE "creditoId"=$1 AND "status" IN ('PENDING','APPROVED')`,input.creditoId);
    if(open.length)throw new CreditApprovalError("MORA_REQUEST_PENDING","Ya existe una solicitud pendiente o una excepción vigente para este crédito.",409);
    if(input.type==="EXCEPCION"){
      const last=await latestExceptionExpiry(db,input.creditoId);
      const enabled=last?moraCooldownEnabledOn(last):null;
      if(enabled&&colombiaDateKey(now)<enabled){
        if(!input.bypassCooldown)throw new CreditApprovalError("MORA_COOLDOWN",moraCooldownMessage(enabled),409);
        if(!await hasBypassPermission(db,verified))throw new CreditApprovalError("MORA_BYPASS_FORBIDDEN","No tienes el permiso especial para omitir el enfriamiento.",403);
      }else if(input.bypassCooldown)throw invalid("No existe un enfriamiento vigente para omitir.");
    }
    const id=randomUUID();
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionRequest"
      ("id","creditoId","type","status","version","installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",
       "reason","observation","createdByUserId","createdByName","cooldownBypassed","cooldownBypassReason","createIdempotencyKey","createRequestHash")
      VALUES ($1::uuid,$2,$3,'PENDING',1,$4,$5::date,$6::date,$7,$8::date,$9,$10,$11,$12,$13,$14,$15::uuid,$16)`,
    id,input.creditoId,input.type,rule.installmentNumber,rule.installmentDueDate,input.expiresOn,input.promiseAmount,input.promiseDate,
    input.reason,input.observation,verified.id,verified.nombre,input.bypassCooldown,input.bypassReason,input.idempotencyKey,requestHash);
    const payload={type:input.type,expiresOn:input.expiresOn,promiseAmount:input.promiseAmount,promiseDate:input.promiseDate,
      installmentNumber:rule.installmentNumber,installmentDueDate:rule.installmentDueDate,reason:input.reason,observation:input.observation,
      bypassCooldown:input.bypassCooldown,bypassReason:input.bypassReason};
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
      ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","idempotencyKey","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,1,'SUBMITTED',NULL,'PENDING',$4::jsonb,$5,$6,$7::uuid,$8)`,
    randomUUID(),id,input.creditoId,JSON.stringify(payload),verified.id,verified.nombre,input.idempotencyKey,requestHash);
    const rows=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`,id);
    return {item:requestDto(rows[0],now),unchanged:false};
  },{isolationLevel:"ReadCommitted",maxWait:10_000,timeout:45_000});
}

export async function actOnMoraExceptionRequest(id: string, input: DecisionInput, actor: MoraActor, now = new Date()) {
  if(!uuid.test(id))throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
  await ensureSchemas();
  const requestHash=createHash("sha256").update(JSON.stringify({id,input,actorId:actor.id})).digest("hex");
  return prisma.$transaction(async db=>{
    const verified=await assertMoraActor(db,actor,input.action!=="OBSERVE");
    const identity=await db.$queryRawUnsafe<Array<{creditoId:number}>>(`SELECT "creditoId" FROM "CreditMoraExceptionRequest" WHERE "id"=$1::uuid`,id);
    if(!identity[0])throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`,identity[0].creditoId);
    await expireApproved(db,now,identity[0].creditoId);
    const prior=await db.$queryRawUnsafe<StoredEvent[]>(`SELECT * FROM "CreditMoraExceptionEvent" WHERE "idempotencyKey"=$1::uuid`,input.idempotencyKey);
    if(prior[0]){
      if(prior[0].requestHash!==requestHash)throw new CreditApprovalError("IDEMPOTENCY_CONFLICT","La acción ya corresponde a otra solicitud.",409);
      const rows=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`,id);
      if(!rows[0])throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
      return {item:requestDto(rows[0],now),unchanged:true};
    }
    const locked=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT * FROM "CreditMoraExceptionRequest" WHERE "id"=$1::uuid FOR UPDATE`,id);
    const current=locked[0];
    if(!current)throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND","Solicitud no encontrada.",404);
    if(current.version!==input.version)throw new CreditApprovalError("MORA_REQUEST_CHANGED","La solicitud cambió. Actualiza antes de continuar.",409);
    if(input.action!=="OBSERVE"&&current.status!=="PENDING")throw new CreditApprovalError("MORA_REQUEST_DECIDED","La solicitud ya fue decidida.",409);
    const nextVersion=current.version+1;
    let nextStatus=current.status;
    let payload:Record<string,unknown>={reason:input.reason};
    if(input.action==="OBSERVE"){
      await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "version"=$2,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,id,nextVersion);
      payload={observation:input.reason};
    }else{
      nextStatus=input.action==="APPROVE"?"APPROVED":"REJECTED";
      if(input.action==="APPROVE"){
        const credit=await db.credito.findUnique({where:{id:current.creditoId},select:moraCreditSelect});
        if(!credit || ["ANULADO","ANULADA","CANCELADO","CANCELADA"].includes(credit.estado.trim().toUpperCase()))
          throw new CreditApprovalError("CREDIT_NOT_FOUND","Crédito no encontrado.",404);
        if(current.expiresOn!==null && toDateKey(current.expiresOn)<colombiaDateKey(now))
          throw invalid("La fecha de vencimiento ya pasó. Registra una nueva excepción con la fecha que necesites.");
      }
      const cooldownBypassed=input.bypassCooldown||current.cooldownBypassed;
      const cooldownBypassReason=input.bypassReason||current.cooldownBypassReason;
      await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "status"=$2,"version"=$3,
        "decidedByUserId"=$4,"decidedByName"=$5,"decidedAt"=CURRENT_TIMESTAMP,"decisionReason"=$6,
        "cooldownBypassed"=$7,"cooldownBypassReason"=$8,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,
      id,nextStatus,nextVersion,verified.id,verified.nombre,input.reason,cooldownBypassed,cooldownBypassReason);
      payload={reason:input.reason,bypassCooldown:cooldownBypassed,bypassReason:cooldownBypassReason};
    }
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
      ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","idempotencyKey","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::uuid,$12)`,
    randomUUID(),id,current.creditoId,nextVersion,input.action==="APPROVE"?"APPROVED":input.action==="REJECT"?"REJECTED":"OBSERVED",
    current.status,nextStatus,JSON.stringify(payload),verified.id,verified.nombre,input.idempotencyKey,requestHash);
    const rows=await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`,id);
    return {item:requestDto(rows[0],now),unchanged:false};
  },{isolationLevel:"ReadCommitted",maxWait:10_000,timeout:45_000});
}

function amendmentSnapshot(row: StoredRequest) {
  return {
    creditoId: row.creditoId, type: row.type, source: row.source, status: row.status, version: row.version,
    installmentNumber: row.installmentNumber, installmentDueDate: nullableDateKey(row.installmentDueDate),
    expiresOn: nullableDateKey(row.expiresOn), promiseAmount: row.promiseAmount === null ? null : Number(row.promiseAmount),
    promiseDate: nullableDateKey(row.promiseDate), reason: row.reason, observation: row.observation,
    decidedByUserId: row.decidedByUserId, decidedByName: row.decidedByName, decidedAt: toIso(row.decidedAt),
    decisionReason: row.decisionReason,
  };
}

export async function amendMoraExceptionRequest(id: string, input: AmendmentInput, actor: MoraActor, now = new Date()) {
  if (!uuid.test(id)) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
  await ensureSchemas();
  const requestHash = createHash("sha256").update(JSON.stringify({ id, input, actorId: actor.id })).digest("hex");
  return prisma.$transaction(async db => {
    const verified = await assertMoraActor(db, actor, true);
    const identity = await db.$queryRawUnsafe<Array<{ creditoId: number }>>(
      `SELECT "creditoId" FROM "CreditMoraExceptionRequest" WHERE "id"=$1::uuid`, id);
    if (!identity[0]) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
    // All changes to a credit's effective exception serialize on the credit row.
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, identity[0].creditoId);
    const prior = await db.$queryRawUnsafe<StoredEvent[]>(
      `SELECT * FROM "CreditMoraExceptionEvent" WHERE "idempotencyKey"=$1::uuid`, input.idempotencyKey);
    if (prior[0]) {
      if (prior[0].requestHash !== requestHash)
        throw new CreditApprovalError("IDEMPOTENCY_CONFLICT", "La confirmación ya corresponde a otra corrección.", 409);
      const rows = await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`, id);
      if (!rows[0]) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
      return { item: requestDto(rows[0], now), unchanged: true, affectsMora: prior[0].fromStatus === "APPROVED" };
    }
    await expireApproved(db, now, identity[0].creditoId);
    const locked = await db.$queryRawUnsafe<StoredRequest[]>(
      `SELECT * FROM "CreditMoraExceptionRequest" WHERE "id"=$1::uuid FOR UPDATE`, id);
    const current = locked[0];
    if (!current) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
    if (current.version !== input.version)
      throw new CreditApprovalError("MORA_REQUEST_CHANGED", "La solicitud cambió. Actualiza antes de continuar.", 409);
    if (!["PENDING", "APPROVED"].includes(current.status))
      throw new CreditApprovalError("MORA_REQUEST_TERMINAL", "La solicitud ya fue cerrada. Su historial se conserva; registra una nueva excepción si es necesario.", 409);
    const before = amendmentSnapshot(current);
    const nextVersion = current.version + 1;
    let nextStatus: ExceptionStatus = current.status;
    if (input.action === "CANCEL") {
      nextStatus = "CANCELLED";
      await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "status"='CANCELLED',"version"=$2,
        "decidedByUserId"=COALESCE("decidedByUserId",$3),"decidedByName"=COALESCE("decidedByName",$4),
        "decidedAt"=COALESCE("decidedAt",CURRENT_TIMESTAMP),"decisionReason"=COALESCE("decisionReason",$5),
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`, id, nextVersion, verified.id, verified.nombre, input.auditReason);
    } else {
      const promiseAmount = input.promiseAmount === undefined
        ? current.promiseAmount === null ? null : Number(current.promiseAmount) : input.promiseAmount;
      const promiseDate = input.promiseDate === undefined ? nullableDateKey(current.promiseDate) : input.promiseDate;
      if (current.source === "CENTRAL_DIRECT" && (promiseAmount !== null || promiseDate !== null))
        throw invalid("Esta excepción directa no tiene un compromiso de pago asociado.");
      if (current.source !== "CENTRAL_DIRECT" && (input.expiresOn === null || promiseAmount === null || promiseDate === null))
        throw invalid("Conserva una fecha de vencimiento y un compromiso válido para esta solicitud.");
      if (promiseDate !== null && input.expiresOn !== null && promiseDate > input.expiresOn)
        throw invalid("El compromiso de pago debe vencer a más tardar con la excepción.");
      if (current.status === "APPROVED" && input.expiresOn !== null && input.expiresOn < colombiaDateKey(now)) nextStatus = "EXPIRED";
      await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"=$2::date,"reason"=$3,"observation"=$4,
        "promiseAmount"=$5,"promiseDate"=$6::date,"version"=$7,"status"=$8,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,
      id, input.expiresOn, input.reason, input.observation, promiseAmount, promiseDate, nextVersion, nextStatus);
    }
    const rows = await db.$queryRawUnsafe<StoredRequest[]>(`SELECT ${requestColumns}${requestFrom} WHERE r."id"=$1::uuid`, id);
    const after = amendmentSnapshot(rows[0]);
    const affectsMora = current.status === "APPROVED";
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"
      ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","idempotencyKey","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::uuid,$12)`,
    randomUUID(), id, current.creditoId, nextVersion, input.action === "EDIT" ? "EDITED" : "CANCELLED",
    current.status, nextStatus, JSON.stringify({ auditReason: input.auditReason, before, after, affectsMora }),
    verified.id, verified.nombre, input.idempotencyKey, requestHash);
    return { item: requestDto(rows[0], now), unchanged: false, affectsMora };
  }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 45_000 });
}

export async function getActiveMoraExceptionsByCreditIds(ids: number[], effectiveAt = new Date(), db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma) {
  const selected=[...new Set(ids.filter(id=>Number.isSafeInteger(id)&&id>0))];
  if(!selected.length)return new Map<number,{fechaFin:Date|null;type:ExceptionType}>();
  await ensureMoraExceptionRequestSchema();
  const rows=await db.$queryRawUnsafe<Array<{creditoId:number;type:ExceptionType;expiresOn:Date|string|null}>>(`SELECT DISTINCT ON ("creditoId")
    "creditoId","type","expiresOn" FROM "CreditMoraExceptionRequest"
    WHERE "creditoId"=ANY($1::integer[]) AND "status"='APPROVED' AND ("expiresOn" IS NULL OR "expiresOn">=$2::date)
    ORDER BY "creditoId","expiresOn" DESC,"id" DESC`,selected,colombiaDateKey(effectiveAt));
  return new Map(rows.map(row=>[row.creditoId,{fechaFin:row.expiresOn===null?null:endOfColombiaDay(toDateKey(row.expiresOn)),type:row.type}]));
}

export async function getActiveMoraExceptionByCreditId(id: number, effectiveAt = new Date()) {
  return (await getActiveMoraExceptionsByCreditIds([id],effectiveAt)).get(id)||null;
}
