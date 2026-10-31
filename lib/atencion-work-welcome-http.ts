import "server-only";
import { getAttentionWorkAccess } from "./atencion-work-access";
import { attentionWorkWelcome } from "./atencion-work-welcome";
import { AttentionError } from "./atencion-core";
import { CreditApprovalError } from "./credit-approval-errors";
import { CreditWelcomeVoiceStoreError } from "./credit-welcome-voice-store";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";
import { approvalCallAudioResponse, approvalCallRequestHeaders, readApprovalCallBytes } from "./credit-approval-call-http";
import { prepareApprovalCallFile } from "./credit-approval-call-file";

type Context = { params: Promise<{ id: string; recordingId?: string }> };
function failure(error: unknown) {
  if (error instanceof AttentionError || error instanceof CreditApprovalError || error instanceof CreditWelcomeVoiceStoreError) {
    const requestCreated = (error as Error & { requestCreated?: boolean }).requestCreated;
    return attentionJson({ ok: false, error: error.message, ...(typeof requestCreated === "boolean" ? { requestCreated } : {}) }, error.status);
  }
  return attentionHttpError(error);
}
async function access(context: Context) { return { actor: await getAttentionWorkAccess("attention"), id: (await context.params).id }; }
export const attentionWorkWelcomeHandlers = {
  read: async (_request: Request, context: Context) => {
    try { const { actor, id } = await access(context); return attentionJson(await (await attentionWorkWelcome()).read(actor, id)); }
    catch (error) { return failure(error); }
  },
  voices: async (request: Request, context: Context) => {
    try {
      const { actor, id } = await access(context), params = new URL(request.url).searchParams;
      if ([...params.keys()].some(key => key !== "requestId") || params.getAll("requestId").length > 1) throw new AttentionError("Consulta inválida.");
      return attentionJson(await (await attentionWorkWelcome()).voices(actor, id, params.get("requestId") ?? undefined));
    } catch (error) { return failure(error); }
  },
  call: async (request: Request, context: Context) => {
    try { assertAttentionOrigin(request); const { actor, id } = await access(context); return attentionJson(await (await attentionWorkWelcome()).call(actor, id, await readAttentionJson(request, { maxBytes: 2048 }))); }
    catch (error) { return failure(error); }
  },
  upload: async (request: Request, context: Context) => {
    try {
      assertAttentionOrigin(request); const { actor, id } = await access(context);
      const metadata = approvalCallRequestHeaders(request), rawVersion = request.headers.get("x-work-version"), contextHash = request.headers.get("x-work-context");
      if (!rawVersion || !/^[1-9]\d{0,9}$/.test(rawVersion) || !contextHash || !/^[a-f0-9]{64}$/.test(contextHash)) throw new AttentionError("Actualiza la solicitud antes de guardar la grabación.");
      const service = await attentionWorkWelcome();
      await service.read(actor, id); // Authorize case scope before accepting/decoding audio bytes.
      const file = await prepareApprovalCallFile(await readApprovalCallBytes(request), metadata.fileName);
      return attentionJson(await service.upload(actor, id, { ...file, ...metadata }, Number(rawVersion), contextHash));
    } catch (error) { return failure(error); }
  },
  finish: async (request: Request, context: Context) => {
    try { assertAttentionOrigin(request); const { actor, id } = await access(context); return attentionJson(await (await attentionWorkWelcome()).finish(actor, id, await readAttentionJson(request, { maxBytes: 16000 }))); }
    catch (error) { return failure(error); }
  },
  recording: async (request: Request, context: Context) => {
    try {
      const { actor, id } = await access(context), recordingId = (await context.params).recordingId;
      if (!recordingId) throw new AttentionError("Grabación no disponible.", 404);
      return approvalCallAudioResponse(request, await (await attentionWorkWelcome()).recording(actor, id, recordingId));
    } catch (error) { return failure(error); }
  },
};
