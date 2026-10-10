import "server-only";

import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { getAnalystRequestCorrection } from "@/lib/approval-request-correction";
import {
  applyRequestDataCorrection, correctionRecord, requestDataValues, RequestDataCorrectionError,
  REQUEST_CORRECTION_FIELDS, requestDataRevision, type RequestDataCorrectionInput,
} from "@/lib/approval-request-correction-core";
import { refreshFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import { isVerifiedPendingSignatureStatus, isVerifiedTerminalSignatureFailure } from "@/lib/approval-operations-core";
import { isFirmaSeguroVerifiedCompletedStatus } from "@/lib/firmaseguro-status";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { buildFrozenDraftClientCorrection } from "@/lib/firmaseguro-draft-client-correction-frozen";
import { buildFirmaSeguroCreditPdf } from "@/lib/firmaseguro-folio-pdf";
import {
  dispatchReservedDraft, finalizeDraftDispatch, getDraftDispatch, getDraftDispatchReceipt,
  reserveDraftDispatch, type DraftDispatchRow,
} from "@/lib/firmaseguro-draft-dispatch-ledger";

type Actor = { id: number; nombre: string };
type Draft = {
  id: number; estado: string; creditoId: number | null; currentStep: number;
  clienteNombre: string | null; clienteDocumento: string | null; clienteTelefono: string | null;
  payload: unknown; usuarioNombre: string | null; usuarioLogin: string | null;
  vendedorId: number | null; vendedorNombre: string | null; vendedorDocumento: string | null;
  vendedorTelefono: string | null; vendedorEmail: string | null; sedeNombre: string | null;
  sedeCodigo: string | null; sedeAliadoId: number | null;
};

function intent(input: RequestDataCorrectionInput) {
  return createHash("sha256").update(JSON.stringify({ version: 1,
    values: Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b)),
    expectedValues: Object.entries(input.expectedValues).sort(([a], [b]) => a.localeCompare(b)),
    expectedRevision: input.expectedRevision,
  })).digest("hex");
}

async function outcome(id: number, row: DraftDispatchRow) {
  const state = await getAnalystRequestCorrection(id);
  const audits = await prisma.$queryRawUnsafe<Array<{ saved: boolean }>>(`SELECT EXISTS(
    SELECT 1 FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid AND "targetKind"='DRAFT'
      AND "targetId"=$2 AND "eventType"='CONTACT_UPDATED' AND "status"='PENDING_REISSUE') AS "saved"`, row.id, id);
  const saved = audits[0]?.saved === true;
  const message = row.status === "AWAITING_SIGNATURE"
    ? "Datos corregidos y nueva firma enviada. Esperando la firma del cliente."
    : row.status === "FAILED_SAFE"
      ? saved ? "Los datos se corrigieron, pero no se envió la firma. Revisa su estado antes de intentar otra vez."
        : "No se enviaron ni guardaron los cambios. Actualiza los datos y revisa el problema antes de intentar otra vez."
      : row.status === "UNCERTAIN"
        ? "No se confirmó el resultado del envío. Consulta Gestionar firma; no repitas la solicitud."
        : "La nueva firma se está preparando o enviando. Consulta su estado antes de continuar.";
  return { ...state, signature: { id: row.id, status: row.status, saved, message,
    processUuid: row.processUuid } };
}

async function resume(row: DraftDispatchRow) {
  try {
    if (row.status === "PREPARING") return await dispatchReservedDraft(row.id);
    if (["DISPATCHING", "UNCERTAIN"].includes(row.status) && await getDraftDispatchReceipt(row.id))
      return await finalizeDraftDispatch(row.id);
    return row;
  } catch (error) {
    // A persisted operation is the result even if the provider response was lost.
    const latest = await getDraftDispatch(row.id);
    if (latest && latest.status !== "PREPARING") return latest;
    throw error;
  }
}

