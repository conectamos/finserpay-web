import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionText, attentionUuid, normalizeAttentionPhone } from "./atencion-core";
import type { AttentionActor, AttentionMessage } from "./atencion-types";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import type { MetaScope, MetaWebhookEvents, MetaDeliveryStatus } from "./atencion-meta";
import { applyWhatsAppAutomationDelivery } from "./whatsapp-automation-meta-storage";

export type MetaReplyAttachment = {
  kind: "image" | "audio" | "video" | "document" | "sticker";
  mimeType: string; fileName: string | null; sha256: string; size: number;
};
type StoredAttachment = { kind: MetaReplyAttachment["kind"]; mediaId: string; mimeType: string; fileName: string | null; sha256?: string };
type MetaConversation = { id: string; phone: string | null; version: number; metaManaged: boolean; metaLastInboundAt: Date | string | null;
  lastContactAt: Date | string | null; closedAt: Date | string | null; status: string; assigneeKey: string | null };
export type MetaReply = {
  id: string; conversationId: string; userId: number; actorKey: string; authorName: string; requestId: string;
  fingerprint: string; conversationVersion: number; phoneNumberId: string; wabaId: string; contactId: string;
  text: string; attachment: MetaReplyAttachment | null; uploadedMediaId: string | null;
  status: NonNullable<AttentionMessage["deliveryStatus"]>; messageId: string | null; wamid: string | null;
  leaseToken: string | null; leaseUntil: Date | string | null; sendStartedAt: Date | string | null;
  acceptedAt: Date | string | null; deliveryAt: Date | string | null; errorCode: string | null;
  createdAt: Date | string; updatedAt: Date | string; attempts: number;
};
export type AttentionMetaStorageOptions = { scope: MetaScope; sendingEnabled?: boolean; cutoverConfirmed?: boolean; now?: () => Date;
  beforeReplySend?: (db: AttentionDb, actor: AttentionActor, reply: MetaReply) => Promise<void> };
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const rank: Record<string, number> = { queued: 0, sending: 0, uncertain: 0, failed: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
const date = (value: Date | string) => new Date(value).toISOString();
const strictId = (value: unknown, max = 256) => {
  if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9_.:+/=-]+$/.test(value)) throw new AttentionError("Identificador de Meta inválido.");
  return value;
};
const wamid = (value: unknown) => { const id = strictId(value, 512); if (!id.startsWith("wamid.")) throw new AttentionError("Identificador de mensaje inválido."); return id; };
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/i.test(value) ? value : "META_DELIVERY_ERROR";
function timestamp(value: unknown) {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AttentionError("Fecha de Meta inválida.");
  return new Date(value).toISOString();
}
export async function attentionMetaSchemaReady(db: AttentionDb) {
  const [row] = await db.$queryRawUnsafe<{ready: boolean}[]>(`SELECT to_regclass('public."AttentionMetaBinding"') IS NOT NULL
    AND to_regclass('public."AttentionMetaOutbox"') IS NOT NULL AND to_regclass('public."AttentionMetaDelivery"') IS NOT NULL AS ready`);
  return row?.ready === true;
}
async function systemAudit(db: AttentionDb, action: string, conversationId: string | null, metadata: object = {}) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","actorKind","actorKey",action,metadata)
    VALUES($1::uuid,'system','SYSTEM_META',$2,$3::jsonb) RETURNING id`, conversationId, action, JSON.stringify(metadata));
}
async function userAudit(db: AttentionDb, actor: AttentionActor, action: string, conversationId: string, metadata: object = {}) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","actorKey",action,metadata)
    VALUES($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`, conversationId, actor.userId, actor.key, action, JSON.stringify(metadata));
}
async function assertActor(db: AttentionDb, actor: AttentionActor) {
  assertAttentionActor(actor);
  const [row] = await db.$queryRawUnsafe<{role: string}[]>(`SELECT upper(trim(r.nombre)) AS role FROM "Usuario" u
    JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.id=$1 AND u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
    AND u."sedeId"=$2 AND s."aliadoId"=$3 FOR SHARE OF u,r,s,a`, actor.userId, actor.sedeId, actor.aliadoId);
  if (row?.role !== (actor.central ? "ADMIN" : "ANALISTA_APROBACION")) throw new AttentionError("La cuenta de atención ya no está autorizada.", 403);
}
async function scopedConversation(db: AttentionDb, actor: AttentionActor, id: string) {
  await assertActor(db, actor);
  const [row] = await db.$queryRawUnsafe<MetaConversation[]>(`SELECT * FROM "AttentionConversation" c WHERE c.id=$1::uuid
    AND ($2::boolean OR (c."assigneeUserId"=$3 AND c."assigneeKey"=$4 AND c."assigneeSellerId" IS NULL)) FOR UPDATE`, attentionUuid(id), actor.central, actor.userId, actor.key);
  if (!row) throw new AttentionError("Conversación no encontrada o no autorizada.", 404);
  return row;
}
export function attentionMetaMessage(row: {id: string; conversationId: string; direction: "inbound" | "outbound"; text: string;
  sentAt: Date | string; author: string | null; attachment?: StoredAttachment | null; deliveryStatus?: AttentionMessage["deliveryStatus"] | null}): AttentionMessage {
  return { id: row.id, direction: row.direction, text: row.text, sentAt: date(row.sentAt), author: row.author,
    ...(row.deliveryStatus ? { deliveryStatus: row.deliveryStatus } : {}),
    ...(row.attachment ? { attachment: { id: row.id, kind: row.attachment.kind, mimeType: row.attachment.mimeType,
      fileName: row.attachment.fileName, url: `/api/atencion/${row.conversationId}/messages/${row.id}/media` } } : {}) };
}
export function attentionMetaReplyMessage(row: MetaReply): AttentionMessage {
  return { id: row.messageId || row.id, direction: "outbound", text: row.text, sentAt: date(row.acceptedAt || row.createdAt), author: row.authorName,
    deliveryStatus: row.status, deliveryError: row.status === "failed" ? "No se pudo enviar el mensaje." : row.status === "uncertain" ? "El envío está pendiente de confirmación. No lo reenvíes." : null,
    ...(row.attachment ? { attachment: { id: row.messageId || row.id, kind: row.attachment.kind, mimeType: row.attachment.mimeType,
      fileName: row.attachment.fileName, url: row.messageId ? `/api/atencion/${row.conversationId}/messages/${row.messageId}/media` : null } } : {}) };
}
export async function attentionMetaPendingMessages(db: AttentionDb, conversationId: string): Promise<AttentionMessage[]> {
  const rows = await db.$queryRawUnsafe<MetaReply[]>(`SELECT * FROM "AttentionMetaOutbox" WHERE "conversationId"=$1::uuid AND "messageId" IS NULL ORDER BY "createdAt" DESC,id DESC LIMIT 100`, conversationId);
  return rows.reverse().map(attentionMetaReplyMessage);
}
function attachmentInput(input?: MetaReplyAttachment) {
  if (!input) return null;
  if (!["image","audio","video","document","sticker"].includes(input.kind) || typeof input.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.mimeType)
    || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 100 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new AttentionError("Adjunto inválido.");
  return { kind: input.kind, mimeType: input.mimeType.toLowerCase(), fileName: input.fileName ? attentionText(input.fileName, 240) : null, sha256: input.sha256.toLowerCase(), size: input.size };
}
function statusAfter(current: string, incoming: string) {
  if (incoming === "failed") return (rank[current] ?? 0) < 3 ? "failed" : current;
  return (rank[incoming] ?? 0) > (rank[current] ?? 0) ? incoming : current;
}

