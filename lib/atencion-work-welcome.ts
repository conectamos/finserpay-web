import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { attentionWorkStore, type AttentionWorkWorkflowContext, type createAttentionWorkStore } from "./atencion-work-storage";
import type { AttentionWorkActor } from "./atencion-work-types";
import { getCreditApprovalDetail, CreditApprovalError, type ApprovalDatabase } from "./credit-approval";
import { saveCreditApprovalCall, readCreditApprovalCallBytes } from "./credit-approval-call-store";
import { createCreditWelcomeVoiceStore, ensureCreditWelcomeVoiceSchema, CreditWelcomeVoiceStoreError, type VoiceDispatchClaim, type VoiceCallRecord } from "./credit-welcome-voice-store";
import { dispatchCreditWelcomeVoice, getCreditWelcomeVoiceConfig } from "./credit-welcome-voice-dispatch";
import { normalizeManualVoicePhone } from "./credit-welcome-voice-phone";
import { attentionWelcomeOutcomes, type AttentionWelcomeOutcome, type AttentionWelcomeView, type AttentionWelcomeRecordingDetail } from "./atencion-work-welcome-types";

type WorkStore = Pick<ReturnType<typeof createAttentionWorkStore>, "workflowRead" | "workflowMutate">;
type DomainDetail = Awaited<ReturnType<typeof getCreditApprovalDetail>>;
type RecordingInput = Parameters<typeof saveCreditApprovalCall>[2];
type VoiceStore = Pick<ReturnType<typeof createCreditWelcomeVoiceStore>, "listCreditWelcomeVoiceCallsForCredit" | "getCreditWelcomeVoiceOperatorAvailability" | "getCreditWelcomeVoiceOperatorRequest" | "prepareCreditWelcomeVoiceOperatorCall" | "prepareCreditWelcomeVoiceDispatch" | "creditWelcomeVoiceEvidenceIsCurrent">;
export type AttentionWelcomeDependencies = {
  work: WorkStore; ensure: () => Promise<void>; configured: () => boolean;
  detail: (context: AttentionWorkWorkflowContext) => Promise<DomainDetail>;
  voice: (context: AttentionWorkWorkflowContext) => VoiceStore;
  saveRecording: (context: AttentionWorkWorkflowContext, input: RecordingInput) => ReturnType<typeof saveCreditApprovalCall>;
  recordingBytes: (context: AttentionWorkWorkflowContext, recordingId: string) => ReturnType<typeof readCreditApprovalCallBytes>;
  dispatch: (claim: VoiceDispatchClaim, prepare: (eventId: string) => Promise<VoiceDispatchClaim | null>) => Promise<unknown>;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actor = (context: AttentionWorkWorkflowContext) => ({ id: context.actor.userId, nombre: context.actor.name });
function contextHash(context: AttentionWorkWorkflowContext, detail: DomainDetail) {
  return hash({ workId: context.work.id, creditId: detail.id, name: detail.clienteNombre, document: detail.clienteDocumento,
    imei: detail.imei, phone: detail.clienteTelefono, revision: detail.review.revision, reviewHash: detail.review.reviewHash });
}
function assertContext(context: AttentionWorkWorkflowContext, detail: DomainDetail, supplied: unknown) {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) || supplied !== contextHash(context, detail))
    throw new AttentionError("El cliente, teléfono o expediente cambió. Actualiza la bienvenida antes de continuar.", 409);
}
function assertMode(context: AttentionWorkWorkflowContext, mode: "human" | "dapta") {
  if (context.work.callMode !== mode) throw new AttentionError("La modalidad de la bienvenida cambió. Actualiza la solicitud.", 409);
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new AttentionError("La gestión contiene campos no admitidos.");
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AttentionError("Actualiza la versión de la solicitud.");
  return Number(value);
}
function review(body: Record<string, unknown>, detail: DomainDetail) {
  if (body.revision !== detail.review.revision || body.reviewHash !== detail.review.reviewHash)
    throw new AttentionError("La revisión del crédito cambió. Actualiza antes de guardar el resultado.", 409);
}
function recordingProjection(context: AttentionWorkWorkflowContext, detail: DomainDetail): AttentionWelcomeRecordingDetail {
  const recording = detail.callRecording.recording;
  return { id: detail.id, clienteTelefono: detail.clienteTelefono, review: { ...detail.review, status: detail.review.status as AttentionWelcomeRecordingDetail["review"]["status"] },
    callRecording: { ...detail.callRecording, canUpload: context.work.state !== "completed" && detail.callRecording.canUpload,
      recording: recording ? { ...recording, href: `/api/atencion/solicitudes/${context.work.id}/bienvenida/grabaciones/${recording.id}` } : null } };
}
function voiceCompleted(call: VoiceCallRecord | undefined, outcome: AttentionWelcomeOutcome) {
  if (!call || call.status !== "COMPLETED" || !call.providerCallId || !call.completedAt || call.source === "CONTROLLED_TEST" ||
      !Object.hasOwn(attentionWelcomeOutcomes, call.communicationOutcome || "") || call.communicationOutcome !== outcome)
    throw new AttentionError("Selecciona un resultado confirmado de Dapta. Una llamada pendiente o por confirmar no permite finalizar la bienvenida.", 409);
}

