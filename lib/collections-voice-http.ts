import { parseWelcomeVoiceSpokenDocument } from "@/lib/credit-welcome-voice-document";
import { collectionsFlowAuthorized, collectionsUuid, verifyCollectionsVoiceToken } from "@/lib/collections-voice-core";
import type { CollectionsVoiceResult } from "@/lib/collections-voice-store";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
class InputError extends Error { constructor(public code: string, public status = 400) { super(code); } }
function required(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new InputError("INVALID_INPUT");
  return value.trim();
}
async function body(request: Request, max = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new InputError("INVALID_CONTENT_TYPE", 415);
  if (Number(request.headers.get("content-length")) > max) throw new InputError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > max) { await reader.cancel(); throw new InputError("REQUEST_TOO_LARGE", 413); } chunks.push(chunk.value); }
  } finally { reader?.releaseLock(); }
  try { const value = obj(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if (!value) throw new Error(); return value; }
  catch { throw new InputError("INVALID_BODY"); }
}
function failure(error: unknown) {
  if (error instanceof InputError) return json({ ok: false, code: error.code }, error.status);
  const code = obj(error)?.code;
  return ["CALL_CONFLICT", "RESULT_CONFLICT", "RESULT_NOT_ALLOWED", "IDENTITY_REQUIRED"].includes(String(code))
    ? json({ ok: false, code: "CALL_CONFLICT" }, 409) : json({ ok: false, code: "COLLECTIONS_UNAVAILABLE" }, 503);
}
type Dependencies = {
  flowSecret: () => string; tokenSecret: () => string; agentId: () => string;
  verifyIdentity: (input: { eventId: string; customerName: string; customerDocument: string }) => Promise<unknown>;
  saveResult: (input: CollectionsVoiceResult) => Promise<unknown>;
  recordManagement: (scope: { eventId: string }, input: { result: "MEDIOS_PAGO" | "PAGO_REALIZADO"; comment: string; nextFollowUpAt: string }) => Promise<unknown>;
};

export function parseCollectionsVoiceCallback(raw: Record<string, unknown>, secret: string, expectedAgent: string): CollectionsVoiceResult {
  const call = obj(raw.call ?? raw.data ?? raw); if (!call) throw new InputError("INVALID_CALL");
  const vars = obj(call.dynamic_variables), scope = verifyCollectionsVoiceToken(vars?.event_token, secret);
  if (!scope) throw new InputError("UNAUTHORIZED", 401);
  if (vars?.event_id !== scope.eventId || String(vars?.credito_id) !== String(scope.creditId)
    || !collectionsUuid.test(expectedAgent) || ![expectedAgent, `agent_${expectedAgent}`].includes(String(call.agent_id))) throw new InputError("CALL_SCOPE_MISMATCH", 403);
  const providerCallId = required(call.call_id, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(providerCallId)) throw new InputError("INVALID_CALL");
  const status = String(call.call_status || "").toLowerCase();
  if (!["ended", "completed", "finished", "failed", "error", "not_connected", "no_answer", "no-answer"].includes(status)) throw new InputError("INVALID_CALL_STATUS");
  const userTurns = Array.isArray(call.transcript_object) ? call.transcript_object.flatMap(v => {
    const row = obj(v); if (row?.role !== "user" || typeof row.content !== "string" || row.content.length > 2000) return [];
    const text = row.content.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    return text && !/^(inaudible|ininteligible|silencio|silence|ruido|noise|uh|eh|hmm)$/.test(text) ? [text] : [];
  }) : [];
  const optedOut = userTurns.some(t =>
    /\b(?:no (?:me|nos) (?:llames?|llamen|vuelvas? a llamar|vuelvan a llamar)|no quiero (?:recibir )?(?:mas )?llamadas|no (?:quiero|deseo) que (?:me|nos) llamen|numero (?:equivocado|incorrecto))\b/.test(t)
    || /\bno (?:autorizo|acepto|consiento|permito|quiero|deseo) (?:(?:la|esta) grabacion|ser grabad[oa]|que (?:me|nos) grab(?:e|en|es)|que grab(?:e|en|es)(?: (?:mi|nuestra|la|esta) llamada)?|que (?:la|esta) llamada (?:sea|este siendo) grabada)\b/.test(t));
  const reason = String(call.disconnection_reason || "").toLowerCase();
  const voicemail = obj(call.call_analysis)?.in_voicemail === true || /voicemail/.test(reason);
  const automatedGreeting = userTurns.length === 1 && /\b(deje (?:su|un|el) mensaje|buzon (?:de )?voz|despues del tono|correo de voz|casilla de voz)\b/.test(userTurns[0]);
  // Model analysis is never evidence of consent, an agreement, or a refusal.
  const outcome = optedOut ? "OPT_OUT" : voicemail
    ? userTurns.length < 2 && (!userTurns.length || automatedGreeting) ? "NO_ANSWER" : "UNCERTAIN"
    : userTurns.length >= 2 ? "HUMAN_CONTACT" : userTurns.length ? "UNCERTAIN"
    : ["dial_no_answer", "dial_busy", "no_answer", "user_busy"].includes(reason) || ["no_answer", "no-answer"].includes(status) ? "NO_ANSWER" : "UNCERTAIN";
  return { ...scope, providerCallId, outcome, resultCode: outcome, completedAt: null };
}

export function createCollectionsVoiceHandlers(deps: Dependencies) {
  return {
    identity: async (request: Request) => {
      try {
        if (!collectionsFlowAuthorized(request.headers.get("authorization"), deps.flowSecret())) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
        const data = await body(request);
        if (Object.keys(data).some(k => !["event_id", "customer_name", "customer_document"].includes(k))) throw new InputError("INVALID_INPUT");
        const eventId = required(data.event_id, 36); if (!collectionsUuid.test(eventId)) throw new InputError("INVALID_EVENT");
        const customerName = required(data.customer_name, 240), customerDocument = parseWelcomeVoiceSpokenDocument(required(data.customer_document, 240));
        if (!customerDocument) return json({ ok: true, verificado: false, code: "DOCUMENT_NOT_UNDERSTOOD" });
        return json({ ok: true, ...await deps.verifyIdentity({ eventId, customerName, customerDocument }) as object });
      } catch (error) { return failure(error); }
    },
    result: async (request: Request) => {
      try { const data = parseCollectionsVoiceCallback(await body(request, 131072), deps.tokenSecret(), deps.agentId());
        return json({ ok: true, ...await deps.saveResult(data) as object }); }
      catch (error) { return failure(error); }
    },
    management: async (request: Request) => {
      try {
        if (!collectionsFlowAuthorized(request.headers.get("authorization"), deps.flowSecret())) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
        const data = await body(request), eventId = required(data.event_id, 36);
        if (!collectionsUuid.test(eventId)) throw new InputError("INVALID_EVENT");
        if (Object.keys(data).some(k => !["event_id", "result", "comment", "next_follow_up_at"].includes(k))
          || !["MEDIOS_PAGO", "PAGO_REALIZADO"].includes(String(data.result))) throw new InputError("INVALID_RESULT");
        const result = await deps.recordManagement({ eventId }, { result: data.result as "MEDIOS_PAGO" | "PAGO_REALIZADO",
          comment: required(data.comment, 1500), nextFollowUpAt: required(data.next_follow_up_at, 35) });
        return json({ ok: true, registrado: true, ...result as object });
      } catch (error) { return failure(error); }
    },
  };
}
