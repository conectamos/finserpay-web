import { isAdminRole, isApprovalAnalystRole, canReviewCreditApprovals } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import type { WelcomeVoiceToken } from "@/lib/credit-welcome-voice-core";

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
  verifyIdentity: (input: { eventId: string; creditId: number; customerName: string; customerDocument: string }) => Promise<{
    verificado: boolean; condiciones?: unknown;
  }>;
}) {
  return async function POST(request: Request) {
    try {
      const body = await readBody(request, 4096);
      const token = dependencies.verifyToken(body.event_token);
      if (!token) return unauthorized();
      const customerName = requiredString(body.customer_name, 240);
      const customerDocument = requiredString(body.customer_document, 80);
      if (!/^[\d\s.,-]+$/.test(customerDocument) || !/^\d{5,15}$/.test(customerDocument.replace(/[\s.,-]/g, ""))) {
        throw new WelcomeVoiceRequestError("INVALID_INPUT");
      }
      const result = await dependencies.verifyIdentity({ eventId: token.eventId, creditId: token.creditId, customerName, customerDocument });
      return response(result.verificado === true
        ? { ok: true, verificado: true, condiciones: result.condiciones }
        : { ok: true, verificado: false });
    } catch (error) { return requestError(error); }
  };
}

export type WelcomeVoiceCallbackData = {
  eventId: string; creditId: number; providerCallId: string; status: "COMPLETED" | "FAILED";
  recordingUrl: string | null; summary: string | null; transcript: string | null; doubts: string | null;
  durationSeconds: number | null; completedAt: string | null; resultCode: string;
};

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
  const resultCode = failed ? "CALL_FAILED" : analysis.in_voicemail === true ? "VOICEMAIL"
    : custom.recording_accepted === false ? "RECORDING_DECLINED"
      : discrepancies ? "CUSTOMER_DISCREPANCY" : questions ? "CUSTOMER_QUESTIONS"
        : custom.terms_confirmed === true ? "TERMS_REVIEWED" : "CALL_COMPLETED";
  return { eventId: token.eventId, creditId: token.creditId, providerCallId, status: failed ? "FAILED" : "COMPLETED",
    // Do not accept public audio hosts or a provider/model's identity_confirmed flag.
    recordingUrl: safeUrl(call.recording_url) || safeUrl(call.public_log_url),
    summary: optionalText(analysis.call_summary, 4000), transcript: optionalText(call.transcript, 32768),
    doubts, durationSeconds, completedAt: null, resultCode };
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

export function createCreditWelcomeVoiceReadHandler(dependencies: {
  getUser: () => Promise<WelcomeVoiceReadUser | null>;
  getSeller: (user: WelcomeVoiceReadUser) => Promise<ReadSeller | null>;
  findCredit: (id: number, access: ReturnType<typeof buildCreditAccessWhere>) => Promise<{ id: number } | null>;
  listCalls: (id: number) => Promise<WelcomeVoiceCallView[]>;
  safeUrl: (value: unknown) => string | null;
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
      const items = (await dependencies.listCalls(credit.id)).map(call => {
        const recordingUrl = dependencies.safeUrl(call.recordingUrl);
        // Explicit projection prevents stored transcripts, snapshots and tokens from reaching the browser.
        return { id: call.id, creditId: call.creditId, status: call.status, source: call.source,
          providerCallId: call.providerCallId, createdAt: call.createdAt, dispatchedAt: call.dispatchedAt,
          completedAt: call.completedAt, durationSeconds: call.durationSeconds, identityVerified: call.identityVerified === true,
          summary: call.summary, doubts: call.doubts, recordingUrl,
          audioStorage: recordingUrl ? "DAPTA_PRIVATE_LINK" : "UNAVAILABLE", resultCode: call.resultCode };
      });
      return response({ ok: true, items });
    } catch (error) { return requestError(error); }
  };
}
