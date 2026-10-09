import { isAdminRole, isApprovalAnalystRole, canReviewCreditApprovals } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import type { WelcomeVoiceToken } from "@/lib/credit-welcome-voice-core";
import { parseWelcomeVoiceSpokenDocument } from "@/lib/credit-welcome-voice-document";
import type { WelcomeVoiceIdentityRecoveryResponse, VoiceDispatchClaim } from "@/lib/credit-welcome-voice-store";

export const welcomeVoicePrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vary": "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

class WelcomeVoiceRequestError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: welcomeVoicePrivateHeaders });
}
function unauthorized() {
  return response({ ok: false, code: "UNAUTHORIZED", error: "Solicitud no autorizada." }, 401);
}
function unavailable() {
  return response({ ok: false, code: "WELCOME_VOICE_UNAVAILABLE", error: "No se pudo consultar o registrar la bienvenida." }, 503);
}
function requestError(error: unknown) {
  if (error instanceof WelcomeVoiceRequestError) {
    return response({ ok: false, code: error.code, error: "Solicitud de bienvenida no válida." }, error.status);
  }
  // Never expose provider payloads, customer identifiers, tokens or database errors.
  const code = object(error)?.code;
  if (["CALL_ID_CONFLICT", "RESULT_CONFLICT", "RESULT_NOT_ALLOWED"].includes(String(code))) {
    return response({ ok: false, code: "CALL_CONFLICT", error: "La llamada no corresponde a esta bienvenida." }, 409);
  }
  if (code === "EVENT_NOT_FOUND") return response({ ok: false, code: "WELCOME_NOT_FOUND", error: "Bienvenida no encontrada." }, 404);
  if (["INVALID_EVENT", "INVALID_CALL_ID", "INVALID_RESULT", "INVALID_RECORDING_URL"].includes(String(code))) {
    return response({ ok: false, code: "INVALID_INPUT", error: "Solicitud de bienvenida no válida." }, 400);
  }
  return unavailable();
}

async function readBody(request: Request, maxBytes: number): Promise<ObjectValue> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") || "")) {
    throw new WelcomeVoiceRequestError("INVALID_CONTENT_TYPE", 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WelcomeVoiceRequestError("REQUEST_TOO_LARGE", 413);
  }
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new WelcomeVoiceRequestError("REQUEST_TOO_LARGE", 413);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!body) throw new Error("Invalid object");
    return body;
  } catch { throw new WelcomeVoiceRequestError("INVALID_BODY"); }
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new WelcomeVoiceRequestError("INVALID_INPUT");
  }
  return value.trim();
}
function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, maxLength);
}
function analysisText(value: unknown, maxLength: number): string | null {
  if (Array.isArray(value)) {
    if (value.length > 30 || value.some(item => typeof item !== "string")) throw new WelcomeVoiceRequestError("INVALID_ANALYSIS");
    return optionalText(value.filter(item => item.trim()).join("\n"), maxLength);
  }
  return optionalText(value, maxLength);
}

