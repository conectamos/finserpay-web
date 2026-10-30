import { readFile } from "node:fs/promises";

export async function installWhatsAppAutomationMetaSchema(client) {
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_lock(hashtext('finserpay-whatsapp-automation-meta-schema'))");
  await client.query(await readFile(new URL("./setup-whatsapp-automation-meta.sql",import.meta.url),"utf8"));
  const {rows}=await client.query(`SELECT a.attname::text AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required
    FROM pg_catalog.pg_attribute a WHERE a.attrelid='public."WhatsAppAutomationMetaOutbox"'::regclass AND a.attnum>0 AND NOT a.attisdropped`);
  const required={id:"uuid",operationKey:"text",provider:"text",fingerprint:"text",templateName:"text",language:"text",phoneNumberId:"text",wabaId:"text",contactId:"text",bodyParameters:"jsonb",conversationId:"uuid",messageId:"uuid",renderedText:"text",status:"text",createdAt:"timestamp with time zone",updatedAt:"timestamp with time zone"};
  const optional={headerImageUrl:"text",templateMetadata:"jsonb",uploadedMediaId:"text",mediaMimeType:"text",wamid:"text",leaseToken:"uuid",leaseUntil:"timestamp with time zone",sendStartedAt:"timestamp with time zone",acceptedAt:"timestamp with time zone",deliveryAt:"timestamp with time zone",errorCode:"text"};
  for(const [name,type] of Object.entries({...required,...optional})) {
    const column=rows.find(row=>row.name===name);
    if(!column || column.type!==type || column.required!==Object.hasOwn(required,name))throw new Error(`WHATSAPP_AUTOMATION_SCHEMA_COLUMN_${name}`);
  }
  const {rows:keys}=await client.query(`SELECT c.contype AS kind,ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(id,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.id ORDER BY k.position) AS columns,
    c.confrelid::regclass::text AS target,c.convalidated AS valid FROM pg_catalog.pg_constraint c WHERE c.conrelid='public."WhatsAppAutomationMetaOutbox"'::regclass`);
  const has=(kind,columns,target)=>keys.some(row=>row.kind===kind && row.valid && JSON.stringify(row.columns)===JSON.stringify(columns) && (!target || row.target===target));
  if(!has("p",["id"]) || !has("u",["operationKey"]) || !has("u",["phoneNumberId","wamid"])
    || !has("f",["conversationId"],'"AttentionConversation"') || !has("f",["messageId"],'"AttentionMessage"'))throw new Error("WHATSAPP_AUTOMATION_SCHEMA_KEYS");
}
