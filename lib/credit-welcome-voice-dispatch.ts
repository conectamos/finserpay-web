import "server-only";
import { createWelcomeVoiceToken } from "@/lib/credit-welcome-voice-core";
import { welcomeVoiceDocumentSpoken, welcomeVoiceNameSpoken } from "@/lib/credit-welcome-voice-speech";
import {
  claimPendingCreditWelcomeVoice,
  ensureCreditWelcomeVoiceSchema,
  markCreditWelcomeVoiceDispatchAccepted,
  markCreditWelcomeVoiceDispatchFailed,
  markCreditWelcomeVoiceDispatchUnknown,
  prepareCreditWelcomeVoiceDispatch,
} from "@/lib/credit-welcome-voice-store";

type VoiceConfig = { webhookUrl: string; secret: string; agentId: string };
export function getCreditWelcomeVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  if (env.DAPTA_WELCOME_VOICE_ENABLED !== "true") return null;
  const webhookUrl = env.DAPTA_WELCOME_VOICE_WEBHOOK_URL || "";
  const secret = env.DAPTA_WELCOME_VOICE_TOKEN_SECRET || "";
  const agentId = env.DAPTA_WELCOME_VOICE_AGENT_ID || "";
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.dapta.ai" || url.username || url.password ||
      (url.port && url.port !== "443") || secret.length < 32 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) return null;
  } catch { return null; }
  return { webhookUrl, secret, agentId };
}

/** Only an explicit native-call receipt counts as dispatched, never HTTP 200 alone. */
function executionFailed(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object") return false;
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some(child => executionFailed(child, depth + 1));
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (record.ok === false || record.success === false || error === true ||
    (typeof error === "string" && error.trim().length > 0) ||
    (error && typeof error === "object" && Object.keys(error).length > 0)) return true;
  return Object.values(record).some(child => executionFailed(child, depth + 1));
}
export function welcomeVoiceReceipt(value: unknown): string | null {
  if (executionFailed(value)) return null;
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    if (record.error && (typeof record.error !== "object" || Object.keys(record.error).length)) return null;
    if (record.ok === true && typeof record.call_id === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(record.call_id)) return record.call_id;
    current = record.response ?? record.result ?? record.data;
  }
  return null;
}

type DispatchDependencies = {
  config?: VoiceConfig | null;
  ensureSchema?: typeof ensureCreditWelcomeVoiceSchema;
  claim?: typeof claimPendingCreditWelcomeVoice;
  prepare?: typeof prepareCreditWelcomeVoiceDispatch;
  accepted?: typeof markCreditWelcomeVoiceDispatchAccepted;
  failed?: typeof markCreditWelcomeVoiceDispatchFailed;
  unknown?: typeof markCreditWelcomeVoiceDispatchUnknown;
  fetcher?: typeof fetch;
};

export async function dispatchCreditWelcomeVoice(
  options: { limit?: number } = {}, deps: DispatchDependencies = {},
) {
  const config = deps.config === undefined ? getCreditWelcomeVoiceConfig() : deps.config;
  const summary = { configured: Boolean(config), selected: 0, accepted: 0, unknown: 0, skipped: 0 };
  if (!config) return summary;
  await (deps.ensureSchema ?? ensureCreditWelcomeVoiceSchema)();
  const claims = await (deps.claim ?? claimPendingCreditWelcomeVoice)({ limit: options.limit ?? 5 });
  summary.selected = claims.length;
  await Promise.all(claims.map(async claim => {
    const prepared = await (deps.prepare ?? prepareCreditWelcomeVoiceDispatch)(claim.eventId);
    if (!prepared) { summary.skipped++; return; }
    const spokenName = welcomeVoiceNameSpoken(prepared.snapshot.spokenName ?? prepared.snapshot.name, prepared.snapshot.name);
    const spokenDocument = welcomeVoiceDocumentSpoken(prepared.snapshot.document);
    if (!spokenName || !spokenDocument) {
      await (deps.failed ?? markCreditWelcomeVoiceDispatchFailed)(claim.eventId, "INVALID_IDENTITY_SPEECH");
      summary.skipped++;
      return;
    }
    let token: string;
    try {
      token = createWelcomeVoiceToken({ eventId: prepared.eventId, creditId: prepared.creditId }, { secret: config.secret });
    } catch {
      await (deps.failed ?? markCreditWelcomeVoiceDispatchFailed)(claim.eventId, "INVALID_DISPATCH_CONFIG");
      summary.skipped++;
      return;
    }
    // The short opening uses the revalidated name/document for confirmation.
    // Financial conditions still come only from the authenticated identity tool.
    let callId: string | null = null;
    try {
      const response = await (deps.fetcher ?? fetch)(config.webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        redirect: "error", signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ event_id: prepared.eventId, credito_id: String(prepared.creditId),
          event_token: token, to_number: `+${prepared.destinationPhone ?? prepared.snapshot.phone}`,
          customer_name: prepared.snapshot.name, customer_document: prepared.snapshot.document,
          customer_name_spoken: spokenName, customer_document_spoken: spokenDocument }),
      });
      if (response.ok) {
        const length = Number(response.headers.get("content-length"));
        if (!Number.isFinite(length) || length <= 131072) {
          const body = await response.text();
          if (Buffer.byteLength(body, "utf8") <= 131072) {
            try { callId = welcomeVoiceReceipt(JSON.parse(body)); } catch { /* An invalid receipt remains unknown. */ }
          }
        }
      }
    } catch { /* A timeout can happen after the provider placed the call. */ }
    if (callId) {
      await (deps.accepted ?? markCreditWelcomeVoiceDispatchAccepted)(claim.eventId, callId);
      summary.accepted++;
    } else {
      // An ambiguous response is held for reconciliation. Retrying it can call
      // the same customer twice; a later authenticated callback still completes it.
      await (deps.unknown ?? markCreditWelcomeVoiceDispatchUnknown)(claim.eventId);
      summary.unknown++;
    }
  }));
  return summary;
}