type TokenVerifier = (value: unknown) => WelcomeVoiceToken | null;
export function createCreditWelcomeVoiceIdentityHandler(dependencies: {
  verifyToken: TokenVerifier;
  verifyFlowAuthorization?: (value: unknown) => boolean;
  verifyIdentity: (input: { eventId: string; creditId?: number; requireFreshDispatch?: boolean; customerName: string; customerDocument: string }) => Promise<{
    verificado: boolean; condiciones?: unknown;
  } & Partial<WelcomeVoiceIdentityRecoveryResponse>>;
}) {
  return async function POST(request: Request) {
    try {
      const body = await readBody(request, 4096);
      // Select one transport; a bad bearer must not fall back to a model-copied token.
      const usesFlow = Object.prototype.hasOwnProperty.call(body, "event_id");
      let scope: { eventId: string; creditId?: number; requireFreshDispatch?: boolean };
      if (usesFlow) {
        if (!dependencies.verifyFlowAuthorization?.(request.headers.get("authorization"))) return unauthorized();
        const eventId = requiredString(body.event_id, 36);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
          || Object.prototype.hasOwnProperty.call(body, "event_token")) throw new WelcomeVoiceRequestError("INVALID_INPUT");
        scope = { eventId, requireFreshDispatch: true };
      } else {
        const token = dependencies.verifyToken(body.event_token);
        if (!token) return unauthorized();
        scope = { eventId: token.eventId, creditId: token.creditId };
      }
      const customerName = requiredString(body.customer_name, 240);
      const suppliedDocument = requiredString(body.customer_document, 240);
      // Private live calls parse and count every submitted identity under the
      // event's row lock, including unrecognized documents. Legacy tokens retain
      // their existing canonical-input contract.
      const customerDocument = usesFlow ? suppliedDocument : parseWelcomeVoiceSpokenDocument(suppliedDocument);
      if (!customerDocument) return response({ ok: true, verificado: false, condiciones: null, code: "DOCUMENT_NOT_UNDERSTOOD" });
      const result = await dependencies.verifyIdentity({ ...scope, customerName, customerDocument });
      if (usesFlow) {
        const remainingAttempts = Number.isInteger(result.remainingAttempts) && Number(result.remainingAttempts) >= 0 && Number(result.remainingAttempts) <= 2
          ? result.remainingAttempts : 0;
        if (result.verificado === true) return response({ ok: true, verificado: true, condiciones: result.condiciones,
          code: null, nextAction: "CONTINUE", remainingAttempts, question: null, mayEndCall: false });
        const nextAction = Number(remainingAttempts) > 0 && (result.nextAction === "ASK_NAME" || result.nextAction === "ASK_DOCUMENT") ? result.nextAction : "REVIEW";
        return response({ ok: true, verificado: false, condiciones: null,
          code: result.code === "DOCUMENT_NOT_UNDERSTOOD" ? result.code : "IDENTITY_NOT_CONFIRMED", nextAction,
          remainingAttempts: nextAction === "REVIEW" ? 0 : remainingAttempts,
          question: nextAction === "ASK_NAME" ? "¿Me repite su nombre completo, por favor?"
            : nextAction === "ASK_DOCUMENT" ? "¿Me repite su número de cédula, por favor?" : "No pude confirmar sus datos. Un asesor revisará su caso.",
          mayEndCall: nextAction === "REVIEW" });
      }
      return response(result.verificado === true
        ? { ok: true, verificado: true, condiciones: result.condiciones }
        : { ok: true, verificado: false });
    } catch (error) { return requestError(error); }
  };
}

export type WelcomeVoiceCommunicationOutcome = "HUMAN_CONTACT" | "NO_ANSWER" | "OPT_OUT" | "UNCERTAIN";

export type WelcomeVoiceCallbackData = {
  eventId: string; creditId: number; providerCallId: string; status: "COMPLETED" | "FAILED";
  recordingUrl: string | null; summary: string | null; transcript: string | null; doubts: string | null;
  durationSeconds: number | null; completedAt: string | null; resultCode: string;
  communicationOutcome: WelcomeVoiceCommunicationOutcome; disconnectionReason: string | null;
};

function callbackDisconnectionReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null;
}

function spokenUserTurns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // Dapta's structured transcript distinguishes spoken user content from agent/tool text.
  // Never infer speakers from the free-form transcript, summaries or model identity flags.
  return value.flatMap(entry => {
    const turn = object(entry);
    if (turn?.role !== "user" || typeof turn.content !== "string") return [];
    const text = turn.content.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(text)
      || /^(?:inaudible|ininteligible|unintelligible|unclear|silence|silencio|noise|ruido|no audio|hmm|mmm|um|uh|eh)$/.test(text)) return [];
    return [text];
  });
}

function explicitlyRefusesRecording(userTurns: string[]): boolean {
  // A model's recording_accepted flag, a bare "no" or a correction of a name
  // is not an opt-out. Require an explicit refusal about recording in user speech.
  return userTurns.some(text =>
    /\bno (?:autorizo|acepto|consiento|permito|quiero|deseo) (?:(?:la|esta) grabacion|ser grabad[oa]|que (?:me|nos) grab(?:e|en|es)|que grab(?:e|en|es)(?: (?:mi|nuestra|la|esta) llamada)?|que (?:la|esta) llamada (?:sea|este siendo) grabada)\b/.test(text)
    || /\bno (?:me|nos) grab(?:e|en|es)\b/.test(text)
    || /\b(?:deje|dejen|deja) de grabar(?:me|nos)?\b/.test(text)
    || /\bno estoy de acuerdo con (?:(?:la|esta) grabacion|que (?:me|nos) grab(?:e|en|es))\b/.test(text));
}

