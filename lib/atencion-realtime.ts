import "server-only";
import { Client } from "pg";
import { AttentionError, assertAttentionActor } from "./atencion-core";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDb } from "./atencion-storage";

export const ATTENTION_REALTIME_CHANNEL = "finserpay_attention_changes";
export type AttentionRealtimeChange = {
  conversationId: string;
  previousUserId: number | null;
  previousKey: string | null;
  previousSellerId: number | null;
  currentUserId: number | null;
  currentKey: string | null;
  currentSellerId: number | null;
  readActorUserId?: number;
};
type BrokerEvent = { kind: "connected" } | { kind: "disconnected" } | { kind: "change"; change: AttentionRealtimeChange };
type Subscriber = (event: BrokerEvent) => void;
type ListenClient = {
  connect(): Promise<unknown>; query(sql: string): Promise<unknown>; end(): Promise<unknown>;
  on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: "error" | "end", listener: () => void): unknown;
};
export type AttentionRealtimeBroker = { subscribe(listener: Subscriber): () => void; connected(): boolean; close(): void };

export function parseAttentionRealtimeChange(payload: string | undefined): AttentionRealtimeChange | null {
  if (!payload || payload.length > 2048) return null;
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.conversationId)) return null;
    const number = (item: unknown) => item === null || Number.isSafeInteger(item) && Number(item) > 0;
    const key = (item: unknown) => item === null || typeof item === "string" && item.length <= 80;
    if (![value.previousUserId, value.previousSellerId, value.currentUserId, value.currentSellerId].every(number) ||
        ![value.previousKey, value.currentKey].every(key) ||
        (value.readActorUserId !== undefined && (!Number.isSafeInteger(value.readActorUserId) || value.readActorUserId <= 0))) return null;
    return { conversationId: value.conversationId, previousUserId: value.previousUserId, previousKey: value.previousKey,
      previousSellerId: value.previousSellerId, currentUserId: value.currentUserId, currentKey: value.currentKey, currentSellerId: value.currentSellerId,
      ...(value.readActorUserId !== undefined ? { readActorUserId: value.readActorUserId } : {}) };
  } catch { return null; }
}

/** One PostgreSQL connection per process; NOTIFY is delivered only after commit. */
export function createAttentionRealtimeBroker(options: { createClient: () => ListenClient; retryMs?: number; random?: () => number }): AttentionRealtimeBroker {
  const subscribers = new Set<Subscriber>();
  let client: ListenClient | null = null;
  let ready = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let health: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  const emit = (event: BrokerEvent) => { for (const subscriber of subscribers) { try { subscriber(event); } catch { /* A closed HTTP stream cannot break the broker. */ } } };
  const stop = () => {
    if (retry) clearTimeout(retry); retry = null;
    if (idle) clearTimeout(idle); idle = null;
    if (health) clearInterval(health); health = null;
    const previous = client; client = null; ready = false;
    if (previous) void previous.end().catch(() => undefined);
  };
  function reconnect() {
    if (!subscribers.size || retry) return;
    const delay = Math.min(30_000, (options.retryMs ?? 1000) * 2 ** Math.min(attempts++, 5)) * (0.8 + (options.random ?? Math.random)() * 0.4);
    retry = setTimeout(() => { retry = null; void connect(); }, delay); retry.unref?.();
  }
  async function connect() {
    if (client || !subscribers.size) return;
    let next: ListenClient;
    try { next = options.createClient(); } catch { emit({ kind: "disconnected" }); reconnect(); return; }
    client = next;
    const lost = () => {
      if (client !== next) return;
      if (health) clearInterval(health); health = null;
      client = null; ready = false; emit({ kind: "disconnected" });
      void next.end().catch(() => undefined); reconnect();
    };
    next.on("error", lost); next.on("end", lost);
    next.on("notification", message => {
      if (client !== next || !ready || message.channel !== ATTENTION_REALTIME_CHANNEL) return;
      const change = parseAttentionRealtimeChange(message.payload);
      if (change) emit({ kind: "change", change });
    });
    try {
      await next.connect();
      if (client !== next) { void next.end().catch(() => undefined); return; }
      await next.query(`LISTEN ${ATTENTION_REALTIME_CHANNEL}`);
      if (client !== next) return;
      ready = true; attempts = 0; emit({ kind: "connected" });
      let probing = false;
      health = setInterval(() => {
        if (probing || client !== next) return;
        probing = true;
        void next.query("SELECT 1").catch(lost).finally(() => { probing = false; });
      }, 20_000);
      health.unref?.();
    } catch { lost(); }
  }
  return {
    connected: () => ready,
    subscribe(listener) {
      if (subscribers.size >= 500) throw new AttentionError("Hay demasiadas conexiones de atención. Intenta de nuevo.", 429);
      if (idle) clearTimeout(idle); idle = null;
      subscribers.add(listener);
      if (ready) queueMicrotask(() => { if (subscribers.has(listener) && ready) listener({ kind: "connected" }); });
      else void connect();
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) { idle = setTimeout(stop, 2000); idle.unref?.(); }
      };
    },
    close() { stop(); subscribers.clear(); },
  };
}