/** Correct the nominal analyst's client data and prepare the new contract from its existing seal. */
export async function correctAndReissueAnalystRequestData(id: number, input: RequestDataCorrectionInput, actor: Actor,
  options: { retryOnly?: boolean } = {}) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !actor.nombre.trim())
    throw new RequestDataCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  if (!input.idempotencyKey || !input.expectedProcessUuid || input.confirmed !== true)
    throw new RequestDataCorrectionError("CONFIRM_NEW_SIGNATURE", "Confirma la corrección y el envío de la nueva firma.", 400);
  const fingerprint = intent(input);
  const replay = await getDraftDispatch(input.idempotencyKey);
  if (replay) {
    const marker = correctionRecord(replay.updatedPayload);
    if (replay.draftId !== id || replay.actorUserId !== actor.id || replay.reason !== input.reason ||
      replay.expectedProcessUuid !== input.expectedProcessUuid || marker.firmaSeguroClientCorrectionId !== replay.id ||
      marker.firmaSeguroClientCorrectionIntentSha256 !== fingerprint)
      throw new RequestDataCorrectionError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otra corrección.");
    return outcome(id, await resume(replay));
  }
  const state = await getAnalystRequestCorrection(id);
  if (!state.editableFields.length || !state.requiresNewSignature)
    throw new RequestDataCorrectionError("REQUEST_LOCKED", state.reason || "Actualiza la solicitud antes de corregir el contrato.");
  if (state.expectedProcessUuid !== input.expectedProcessUuid)
    throw new RequestDataCorrectionError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
  const drafts = await prisma.$queryRawUnsafe<Draft[]>(`SELECT draft."id",draft."estado",draft."creditoId",
    draft."currentStep",draft."clienteNombre",draft."clienteDocumento",draft."clienteTelefono",draft."payload",
    creator."nombre" AS "usuarioNombre",creator."usuario" AS "usuarioLogin",
    seller."id" AS "vendedorId",seller."nombre" AS "vendedorNombre",seller."documento" AS "vendedorDocumento",
    seller."telefono" AS "vendedorTelefono",seller."email" AS "vendedorEmail",
    site."nombre" AS "sedeNombre",site."codigo" AS "sedeCodigo",site."aliadoId" AS "sedeAliadoId"
    FROM "CreditoBorrador" draft LEFT JOIN "Usuario" creator ON creator."id"=draft."usuarioId"
    LEFT JOIN "Vendedor" seller ON seller."id"=draft."vendedorId" LEFT JOIN "Sede" site ON site."id"=draft."sedeId"
    WHERE draft."id"=$1 AND draft."estado"='ABIERTO' AND draft."creditoId" IS NULL
      AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP`, id);
  const draft = drafts[0];
  if (!draft || ![3, 4, 5].includes(draft.currentStep))
    throw new RequestDataCorrectionError("REQUEST_LOCKED", "La solicitud ya no está abierta en Identidad y firma.");
  const stored = correctionRecord(draft.payload);
  const payload: Record<string, unknown> = { ...stored, clienteNombre: draft.clienteNombre ?? stored.clienteNombre,
    clienteTelefono: draft.clienteTelefono ?? stored.clienteTelefono,
    clienteDocumento: draft.clienteDocumento ?? stored.clienteDocumento };
  let correction: ReturnType<typeof applyRequestDataCorrection>;
  if (options.retryOnly) {
    if (payload.firmaSeguroClientCorrectionPending !== true)
      throw new RequestDataCorrectionError("CORRECTION_NOT_PENDING", "No hay una corrección pendiente por reenviar.");
    const revision = requestDataRevision(payload) + 1;
    correction = { payload: { ...payload, analystDataRevision: revision,
      analystDataCorrection: { ...correctionRecord(payload.analystDataCorrection), revision,
        updatedAt: new Date().toISOString(), actorName: actor.nombre } }, before: {}, after: {}, revision };
  } else correction = applyRequestDataCorrection(payload, input, state.editableFields, actor.nombre,
    new Date(), { preserveIdentityEvidence: true });
  const processes = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(`SELECT * FROM "FirmaSeguroProcess"
    WHERE "draftId"=$1 AND "creditoId" IS NULL AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC`, id);
  let source = processes.length === 1 ? processes[0] : null;
  if (!source || source.processUuid !== input.expectedProcessUuid)
    throw new RequestDataCorrectionError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
  if (!source.completedAt || !source.signedDocumentBase64) {
    try { source = await refreshFirmaSeguroProcess(source); }
    catch { throw new RequestDataCorrectionError("SIGNATURE_REFRESH_FAILED",
      "No se pudo consultar el estado real de FirmaSeguro. Actualiza la solicitud e intenta de nuevo.", 502); }
  }
  if (!source || source.supersededAt || source.processUuid !== input.expectedProcessUuid)
    throw new RequestDataCorrectionError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
  const sourceSigned = Boolean(source.completedAt && source.signedDocumentBase64 &&
    Buffer.from(source.signedDocumentBase64, "base64").subarray(0, 5).toString() === "%PDF-" &&
    isFirmaSeguroVerifiedCompletedStatus(source.status));
  const terminal = isVerifiedTerminalSignatureFailure(source.status);
  const pending = isVerifiedPendingSignatureStatus(source.status);
  if (options.retryOnly && (!terminal || sourceSigned))
    throw new RequestDataCorrectionError("SIGNATURE_NOT_FAILED", "La firma no tiene un fallo definitivo confirmado. Consulta su estado antes de reenviar.");
  if (!sourceSigned && (source.completedAt || source.signedDocumentBase64 || (!terminal && !pending) ||
    (source.lastError && !terminal)))
    throw new RequestDataCorrectionError("SIGNATURE_NOT_VERIFIED", "El estado de la firma requiere revisión antes de corregir el contrato.");
  const sourceSeal = readFinancingTermsSeal(correctionRecord(source.draftPayload).financialTermsSeal);
  if (!sourceSeal) throw new RequestDataCorrectionError("CONTRACT_NOT_VERIFIED",
    "No se pudieron verificar los valores del contrato. Requiere revisión técnica.");
  const lineage = { correlationId: input.idempotencyKey, draftId: id,
    previousProcessUuid: source.processUuid, sourceSealChecksum: sourceSeal.checksum,
    before: requestDataValues(payload), after: requestDataValues(correction.payload) };
  let frozen: ReturnType<typeof buildFrozenDraftClientCorrection>;
  try { frozen = buildFrozenDraftClientCorrection({ draft: { ...draft, payload: correction.payload }, source, correction: lineage }); }
  catch { throw new RequestDataCorrectionError("CONTRACT_NOT_VERIFIED",
    "El contrato y la solicitud no coinciden. Actualiza el expediente antes de corregir."); }
  const updatedPayload = { ...correction.payload, wizardStep: 4, financialTermsSeal: frozen.seal,
    entregaValidada: false, deliverableReady: false,
    firmaSeguroClientCorrectionPending: true, firmaSeguroClientCorrectionId: input.idempotencyKey,
    firmaSeguroClientCorrectionSourceProcessUuid: source.processUuid,
    firmaSeguroClientCorrectionSourceChecksum: sourceSeal.checksum,
    firmaSeguroClientCorrectionSourceSigned: sourceSigned,
    firmaSeguroClientCorrectionIntentSha256: fingerprint };
  const document = await buildFirmaSeguroCreditPdf(frozen.credit);
  if (document.length > 32 * 1024 * 1024 || document.subarray(0, 5).toString() !== "%PDF-")
    throw new RequestDataCorrectionError("CONTRACT_DOCUMENT_INVALID", "No se pudo generar el contrato corregido.");
  const draftPayload: Record<string, unknown> = { ...updatedPayload,
    firmaSeguroFrozenClientCorrectionSource: frozen.frozenClientCorrectionSource };
  delete draftPayload.firmaSeguroIdentity;
  delete draftPayload.firmaSeguroContractNameVersion;
  const signingSnapshot = correctionRecord(frozen.credit.contratoSnapshot);
  if (signingSnapshot.firmaSeguroContractNameVersion === 1 && signingSnapshot.firmaSeguroIdentity) {
    draftPayload.firmaSeguroIdentity = signingSnapshot.firmaSeguroIdentity;
    draftPayload.firmaSeguroContractNameVersion = 1;
  }
  const reserved = await reserveDraftDispatch({ id: input.idempotencyKey, draftId: id, actor,
    reason: input.reason, expectedProcessUuid: source.processUuid, sourcePayload: draft.payload,
    updatedPayload, draftPayload,
    draftFolio: frozen.credit.folio, frozenCredit: frozen.credit, document, supersedeActive: true });
  return outcome(id, await resume(reserved));
}

/** Retry the corrected document only after an authoritative terminal provider failure. */
export async function retryAnalystRequestClientSignature(id: number, input: {
  idempotencyKey: string; expectedProcessUuid: string | null; reason: string;
}, actor: Actor) {
  const state = await getAnalystRequestCorrection(id);
  const replay = await getDraftDispatch(input.idempotencyKey);
  const baseline = replay ? requestDataValues(correctionRecord(replay.sourcePayload)) : state.values;
  const revision = replay ? requestDataRevision(correctionRecord(replay.sourcePayload)) : state.revision;
  const values = Object.fromEntries(REQUEST_CORRECTION_FIELDS.map(field => [field, baseline[field] || ""]));
  const result = await correctAndReissueAnalystRequestData(id, { values, expectedValues: values,
    expectedRevision: revision, expectedProcessUuid: input.expectedProcessUuid,
    idempotencyKey: input.idempotencyKey, reason: input.reason, confirmed: true }, actor, { retryOnly: true });
  return result.signature;
}