function callbackCommunicationOutcome(call: ObjectValue, analysis: ObjectValue,
  failed: boolean, disconnectionReason: string | null, recordingDeclined: boolean): WelcomeVoiceCommunicationOutcome {
  const userTurns = spokenUserTurns(call.transcript_object);
  const optedOut = recordingDeclined || userTurns.some(text =>
    /\b(?:no (?:me|nos) (?:llames?|llamen|vuelvas? a llamar|vuelvan a llamar)|no quiero (?:recibir )?(?:mas )?llamadas|numero (?:equivocado|incorrecto))\b/.test(text));
  if (optedOut) return "OPT_OUT";
  const voicemail = analysis.in_voicemail === true || disconnectionReason === "voicemail_reached";
  const notConnected = voicemail || ["dial_no_answer", "dial_failed", "dial_busy", "concurrency_limit_reached"].includes(disconnectionReason || "")
    || /^error_[a-z0-9_]+$/.test(disconnectionReason || "");
  // Contradictory voicemail/no-answer metadata must not trigger an unsafe automatic retry.
  if (userTurns.length >= 2) return notConnected ? "UNCERTAIN" : "HUMAN_CONTACT";
  if (voicemail) return "NO_ANSWER";
  if (userTurns.length === 0 && (notConnected || (failed && (typeof call.transcript !== "string" || !call.transcript.trim())))) {
    return "NO_ANSWER";
  }
  return "UNCERTAIN";
}

function parseCallback(body: ObjectValue, token: WelcomeVoiceToken, expectedAgent: string, safeUrl: (value: unknown) => string | null): WelcomeVoiceCallbackData {
  const call = object(body.call ?? body.data ?? body);
  if (!call) throw new WelcomeVoiceRequestError("INVALID_CALL");
  const variables = object(call.dynamic_variables);
  if (!variables || variables.event_id !== token.eventId || typeof variables.credito_id !== "string"
    || !/^[1-9]\d*$/.test(variables.credito_id) || Number(variables.credito_id) !== token.creditId) {
    throw new WelcomeVoiceRequestError("CALL_SCOPE_MISMATCH", 403);
  }
  if (call.agent_id !== expectedAgent && call.agent_id !== `agent_${expectedAgent}`) {
    throw new WelcomeVoiceRequestError("CALL_SCOPE_MISMATCH", 403);
  }
  const providerCallId = requiredString(call.call_id, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(providerCallId)) throw new WelcomeVoiceRequestError("INVALID_CALL");
  const callStatus = requiredString(call.call_status, 40).toLowerCase();
  const failed = ["failed", "error", "not_connected", "no_answer", "no-answer"].includes(callStatus);
  if (!failed && !["ended", "completed", "finished"].includes(callStatus)) throw new WelcomeVoiceRequestError("INVALID_CALL_STATUS");
  const analysis = object(call.call_analysis) || {};
  const custom = object(analysis.custom_analysis_data) || {};
  const questions = analysisText(custom.customer_questions, 2000);
  const discrepancies = analysisText(custom.customer_discrepancies, 2000);
  const doubts = [questions && `Preguntas: ${questions}`, discrepancies && `Diferencias reportadas: ${discrepancies}`].filter(Boolean).join("\n") || null;
  let durationSeconds: number | null = null;
  if (call.duration_ms !== undefined && call.duration_ms !== null) {
    if (typeof call.duration_ms !== "number" || !Number.isFinite(call.duration_ms) || call.duration_ms < 0 || call.duration_ms > 86_400_000) {
      throw new WelcomeVoiceRequestError("INVALID_DURATION");
    }
    durationSeconds = Math.round(call.duration_ms / 1000);
  }
  const recordingDeclined = explicitlyRefusesRecording(spokenUserTurns(call.transcript_object));
  const resultCode = failed ? "CALL_FAILED" : analysis.in_voicemail === true ? "VOICEMAIL"
    : recordingDeclined ? "RECORDING_DECLINED"
      : discrepancies ? "CUSTOMER_DISCREPANCY" : questions ? "CUSTOMER_QUESTIONS"
        : custom.terms_confirmed === true ? "TERMS_REVIEWED" : "CALL_COMPLETED";
  const disconnectionReason = callbackDisconnectionReason(call.disconnection_reason);
  return { eventId: token.eventId, creditId: token.creditId, providerCallId, status: failed ? "FAILED" : "COMPLETED",
    // Do not accept public audio hosts or a provider/model's identity_confirmed flag.
    recordingUrl: safeUrl(call.recording_url) || safeUrl(call.public_log_url),
    summary: optionalText(analysis.call_summary, 4000), transcript: optionalText(call.transcript, 32768),
    doubts, durationSeconds, completedAt: null, resultCode, disconnectionReason,
    communicationOutcome: callbackCommunicationOutcome(call, analysis, failed, disconnectionReason, recordingDeclined) };
}

