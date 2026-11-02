import { randomUUID } from "node:crypto";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import { attentionText } from "./atencion-core";
import { metaRecipientPhone } from "./atencion-meta-identity";
import { assertDaptaEventScope, canonicalDaptaEventContact, daptaEventFingerprint, daptaEventTimestamp,
  DaptaEventError, type DaptaAttentionEvent, type DaptaEventScope } from "./atencion-dapta-events";

type EventRow = DaptaAttentionEvent & {
  id: string; conversationId: string | null; status: "pending" | "complete" | "blocked";
  historyCursor: string | null; attempts: number; nextAttemptAt: Date | string; expiresAt: Date | string;
  leaseToken: string | null; leaseUntil: Date | string | null;
};
export type DaptaEventJob = Omit<EventRow, "leaseToken" | "leaseUntil"> & { leaseToken: string; leaseUntil: Date | string };
export type DaptaConfirmedEventMessage = {
  source: { workspaceId: string; agentId: string; externalConversationId: string; contactId: string };
  verification?: { fresh: true; kind: "agent" | "followup" | "lead" };
  message: { id: string; text: string; sentAt: string; status: "sent" | "delivered" | "read"; direction: "outbound" | "inbound"; contentType: "text" };
};
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const MAX_ATTEMPTS = 20;
const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
const iso = (value: Date | string) => new Date(value).toISOString();
function fail(code: string, status = 409): never { throw new DaptaEventError(code, status); }
async function audit(db: AttentionDb, action: string, conversationId: string | null, eventId: string, count = 0) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","actorKind","actorKey",action,metadata)
    VALUES($1::uuid,'system','SYSTEM_DAPTA',$2,$3::jsonb) RETURNING id`, conversationId, action, JSON.stringify({ eventId, count }));
}
/** Queue and import operations have a system identity; no nominal admin is impersonated. */
export function createAttentionDaptaEventStore(database: AttentionDatabase, options: { scope: DaptaEventScope; now?: () => Date }) {
  const scope = options.scope;
  assertDaptaEventScope(scope);
  const now = options.now || (() => new Date());
  const transact = <T>(fn: (db: AttentionDb) => Promise<T>) => database.$transaction(fn, transactionOptions);
  function assertSource(event: Pick<DaptaAttentionEvent, keyof DaptaEventScope>) {
    if (Object.entries(scope).some(([key, value]) => event[key as keyof DaptaEventScope] !== value)) fail("DAPTA_EVENT_SCOPE_MISMATCH", 403);
  }
  async function bind(db: AttentionDb, event: Pick<DaptaAttentionEvent, "contactId" | "phone" | "externalConversationId">) {
    const bindings = await db.$queryRawUnsafe<{ conversationId: string; wabaId: string }[]>(`SELECT "conversationId","wabaId" FROM "AttentionMetaBinding"
      WHERE "phoneNumberId"=$1 AND "contactId"=$2 ORDER BY id FOR SHARE`, scope.phoneNumberId, event.contactId);
    if (bindings.length > 1 || bindings.some(binding => binding.wabaId !== scope.wabaId)) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    const rows = await db.$queryRawUnsafe<{ id: string; externalId: string | null; phone: string | null; channel: string }[]>(`SELECT id,"externalId",phone,channel FROM "AttentionConversation"
      WHERE "externalId"=$1 OR id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, event.externalConversationId, bindings.map(binding => binding.conversationId));
    if (rows.length > 1) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    const row = rows[0];
    if (!row) return null;
    if (row.channel !== "whatsapp" || (row.externalId && row.externalId !== event.externalConversationId)) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    const conversationBindings = await db.$queryRawUnsafe<{ phoneNumberId: string; wabaId: string }[]>(`SELECT "phoneNumberId","wabaId" FROM "AttentionMetaBinding"
      WHERE "conversationId"=$1::uuid ORDER BY id FOR SHARE`, row.id);
    if (conversationBindings.some(binding => binding.phoneNumberId !== scope.phoneNumberId || binding.wabaId !== scope.wabaId)) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    if (bindings.length === 1) {
      if (row.id !== bindings[0].conversationId || (event.phone !== null && row.phone !== event.phone)) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    } else if (!event.phone || row.phone !== event.phone || row.externalId !== event.externalConversationId) {
      // A legacy opaque identifier with a null phone is not enough to identify
      // a native contact. It needs the exact current-line Meta binding.
      return null;
    }
    if (!row.externalId) await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "externalId"=$2 WHERE id=$1::uuid AND "externalId" IS NULL RETURNING id`, row.id, event.externalConversationId);
    return row.id;
  }
  function validateEvent(event: DaptaAttentionEvent) {
    assertSource(event);
    if (!["new_message_sent", "new_message_received"].includes(event.event) || canonicalDaptaEventContact(event.contactId) !== event.contactId
      || event.phone !== metaRecipientPhone(event.contactId) || daptaEventFingerprint(event) !== event.fingerprint) fail("DAPTA_EVENT_INVALID", 400);
  }
  async function leased(db: AttentionDb, job: DaptaEventJob) {
    const [row] = await db.$queryRawUnsafe<EventRow[]>(`SELECT * FROM "AttentionDaptaEvent" WHERE id=$1::uuid FOR UPDATE`, job.id);
    if (!row || row.status !== "pending" || row.leaseToken !== job.leaseToken || !row.leaseUntil || Date.parse(iso(row.leaseUntil)) <= now().getTime()) fail("DAPTA_EVENT_LEASE_LOST");
    assertSource(row);
    if (row.event !== job.event || row.fingerprint !== job.fingerprint || row.messageId !== job.messageId || row.externalConversationId !== job.externalConversationId || row.contactId !== job.contactId) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    return row;
  }
  function verifiedMessage(row: EventRow, confirmed: DaptaConfirmedEventMessage, requireFresh = false) {
    const source = confirmed?.source, message = confirmed?.message;
    const inbound = row.event === "new_message_received";
    if (!source || !message || source.workspaceId !== row.workspaceId || source.agentId !== row.agentId
      || source.externalConversationId !== row.externalConversationId || canonicalDaptaEventContact(source.contactId) !== row.contactId
      || message.id !== row.messageId || message.direction !== (inbound ? "inbound" : "outbound") || message.contentType !== "text"
      || !(inbound ? ["delivered", "read"] : ["sent", "delivered", "read"]).includes(message.status)
      || (requireFresh && (confirmed.verification?.fresh !== true || !(inbound ? ["lead"] : ["agent", "followup"]).includes(confirmed.verification.kind)))) fail("DAPTA_EVENT_SCOPE_MISMATCH", 403);
    const sentAt = daptaEventTimestamp(message.sentAt), text = attentionText(message.text, 16000);
    if (sentAt !== iso(row.messageAt)) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
    return { sentAt, text };
  }
  return {
    async ingest(event: DaptaAttentionEvent) {
      validateEvent(event);
      return transact(async db => {
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        const conversationId = await bind(db, event);
        const inserted = await db.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "AttentionDaptaEvent"
          (id,event,"deliveryId","eventAt","workspaceId","agentId","agentChannelId","phoneNumberId","wabaId","externalConversationId","contactId",phone,"messageId","messageAt",fingerprint,"conversationId","nextAttemptAt","expiresAt")
          VALUES($1::uuid,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15,$16::uuid,$17::timestamptz,$18::timestamptz)
          ON CONFLICT DO NOTHING RETURNING id`, randomUUID(), event.event, event.deliveryId, event.eventAt, event.workspaceId, event.agentId,
        event.agentChannelId, event.phoneNumberId, event.wabaId, event.externalConversationId, event.contactId, event.phone, event.messageId,
        event.messageAt, event.fingerprint, conversationId, now(), new Date(now().getTime() + 15 * 60 * 1000));
        const rows = await db.$queryRawUnsafe<EventRow[]>(`SELECT * FROM "AttentionDaptaEvent" WHERE "deliveryId"=$1 OR
          ("workspaceId"=$2 AND "agentChannelId"=$3 AND "messageId"=$4) ORDER BY id FOR UPDATE`, event.deliveryId, event.workspaceId, event.agentChannelId, event.messageId);
        if (rows.length !== 1 || rows[0].fingerprint !== event.fingerprint) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        const row = rows[0];
        if (row.conversationId && conversationId && row.conversationId !== conversationId) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        if (conversationId && !row.conversationId) await db.$queryRawUnsafe(`UPDATE "AttentionDaptaEvent" SET "conversationId"=$2::uuid,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, conversationId);
        if (inserted.length) await audit(db, "DAPTA_EVENT_QUEUED", conversationId, row.id);
        return { id: row.id, duplicate: inserted.length === 0, linked: Boolean(conversationId || row.conversationId) };
      });
    },
    async claim(limit = 5): Promise<DaptaEventJob[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail("DAPTA_EVENT_INVALID", 400);
      return transact(async db => {
        const clock = now();
        await db.$queryRawUnsafe(`UPDATE "AttentionDaptaEvent" SET status='blocked',"errorCode"='DAPTA_EVENT_EXPIRED',"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
          WHERE status='pending' AND ("expiresAt"<=$1::timestamptz OR attempts>=$2) AND ("leaseUntil" IS NULL OR "leaseUntil"<=$1::timestamptz)
          AND "workspaceId"=$3 AND "agentId"=$4 AND "agentChannelId"=$5 AND "phoneNumberId"=$6 AND "wabaId"=$7 RETURNING id`,
        clock, MAX_ATTEMPTS, scope.workspaceId, scope.agentId, scope.agentChannelId, scope.phoneNumberId, scope.wabaId);
        const rows = await db.$queryRawUnsafe<EventRow[]>(`SELECT * FROM "AttentionDaptaEvent" WHERE status='pending' AND "workspaceId"=$1 AND "agentId"=$2
          AND "agentChannelId"=$3 AND "phoneNumberId"=$4 AND "wabaId"=$5 AND "nextAttemptAt"<=$6::timestamptz
          AND "expiresAt">$6::timestamptz AND attempts<$7 AND ("leaseUntil" IS NULL OR "leaseUntil"<=$6::timestamptz)
          ORDER BY "nextAttemptAt",id LIMIT $8 FOR UPDATE SKIP LOCKED`, scope.workspaceId, scope.agentId, scope.agentChannelId, scope.phoneNumberId, scope.wabaId, clock, MAX_ATTEMPTS, limit);
        const result: DaptaEventJob[] = [];
        for (const row of rows) {
          const [claimed] = await db.$queryRawUnsafe<DaptaEventJob[]>(`UPDATE "AttentionDaptaEvent" SET "leaseToken"=$2::uuid,"leaseUntil"=$3::timestamptz,attempts=attempts+1,"updatedAt"=now()
            WHERE id=$1::uuid RETURNING *`, row.id, randomUUID(), new Date(clock.getTime() + 90_000));
          result.push(claimed);
        }
        return result;
      });
    },
    async retry(job: DaptaEventJob, input: { delaySeconds: number; code: string; historyCursor?: string | null }) {
      if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 3600) fail("DAPTA_EVENT_INVALID", 400);
      if (input.historyCursor !== undefined && input.historyCursor !== null && (typeof input.historyCursor !== "string" || !input.historyCursor || input.historyCursor.length > 4096 || /[\x00-\x20\x7f]/.test(input.historyCursor))) fail("DAPTA_EVENT_INVALID", 400);
      const code = ["DAPTA_PENDING", "DAPTA_NOT_FOUND", "DAPTA_FAILED", "DAPTA_RATE_LIMITED", "DAPTA_UNAVAILABLE", "DAPTA_BINDING_PENDING", "DAPTA_SCOPE_MISMATCH", "DAPTA_EXTENSION_PENDING"].includes(input.code) ? input.code : "DAPTA_UNAVAILABLE";
      return transact(async db => {
        const row = await leased(db, job);
        const blocked = input.code === "DAPTA_FAILED" || input.code === "DAPTA_SCOPE_MISMATCH" || row.attempts >= MAX_ATTEMPTS || new Date(row.expiresAt).getTime() <= now().getTime();
        await db.$queryRawUnsafe(`UPDATE "AttentionDaptaEvent" SET status=$2,"nextAttemptAt"=$3::timestamptz,"leaseToken"=NULL,"leaseUntil"=NULL,
          "errorCode"=$4,"historyCursor"=$5,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, blocked ? "blocked" : "pending",
        new Date(now().getTime() + input.delaySeconds * 1000), code, input.historyCursor === undefined ? row.historyCursor : input.historyCursor);
        return { blocked };
      });
    },
    /** Commit the binding read before invoking a financial store with its own transaction. */
    async getVerifiedConversation(job: DaptaEventJob, confirmed: DaptaConfirmedEventMessage) {
      return transact(async db => {
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        const row = await leased(db, job);
        verifiedMessage(row, confirmed, true);
        const conversationId = await bind(db, row);
        if (row.conversationId && conversationId && row.conversationId !== conversationId) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        return { conversationId };
      });
    },
    /** Native Meta already owns inbound history; only acknowledge the witnessed event. */
    async completeVerifiedInbound(job: DaptaEventJob, confirmed: DaptaConfirmedEventMessage) {
      return transact(async db => {
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        const row = await leased(db, job);
        if (row.event !== "new_message_received") fail("DAPTA_EVENT_SCOPE_MISMATCH", 403);
        verifiedMessage(row, confirmed, true);
        const conversationId = await bind(db, row);
        if (!conversationId) return { imported: false, pendingBinding: true };
        if (row.conversationId && row.conversationId !== conversationId) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        await db.$queryRawUnsafe(`UPDATE "AttentionDaptaEvent" SET status='complete',"conversationId"=$2::uuid,"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"completedAt"=$3::timestamptz,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, conversationId, now());
        await audit(db, "DAPTA_INBOUND_VERIFIED", conversationId, row.id);
        return { imported: false, pendingBinding: false };
      });
    },
    async persistConfirmed(job: DaptaEventJob, confirmed: DaptaConfirmedEventMessage) {
      return transact(async db => {
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        const row = await leased(db, job), message = confirmed?.message;
        if (row.event !== "new_message_sent") fail("DAPTA_EVENT_SCOPE_MISMATCH", 403);
        const { sentAt, text } = verifiedMessage(row, confirmed);
        const conversationId = await bind(db, row);
        if (!conversationId) return { imported: false, pendingBinding: true };
        if (row.conversationId && row.conversationId !== conversationId) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        const existing = await db.$queryRawUnsafe<{ id: string; conversationId: string; direction: string; text: string; sentAt: Date | string; author: string | null; deliveryStatus: string | null; metaWamid: string | null }[]>(`SELECT id,"conversationId",direction,text,"sentAt",author,"deliveryStatus","metaWamid" FROM "AttentionMessage"
          WHERE "externalId"=$1 ORDER BY id FOR UPDATE`, row.messageId);
        if (existing.length > 1 || existing.some(value => value.conversationId !== conversationId || value.direction !== "outbound" || value.text !== text || iso(value.sentAt) !== sentAt || value.metaWamid !== null || value.author !== null && value.author !== "Diana")) fail("DAPTA_EVENT_IDENTITY_CONFLICT");
        let inserted = false;
        if (!existing.length) {
          await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,"deliveryStatus")
            VALUES($1::uuid,$2::uuid,$3,'outbound',$4,$5::timestamptz,'Diana',$6) RETURNING id`, randomUUID(), conversationId, row.messageId, text, sentAt, message.status);
          inserted = true;
        } else if (existing[0].author !== "Diana" || (rank[existing[0].deliveryStatus || ""] || 0) < rank[message.status]) {
          const status = (rank[existing[0].deliveryStatus || ""] || 0) > rank[message.status] ? existing[0].deliveryStatus : message.status;
          await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET author='Diana',"deliveryStatus"=$2 WHERE id=$1::uuid RETURNING id`, existing[0].id, status);
        }
        if (inserted) await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "lastContactAt"=GREATEST("lastContactAt",$2::timestamptz),version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, conversationId, sentAt);
        await db.$queryRawUnsafe(`UPDATE "AttentionDaptaEvent" SET status='complete',"conversationId"=$2::uuid,"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"completedAt"=$3::timestamptz,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, conversationId, now());
        await audit(db, "DAPTA_RESPONSE_IMPORTED", conversationId, row.id, inserted ? 1 : 0);
        return { imported: inserted, pendingBinding: false };
      });
    },
  };
}
