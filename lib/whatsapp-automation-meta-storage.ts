import { createHash, randomUUID } from "node:crypto";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import type { MetaDeliveryStatus, MetaScope } from "./atencion-meta";
import { META_AUTOMATION_SCOPE, META_AUTOMATION_TEMPLATES, type MetaAutomationTemplate } from "./whatsapp-automation-meta-config";

export type AutomationInput = { operationKey: string; template: MetaAutomationTemplate; phone: string; body: string[]; headerImageUrl?: string };
export type AutomationRow = {
  id: string; operationKey: string; provider: "meta"; fingerprint: string; templateName: MetaAutomationTemplate; language: string;
  phoneNumberId: string; wabaId: string; contactId: string; bodyParameters: string[]; headerImageUrl: string | null;
  conversationId: string; messageId: string; renderedText: string; uploadedMediaId: string | null; mediaMimeType: string | null;
  status: "queued" | "sending" | "accepted" | "sent" | "delivered" | "read" | "failed" | "uncertain";
  wamid: string | null; leaseToken: string | null; leaseUntil: Date | string | null; sendStartedAt: Date | string | null;
  deliveryAt: Date | string | null; errorCode: string | null;
};
export class AutomationError extends Error {
  constructor(public code: string) { super(code); this.name = "AutomationError"; }
}
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const validWamid = (value: string) => /^wamid\.[A-Za-z0-9_+/=.-]{1,500}$/.test(value);
const rank: Record<string, number> = { queued: 0, sending: 0, uncertain: 0, failed: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
async function audit(db: AttentionDb, row: AutomationRow, action: string, metadata: object = {}) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","actorKind","actorKey",action,metadata)
    VALUES($1::uuid,'system','SYSTEM_META',$2,$3::jsonb) RETURNING id`, row.conversationId, action, JSON.stringify({ outboxId: row.id, template: row.templateName, ...metadata }));
}
async function lockedRow(db: AttentionDb, id: string) {
  const [location] = await db.$queryRawUnsafe<{conversationId: string}[]>(`SELECT "conversationId" FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1::uuid`, id);
  if (!location) throw new AutomationError("OUTBOX_NOT_FOUND");
  await db.$queryRawUnsafe(`SELECT id FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, location.conversationId);
  return (await db.$queryRawUnsafe<AutomationRow[]>(`SELECT * FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1::uuid FOR UPDATE`, id))[0];
}
async function receipt(db: AttentionDb, row: AutomationRow, providerId: string) {
  if (!validWamid(providerId) || !row.sendStartedAt || (row.wamid && row.wamid !== providerId)) throw new AutomationError("INVALID_SEND_RECEIPT");
  const next = ["queued", "sending", "uncertain"].includes(row.status) ? "accepted" : row.status;
  await db.$queryRawUnsafe(`UPDATE "WhatsAppAutomationMetaOutbox" SET wamid=$2,status=$3,"acceptedAt"=COALESCE("acceptedAt",now()),
    "leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=CASE WHEN status='failed' THEN "errorCode" ELSE NULL END,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, providerId, next);
  await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "externalId"=$2,"metaWamid"=$3,"deliveryStatus"=$4 WHERE id=$1::uuid RETURNING id`, row.messageId, `meta:${providerId}`, providerId, next);
  if (!row.wamid) {
    // Outbound contact neither reopens a closed chat nor opens the 24-hour response window.
    await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "metaManaged"=true,"lastContactAt"=GREATEST("lastContactAt",$2::timestamptz),"updatedAt"=now(),version=version+1 WHERE id=$1::uuid RETURNING id`,row.conversationId,row.sendStartedAt);
    await audit(db, row, "META_AUTOMATION_ACCEPTED");
  }
  return { ...row, wamid: providerId, status: next, leaseToken: null, leaseUntil: null } as AutomationRow;
}

/** Called only after the existing signed webhook verifies its exact Meta scope. */
export async function applyWhatsAppAutomationDelivery(db: AttentionDb, scope: MetaScope, event: MetaDeliveryStatus): Promise<boolean> {
  const [ready] = await db.$queryRawUnsafe<{ready: boolean}[]>(`SELECT to_regclass('public."WhatsAppAutomationMetaOutbox"') IS NOT NULL AS ready`);
  if (!ready?.ready || scope.phoneNumberId !== META_AUTOMATION_SCOPE.phoneNumberId || scope.wabaId !== META_AUTOMATION_SCOPE.wabaId) return false;
  const candidates = await db.$queryRawUnsafe<{id: string}[]>(`SELECT id FROM "WhatsAppAutomationMetaOutbox" WHERE "phoneNumberId"=$1 AND "wabaId"=$2
    AND (wamid=$3 OR ($4::uuid IS NOT NULL AND id=$4::uuid)) ORDER BY id LIMIT 2`, scope.phoneNumberId, scope.wabaId, event.id, event.requestId ?? null);
  if (candidates.length !== 1) return false;
  let row = await lockedRow(db, candidates[0].id);
  if (row.contactId !== event.recipient || !row.sendStartedAt || (row.wamid && row.wamid !== event.id)) return false;
  if (!row.wamid) row = await receipt(db, row, event.id);
  const older = row.deliveryAt && new Date(event.timestamp) <= new Date(row.deliveryAt);
  if (row.status === "failed" && event.status === "sent" && older) return false;
  const next = event.status === "failed" ? (!older && (rank[row.status] ?? 0) < 3 ? "failed" : row.status)
    : (rank[event.status] ?? 0) > (rank[row.status] ?? 0) ? event.status : row.status;
  if (next === row.status && older) return false;
  const error = next === "failed" ? `META_${String(event.errorCodes?.[0] || "DELIVERY_FAILED").replace(/[^A-Z0-9_]/gi, "").slice(0, 50)}` : null;
  await db.$queryRawUnsafe(`UPDATE "WhatsAppAutomationMetaOutbox" SET status=$2,"deliveryAt"=GREATEST("deliveryAt",$3::timestamptz),"errorCode"=$4,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, row.id, next, event.timestamp, error);
  await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "deliveryStatus"=$2,"deliveryAt"=GREATEST("deliveryAt",$3::timestamptz) WHERE id=$1::uuid RETURNING id`, row.messageId, next, event.timestamp);
  await audit(db, row, "META_AUTOMATION_DELIVERY", { status: next }); return true;
}

export function createWhatsAppAutomationMetaStore(database: AttentionDatabase, options: {now?: () => Date} = {}) {
  const now = options.now ?? (() => new Date());
  const transact = <T>(run: (db: AttentionDb) => Promise<T>) => database.$transaction(run, transactionOptions);
  function owned(row: AutomationRow, leaseToken: string) {
    if (row.leaseToken !== leaseToken || !row.leaseUntil || new Date(row.leaseUntil) <= now() || row.status !== "queued") throw new AutomationError("OUTBOX_LEASE_LOST");
  }
  return {
    async reserve(input: AutomationInput): Promise<{row: AutomationRow; claimed: boolean}> {
      const rule = META_AUTOMATION_TEMPLATES[input.template];
      if (!rule || !/^[a-z][a-z0-9:_-]{4,180}$/i.test(input.operationKey) || !/^573\d{9}$/.test(input.phone)
        || !Array.isArray(input.body) || input.body.length !== rule.parameters || input.body.some(value => typeof value !== "string" || !value.trim() || value.length > 500 || Array.from(value).some(c => c.charCodeAt(0) < 32))) throw new AutomationError("INVALID_AUTOMATION_INPUT");
      const fingerprint = createHash("sha256").update(JSON.stringify({ provider: "meta", ...META_AUTOMATION_SCOPE, template: input.template,
        language: rule.language, phone: input.phone, body: input.body, image: input.headerImageUrl ?? null })).digest("hex");
      return transact(async db => {
        // Shared lock order with Dapta/Meta import: provider, contact, conversation, outbox.
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:phone:+${input.phone}`);
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:automation:${input.operationKey}`);
        const [existing] = await db.$queryRawUnsafe<AutomationRow[]>(`SELECT * FROM "WhatsAppAutomationMetaOutbox" WHERE "operationKey"=$1`, input.operationKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new AutomationError("AUTOMATION_OPERATION_CONFLICT");
          const locked = await lockedRow(db,existing.id);
          if (locked.leaseUntil && new Date(locked.leaseUntil)<=now() && ["queued","sending"].includes(locked.status)) {
            const status=locked.sendStartedAt?"uncertain":"failed",code=locked.sendStartedAt?"LEASE_EXPIRED_AFTER_SEND":"LEASE_EXPIRED_BEFORE_SEND";
            const [recovered]=await db.$queryRawUnsafe<AutomationRow[]>(`UPDATE "WhatsAppAutomationMetaOutbox" SET status=$2,"errorCode"=$3,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,locked.id,status,code);
            await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "deliveryStatus"=$2 WHERE id=$1::uuid RETURNING id`,locked.messageId,status);
            await audit(db,locked,"META_AUTOMATION_RECOVERED",{status,code});return {row:recovered,claimed:false};
          }
          return { row: locked, claimed: false };
        }
        const { phoneNumberId, wabaId } = META_AUTOMATION_SCOPE;
        const [binding] = await db.$queryRawUnsafe<{conversationId: string; wabaId: string}[]>(`SELECT "conversationId","wabaId" FROM "AttentionMetaBinding" WHERE "phoneNumberId"=$1 AND "contactId"=$2 FOR UPDATE`, phoneNumberId, input.phone);
        if (binding && binding.wabaId !== wabaId) throw new AutomationError("META_SCOPE_MISMATCH");
        let conversationId = binding?.conversationId;
        if (!conversationId) {
          const candidates = await db.$queryRawUnsafe<{id: string}[]>(`SELECT c.id FROM "AttentionConversation" c WHERE c.channel='whatsapp' AND c.phone=$1
            AND NOT EXISTS(SELECT 1 FROM "AttentionMetaBinding" b WHERE b."conversationId"=c.id AND (b."phoneNumberId"<>$2 OR b."wabaId"<>$3)) ORDER BY c.id LIMIT 2 FOR UPDATE`, `+${input.phone}`, phoneNumberId, wabaId);
          if (candidates.length === 1) conversationId = candidates[0].id;
          else {
            conversationId = randomUUID();
            await db.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,phone,name,"metaManaged") VALUES($1::uuid,'whatsapp',$2,$2,true) RETURNING id`, conversationId, `+${input.phone}`);
          }
          await db.$queryRawUnsafe(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1::uuid,$2::uuid,$3,$4,$5) RETURNING id`, randomUUID(), conversationId, phoneNumberId, wabaId, input.phone);
        }
        const [conversation] = await db.$queryRawUnsafe<{phone: string | null}[]>(`SELECT phone FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, conversationId);
        if (conversation.phone && conversation.phone !== `+${input.phone}`) throw new AutomationError("CONTACT_IDENTITY_CHANGED");
        const id = randomUUID(), messageId = randomUUID(), leaseToken = randomUUID();
        await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,"metaPhoneNumberId","deliveryStatus")
          VALUES($1::uuid,$2::uuid,$3,'outbound',$4,$5::timestamptz,'Automatización FINSER PAY',$6,'queued') RETURNING id`, messageId, conversationId, `automation:${id}`, `Plantilla ${input.template}`, now().toISOString(), phoneNumberId);
        const [row] = await db.$queryRawUnsafe<AutomationRow[]>(`INSERT INTO "WhatsAppAutomationMetaOutbox"(id,"operationKey",provider,fingerprint,"templateName",language,"phoneNumberId","wabaId","contactId","bodyParameters","headerImageUrl","conversationId","messageId",status,"leaseToken","leaseUntil")
          VALUES($1::uuid,$2,'meta',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::uuid,$12::uuid,'queued',$13::uuid,$14::timestamptz) RETURNING *`, id,input.operationKey,fingerprint,input.template,rule.language,phoneNumberId,wabaId,input.phone,JSON.stringify(input.body),input.headerImageUrl??null,conversationId,messageId,leaseToken,new Date(now().getTime()+120000).toISOString());
        await audit(db, row, "META_AUTOMATION_QUEUED"); return { row, claimed: true };
      });
    },
    async prepare(id: string, leaseToken: string, data: {text: string; metadata: object; mediaId?: string; mimeType?: string}) {
      return transact(async db => {
        const row = await lockedRow(db,id); owned(row,leaseToken);
        const attachment = data.mediaId ? {kind:"image",mediaId:data.mediaId,mimeType:data.mimeType,fileName:null} : null;
        await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET text=$2,attachment=$3::jsonb WHERE id=$1::uuid RETURNING id`,row.messageId,data.text,JSON.stringify(attachment));
        const [updated] = await db.$queryRawUnsafe<AutomationRow[]>(`UPDATE "WhatsAppAutomationMetaOutbox" SET "renderedText"=$2,"templateMetadata"=$3::jsonb,"uploadedMediaId"=$4,"mediaMimeType"=$5,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,data.text,JSON.stringify(data.metadata),data.mediaId??null,data.mimeType??null);
        return updated;
      });
    },
    async start(id: string, leaseToken: string) {
      return transact(async db => {
        const row = await lockedRow(db,id); owned(row,leaseToken);
        if (!row.renderedText || (META_AUTOMATION_TEMPLATES[row.templateName].imageEnv && !row.uploadedMediaId)) throw new AutomationError("TEMPLATE_NOT_PREPARED");
        const [updated] = await db.$queryRawUnsafe<AutomationRow[]>(`UPDATE "WhatsAppAutomationMetaOutbox" SET status='sending',"sendStartedAt"=$2::timestamptz,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,now().toISOString());
        await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "deliveryStatus"='sending',"sentAt"=$2::timestamptz WHERE id=$1::uuid RETURNING id`,row.messageId,now().toISOString());
        await audit(db,row,"META_AUTOMATION_SENDING");return updated;
      });
    },
    async accept(id: string, providerId: string) {
      return transact(async db => {
        const row = await lockedRow(db,id); return receipt(db,row,providerId);
      });
    },
    async fail(id: string, leaseToken: string, uncertain: boolean, code: string) {
      return transact(async db => {
        const row = await lockedRow(db,id);
        // A late network error must never overwrite an independently received delivery receipt.
        if (row.leaseToken !== leaseToken || !["queued","sending"].includes(row.status)) return row;
        const next = uncertain ? "uncertain" : "failed";
        const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : "AUTOMATION_FAILED";
        const [updated] = await db.$queryRawUnsafe<AutomationRow[]>(`UPDATE "WhatsAppAutomationMetaOutbox" SET status=$2,"errorCode"=$3,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,id,next,safeCode);
        await db.$queryRawUnsafe(`UPDATE "AttentionMessage" SET "deliveryStatus"=$2 WHERE id=$1::uuid RETURNING id`,row.messageId,next);
        await audit(db,row,"META_AUTOMATION_FAILED",{status:next,code:safeCode});return updated;
      });
    },
  };
}