export function createCreditWelcomeVoiceResultHandler(dependencies: {
  verifyToken: TokenVerifier;
  expectedAgent: () => string;
  safeUrl: (value: unknown) => string | null;
  saveResult: (input: WelcomeVoiceCallbackData) => Promise<{ unchanged: boolean }>;
}) {
  return async function POST(request: Request) {
    try {
      const body = await readBody(request, 131072);
      const call = object(body.call ?? body.data ?? body);
      const token = dependencies.verifyToken(object(call?.dynamic_variables)?.event_token);
      if (!token) return unauthorized();
      const expectedAgent = dependencies.expectedAgent().trim();
      if (!expectedAgent) return unavailable();
      const result = await dependencies.saveResult(parseCallback(body, token, expectedAgent, dependencies.safeUrl));
      return response({ ok: true, duplicate: result.unchanged === true });
    } catch (error) { return requestError(error); }
  };
}

export type WelcomeVoiceReadUser = {
  id: number; activo: boolean; rolNombre: string; aliadoAccesoCodigo: string | null;
  aliadoAccesoId: number | null; sedeId: number; sedeAccesoActiva: boolean; aliadoAccesoActivo: boolean;
};
type ReadSeller = { activo: boolean; tipoPerfil: "VENDEDOR" | "SUPERVISOR"; sedeId: number };
export type WelcomeVoiceCallView = {
  id: string; creditId: number; status: string; source: string; providerCallId: string | null;
  createdAt: string; dispatchedAt: string | null; completedAt: string | null; durationSeconds: number | null;
  identityVerified: boolean; summary: string | null; doubts: string | null; recordingUrl: string | null;
  audioStorage: "DAPTA_PRIVATE_LINK" | "UNAVAILABLE"; resultCode: string | null;
};
export type WelcomeVoiceManualCallView = { canCall: boolean; phone: string | null; reason?: string };
export type WelcomeVoiceManualRequestView = { requestId: string; found: boolean; eventId?: string; status?: string };

