import "server-only";
import { AttentionError } from "./atencion-core";
import { AttentionDaptaError, attentionIntegrationStatus, fetchConfirmedEventMessage } from "./atencion-dapta";
import { getMetaAttentionScope } from "./atencion-meta";
import { attentionHttpError } from "./atencion-http";
import { readAttentionBody } from "./atencion-meta-http";
import { createAttentionDaptaEventStore, type DaptaEventJob } from "./atencion-dapta-event-storage";
import { assertDaptaEventAuthorization, DAPTA_ATTENTION_EVENT_MAX_BYTES, DaptaEventError,
  getDaptaEventScope, parseDaptaAttentionEvent, type DaptaAttentionEvent, type DaptaEventScope } from "./atencion-dapta-events";
import type { AttentionDatabase } from "./atencion-storage";

type EventConfig = { scope: DaptaEventScope; token: string };
export function attentionDaptaEventConfig(env: NodeJS.ProcessEnv = process.env): EventConfig | null {
  if (env.DAPTA_ATTENTION_EVENTS_ENABLED !== "true") return null;
  const scope = getDaptaEventScope(env), meta = getMetaAttentionScope(env);
  const token = env.DAPTA_ATTENTION_EVENT_TOKEN?.trim() || "";
  if (!scope || !meta || scope.phoneNumberId !== meta.phoneNumberId || scope.wabaId !== meta.wabaId
      || token.length < 32 || token.length > 4096 || /\s/.test(token)) return null;
  return { scope, token };
}
function eventJson(body: unknown) {
  return Response.json(body, { headers: { "Cache-Control": "private, no-store", Vary: "Authorization", "X-Content-Type-Options": "nosniff" } });
}
/** The flow only submits identifiers. Provider text is read later under our MCP credentials. */
export function createAttentionDaptaEventHandler(deps: {
  config: () => EventConfig | null;
  ingest: (event: DaptaAttentionEvent) => Promise<unknown>;
  now?: () => Date;
}) {
  return async (request: Request) => {
    try {
      const config = deps.config();
      if (!config) throw new DaptaEventError("DAPTA_EVENT_NOT_CONFIGURED", 503);
      assertDaptaEventAuthorization(request.headers.get("authorization"), config.token);
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AttentionError("Envía los datos en formato JSON.", 415);
      const raw = await readAttentionBody(request, DAPTA_ATTENTION_EVENT_MAX_BYTES, 10000);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch { throw new AttentionError("Los datos enviados no son válidos.", 400); }
      const event = parseDaptaAttentionEvent(body, config.scope, deps.now?.());
      await deps.ingest(event);
      return eventJson({ ok: true });
    } catch (error) { return attentionHttpError(error); }
  };
}
export async function attentionDaptaEventRuntime() {
  const config = attentionDaptaEventConfig();
  if (!config) throw new DaptaEventError("DAPTA_EVENT_NOT_CONFIGURED", 503);
  const { default: prisma } = await import("./prisma");
  return { config, store: createAttentionDaptaEventStore(prisma as unknown as AttentionDatabase, { scope: config.scope }) };
}
type EventStore = Pick<ReturnType<typeof createAttentionDaptaEventStore>, "claim" | "retry" | "persistConfirmed">;
function retryClassification(error: unknown, job: DaptaEventJob) {
  if (error instanceof DaptaEventError) return { code: "DAPTA_SCOPE_MISMATCH", delaySeconds: 60 };
  if (error instanceof AttentionDaptaError) {
    if (["SCOPE_MISMATCH", "UNAUTHORIZED", "INVALID_RESPONSE", "INVALID_CURSOR", "NOT_CONFIGURED"].includes(error.code)) return { code: "DAPTA_SCOPE_MISMATCH", delaySeconds: 60 };
    if (error.code === "RATE_LIMITED") return { code: "DAPTA_RATE_LIMITED", delaySeconds: Math.max(1, Math.min(error.retryAfterSeconds || 60, 3600)) };
  }
  return { code: "DAPTA_UNAVAILABLE", delaySeconds: Math.min(300, 10 * 2 ** Math.min(job.attempts, 5)) };
}
/** A native event wakes a durable job; pending sends never become a delivered CRM message. */
export async function dispatchAttentionDaptaEvents(store: EventStore, read = fetchConfirmedEventMessage) {
  const jobs = await store.claim(2);
  const result = { processed: jobs.length, imported: 0, pending: 0, failed: 0 };
  await Promise.all(jobs.map(async job => {
    try {
      const reply = await read({ externalConversationId: job.externalConversationId, contactId: job.contactId,
        messageId: job.messageId, historyCursor: job.historyCursor });
      if (reply.state === "confirmed") {
        const saved = await store.persistConfirmed(job, reply);
        if (!saved.pendingBinding) { if (saved.imported) result.imported++; return; }
        await store.retry(job, { delaySeconds: 10, code: "DAPTA_BINDING_PENDING", historyCursor: reply.historyCursor });
        result.pending++;
      } else if (reply.state === "failed") {
        await store.retry(job, { delaySeconds: 60, code: "DAPTA_FAILED", historyCursor: reply.historyCursor });
        result.failed++;
      } else {
        await store.retry(job, { delaySeconds: 10, code: reply.reason === "DELIVERY_PENDING" ? "DAPTA_PENDING" : "DAPTA_NOT_FOUND", historyCursor: reply.historyCursor });
        result.pending++;
      }
    } catch (error) {
      result.failed++;
      // A lost/expired lease belongs to another attempt; never manufacture another send.
      if (error instanceof DaptaEventError && error.code === "DAPTA_EVENT_LEASE_LOST") return;
      try { await store.retry(job, retryClassification(error, job)); } catch { /* Durable lease recovery retains the job. */ }
    }
  }));
  return result;
}

declare global { var __finserAttentionDaptaWorker: { running: boolean; timer: ReturnType<typeof setInterval> } | undefined; }
export function startAttentionDaptaEventWorker() {
  if (process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build"
      || !attentionDaptaEventConfig() || !attentionIntegrationStatus().canSync || globalThis.__finserAttentionDaptaWorker) return;
  const tick = async () => {
    const state = globalThis.__finserAttentionDaptaWorker;
    if (!state || state.running) return;
    state.running = true;
    try {
      if (!attentionDaptaEventConfig()) return;
      const { store } = await attentionDaptaEventRuntime();
      const result = await dispatchAttentionDaptaEvents(store);
      if (result.imported) console.log(`[attention-dapta] imported=${result.imported}`);
      if (result.failed) console.warn(`[attention-dapta] failed=${result.failed}; durable retries retained`);
    } catch { console.warn("[attention-dapta] worker unavailable; pending events retained"); }
    finally { state.running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5000);
  timer.unref();
  globalThis.__finserAttentionDaptaWorker = { running: false, timer };
  void tick();
}