/** No network calls. The route verifies webhook signatures; the configured scope is checked again here. */
export function createAttentionMetaStore(database: AttentionDatabase, options: AttentionMetaStorageOptions) {
  const scope = { phoneNumberId: strictId(options.scope.phoneNumberId), wabaId: strictId(options.scope.wabaId) };
  const now = options.now ?? (() => new Date());
  const transact = <T>(fn: (db: AttentionDb) => Promise<T>) => database.$transaction(async db => {
    if (!await attentionMetaSchemaReady(db)) throw new AttentionError("La preparación de Meta está pendiente.", 503);
    return fn(db);
  }, transactionOptions);
  function messaging(row: MetaConversation) {
    const expiresAt = row.metaLastInboundAt ? new Date(new Date(row.metaLastInboundAt).getTime() + 24 * 3600000) : null;
    const reason = !row.metaManaged ? "Esta conversación todavía no está conectada a Meta."
      : !options.sendingEnabled || !options.cutoverConfirmed ? "El envío está pendiente de validar Meta y el control de la IA."
        : !expiresAt || expiresAt.getTime() <= now().getTime() ? "La ventana de respuesta de 24 horas está cerrada." : null;
    return { windowExpiresAt: expiresAt?.toISOString() ?? null, canReply: reason === null, reason };
  }
  async function binding(db: AttentionDb, conversationId: string) {
    const rows = await db.$queryRawUnsafe<{contactId: string}[]>(`SELECT "contactId" FROM "AttentionMetaBinding" WHERE "conversationId"=$1::uuid
      AND "phoneNumberId"=$2 AND "wabaId"=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1`, conversationId, scope.phoneNumberId, scope.wabaId);
    if (!rows[0]) throw new AttentionError("La conversación no corresponde al canal Meta configurado.", 409);
    return rows[0];
  }
  async function reply(db: AttentionDb, actor: AttentionActor, conversationId: string, requestId: string) {
    await scopedConversation(db, actor, conversationId);
    const [row] = await db.$queryRawUnsafe<MetaReply[]>(`SELECT * FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid FOR UPDATE`, actor.key, attentionUuid(requestId));
    if (row && row.conversationId !== conversationId) throw new AttentionError("La solicitud pertenece a otra conversación.", 409);
    if (row && (row.phoneNumberId !== scope.phoneNumberId || row.wabaId !== scope.wabaId)) throw new AttentionError("El canal configurado cambió.", 409);
    return row ?? null;
  }
  async function ownedReply(db: AttentionDb, actor: AttentionActor, id: string, leaseToken: string) {
    const [location] = await db.$queryRawUnsafe<{conversationId: string}[]>(`SELECT "conversationId" FROM "AttentionMetaOutbox" WHERE id=$1::uuid`, attentionUuid(id));
    if (!location) throw new AttentionError("Envío no encontrado.", 404);
    const conversation = await scopedConversation(db, actor, location.conversationId);
    const [row] = await db.$queryRawUnsafe<MetaReply[]>(`SELECT * FROM "AttentionMetaOutbox" WHERE id=$1::uuid FOR UPDATE`, id);
    if (row.actorKey !== actor.key || row.userId !== actor.userId) throw new AttentionError("El envío pertenece a otro usuario.", 403);
    if (row.phoneNumberId !== scope.phoneNumberId || row.wabaId !== scope.wabaId || row.leaseToken !== attentionUuid(leaseToken)
      || !row.leaseUntil || new Date(row.leaseUntil) <= now()) throw new AttentionError("La reserva del envío venció.", 409);
    return { row, conversation };
  }
  // Every writer locks the conversation before its outbox row, including webhooks.
  async function systemReply(db: AttentionDb, id: string) {
    const [location] = await db.$queryRawUnsafe<{conversationId:string}[]>(`SELECT "conversationId" FROM "AttentionMetaOutbox" WHERE id=$1::uuid AND "phoneNumberId"=$2 AND "wabaId"=$3`, attentionUuid(id), scope.phoneNumberId, scope.wabaId);
    if (!location) throw new AttentionError("Envío no encontrado.",404);
    await db.$queryRawUnsafe(`SELECT id FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, location.conversationId);
    return (await db.$queryRawUnsafe<MetaReply[]>(`SELECT * FROM "AttentionMetaOutbox" WHERE id=$1::uuid FOR UPDATE`,id))[0];
  }
  async function accepted(db: AttentionDb, row: MetaReply, providerId: string) {
    const messageId = row.messageId || randomUUID();
    if (row.wamid && row.wamid !== providerId) throw new AttentionError("El envío tiene otra confirmación de Meta.", 409);
    if (!row.sendStartedAt) throw new AttentionError("El envío todavía no fue iniciado.", 409);
    const attachment = row.attachment && row.uploadedMediaId ? { ...row.attachment, mediaId: row.uploadedMediaId } : null;
    if (!row.messageId) {
      await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,"metaWamid","metaPhoneNumberId",attachment,"deliveryStatus")
        VALUES($1::uuid,$2::uuid,$3,'outbound',$4,$5::timestamptz,$6,$7,$8,$9::jsonb,'accepted') RETURNING id`,
      messageId, row.conversationId, `meta:${providerId}`, row.text, row.sendStartedAt, row.authorName, providerId, row.phoneNumberId, JSON.stringify(attachment));
      await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "lastContactAt"=GREATEST("lastContactAt",$2::timestamptz),"updatedAt"=now(),version=version+1 WHERE id=$1::uuid RETURNING id`, row.conversationId, row.sendStartedAt);
    }
    const [updated] = await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET "messageId"=$2::uuid,wamid=$3,
      status=CASE WHEN status IN ('queued','sending','uncertain') THEN 'accepted' ELSE status END,"acceptedAt"=COALESCE("acceptedAt",now()),
      "leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`, row.id, messageId, providerId);
    return updated;
  }
  async function applyDelivery(db: AttentionDb, event: MetaDeliveryStatus) {
    const candidates = await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionMetaOutbox" WHERE "phoneNumberId"=$1 AND "wabaId"=$2
      AND (wamid=$3 OR ($4::uuid IS NOT NULL AND id=$4::uuid)) ORDER BY id LIMIT 2`, scope.phoneNumberId, scope.wabaId, event.id, event.requestId ?? null);
    if(candidates.length !== 1) return false;
    let outbox = await systemReply(db,candidates[0].id);
    if (outbox.contactId !== event.recipient || !outbox.sendStartedAt) return false;
    if (outbox.wamid && outbox.wamid !== event.id) return false;
    if (!outbox.messageId) outbox = await accepted(db, outbox, event.id);
    // A replayed pre-failure "sent" receipt cannot revive a confirmed failure.
    // Actual delivery/read evidence is stronger and may still advance it.
    if(outbox.status==='failed' && event.status==='sent' && outbox.deliveryAt && new Date(event.timestamp)<=new Date(outbox.deliveryAt))return false;
    const staleFailure = event.status === "failed" && outbox.deliveryAt && new Date(event.timestamp) < new Date(outbox.deliveryAt);
    const next = staleFailure ? outbox.status : statusAfter(outbox.status, event.status);
    // A later receipt may improve delivery even when webhook arrival order differs.
    if (next === outbox.status && outbox.deliveryAt && new Date(outbox.deliveryAt) >= new Date(event.timestamp)) return false;
    const errorCode = next === "failed" ? safeCode(event.errorCodes?.[0]?.toString()) : null;
    await db.$queryRawUnsafe(`UPDATE "AttentionMetaOutbox" SET status=$2,"deliveryAt"=GREATEST("deliveryAt",$3::timestamptz),"errorCode"=$4,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, outbox.id, next, event.timestamp, errorCode);
    await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "deliveryStatus"=$2,"deliveryAt"=GREATEST("deliveryAt",$3::timestamptz) WHERE id=$1::uuid RETURNING id`, outbox.messageId, next, event.timestamp);
    await systemAudit(db, "META_DELIVERY_UPDATED", outbox.conversationId, { outboxId: outbox.id, status: next });
    return true;
  }
  async function recoverExpired(db: AttentionDb,row:MetaReply) {
    const expires = row.leaseUntil ? new Date(row.leaseUntil).getTime() : new Date(row.createdAt).getTime()+120000;
    if(expires>now().getTime() || !['queued','sending'].includes(row.status))return row;
    const uncertain = row.status==='sending' || Boolean(row.sendStartedAt);
    const [updated]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET status=$2,"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=$3,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,row.id,uncertain?'uncertain':'failed',uncertain?'LEASE_EXPIRED_AFTER_SEND':'LEASE_EXPIRED_BEFORE_SEND');
    await systemAudit(db,"META_REPLY_RECOVERED",row.conversationId,{outboxId:row.id,status:updated.status});return updated;
  }
  return {
    async getMessaging(actor: AttentionActor, conversationId: string) {
      return database.$transaction(async db => {
        const row = await scopedConversation(db, actor, conversationId);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId",action) VALUES($1::uuid,$2,'META_MESSAGING_READ') RETURNING id`,row.id,actor.userId);
        if (!await attentionMetaSchemaReady(db)) return {windowExpiresAt:null,canReply:false,reason:"La preparación de Meta está pendiente."};
        const [channel] = await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionMetaBinding" WHERE "conversationId"=$1::uuid AND "phoneNumberId"=$2 AND "wabaId"=$3 LIMIT 1`,row.id,scope.phoneNumberId,scope.wabaId);
        return channel ? messaging(row) : {windowExpiresAt:null,canReply:false,reason:"Esta conversación todavía no está conectada al canal Meta configurado."};
      }, transactionOptions);
    },
    async ingest(events: MetaWebhookEvents) {
      if (events.scope.phoneNumberId !== scope.phoneNumberId || events.scope.wabaId !== scope.wabaId) throw new AttentionError("El evento no pertenece al canal configurado.", 403);
      if (!Array.isArray(events.messages) || !Array.isArray(events.statuses) || events.messages.length + events.statuses.length > 1000) throw new AttentionError("Lote Meta inválido.");
      return transact(async db => {
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        let messagesImported = 0, statusesApplied = 0;
        for (const message of [...events.messages].sort((a,b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id))) {
          const providerId = wamid(message.id), contactId = strictId(message.from), sentAt = timestamp(message.timestamp);
          const phone = message.phone ? normalizeAttentionPhone(message.phone) : null;
          await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:phone:${phone || `${scope.phoneNumberId}:${contactId}`}`);
          const [duplicate] = await db.$queryRawUnsafe<{id: string}[]>(`SELECT id FROM "AttentionMessage" WHERE "metaPhoneNumberId"=$1 AND "metaWamid"=$2`, scope.phoneNumberId, providerId);
          if (duplicate) continue;
          const bindings = await db.$queryRawUnsafe<{conversationId: string; wabaId: string}[]>(`SELECT "conversationId","wabaId" FROM "AttentionMetaBinding" WHERE "phoneNumberId"=$1 AND "contactId"=$2 FOR UPDATE`, scope.phoneNumberId, contactId);
          if (bindings[0] && bindings[0].wabaId !== scope.wabaId) throw new AttentionError("La cuenta Meta no coincide.", 409);
          let conversationId = bindings[0]?.conversationId;
          if (!conversationId && phone) {
            const candidates = await db.$queryRawUnsafe<{id: string}[]>(`SELECT c.id FROM "AttentionConversation" c WHERE c.channel='whatsapp' AND c.phone=$1
              AND NOT EXISTS(SELECT 1 FROM "AttentionMetaBinding" b WHERE b."conversationId"=c.id AND (b."phoneNumberId"<>$2 OR b."wabaId"<>$3)) ORDER BY c.id LIMIT 2 FOR UPDATE`, phone, scope.phoneNumberId, scope.wabaId);
            if (candidates.length === 1) conversationId = candidates[0].id;
          }
          if (!conversationId) {
            conversationId = randomUUID();
            await db.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,phone,name,"metaManaged") VALUES($1::uuid,'whatsapp',$2,$3,true) RETURNING id`, conversationId, phone,
              message.name ? attentionText(message.name,160) : phone || "Contacto de WhatsApp");
          }
          if (!bindings.length) await db.$queryRawUnsafe(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1::uuid,$2::uuid,$3,$4,$5) RETURNING id`, randomUUID(), conversationId, scope.phoneNumberId, scope.wabaId, contactId);
          const [conversation] = await db.$queryRawUnsafe<MetaConversation[]>(`SELECT * FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, conversationId);
          if (conversation.phone && phone && conversation.phone !== phone) throw new AttentionError("La identidad del contacto cambió.",409);
          let attachment: StoredAttachment | null = null;
          if (message.media) {
            if (!["image","audio","video","document","sticker"].includes(message.type)) throw new AttentionError("Tipo de adjunto inválido.");
            attachment = { kind: message.type as StoredAttachment["kind"], mediaId: strictId(message.media.id), mimeType: attentionText(message.media.mimeType,120),
              fileName: message.media.fileName ? attentionText(message.media.fileName,240) : null, ...(message.media.sha256 ? {sha256:attentionText(message.media.sha256,128)} : {}) };
          }
          const text = attentionText(message.text || message.media?.caption || "",16000,false);
          if (!text && !attachment) throw new AttentionError("Mensaje vacío.");
          await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt","metaWamid","metaPhoneNumberId",attachment,"replyToWamid")
            VALUES($1::uuid,$2::uuid,$3,'inbound',$4,$5::timestamptz,$6,$7,$8::jsonb,$9) RETURNING id`,randomUUID(),conversationId,`meta:${providerId}`,text,sentAt,providerId,scope.phoneNumberId,JSON.stringify(attachment),message.replyToId ? wamid(message.replyToId) : null);
          await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "metaManaged"=true,phone=COALESCE(phone,$2),
            "metaLastInboundAt"=GREATEST("metaLastInboundAt",$3::timestamptz),"lastContactAt"=GREATEST("lastContactAt",$3::timestamptz),
            status=CASE WHEN status='closed' AND $3::timestamptz>COALESCE("closedAt","updatedAt") THEN 'pending' ELSE status END,
            "closedAt"=CASE WHEN status='closed' AND $3::timestamptz>COALESCE("closedAt","updatedAt") THEN NULL ELSE "closedAt" END,
            version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, conversationId,phone,sentAt);
          await systemAudit(db,"META_MESSAGE_RECEIVED",conversationId,{attachment:Boolean(attachment)}); messagesImported++;
        }
        for (const event of events.statuses) {
          wamid(event.id); strictId(event.recipient); timestamp(event.timestamp);
          if (!["sent","delivered","read","failed"].includes(event.status)) throw new AttentionError("Estado Meta inválido.");
          if (event.requestId) attentionUuid(event.requestId);
          await db.$queryRawUnsafe(`INSERT INTO "AttentionMetaDelivery"(id,"phoneNumberId","wabaId",wamid,recipient,status,"eventAt","errorCode","requestId")
            VALUES($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9::uuid) ON CONFLICT("phoneNumberId",wamid,status,"eventAt") DO NOTHING RETURNING id`,
          randomUUID(),scope.phoneNumberId,scope.wabaId,event.id,event.recipient,event.status,event.timestamp,event.errorCodes?.[0]?.toString() ?? null,event.requestId ?? null);
          if(await applyDelivery(db,event) || await applyWhatsAppAutomationDelivery(db,scope,event)) statusesApplied++;
        }
        return {messagesImported,statusesApplied};
      });
    },
    async queueReply(actor: AttentionActor, conversationId: string, input: {requestId:string;version:number;text:string;attachment?:MetaReplyAttachment}) {
      const requestId=attentionUuid(input.requestId), text=attentionText(input.text,4096,false), attachment=attachmentInput(input.attachment);
      if ((!text&&!attachment)||!Number.isSafeInteger(input.version)||input.version<1) throw new AttentionError("Respuesta inválida.");
      const fingerprint=createHash("sha256").update(JSON.stringify({conversationId,text,attachment,version:input.version})).digest("hex");
      return transact(async db=>{
        const conversation=await scopedConversation(db,actor,conversationId);
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:meta:request:${actor.key}:${requestId}`);
        const [reserved]=await db.$queryRawUnsafe<{fingerprint:string}[]>(`SELECT fingerprint FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,actor.key,requestId);
        if(reserved)throw new AttentionError(reserved.fingerprint==='META_REPLY_CANCELLED'?"La solicitud fue cancelada y ya no puede enviarse.":"La solicitud ya corresponde a otra operación.",409);
        const existing=await reply(db,actor,conversationId,requestId);
        if(existing){ if(existing.fingerprint!==fingerprint)throw new AttentionError("La solicitud ya se usó con otro contenido.",409); return existing; }
        const [unresolved]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionMetaOutbox" WHERE "conversationId"=$1::uuid AND status IN ('queued','sending','uncertain') LIMIT 1`,conversationId);
        if(unresolved)throw new AttentionError("Hay un envío pendiente de confirmación. Revisa su estado antes de escribir otro mensaje.",409);
        const capability=messaging(conversation); if(!capability.canReply)throw new AttentionError(capability.reason!,409);
        if(conversation.version!==input.version)throw new AttentionError("La conversación cambió. Actualiza antes de responder.",409);
        const recipient=await binding(db,conversationId);
        const [row]=await db.$queryRawUnsafe<MetaReply[]>(`INSERT INTO "AttentionMetaOutbox"(id,"conversationId","userId","actorKey","authorName","requestId",fingerprint,"conversationVersion","phoneNumberId","wabaId","contactId",text,attachment)
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,randomUUID(),conversationId,actor.userId,actor.key,actor.name,requestId,fingerprint,input.version,scope.phoneNumberId,scope.wabaId,recipient.contactId,text,JSON.stringify(attachment));
        await userAudit(db,actor,"META_REPLY_QUEUED",conversationId,{outboxId:row.id,requestId}); return row;
      });
    },
    async cancelReply(actor:AttentionActor,conversationId:string,requestId:string){
      attentionUuid(requestId);
      return transact(async db=>{
        await scopedConversation(db,actor,conversationId);
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:meta:request:${actor.key}:${requestId}`);
        const [reserved]=await db.$queryRawUnsafe<{fingerprint:string;resultId:string|null}[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,actor.key,requestId);
        if(reserved){
          if(reserved.fingerprint==='META_REPLY_CANCELLED'&&reserved.resultId===conversationId)return {cancelled:true};
          throw new AttentionError("La solicitud ya corresponde a otra operación.",409);
        }
        const row=await reply(db,actor,conversationId,requestId);
        if(row && (row.sendStartedAt || row.wamid || row.messageId || ['sending','uncertain','accepted','sent','delivered','read'].includes(row.status)))throw new AttentionError("El envío ya se inició y no puede cancelarse. Consulta su estado.",409);
        if(row)await db.$queryRawUnsafe(`UPDATE "AttentionMetaOutbox" SET status='failed',"errorCode"='USER_CANCELLED',"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,row.id);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint,"resultId") VALUES($1,$2::uuid,'META_REPLY_CANCELLED',$3::uuid) RETURNING "requestId"`,actor.key,requestId,conversationId);
        await userAudit(db,actor,"META_REPLY_CANCELLED",conversationId,{requestId,outboxId:row?.id??null});return {cancelled:true};
      });
    },
    async findReply(actor:AttentionActor,conversationId:string,requestId:string){return transact(async db=>{const row=await reply(db,actor,conversationId,requestId);await userAudit(db,actor,"META_REPLY_READ",conversationId);return row?recoverExpired(db,row):null;});},
    async claimReply(actor:AttentionActor,conversationId:string,requestId:string){return transact(async db=>{
      const conversation=await scopedConversation(db,actor,conversationId);
      const lastInboundAt=conversation.metaLastInboundAt?date(conversation.metaLastInboundAt):null;
      const row=await reply(db,actor,conversationId,requestId);if(!row)throw new AttentionError("Envío no encontrado.",404);
      if(row.status==='sending'&&row.leaseUntil&&new Date(row.leaseUntil)<=now()){
        const [uncertain]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET status='uncertain',"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"='LEASE_EXPIRED_AFTER_SEND',"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,row.id);
        await systemAudit(db,"META_REPLY_UNCERTAIN",conversationId,{outboxId:row.id});return {reply:uncertain,claimed:false,lastInboundAt};
      }
      if(row.status!=='queued'||row.leaseUntil&&new Date(row.leaseUntil)>now())return {reply:{...row,leaseToken:null},claimed:false,lastInboundAt};
      const [claimed]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET "leaseToken"=$2::uuid,"leaseUntil"=$3::timestamptz,attempts=attempts+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,row.id,randomUUID(),new Date(now().getTime()+120000));
      await userAudit(db,actor,"META_REPLY_CLAIMED",conversationId,{outboxId:row.id});return {reply:claimed,claimed:true,lastInboundAt};
    });},
    async setUploadedMedia(actor:AttentionActor,id:string,leaseToken:string,mediaId:string){return transact(async db=>{
      const {row}=await ownedReply(db,actor,id,leaseToken);if(row.status!=='queued'||!row.attachment||row.sendStartedAt)throw new AttentionError("El envío no admite un adjunto nuevo.",409);
      const [updated]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET "uploadedMediaId"=$2,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,strictId(mediaId));
      await userAudit(db,actor,"META_MEDIA_UPLOADED",row.conversationId,{outboxId:id});return updated;
    });},
    async beforeSend(actor:AttentionActor,id:string,leaseToken:string){return transact(async db=>{
      const {row,conversation}=await ownedReply(db,actor,id,leaseToken);const capability=messaging(conversation);
      if(!capability.canReply)throw new AttentionError(capability.reason!,409);
      if(row.status!=='queued'||row.sendStartedAt||conversation.version!==row.conversationVersion)throw new AttentionError("La conversación o el envío cambió. No se envió el mensaje.",409);
      const recipient=await binding(db,conversation.id);if(recipient.contactId!==row.contactId)throw new AttentionError("El contacto cambió.",409);
      if(row.attachment&&!row.uploadedMediaId)throw new AttentionError("El adjunto no fue cargado.",409);
      await options.beforeReplySend?.(db,actor,row);
      const [updated]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET status='sending',"sendStartedAt"=$2::timestamptz,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,now());
      await userAudit(db,actor,"META_REPLY_SENDING",row.conversationId,{outboxId:id});return updated;
    });},
    async acceptReply(id:string,leaseToken:string,providerId:string){return transact(async db=>{
      const row=await systemReply(db,id);
      const confirmed=wamid(providerId);if(row.wamid===confirmed&&row.messageId)return row;
      if(row.leaseToken!==attentionUuid(leaseToken)||!['sending','uncertain'].includes(row.status))throw new AttentionError("La reserva del envío cambió.",409);
      const result=await accepted(db,row,confirmed);
      const deliveries=await db.$queryRawUnsafe<{id:string;recipient:string;timestamp:Date|string;status:MetaDeliveryStatus['status'];errorCode:string|null;requestId:string|null}[]>(`SELECT wamid AS id,recipient,"eventAt" AS timestamp,status,"errorCode","requestId" FROM "AttentionMetaDelivery" WHERE "phoneNumberId"=$1 AND "wabaId"=$2 AND wamid=$3 ORDER BY "eventAt",id`,scope.phoneNumberId,scope.wabaId,confirmed);
      for(const event of deliveries)await applyDelivery(db,{...event,timestamp:date(event.timestamp),errorCodes:event.errorCode?[Number(event.errorCode)]:[],requestId:event.requestId??undefined});
      await systemAudit(db,"META_REPLY_ACCEPTED",row.conversationId,{outboxId:id});
      return (await db.$queryRawUnsafe<MetaReply[]>(`SELECT * FROM "AttentionMetaOutbox" WHERE id=$1::uuid`,result.id))[0];
    });},
    async failReply(id:string,leaseToken:string,input:{code:string;uncertain:boolean}){return transact(async db=>{
      const row=await systemReply(db,id);
      if(row.wamid||row.messageId)return row;
      if(row.leaseToken!==attentionUuid(leaseToken))throw new AttentionError("La reserva del envío cambió.",409);
      const [updated]=await db.$queryRawUnsafe<MetaReply[]>(`UPDATE "AttentionMetaOutbox" SET status=$2,"errorCode"=$3,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,input.uncertain?'uncertain':'failed',safeCode(input.code));
      await systemAudit(db,"META_REPLY_FAILED",row.conversationId,{outboxId:id,status:updated.status});return updated;
    });},
    async getMedia(actor:AttentionActor,conversationId:string,messageId:string){return transact(async db=>{
      await scopedConversation(db,actor,conversationId);
      await binding(db,conversationId);
      const [row]=await db.$queryRawUnsafe<{attachment:StoredAttachment|null}[]>(`SELECT attachment FROM "AttentionMessage" WHERE id=$1::uuid AND "conversationId"=$2::uuid AND "metaPhoneNumberId"=$3`,attentionUuid(messageId),conversationId,scope.phoneNumberId);
      if(!row?.attachment)throw new AttentionError("Adjunto no encontrado.",404);
      await userAudit(db,actor,"META_MEDIA_READ",conversationId,{messageId});return {...row.attachment,phoneNumberId:scope.phoneNumberId};
    });},
  };
}
