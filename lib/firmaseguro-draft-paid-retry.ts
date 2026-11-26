import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { ensureDraftAdministrativeRecoverySchema } from "@/lib/firmaseguro-draft-administration";
import { DraftDispatchError, type DraftDispatchRow } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { resolveActivationFirstPaymentDate } from "@/lib/credit-factory";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { isVeriffRequired } from "@/lib/veriff";
import { isVeriffApproved, type VeriffValidationRow } from "@/lib/veriff-storage";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { assertFirmaSeguroDispatchBalance, firmaSeguroSignIn, getFirmaSeguroConfig } from "@/lib/firmaseguro";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMERCIAL_REASON = "Envío del contrato de la solicitud a FirmaSeguro";
// Eligibility describes the two observed errors, never proof of remote absence.
export const PAID_DRAFT_RETRY_BALANCE_ERROR = "provider_dispatch [UNKNOWN]: Ocurrió un error: No posees saldo suficiente para realizar la operación. Firma seguro method -> Firma Electrónica Certificada - OTP Whatsapp, balanceType -> 2 (HTTP 500 en /api/v2/Process/create-full)";
type Db = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;
type FrozenDispatch = DraftDispatchRow & { fingerprint: string; dispatchedAt: unknown; acknowledgedAt: unknown };
type Recovery = { originalDispatchId: string; replacementDispatchId: string; documentHash: string; sealChecksum: string; originalFingerprint: string };
type PaidAuthorization = { originalDispatchId: string; replacementDispatchId: string; firstOriginalDispatchId: string;
  actorUserId: number; actorName: string; reason: string; authorizationFingerprint: string; status: string };

export type AuthorizedPaidDraftRetryInput = {
  draftId: number; dispatchId: string; actor: { id: number; nombre: string }; reason: string;
  providerReviewConfirmed: boolean; remoteOutcomeUnknownAccepted: boolean; newChargeAccepted: boolean;
  expectedFingerprint?: string;
};
export type AuthorizedPaidDraftRetryPlan = {
  draftId: number; originalDispatchId: string; firstOriginalDispatchId: string;
  replacementDispatchId: string | null; status: string; idempotent: boolean; expectedFingerprint: string;
};
function fail(code: string, message: string): never {
  throw new DraftDispatchError("DRAFT_PAID_RETRY_" + code, message);
}
function validate(input: AuthorizedPaidDraftRetryInput) {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!Number.isSafeInteger(input.draftId) || input.draftId < 1 || !UUID.test(input.dispatchId)
    || !Number.isSafeInteger(input.actor?.id) || input.actor.id < 1 || typeof input.actor.nombre !== "string" || !input.actor.nombre.trim()
    || input.actor.nombre.length > 250 || reason.length < 20 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)
    || input.providerReviewConfirmed !== true || input.remoteOutcomeUnknownAccepted !== true || input.newChargeAccepted !== true
    || (input.expectedFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedFingerprint))) {
    fail("INVALID", "Confirma la revisión del proveedor, el resultado aún incierto y el posible nuevo cobro, con un motivo de 20 a 500 caracteres.");
  }
  return { ...input, reason, actor: { id: input.actor.id, nombre: input.actor.nombre.trim() } };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const digits = (value: unknown) => String(value || "").replace(/\D/g, "");

