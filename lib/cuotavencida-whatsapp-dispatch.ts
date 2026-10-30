import "server-only";
import { colombiaDateKey } from "@/lib/colombia-date";
import { isMetaAutomationConfigured, sendMetaAutomation, whatsAppAutomationProvider, type MetaAutomationSender } from "@/lib/whatsapp-automation-provider";
import {
  claimCuotaVencidaWhatsApp, prepareCuotaVencidaWhatsAppDispatch, releaseCuotaVencidaWhatsAppClaim,
  markCuotaVencidaWhatsAppAccepted, markCuotaVencidaWhatsAppFailed, markCuotaVencidaWhatsAppUnknown,
  safeCuotaVencidaProviderMessageId,
  createCuotaVencidaWhatsAppStore, type PortfolioWhatsAppCampaign,
} from "@/lib/cuotavencida-whatsapp-store";

type Config = { provider: "meta" | "dapta"; webhookUrl?: string; env: NodeJS.ProcessEnv };
function configuration(env: NodeJS.ProcessEnv, campaign: PortfolioWhatsAppCampaign = "CUOTAVENCIDA"): Config | null {
  if (!["CUOTAVENCIDA", "BLOQUEO"].includes(campaign) || env[`DAPTA_${campaign}_ENABLED`] !== "true") return null;
  const provider = whatsAppAutomationProvider(env);
  if (!provider) return null;
  if (provider === "meta") return isMetaAutomationConfigured(env, campaign === "BLOQUEO" ? "bloqueo" : "cuotavencida")
    ? { provider, env: { ...env } } : null;
  try {
    const url = new URL(env[`DAPTA_${campaign}_WEBHOOK_URL`] || "");
    if (url.protocol !== "https:" || url.hostname !== "api.dapta.ai" || url.username || url.password || url.port || url.hash) return null;
    return { provider, webhookUrl: url.toString(), env: { ...env } };
  } catch { return null; }
}
export function isCuotaVencidaWhatsAppConfigured(env: NodeJS.ProcessEnv = process.env, campaign: PortfolioWhatsAppCampaign = "CUOTAVENCIDA"): boolean {
  return configuration(env, campaign) !== null;
}
function executionError(value: unknown, finalRecord: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object") return false;
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some(item => executionError(item, finalRecord, depth + 1));
  const record = value as Record<string, unknown>;
  const hasError = (error: unknown) => error === true || (typeof error === "string" && error.trim().length > 0)
    || Boolean(error && typeof error === "object" && Object.keys(error).length);
  if ((record !== finalRecord && record.ok === false) || record.success === false || record.suppressed === true || record.scheduled === true
    || hasError(record.error) || hasError(record.errors) || hasError(record.node_error)
    || (typeof record.status === "string" && /^(?:failed|error|node_error|rejected)$/i.test(record.status))) return true;
  return Object.values(record).some(item => executionError(item, finalRecord, depth + 1));
}
export function cuotaVencidaWhatsAppReceipt(payload: unknown, eventId: string):
  { status: "ACCEPTED"; providerMessageId: string } | { status: "FAILED" | "UNKNOWN" } {
  const outer = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  if (!outer) return { status: "UNKNOWN" };
  // Exactly the Dapta HTTP response wrapper, never an arbitrary nested success.
  const record = outer.response && typeof outer.response === "object" && !Array.isArray(outer.response)
    ? outer.response as Record<string, unknown> : outer;
  if (executionError(payload, record)) return { status: "UNKNOWN" };
  if (record !== outer && (outer.ok === false || outer.success === false)) return { status: "UNKNOWN" };
  if (record.event_id !== eventId) return { status: "UNKNOWN" };
  if (record.ok === true && record.accepted === true && record.code === null && safeCuotaVencidaProviderMessageId(record.provider_message_id)) {
    return { status: "ACCEPTED", providerMessageId: record.provider_message_id };
  }
  if (record.ok === false && record.accepted === false && record.provider_message_id === null && record.code === "PROVIDER_REJECTED") return { status: "FAILED" };
  return { status: "UNKNOWN" };
}
type Dependencies = {
  campaign?: PortfolioWhatsAppCampaign;
  env?: NodeJS.ProcessEnv; now?: () => Date; fetcher?: typeof fetch;
  sendMeta?: MetaAutomationSender;
  claim?: typeof claimCuotaVencidaWhatsApp; prepare?: typeof prepareCuotaVencidaWhatsAppDispatch;
  release?: typeof releaseCuotaVencidaWhatsAppClaim; accepted?: typeof markCuotaVencidaWhatsAppAccepted;
  failed?: typeof markCuotaVencidaWhatsAppFailed; unknown?: typeof markCuotaVencidaWhatsAppUnknown;
};
export function createCuotaVencidaWhatsAppDispatcher(deps: Dependencies = {}) {
  const campaign = deps.campaign ?? "CUOTAVENCIDA";
  const defaults = campaign === "BLOQUEO" ? createCuotaVencidaWhatsAppStore({ campaign }) : {
    claimCuotaVencidaWhatsApp, prepareCuotaVencidaWhatsAppDispatch, releaseCuotaVencidaWhatsAppClaim,
    markCuotaVencidaWhatsAppAccepted, markCuotaVencidaWhatsAppFailed, markCuotaVencidaWhatsAppUnknown,
  };
  const now = deps.now ?? (() => new Date());
  let running = false;
  return async function runCuotaVencidaWhatsApp(input: { limit?: number } = {}) {
    const env = { ...(deps.env ?? process.env) };
    const config = configuration(env, campaign);
    const report = { provider: whatsAppAutomationProvider(env), configured: Boolean(config), selected: 0, accepted: 0, failed: 0, unknown: 0, skipped: 0, deferred: 0 };
    if (!config || running) return report;
    const limit = Math.min(10, Math.max(1, Math.trunc(input.limit ?? 10)));
    if (!Number.isFinite(limit)) throw new RangeError("Invalid dispatch limit");
    const deadline = now().getTime() + 25_000;
    running = true;
    try {
      for (let index = 0; index < limit; index++) {
        if (deadline - now().getTime() < 8_000) break;
        // Lease only work that can be processed now, not a ten-request queue that expires while waiting.
        const [claim] = await (deps.claim ?? defaults.claimCuotaVencidaWhatsApp)({ limit: 1 });
        if (!claim) break;
        report.selected++;
        let deferred = false;
        let nativeGuardSkipped = false;
        const outcome: { result: ReturnType<typeof cuotaVencidaWhatsAppReceipt> } = { result: { status: "UNKNOWN" } };
        const prepare = deps.prepare ?? defaults.prepareCuotaVencidaWhatsAppDispatch;
        let prepared: Awaited<ReturnType<typeof prepare>>;
        if (config.provider === "meta") {
          prepared = await prepare(claim.eventId);
          const snapshot = prepared;
          if (snapshot) {
            if (deadline - now().getTime() <= 0 || colombiaDateKey(now()) !== snapshot.campaignDate) deferred = true;
            else try {
              const native = await (deps.sendMeta ?? sendMetaAutomation)({
                operationKey: `${campaign === "BLOQUEO" ? "bloqueo" : "cuotavencida"}:${snapshot.eventId}`,
                template: campaign === "BLOQUEO" ? "bloqueo" : "cuotavencida", phone: snapshot.phone,
                body: campaign === "BLOQUEO" ? [] : [snapshot.name],
              }, { env: config.env, fetcher: deps.fetcher, deadlineAt: deadline,
                withSendGuard: async <T>(send: () => Promise<T>): Promise<T> => {
                  let receipt: { value: T } | undefined;
                  const current = await prepare(claim.eventId, async validated => {
                    if (validated.phone !== snapshot.phone || validated.name !== snapshot.name
                      || deadline - now().getTime() <= 0 || colombiaDateKey(now()) !== validated.campaignDate)
                      throw new Error("BATCH_CHANGED_BEFORE_SEND");
                    // Only Graph HTTP runs while the original financial locks
                    // are held. Native outbox/CRM writes happen outside them.
                    receipt = { value: await send() };
                  });
                  if (!current) nativeGuardSkipped = true;
                  if (!current || !receipt) throw new Error("BATCH_NOT_ELIGIBLE_BEFORE_SEND");
                  return receipt.value;
                },
              });
              outcome.result = native.status === "accepted" && safeCuotaVencidaProviderMessageId(native.providerMessageId)
                ? { status: "ACCEPTED", providerMessageId: native.providerMessageId! }
                : { status: native.status === "failed" ? "FAILED" : "UNKNOWN" };
            } catch { /* Native durable state reconciles uncertain outcomes; never fall back. */ }
          }
        } else prepared = await prepare(claim.eventId, async current => {
          const remaining = deadline - now().getTime();
          if (remaining <= 0 || colombiaDateKey(now()) !== current.campaignDate) { deferred = true; return; }
          try {
            const response = await (deps.fetcher ?? fetch)(config!.webhookUrl!, {
              method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", redirect: "error",
              signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, Math.floor(remaining)))),
              body: JSON.stringify({ telefono: current.phone, nombre: current.name, event_id: current.eventId }),
            });
            // HTTP failure can still follow provider acceptance. Only the explicit correlated result settles it.
            if (response.ok && Number(response.headers.get("content-length") || 0) <= 131072) {
              const text = await response.text();
              if (Buffer.byteLength(text, "utf8") <= 131072) outcome.result = cuotaVencidaWhatsAppReceipt(JSON.parse(text), claim.eventId);
            }
          } catch { /* Never retry an outcome after HTTP has begun. */ }
        });
        if (!prepared) { report.skipped++; continue; }
        if (nativeGuardSkipped) { report.skipped++; continue; }
        if (deferred) {
          await (deps.release ?? defaults.releaseCuotaVencidaWhatsAppClaim)(claim.eventId); report.deferred++; break;
        }
        const result = outcome.result;
        let saved: number;
        if (result.status === "ACCEPTED") saved = await (deps.accepted ?? defaults.markCuotaVencidaWhatsAppAccepted)(claim.eventId, result.providerMessageId);
        else if (result.status === "FAILED") saved = await (deps.failed ?? defaults.markCuotaVencidaWhatsAppFailed)(claim.eventId);
        else saved = await (deps.unknown ?? defaults.markCuotaVencidaWhatsAppUnknown)(claim.eventId);
        if (!saved || result.status === "UNKNOWN") report.unknown++;
        else if (result.status === "ACCEPTED") report.accepted++;
        else report.failed++;
      }
      return report;
    } finally { running = false; }
  };
}
export const runCuotaVencidaWhatsApp = createCuotaVencidaWhatsAppDispatcher();
