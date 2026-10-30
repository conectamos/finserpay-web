import { readFile } from "node:fs/promises";
import pg from "pg";

// PostgreSQL native type names; "!" marks NOT NULL. Existing incompatible tables
// are rejected instead of attempting an implicit repair or destructive migration.
const expectedColumns = {
  AttentionConversation: "id:uuid! externalId:text channel:text! phone:text name:text! status:text! mode:text! sedeId:int4 assigneeKey:text assigneeName:text assigneeUserId:int4 assigneeSellerId:int4 linkedCreditId:int4 lastContactAt:timestamptz closedAt:timestamptz daptaMessagesCursor:text historyTruncated:bool! tags:jsonb! version:int4! createdAt:timestamptz! updatedAt:timestamptz! metaManaged:bool! metaLastInboundAt:timestamptz",
  AttentionMessage: "id:uuid! conversationId:uuid! externalId:text! direction:text! text:text! sentAt:timestamptz! author:text metaWamid:text metaPhoneNumberId:text attachment:jsonb deliveryStatus:text deliveryAt:timestamptz replyToWamid:text",
  AttentionNote: "id:uuid! conversationId:uuid! text:text! author:text! userId:int4! sellerId:int4 createdAt:timestamptz!",
  AttentionTask: "id:uuid! conversationId:uuid! title:text! dueAt:timestamptz completedAt:timestamptz author:text! userId:int4! sellerId:int4 createdAt:timestamptz!",
  AttentionQuickReply: "id:uuid! title:text! text:text! approvedBy:text! approvedByUserId:int4! approvedAt:timestamptz!",
  AttentionAudit: "id:int8! conversationId:uuid userId:int4 sellerId:int4 action:text! metadata:jsonb! createdAt:timestamptz! actorKind:text! actorKey:text",
  AttentionRequest: "actorKey:text! requestId:uuid! fingerprint:text! resultId:uuid createdAt:timestamptz!",
  AttentionReadState: "userId:int4! messageId:uuid! conversationId:uuid! readAt:timestamptz!",
  AttentionMetaBinding: "id:uuid! conversationId:uuid! phoneNumberId:text! wabaId:text! contactId:text! createdAt:timestamptz!",
  AttentionMetaOutbox: "id:uuid! conversationId:uuid! userId:int4! actorKey:text! authorName:text! requestId:uuid! fingerprint:text! conversationVersion:int4! phoneNumberId:text! wabaId:text! contactId:text! text:text! attachment:jsonb uploadedMediaId:text status:text! messageId:uuid wamid:text leaseToken:uuid leaseUntil:timestamptz sendStartedAt:timestamptz acceptedAt:timestamptz deliveryAt:timestamptz errorCode:text attempts:int4! createdAt:timestamptz! updatedAt:timestamptz! template:jsonb",
  AttentionMetaDelivery: "id:uuid! phoneNumberId:text! wabaId:text! wamid:text! recipient:text! status:text! eventAt:timestamptz! errorCode:text requestId:uuid createdAt:timestamptz!",
};
const additiveColumns = {
  AttentionConversation: ["closedAt", "daptaMessagesCursor", "metaManaged", "metaLastInboundAt"],
  AttentionMessage: ["metaWamid", "metaPhoneNumberId", "attachment", "deliveryStatus", "deliveryAt", "replyToWamid"],
  AttentionAudit: ["actorKind", "actorKey"],
  AttentionMetaOutbox: ["template"],
};
const tableNames = Object.keys(expectedColumns);
const foreignKeys = {
  AttentionConversation: { sedeId: "Sede", assigneeUserId: "Usuario", assigneeSellerId: "Vendedor", linkedCreditId: "Credito" },
  AttentionMessage: { conversationId: "AttentionConversation" },
  AttentionReadState: { conversationId: "AttentionConversation", userId: "Usuario", messageId: "AttentionMessage" },
  AttentionNote: { conversationId: "AttentionConversation", userId: "Usuario", sellerId: "Vendedor" },
  AttentionTask: { conversationId: "AttentionConversation", userId: "Usuario", sellerId: "Vendedor" },
  AttentionQuickReply: { approvedByUserId: "Usuario" },
  AttentionAudit: { conversationId: "AttentionConversation", userId: "Usuario", sellerId: "Vendedor" },
  AttentionMetaBinding: { conversationId: "AttentionConversation" },
  AttentionMetaOutbox: { conversationId: "AttentionConversation", userId: "Usuario", messageId: "AttentionMessage" },
};
class AttentionSchemaMismatch extends Error {
  constructor(objectName) { super(`Esquema de atención incompatible: ${objectName}. Revisa la estructura existente; no se intentó una reparación destructiva.`); }
}
async function verifySchema(client, beforeInstallation) {
  const { rows } = await client.query(`SELECT t.relname AS "tableName",t.relkind,a.attname AS "columnName",
    ty.typname AS "typeName",a.attnotnull AS "notNull"
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid
    WHERE n.nspname='public' AND t.relname=ANY($1::text[])`, [tableNames]);
  const present = new Set(rows.map(row => row.tableName));
  for (const [table, specs] of Object.entries(expectedColumns)) {
    if (beforeInstallation && !present.has(table)) continue;
    if (!present.has(table) || rows.some(row => row.tableName === table && row.relkind !== "r")) throw new AttentionSchemaMismatch(table);
    for (const spec of specs.split(" ")) {
      const [column, expected] = spec.split(":");
      const found = rows.find(row => row.tableName === table && row.columnName === column);
      if (beforeInstallation && !found && additiveColumns[table]?.includes(column)) continue;
      const nullableUpgrade = beforeInstallation && (table === "AttentionConversation" && ["sedeId", "phone"].includes(column) || table === "AttentionAudit" && column === "userId");
      if (!found || found.typeName !== expected.replace("!", "") || (!nullableUpgrade && found.notNull !== expected.endsWith("!"))) throw new AttentionSchemaMismatch(`${table}.${column}`);
    }
  }
  const { rows: constraints } = await client.query(`SELECT t.relname AS "tableName",c.contype,c.convalidated,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(id,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.id ORDER BY k.position) AS columns,
    ft.relname AS "foreignTable",fn.nspname AS "foreignSchema",
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(id,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=ft.oid AND a.attnum=k.id ORDER BY k.position) AS "foreignColumns"
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_catalog.pg_class ft ON ft.oid=c.confrelid
    LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid=ft.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[])`, [tableNames]);
  const hasConstraint = (table, kind, columns) => constraints.some(row => row.tableName === table && row.contype === kind && row.convalidated && JSON.stringify(row.columns) === JSON.stringify(columns));
  for (const table of tableNames) {
    if (beforeInstallation && !present.has(table)) continue;
    if (!hasConstraint(table, "p", table === "AttentionRequest" ? ["actorKey", "requestId"] : table === "AttentionReadState" ? ["userId", "messageId"] : ["id"])) throw new AttentionSchemaMismatch(`${table}.PRIMARY_KEY`);
    for (const [column, target] of Object.entries(foreignKeys[table] || {})) {
      if (!constraints.some(row => row.tableName === table && row.contype === "f" && row.convalidated &&
          row.columns.length === 1 && row.columns[0] === column && row.foreignSchema === "public" && row.foreignTable === target &&
          row.foreignColumns.length === 1 && row.foreignColumns[0] === "id")) throw new AttentionSchemaMismatch(`${table}.${column}.FOREIGN_KEY`);
    }
  }
  for (const [table, columns] of [["AttentionConversation", ["externalId"]], ["AttentionMessage", ["conversationId", "externalId"]],
    ["AttentionMetaBinding", ["phoneNumberId", "contactId"]], ["AttentionMetaOutbox", ["actorKey", "requestId"]],
    ["AttentionMetaOutbox", ["phoneNumberId", "wamid"]], ["AttentionMetaDelivery", ["phoneNumberId", "wamid", "status", "eventAt"]]]) {
    if ((!beforeInstallation || present.has(table)) && !hasConstraint(table, "u", columns)) throw new AttentionSchemaMismatch(`${table}.EXTERNAL_ID_UNIQUE`);
  }
  if (!beforeInstallation) {
    if (!constraints.some(row => row.tableName === "AttentionAudit" && row.contype === "c" && row.convalidated && row.columns.includes("actorKind") && row.columns.includes("userId"))) throw new AttentionSchemaMismatch("AttentionAudit.SYSTEM_ACTOR_CHECK");
    const { rows: indexes } = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='AttentionMessage' AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(id,position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.id ORDER BY k.position)=ARRAY['metaPhoneNumberId','metaWamid']::text[]) AS active`);
    if (indexes[0]?.active !== true) throw new AttentionSchemaMismatch("AttentionMessage.META_ID_UNIQUE");
    const { rows: triggers } = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='AttentionAudit' AND t.tgname='attention_audit_immutable'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND (t.tgtype::integer & 27)=27
      AND pn.nspname='public' AND p.proname='attention_audit_immutable') AS active`);
    if (triggers[0]?.active !== true) throw new AttentionSchemaMismatch("AttentionAudit.APPEND_ONLY_TRIGGER");
    const { rows: realtime } = await client.query(`SELECT count(*)=3 AS active FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND (t.tgtype::integer & 23)=21
      AND pn.nspname='public' AND p.proname='attention_realtime_notify' AND NOT p.prosecdef AND
      (c.relname,t.tgname) IN (('AttentionConversation','attention_realtime_conversation'),
        ('AttentionMessage','attention_realtime_message'),('AttentionMetaOutbox','attention_realtime_outbox'))`);
    if (realtime[0]?.active !== true) throw new AttentionSchemaMismatch("AttentionConversation.REALTIME_TRIGGERS");
  }
}

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar atención.");
const client = new pg.Client({ connectionString, application_name: "finserpay-attention-schema", connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  // Session lock covers metadata preflight, SQL transaction and postflight.
  // Closing this dedicated connection releases it on success and on error.
  await client.query("SELECT pg_advisory_lock(hashtext('finserpay-attention-schema'))");
  await verifySchema(client, true);
  await client.query(await readFile(new URL("./setup-atencion.sql", import.meta.url), "utf8"));
  await verifySchema(client, false);
  console.log("Esquema de atención verificado: 11 tablas, columnas y claves compatibles; lectura nominal, closedAt, daptaMessagesCursor, persistencia Meta, auditoría inmutable y eventos transaccionales activos. No se conectó ni modificó ningún proveedor.");
} catch (error) {
  if (error instanceof AttentionSchemaMismatch) throw error;
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error(`No se pudo preparar atención${code ? ` (${code})` : ""}.`);
} finally { await client.end().catch(() => undefined); }