/** A manual call uses the authorized credit's stored contact; the browser cannot choose another recipient. */
export function createCreditWelcomeVoiceManualHandler(dependencies: {
  getUser: () => Promise<WelcomeVoiceReadUser | null>;
  sameOrigin: (request: Request) => boolean;
  configured: () => boolean;
  findCredit: (id: number, access: ReturnType<typeof buildCreditAccessWhere>) => Promise<{ id: number } | null>;
  prepare: (input: { creditId: number; requestId: string; actorId: number }) => Promise<VoiceDispatchClaim & { created: boolean }>;
  dispatch: (claim: VoiceDispatchClaim) => Promise<unknown>;
  listCalls: (id: number) => Promise<WelcomeVoiceCallView[]>;
}) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    let requestReserved = false;
    const rejected = (code: string, error: string, status: number) => response({ ok: false, code, error }, status);
    try {
      if (!dependencies.sameOrigin(request)) return rejected("INVALID_ORIGIN", "Realiza la llamada desde FINSER PAY.", 403);
      const user = await dependencies.getUser();
      if (!user) return rejected("UNAUTHORIZED", "Solicitud no autorizada.", 401);
      const admin = isAdminRole(user.rolNombre);
      const analyst = isApprovalAnalystRole(user.rolNombre) && canReviewCreditApprovals(user);
      if (user.activo !== true || user.sedeAccesoActiva !== true || user.aliadoAccesoActivo !== true || (!admin && !analyst)) {
        return rejected("FORBIDDEN", "No tienes permiso para solicitar esta llamada.", 403);
      }
      const rawId = (await context.params).id;
      if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new WelcomeVoiceRequestError("INVALID_CREDIT");
      const creditId = Number(rawId);
      const access = buildCreditAccessWhere({ admin, adminCentral: analyst || (admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo)),
        aliadoId: user.aliadoAccesoId, sedeId: user.sedeId });
      const credit = await dependencies.findCredit(creditId, access);
      if (!credit) return rejected("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
      const body = await readBody(request, 1024);
      const requestId = body.requestId;
      if (Object.keys(body).some(key => key !== "requestId") || typeof requestId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new WelcomeVoiceRequestError("INVALID_INPUT");
      }
      if (!dependencies.configured()) return rejected("VOICE_NOT_CONFIGURED", "Las llamadas de bienvenida no están disponibles en este momento.", 503);
      const prepared = await dependencies.prepare({ creditId: credit.id, requestId, actorId: user.id });
      requestReserved = true;
      // A replay is a status query, never a second provider request.
      if (prepared.created) await dependencies.dispatch(prepared);
      const call = (await dependencies.listCalls(credit.id)).find(item => item.id === prepared.eventId && item.creditId === credit.id);
      const status = call?.status ?? "UNKNOWN";
      const message = status === "UNKNOWN" ? "El estado de la llamada está por confirmar. Consulta este mismo intento."
        : status === "ACCEPTED" ? "Llamada solicitada. El resultado aparecerá en este registro."
          : status === "DISPATCHING" ? "La llamada se está solicitando. Consulta este mismo intento."
            : "El resultado de este intento está disponible en el registro.";
      return response({ ok: true, eventId: prepared.eventId, status, message }, prepared.created ? 202 : 200);
    } catch (error) {
      const detail = object(error);
      // Only a definite pre-reservation rejection may release the browser's UUID.
      // A network/database failure can follow a committed reservation: keep it ambiguous.
      const rejections: Record<string, { status: number; message: string }> = {
        INVALID_OPERATOR_CALL: { status: 400, message: "Solicitud de llamada no válida." },
        CREDIT_NOT_FOUND: { status: 404, message: "Crédito no encontrado." },
        OTHER_CALL_IN_FLIGHT: { status: 409, message: "Ya hay una llamada en curso o por confirmar para este crédito." },
        OPT_OUT: { status: 409, message: "El cliente solicitó no recibir estas llamadas." },
        OPERATOR_EXCLUDED: { status: 409, message: "Este crédito está excluido de las llamadas de bienvenida." },
        OPERATOR_CALL_REQUEST_MISMATCH: { status: 409, message: "Esta solicitud corresponde a otro intento. Actualiza el registro." },
        OPERATOR_CALL_INELIGIBLE: { status: 409, message: "Este crédito no puede recibir una llamada de bienvenida en su estado actual." },
        OPERATOR_CALL_DOCUMENT_MISMATCH: { status: 409, message: "Los datos del crédito cambiaron. Actualiza el registro." },
        OPERATOR_CALL_ATTEMPT_LIMIT: { status: 409, message: "Este crédito alcanzó el límite de intentos de llamada." },
      };
      const rejection = typeof detail?.code === "string" ? rejections[detail.code] : undefined;
      if (!requestReserved && rejection) {
        return response({ ok: false, code: String(detail!.code), error: rejection.message, requestCreated: false }, rejection.status);
      }
      return requestError(error);
    }
  };
}