async function readState(db: Db, input: ReturnType<typeof validate>, locked: boolean) {
  const actors = await db.$queryRawUnsafe<Array<{ nombre: string; role: string; ally: string }>>(
    `SELECT u."nombre",r."nombre" AS role,a."codigo" AS ally FROM "Usuario" u
     JOIN "Rol" r ON r."id"=u."rolId" JOIN "Sede" s ON s."id"=u."sedeId"
     JOIN "Aliado" a ON a."id"=s."aliadoId" WHERE u."id"=$1 AND u."activo" AND s."activa" AND a."activo"
     ${locked ? "FOR SHARE OF u,r,s,a" : ""}`, input.actor.id);
  if (actors.length !== 1 || !isAdminRole(actors[0].role) || !isFinserPayCentralAlly(actors[0].ally)
    || actors[0].nombre.trim() !== input.actor.nombre) fail("ACTOR_FORBIDDEN", "La autorización requiere al administrador central activo de la sesión.");
  const tables = await db.$queryRawUnsafe<Array<{ basePresent: boolean; paidPresent: boolean }>>(
    `SELECT to_regclass('public."FirmaSeguroDraftAdministrativeRecovery"') IS NOT NULL AS "basePresent",
      to_regclass('public."FirmaSeguroDraftPaidRetryAuthorization"') IS NOT NULL AS "paidPresent"`);
  if (!tables[0]?.basePresent) fail("SCHEMA_REQUIRED", "No existe la recuperación administrativa previa que requiere esta autorización.");
  const prior = await db.$queryRawUnsafe<Recovery[]>(
    `SELECT * FROM "FirmaSeguroDraftAdministrativeRecovery" WHERE "draftId"=$1`, input.draftId);
  if (prior.length !== 1 || prior[0].replacementDispatchId !== input.dispatchId)
    fail("LINEAGE_INVALID", "El envío no es el único reemplazo de la recuperación administrativa original.");
  const recovery = prior[0];
  const paid = tables[0].paidPresent ? await db.$queryRawUnsafe<PaidAuthorization[]>(
    `SELECT permission.*,dispatch."status" FROM "FirmaSeguroDraftPaidRetryAuthorization" permission
     JOIN "FirmaSeguroDraftDispatch" dispatch ON dispatch."id"=permission."replacementDispatchId"
     WHERE permission."draftId"=$1`, input.draftId) : [];
  if (paid.length) {
    const previous = paid[0];
    if (paid.length !== 1 || previous.originalDispatchId !== input.dispatchId
      || previous.firstOriginalDispatchId !== recovery.originalDispatchId || previous.actorUserId !== input.actor.id
      || previous.actorName !== input.actor.nombre || previous.reason !== input.reason)
      fail("REPLAY_CONFLICT", "El reintento con posible cobro ya fue autorizado con otra confirmación.");
    const plan: AuthorizedPaidDraftRetryPlan = { draftId: input.draftId, originalDispatchId: input.dispatchId,
      firstOriginalDispatchId: recovery.originalDispatchId, replacementDispatchId: previous.replacementDispatchId,
      status: previous.status, idempotent: true, expectedFingerprint: previous.authorizationFingerprint };
    if (input.expectedFingerprint && plan.expectedFingerprint !== input.expectedFingerprint)
      fail("PLAN_CHANGED", "La autorización cambió. Revisa de nuevo el expediente.");
    return { plan, leaf: null, sealChecksum: recovery.sealChecksum };
  }
  const dispatches = await db.$queryRawUnsafe<FrozenDispatch[]>(
    `SELECT d.*,md5((to_jsonb(d)-'status'-'updatedAt')::text) AS fingerprint FROM "FirmaSeguroDraftDispatch" d
     WHERE d."draftId"=$1 ORDER BY d."id" ${locked ? "FOR UPDATE" : ""}`, input.draftId);
  const first = dispatches.find(row => row.id === recovery.originalDispatchId);
  const leaf = dispatches.find(row => row.id === input.dispatchId);
  if (dispatches.length !== 2 || !first || !leaf || first.status !== "ABANDONED" || leaf.status !== "UNCERTAIN"
    || [first, leaf].some(row => row.processUuid || row.expectedProcessUuid || row.acknowledgedAt || !row.dispatchedAt
      || row.reason !== COMMERCIAL_REASON || row.lastError !== PAID_DRAFT_RETRY_BALANCE_ERROR)
    || first.fingerprint !== recovery.originalFingerprint || first.documentHash !== recovery.documentHash
    || JSON.stringify(leaf.sourcePayload) !== JSON.stringify(first.updatedPayload)
    || ["draftFolio", "updatedPayload", "draftPayload", "frozenCredit", "documentBase64", "documentHash"]
      .some(key => JSON.stringify(first[key as keyof FrozenDispatch]) !== JSON.stringify(leaf[key as keyof FrozenDispatch])))
    fail("SOURCE_INVALID", "Los dos intentos previos no conservan el mismo contrato o su resultado requiere conciliación.");
  const evidence = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
    `SELECT EXISTS(SELECT 1 FROM "FirmaSeguroProcess" WHERE "draftId"=$1)
      OR EXISTS(SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" r JOIN "FirmaSeguroDraftDispatch" d ON d."id"=r."dispatchId" WHERE d."draftId"=$1)
      OR EXISTS(SELECT 1 FROM "FirmaSeguroDraftDispatchReconciliation" r JOIN "FirmaSeguroDraftDispatch" d ON d."id"=r."dispatchId" WHERE d."draftId"=$1)
      OR EXISTS(SELECT 1 FROM "FirmaSeguroDraftRecovery" WHERE "dispatchId" IN($2::uuid,$3::uuid)) AS blocked`,
    input.draftId, first.id, leaf.id);
  if (evidence[0]?.blocked !== false) fail("EVIDENCE_CHANGED", "Existe un proceso, comprobante o resultado del proveedor que debe conciliarse antes de otro envío.");
  const drafts = await db.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(
    `SELECT "payload" FROM "CreditoBorrador" WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
      AND "currentStep" IN(3,4) AND "payload"=$2::jsonb
      AND COALESCE("expiresAt","createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP ${locked ? "FOR UPDATE" : ""}`,
    input.draftId, JSON.stringify(leaf.updatedPayload));
  if (!drafts[0]) fail("DRAFT_CHANGED", "La solicitud cambió o venció. No se modificó su contrato.");
  const seal = readFinancingTermsSeal(object(leaf.draftPayload).financialTermsSeal);
  const pdf = Buffer.from(leaf.documentBase64, "base64");
  const document = digits(drafts[0].payload.clienteDocumento);
  if (!seal || seal.checksum !== recovery.sealChecksum || seal.snapshot.folio !== leaf.draftFolio
    || !document || document !== digits(seal.snapshot.documento) || document !== digits(leaf.frozenCredit.clienteDocumento)
    || pdf.subarray(0, 5).toString() !== "%PDF-" || createHash("sha256").update(pdf).digest("hex") !== leaf.documentHash
    || resolveActivationFirstPaymentDate({ frequency: seal.snapshot.frecuenciaPago, activatedAt: new Date() }).dateKey !== seal.snapshot.fechaPrimerPago)
    fail("CONTRACT_INVALID", "La integridad, identidad o fecha del contrato reservado requiere revisión.");
  if (getDataCreditoPublicConfig().enabled || isVeriffRequired()) {
    const validationId = Number(drafts[0].payload.veriffValidationId || 0);
    const validations = await db.$queryRawUnsafe<VeriffValidationRow[]>(
      `SELECT * FROM "VeriffIdentityValidation" WHERE "draftId"=$1 AND "creditoId" IS NULL ORDER BY "id" DESC LIMIT 1 ${locked ? "FOR SHARE" : ""}`,
      input.draftId);
    if (!Number.isSafeInteger(validationId) || validationId < 1 || validations[0]?.id !== validationId
      || !isVeriffApproved(validations[0]) || digits(validations[0].clienteDocumento) !== document)
      fail("IDENTITY_CHANGED", "La validación de identidad vigente no corresponde al contrato reservado.");
  }
  const expectedFingerprint = createHash("sha256").update(JSON.stringify({ draftId: input.draftId,
    originalDispatchId: leaf.id, firstOriginalDispatchId: first.id, originalFingerprint: leaf.fingerprint,
    firstOriginalFingerprint: first.fingerprint, documentHash: leaf.documentHash, sealChecksum: seal.checksum,
    actor: input.actor, reason: input.reason, providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true, newChargeAccepted: true })).digest("hex");
  if (input.expectedFingerprint && input.expectedFingerprint !== expectedFingerprint)
    fail("PLAN_CHANGED", "El expediente cambió desde la verificación. Revisa de nuevo antes de autorizar.");
  return { plan: { draftId: input.draftId, originalDispatchId: leaf.id, firstOriginalDispatchId: first.id,
    replacementDispatchId: null, status: "ELIGIBLE", idempotent: false, expectedFingerprint } satisfies AuthorizedPaidDraftRetryPlan,
  leaf, sealChecksum: seal.checksum };
}

