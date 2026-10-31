import type { AttentionDb } from "./atencion-storage";

/** Shared evidence never impersonates a nominal analyst's personal read receipt. */
export const attentionUnreadPredicate = `NOT EXISTS(SELECT 1 FROM "AttentionReadState" rs WHERE rs."userId"=$2 AND rs."messageId"=m.id)
  AND NOT EXISTS(SELECT 1 FROM "AttentionTeamReadState" ts WHERE ts."messageId"=m.id AND ts."conversationId"=m."conversationId")`;

export async function notifyAttentionTeamRead(db: AttentionDb, conversationId: string) {
  await db.$queryRawUnsafe(`SELECT 1 AS notified FROM pg_notify('finserpay_attention_changes',
    (SELECT json_build_object('conversationId',c.id,'previousUserId',NULL,'previousKey',NULL,'previousSellerId',NULL,
      'currentUserId',c."assigneeUserId",'currentKey',c."assigneeKey",'currentSellerId',c."assigneeSellerId")::text
      FROM "AttentionConversation" c WHERE c.id=$1::uuid))`, conversationId);
}

/** Reconcile only new, verified business-app echoes. Existing history remains untouched on installation.
 * Strict ordering deliberately preserves an inbound with the same provider second as a reply. */
export async function reconcileAttentionBusinessReads(db: AttentionDb, conversationId: string, phoneNumberId: string) {
  const changed = await db.$queryRawUnsafe<{ messageId: string }[]>(`WITH reply AS MATERIALIZED (
      SELECT r.id,r."sentAt" FROM "AttentionMessage" r WHERE r."conversationId"=$1::uuid
      AND r.direction='outbound' AND r."teamReadReply"=true AND r."metaPhoneNumberId"=$2
      AND r."metaWamid" IS NOT NULL AND r."externalId"='meta:'||r."metaWamid"
      ORDER BY r."sentAt" DESC,r.id DESC LIMIT 1)
    INSERT INTO "AttentionTeamReadState"("messageId","conversationId",source,"replyMessageId")
    SELECT m.id,m."conversationId",'business_reply',reply.id FROM reply JOIN "AttentionMessage" m
      ON m."conversationId"=$1::uuid AND m.direction='inbound' AND m."sentAt"<reply."sentAt"
    WHERE NOT EXISTS(SELECT 1 FROM "AttentionTeamReadState" prior WHERE prior."messageId"=m.id)
    ON CONFLICT("messageId") DO NOTHING RETURNING "messageId"`, conversationId, phoneNumberId);
  if (changed.length) {
    await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","actorKind","actorKey",action,metadata)
      VALUES($1::uuid,'system','SYSTEM_META','MESSAGES_TEAM_READ_BUSINESS_REPLY',$2::jsonb) RETURNING id`,
      conversationId, JSON.stringify({ count: changed.length }));
    await notifyAttentionTeamRead(db, conversationId);
  }
  return changed.length;
}