export function createAttentionWorkWelcome(deps: AttentionWelcomeDependencies) {
  async function read(a: AttentionWorkActor, id: string): Promise<AttentionWelcomeView> {
    await deps.ensure();
    return deps.work.workflowRead(a, id, "welcome", async context => {
      const detail = await deps.detail(context), voiceItems = await deps.voice(context).listCreditWelcomeVoiceCallsForCredit(context.work.targetId);
      return { ok: true, detail: recordingProjection(context, detail), workVersion: context.work.version, callMode: context.work.callMode, contextHash: contextHash(context, detail), voiceItems };
    });
  }
  async function voices(a: AttentionWorkActor, id: string, requestId?: string) {
    if (requestId !== undefined) attentionUuid(requestId);
    await deps.ensure();
    return deps.work.workflowRead(a, id, "welcome", async context => {
      const voice = deps.voice(context), detail = await deps.detail(context), items = await voice.listCreditWelcomeVoiceCallsForCredit(context.work.targetId);
      const manualCall = deps.configured() && context.work.state !== "completed" && context.work.callMode === "dapta"
        ? await voice.getCreditWelcomeVoiceOperatorAvailability(context.work.targetId)
        : { canCall: false, phone: detail.clienteTelefono, reason: context.work.state === "completed" ? "La solicitud está finalizada." : context.work.callMode !== "dapta" ? "Selecciona Agente de voz Dapta para solicitar una llamada." : "Las llamadas de bienvenida no están disponibles en este momento." };
      let request: { requestId: string; found: boolean; eventId?: string; status?: string } | undefined;
      if (requestId) {
        const [bound] = await context.db.$queryRawUnsafe<{ eventId: string }[]>(`SELECT metadata->'result'->>'eventId' AS "eventId" FROM "AttentionAudit" WHERE "conversationId"=$1::uuid AND "actorKey"=$2 AND action='WORK_WORKFLOW' AND metadata->>'requestId'=$3 AND metadata->'result'->>'action'='VOICE_REQUEST' LIMIT 1`, context.work.conversationId, context.actor.key, requestId);
        const linked = bound ? items.find(item => item.id === bound.eventId) : null;
        request = linked ? { requestId, found: true, eventId: linked.id, status: linked.status } : { requestId, found: false };
      }
      return { ok: true, items, total: items.length, manualCall, ...(request ? { request } : {}), workVersion: context.work.version, contextHash: contextHash(context, detail) };
    });
  }
  async function call(a: AttentionWorkActor, id: string, body: Record<string, unknown>) {
    let committed = false;
    try {
    fields(body, ["requestId", "version", "contextHash", "phone"]);
    const requestId = attentionUuid(body.requestId), expectedVersion = version(body.version);
    const phone = body.phone === undefined ? undefined : normalizeManualVoicePhone(body.phone);
    if (body.phone !== undefined && !phone) throw new AttentionError("Número de llamada inválido.");
    if (!deps.configured()) throw new AttentionError("Las llamadas de bienvenida no están disponibles en este momento.", 503);
    await deps.ensure();
    let dispatchClaim: VoiceDispatchClaim | null = null;
    const saved = await deps.work.workflowMutate(a, id, "welcome", { requestId, version: expectedVersion, action: "VOICE_REQUEST", contextHash: body.contextHash, ...(phone ? { phone } : {}) }, async context => {
      assertMode(context, "dapta");
      const prepared = await deps.voice(context).prepareCreditWelcomeVoiceOperatorCall({ creditId: context.work.targetId, requestId, actorId: context.actor.userId, ...(phone ? { phone } : {}) });
      const detail = await deps.detail(context); assertContext(context, detail, body.contextHash);
      if (prepared.created) dispatchClaim = prepared;
      return { result: { action: "VOICE_REQUEST", eventId: prepared.eventId, status: prepared.status }, summary: "Llamada de bienvenida solicitada al agente de voz Dapta. El resultado se confirmará en esta solicitud.", complete: false };
    });
    committed = true;
    if (dispatchClaim && !saved.alreadyApplied) {
      await deps.dispatch(dispatchClaim, eventId => deps.work.workflowRead(a, id, "welcome", async context => {
        if (context.work.state === "completed") return null;
        assertMode(context, "dapta");
        const prepared = await deps.voice(context).prepareCreditWelcomeVoiceDispatch(eventId);
        const detail = await deps.detail(context); assertContext(context, detail, body.contextHash);
        return prepared;
      }));
    }
    const fresh = await voices(a, id, requestId);
    return { ok: true, eventId: saved.result.eventId, status: fresh.request?.status || "UNKNOWN", workVersion: saved.detail.item.version, ...saved };
    } catch (error) {
      if (!committed && (error instanceof AttentionError || error instanceof CreditApprovalError || error instanceof CreditWelcomeVoiceStoreError)) Object.assign(error, { requestCreated: false });
      throw error;
    }
  }
  async function upload(a: AttentionWorkActor, id: string, input: RecordingInput, expectedVersion: number, suppliedContext: string) {
    await deps.ensure();
    const saved = await deps.work.workflowMutate(a, id, "welcome", { requestId: input.idempotencyKey, version: version(expectedVersion), action: "WELCOME_RECORDING", contextHash: suppliedContext,
      revision: input.revision, reviewHash: input.reviewHash, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256 }, async context => {
      assertMode(context, "human"); const detail = await deps.detail(context); assertContext(context, detail, suppliedContext);
      const result = await deps.saveRecording(context, input);
      return { result: { action: "WELCOME_RECORDING", recordingId: result.state.recording?.id || null }, summary: "El analista guardó la grabación de la llamada de bienvenida. La gestión continúa pendiente de registrar su resultado.", complete: false };
    });
    const current = await read(a, id);
    return { ok: true, state: current.detail.callRecording, unchanged: saved.alreadyApplied, ...saved };
  }
  async function finish(a: AttentionWorkActor, id: string, body: Record<string, unknown>) {
    fields(body, ["requestId", "version", "mode", "outcome", "observation", "recordingId", "voiceEventId", "revision", "reviewHash", "contextHash"]);
    const requestId = attentionUuid(body.requestId), expectedVersion = version(body.version), observation = attentionText(body.observation, 3000);
    if (body.mode !== "human" && body.mode !== "dapta") throw new AttentionError("Selecciona quién realizó la bienvenida.");
    if (typeof body.outcome !== "string" || !Object.hasOwn(attentionWelcomeOutcomes, body.outcome)) throw new AttentionError("Selecciona el resultado real de la llamada.");
    const mode = body.mode, outcome = body.outcome as AttentionWelcomeOutcome;
    const recordingId = body.recordingId === undefined ? undefined : attentionUuid(body.recordingId), voiceEventId = body.voiceEventId === undefined ? undefined : attentionUuid(body.voiceEventId);
    if ((mode === "human" && voiceEventId) || (mode === "dapta" && recordingId)) throw new AttentionError("La evidencia no corresponde a la modalidad elegida.");
    await deps.ensure();
    return deps.work.workflowMutate(a, id, "welcome", { ...body, requestId, version: expectedVersion, action: "WELCOME_RESULT", observation }, async context => {
      assertMode(context, mode); const detail = await deps.detail(context); assertContext(context, detail, body.contextHash); review(body, detail);
      if (mode === "human") {
        if (!detail.callRecording.available) throw new AttentionError("No se pudo verificar la grabación. Actualiza antes de continuar.", 503);
        if (recordingId && detail.callRecording.recording?.id !== recordingId) throw new AttentionError("La grabación cambió. Revisa la grabación vigente.", 409);
        if (outcome === "HUMAN_CONTACT" && detail.callRecording.required && (!recordingId || !detail.callRecording.recording))
          throw new AttentionError("Guarda y revisa la grabación de esta llamada antes de finalizar la bienvenida.", 409);
      } else {
        if (!voiceEventId) throw new AttentionError("Selecciona la llamada de Dapta que sustenta este resultado.");
        const voice = deps.voice(context), calls = await voice.listCreditWelcomeVoiceCallsForCredit(context.work.targetId), selected = calls.find(call => call.id === voiceEventId);
        voiceCompleted(selected, outcome);
        if (!await voice.creditWelcomeVoiceEvidenceIsCurrent(context.work.targetId, voiceEventId)) throw new AttentionError("Los datos de la llamada no corresponden al crédito vigente. Actualiza y revisa el resultado.", 409);
      }
      const complete = outcome === "HUMAN_CONTACT" || outcome === "OPT_OUT";
      const label = outcome === "HUMAN_CONTACT" ? "Bienvenida realizada" : outcome === "OPT_OUT" ? "Gestión cerrada sin bienvenida: el cliente no autoriza la llamada o grabación" : outcome === "NO_ANSWER" ? "Seguimiento de bienvenida: no contestó; requiere continuidad" : "Seguimiento de bienvenida: resultado por confirmar";
      return { result: { action: "WELCOME_RESULT", mode, outcome, observation, recordingId: recordingId || null, voiceEventId: voiceEventId || null, revision: detail.review.revision, reviewHash: detail.review.reviewHash }, summary: `${label}.\n${observation}`, complete, nextState: "review" as const };
    });
  }
  async function recording(a: AttentionWorkActor, id: string, recordingId: string) {
    attentionUuid(recordingId);
    return deps.work.workflowRead(a, id, "welcome", context => deps.recordingBytes(context, recordingId));
  }
  return { read, voices, call, upload, finish, recording };
}