async function verifyPositiveBalance() {
  const config = getFirmaSeguroConfig();
  if (config.balanceTypeId !== 2 || config.signatureMethodId !== 2)
    fail("CONFIG_CHANGED", "La configuración de firma cambió respecto de los intentos revisados.");
  const auth = await firmaSeguroSignIn();
  await assertFirmaSeguroDispatchBalance(auth.token, config);
  return { balanceVerifiedAt: new Date(), balanceTypeId: config.balanceTypeId, signatureMethodId: config.signatureMethodId };
}

/** No schema installation, transactions, writes or contract creation POSTs. The result is
 * a reviewable authorization plan; an empty portal search never proves absence.
 */
export async function verifyAuthorizedPaidDraftRetry(raw: AuthorizedPaidDraftRetryInput): Promise<AuthorizedPaidDraftRetryPlan> {
  const input = validate(raw);
  const state = await readState(prisma, input, false);
  if (!state.plan.idempotent) await verifyPositiveBalance();
  return state.plan;
}

/** One additional explicitly authorized paid retry after the single original
 * recovery. Copies the frozen contract and returns PREPARING; never sends it.
 */
export async function reserveAuthorizedPaidDraftRetry(raw: AuthorizedPaidDraftRetryInput): Promise<AuthorizedPaidDraftRetryPlan> {
  const input = validate(raw);
  if (!input.expectedFingerprint) fail("PLAN_REQUIRED", "Verifica el expediente y conserva su huella antes de autorizar el reintento.");
  const before = await readState(prisma, input, false);
  if (before.plan.idempotent) return before.plan;
  const balance = await verifyPositiveBalance();
  await ensureDraftAdministrativeRecoverySchema();
  return prisma.$transaction(async db => {
    await lockSolicitudOperationMutation(db, input.draftId);
    const state = await readState(db, input, true);
    if (state.plan.idempotent) return state.plan;
    const leaf = state.leaf!;
    if (Date.now() - balance.balanceVerifiedAt.getTime() > 60_000)
      fail("BALANCE_STALE", "Actualiza la verificación de cupo antes de autorizar.");
    const replacementDispatchId = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftPaidRetryAuthorization"
      ("originalDispatchId","replacementDispatchId","firstOriginalDispatchId","draftId","actorUserId","actorName","reason",
       "providerReviewConfirmed","remoteOutcomeUnknownAccepted","newChargeAccepted","originalFingerprint","firstOriginalFingerprint",
       "authorizationFingerprint","documentHash","sealChecksum","balancePositiveConfirmed","balanceVerifiedAt","balanceTypeId","signatureMethodId")
      SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,true,true,true,$8,
       md5((to_jsonb(original)-'status'-'updatedAt')::text),$9,$10,$11,true,$12,$13,$14
      FROM "FirmaSeguroDraftDispatch" original WHERE original."id"=$3::uuid`, leaf.id, replacementDispatchId,
    state.plan.firstOriginalDispatchId, input.draftId, input.actor.id, input.actor.nombre, input.reason, leaf.fingerprint,
    state.plan.expectedFingerprint, leaf.documentHash, state.sealChecksum, balance.balanceVerifiedAt, balance.balanceTypeId, balance.signatureMethodId);
    await db.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='ABANDONED',"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "status"='UNCERTAIN'`, leaf.id);
    await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftDispatch"
      ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status","draftFolio",
       "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
      SELECT $2::uuid,"draftId",$3,$4,$5,NULL,'PREPARING',"draftFolio",
       "updatedPayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"
      FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid`, leaf.id, replacementDispatchId,
    input.actor.id, input.actor.nombre, COMMERCIAL_REASON);
    return { ...state.plan, replacementDispatchId, status: "PREPARING", idempotent: false };
  }, { timeout: 15000 });
}