export function createCreditWelcomeVoiceReadHandler(dependencies: {
  getUser: () => Promise<WelcomeVoiceReadUser | null>;
  getSeller: (user: WelcomeVoiceReadUser) => Promise<ReadSeller | null>;
  findCredit: (id: number, access: ReturnType<typeof buildCreditAccessWhere>) => Promise<{ id: number } | null>;
  listCalls: (id: number) => Promise<WelcomeVoiceCallView[]>;
  safeUrl: (value: unknown) => string | null;
  getManualCall?: (id: number) => Promise<WelcomeVoiceManualCallView>;
  getManualRequest?: (input: { creditId: number; requestId: string; actorId: number }) => Promise<{ eventId: string; status: string } | null>;
}) {
  return async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    try {
      const user = await dependencies.getUser();
      if (!user) return unauthorized();
      if (user.activo !== true || user.sedeAccesoActiva !== true || user.aliadoAccesoActivo !== true) {
        return response({ ok: false, code: "FORBIDDEN", error: "No tienes permiso para consultar esta bienvenida." }, 403);
      }
      const admin = isAdminRole(user.rolNombre);
      const analyst = isApprovalAnalystRole(user.rolNombre) && canReviewCreditApprovals(user);
      if (isApprovalAnalystRole(user.rolNombre) && !analyst) {
        return response({ ok: false, code: "FORBIDDEN", error: "No tienes permiso para consultar esta bienvenida." }, 403);
      }
      const seller = admin || analyst ? null : await dependencies.getSeller(user);
      if (!admin && !analyst && (!seller || seller.activo !== true)) {
        return response({ ok: false, code: "FORBIDDEN", error: "No tienes permiso para consultar esta bienvenida." }, 403);
      }
      const rawId = (await context.params).id;
      if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new WelcomeVoiceRequestError("INVALID_CREDIT");
      const id = Number(rawId);
      const access = buildCreditAccessWhere({ admin, adminCentral: analyst || (admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo)),
        aliadoId: user.aliadoAccesoId, sedeId: user.sedeId, sellerSedeId: seller?.sedeId, supervisor: seller?.tipoPerfil === "SUPERVISOR" });
      const credit = await dependencies.findCredit(id, access);
      if (!credit) return response({ ok: false, code: "CREDIT_NOT_FOUND", error: "Crédito no encontrado." }, 404);
      const requestIds = new URL(_request.url).searchParams.getAll("requestId");
      if (requestIds.length > 1 || (requestIds.length === 1
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestIds[0]))) {
        throw new WelcomeVoiceRequestError("INVALID_INPUT");
      }
      if (requestIds.length && !admin && !analyst) {
        return response({ ok: false, code: "FORBIDDEN", error: "No tienes permiso para consultar esta solicitud de llamada." }, 403);
      }
      const items = (await dependencies.listCalls(credit.id)).map(call => {
        const recordingUrl = dependencies.safeUrl(call.recordingUrl);
        // Explicit projection prevents stored transcripts, snapshots and tokens from reaching the browser.
        return { id: call.id, creditId: call.creditId, status: call.status, source: call.source,
          providerCallId: call.providerCallId, createdAt: call.createdAt, dispatchedAt: call.dispatchedAt,
          completedAt: call.completedAt, durationSeconds: call.durationSeconds, identityVerified: call.identityVerified === true,
          summary: call.summary, doubts: call.doubts, recordingUrl,
          audioStorage: recordingUrl ? "DAPTA_PRIVATE_LINK" : "UNAVAILABLE", resultCode: call.resultCode };
      });
      const manualCall = dependencies.getManualCall && (admin || analyst) ? await dependencies.getManualCall(credit.id) : undefined;
      let request: WelcomeVoiceManualRequestView | undefined;
      if (requestIds.length && dependencies.getManualRequest) {
        const requestId = requestIds[0];
        const linked = await dependencies.getManualRequest({ creditId: credit.id, requestId, actorId: user.id });
        request = linked ? { requestId, found: true, eventId: linked.eventId, status: linked.status } : { requestId, found: false };
      }
      return response({ ok: true, items, ...(manualCall ? { manualCall } : {}), ...(request ? { request } : {}) });
    } catch (error) { return requestError(error); }
  };
}