/** Domain writes run inside the already authorized work-case transaction. No nested transaction or copied business rules. */
function transactionalVoice(context: AttentionWorkWorkflowContext) {
  const tx = context.db as Prisma.TransactionClient;
  const database = { $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx), $executeRawUnsafe: tx.$executeRawUnsafe.bind(tx), credito: tx.credito,
    $transaction: <T>(run: (database: Prisma.TransactionClient) => Promise<T>) => run(tx) };
  return createCreditWelcomeVoiceStore({ database: database as unknown as NonNullable<Parameters<typeof createCreditWelcomeVoiceStore>[0]>["database"] });
}
export async function attentionWorkWelcome() {
  return createAttentionWorkWelcome({ work: await attentionWorkStore(), ensure: ensureCreditWelcomeVoiceSchema, configured: () => Boolean(getCreditWelcomeVoiceConfig()),
    detail: context => getCreditApprovalDetail(context.db as ApprovalDatabase, context.work.targetId, actor(context)), voice: transactionalVoice,
    saveRecording: (context, input) => saveCreditApprovalCall(context.db as ApprovalDatabase, context.work.targetId, input, actor(context)),
    recordingBytes: (context, recordingId) => readCreditApprovalCallBytes(context.db as ApprovalDatabase, context.work.targetId, recordingId),
    dispatch: (claim, prepare) => dispatchCreditWelcomeVoice({ limit: 1 }, { claim: async () => [claim], prepare }),
  });
}