const globals = globalThis as typeof globalThis & { attentionRealtimeBroker?: AttentionRealtimeBroker };
export function getAttentionRealtimeBroker(): AttentionRealtimeBroker {
  if (!globals.attentionRealtimeBroker) globals.attentionRealtimeBroker = createAttentionRealtimeBroker({
    createClient: () => {
      if (!process.env.DATABASE_URL) throw new AttentionError("La actualización en vivo no está configurada.", 503);
      return new Client({ connectionString: process.env.DATABASE_URL, application_name: "finserpay-attention-events",
        connectionTimeoutMillis: 10_000, query_timeout: 10_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
    },
  });
  return globals.attentionRealtimeBroker;
}

export async function attentionRealtimeSchemaReady(database: AttentionDb): Promise<boolean> {
  const rows = await database.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT count(*)=3 AS ready FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND
    (c.relname,t.tgname) IN (('AttentionConversation','attention_realtime_conversation'),
      ('AttentionMessage','attention_realtime_message'),('AttentionMetaOutbox','attention_realtime_outbox'))`);
  return rows[0]?.ready === true;
}

function recipient(actor: AttentionActor, change: AttentionRealtimeChange): boolean {
  if (change.readActorUserId !== undefined && change.readActorUserId !== actor.userId) return false;
  return actor.central || (change.currentUserId === actor.userId && change.currentKey === actor.key && change.currentSellerId === null) ||
    (change.previousUserId === actor.userId && change.previousKey === actor.key && change.previousSellerId === null);
}

/** Recheck active nominal account and current assignment before every frame batch. */
export async function authorizeAttentionRealtime(database: AttentionDb, actor: AttentionActor, changes: readonly AttentionRealtimeChange[] = []): Promise<boolean> {
  assertAttentionActor(actor);
  const relevantChanges = changes.filter(change => change.readActorUserId === undefined || change.readActorUserId === actor.userId);
  const rows = await database.$queryRawUnsafe<{ authorized: boolean; relevant: boolean }[]>(`SELECT
    EXISTS(SELECT 1 FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
      WHERE u.id=$1 AND u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
      AND upper(trim(r.nombre))=$2 AND u."sedeId"=$3 AND s."aliadoId"=$4) AS authorized,
    ($5::boolean OR EXISTS(SELECT 1 FROM "AttentionConversation" c WHERE c.id=ANY($6::uuid[])
      AND c."assigneeUserId"=$1 AND c."assigneeKey"=$7 AND c."assigneeSellerId" IS NULL)) AS relevant`,
  actor.userId, actor.central ? "ADMIN" : "ANALISTA_APROBACION", actor.sedeId, actor.aliadoId,
  (actor.central && (!changes.length || relevantChanges.length > 0)) || relevantChanges.some(change => change.previousUserId === actor.userId && change.previousKey === actor.key && change.previousSellerId === null),
  relevantChanges.map(change => change.conversationId), actor.key);
  if (!rows[0]?.authorized) throw new AttentionError("La cuenta de atención ya no está autorizada.", 403);
  return rows[0].relevant;
}

export function createAttentionRealtimeStream(options: {
  actor: AttentionActor; signal: AbortSignal; broker: AttentionRealtimeBroker;
  authorize: (changes: readonly AttentionRealtimeChange[]) => Promise<boolean>;
  heartbeatMs?: number; lifetimeMs?: number; retryMs?: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup: () => void = () => undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false; let flushing = false; let readyPending = false; let degradedPending = false; let heartbeatPending = false;
      const changes = new Map<string, AttentionRealtimeChange>();
      let overflow = false; let scheduled: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        if (closed) return; closed = true; unsubscribe();
        if (scheduled) clearTimeout(scheduled);
        clearInterval(heartbeat); clearTimeout(lifetime); options.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Consumer already cancelled. */ }
      };
      const send = (text: string) => {
        if (closed) return;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) { close(); return; }
        controller.enqueue(encoder.encode(text));
      };
      const event = (name: string, data: object) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      const schedule = () => {
        if (!closed && !scheduled && !flushing) scheduled = setTimeout(() => { scheduled = null; void flush(); }, 40);
      };
      async function flush() {
        if (closed || flushing) return;
        flushing = true;
        const pending = [...changes.values()]; changes.clear();
        const ready = readyPending; const degraded = degradedPending; const beat = heartbeatPending; const force = overflow;
        readyPending = false; degradedPending = false; heartbeatPending = false; overflow = false;
        try {
          const relevant = await options.authorize(pending);
          if (closed) return;
          if (degraded || !options.broker.connected()) event("degraded", { reason: "connection_lost" });
          if (ready && options.broker.connected()) { event("ready", { connected: true }); event("invalidate", { reason: "reconnected" }); }
          else if ((relevant && pending.length) || force) event("invalidate", { reason: "conversation_changed" });
          if (beat) event("heartbeat", { at: new Date().toISOString(), connected: options.broker.connected() });
        } catch (error) {
          event(error instanceof AttentionError && [401, 403].includes(error.status) ? "unauthorized" : "degraded", {});
          close();
        } finally {
          flushing = false;
          if (changes.size || readyPending || degradedPending || heartbeatPending || overflow) schedule();
        }
      }
      const heartbeat = setInterval(() => { heartbeatPending = true; schedule(); }, options.heartbeatMs ?? 15_000);
      const lifetime = setTimeout(close, options.lifetimeMs ?? 240_000);
      cleanup = close;
      options.signal.addEventListener("abort", close, { once: true });
      if (options.signal.aborted) { close(); return; }
      send(`retry: ${options.retryMs ?? 1000 + Math.floor(Math.random() * 1000)}\n\n`);
      try {
        unsubscribe = options.broker.subscribe(message => {
          if (message.kind === "connected") readyPending = true;
          else if (message.kind === "disconnected") degradedPending = true;
          else {
            if (!recipient(options.actor, message.change)) return;
            if (changes.size < 100 || changes.has(message.change.conversationId)) {
              const previous = changes.get(message.change.conversationId);
              // A second committed transaction may have observed the assignment
              // before a transfer. Preserve proof that this subscriber lost it.
              const revoked = previous?.previousUserId === options.actor.userId && previous.previousKey === options.actor.key && previous.previousSellerId === null;
              changes.set(message.change.conversationId, revoked ? { ...message.change,
                previousUserId: previous.previousUserId, previousKey: previous.previousKey, previousSellerId: previous.previousSellerId } : message.change);
            }
            else overflow = true;
          }
          schedule();
        });
      } catch { event("degraded", {}); close(); }
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 * 1024, size: value => value.byteLength });
}
