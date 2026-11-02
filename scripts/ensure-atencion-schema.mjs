import { readFile } from "node:fs/promises";
import pg from "pg";

// PostgreSQL native type names; "!" marks NOT NULL. Existing incompatible tables
// are rejected instead of attempting an implicit repair or destructive migration.
const expectedColumns = {
  AttentionDaptaEvent: "id:uuid! event:text! deliveryId:text! eventAt:timestamptz! workspaceId:text! agentId:text! agentChannelId:text! phoneNumberId:text! wabaId:text! externalConversationId:text! contactId:text! phone:text messageId:text! messageAt:timestamptz! fingerprint:text! conversationId:uuid status:text! historyCursor:text attempts:int4! nextAttemptAt:timestamptz! expiresAt:timestamptz! leaseToken:uuid leaseUntil:timestamptz errorCode:text completedAt:timestamptz createdAt:timestamptz! updatedAt:timestamptz!",
  AttentionPushSubscription: "id:uuid! recipientKey:text! endpoint:text! keys:jsonb! createdAt:timestamptz! updatedAt:timestamptz! expiresAt:timestamptz!",
  AttentionPushDelivery: "id:uuid! notificationId:uuid! subscriptionId:uuid! attempts:int4! nextAttemptAt:timestamptz! leaseToken:uuid leaseUntil:timestamptz deliveredAt:timestamptz errorCode:text createdAt:timestamptz!",
  AttentionWorkNotification: "id:uuid! recipientKey:text! workId:uuid! eventKey:text! kind:text! workKind:text! createdAt:timestamptz! readAt:timestamptz",
  AttentionWorkFile: "id:uuid! workId:uuid! content:bytea! mimeType:text!",
  AttentionWorkCaptureSession: "id:uuid! workId:uuid! actorKey:text! actor:jsonb! requestId:uuid! requestVersion:int4! tokenHash:text! bindingHash:text! expiresAt:timestamptz! revokedAt:timestamptz uploadedCount:int4! lastUploadedAt:timestamptz createdAt:timestamptz!",
  AttentionWorkRequest: "id:uuid! conversationId:uuid! kind:text! targetSource:text! targetId:int4! sellerId:int4! userId:int4! sedeId:int4! aliadoId:int4! state:text! callMode:text! version:int4! createdAt:timestamptz! updatedAt:timestamptz!",
  AttentionSticker: "id:uuid! userId:int4! name:text! content:bytea! sha256:text! size:int4! animated:bool! favorite:bool! archivedAt:timestamptz version:int4! createdAt:timestamptz!",
  AttentionConversation: "id:uuid! externalId:text channel:text! phone:text name:text! status:text! mode:text! sedeId:int4 assigneeKey:text assigneeName:text assigneeUserId:int4 assigneeSellerId:int4 linkedCreditId:int4 lastContactAt:timestamptz closedAt:timestamptz daptaMessagesCursor:text historyTruncated:bool! tags:jsonb! version:int4! createdAt:timestamptz! updatedAt:timestamptz! metaManaged:bool! metaLastInboundAt:timestamptz sectionId:uuid boardVersion:int4!",
  AttentionBoardSection: "id:uuid! name:text! color:text! position:int4! version:int4! archivedAt:timestamptz createdByUserId:int4 createdAt:timestamptz! updatedAt:timestamptz!",
  AttentionMessage: "id:uuid! conversationId:uuid! externalId:text! direction:text! text:text! sentAt:timestamptz! author:text metaWamid:text metaPhoneNumberId:text attachment:jsonb deliveryStatus:text deliveryAt:timestamptz replyToWamid:text teamReadReply:bool!",
  AttentionNote: "id:uuid! conversationId:uuid! text:text! author:text! userId:int4! sellerId:int4 createdAt:timestamptz!",
  AttentionTask: "id:uuid! conversationId:uuid! title:text! dueAt:timestamptz completedAt:timestamptz author:text! userId:int4! sellerId:int4 createdAt:timestamptz!",
  AttentionQuickReply: "id:uuid! title:text! text:text! approvedBy:text! approvedByUserId:int4! approvedAt:timestamptz!",
  AttentionAudit: "id:int8! conversationId:uuid userId:int4 sellerId:int4 action:text! metadata:jsonb! createdAt:timestamptz! actorKind:text! actorKey:text",
  AttentionRequest: "actorKey:text! requestId:uuid! fingerprint:text! resultId:uuid createdAt:timestamptz!",
  AttentionReadState: "userId:int4! messageId:uuid! conversationId:uuid! readAt:timestamptz!",
  AttentionTeamReadState: "messageId:uuid! conversationId:uuid! source:text! actorUserId:int4 replyMessageId:uuid readAt:timestamptz!",
  AttentionMetaBinding: "id:uuid! conversationId:uuid! phoneNumberId:text! wabaId:text! contactId:text! createdAt:timestamptz!",
  AttentionMetaOutbox: "id:uuid! conversationId:uuid! userId:int4! actorKey:text! authorName:text! requestId:uuid! fingerprint:text! conversationVersion:int4! phoneNumberId:text! wabaId:text! contactId:text! text:text! attachment:jsonb uploadedMediaId:text status:text! messageId:uuid wamid:text leaseToken:uuid leaseUntil:timestamptz sendStartedAt:timestamptz acceptedAt:timestamptz deliveryAt:timestamptz errorCode:text attempts:int4! createdAt:timestamptz! updatedAt:timestamptz! template:jsonb",
  AttentionMetaDelivery: "id:uuid! phoneNumberId:text! wabaId:text! wamid:text! recipient:text! status:text! eventAt:timestamptz! errorCode:text requestId:uuid createdAt:timestamptz!",
};
const additiveColumns = {
  AttentionConversation: ["closedAt", "daptaMessagesCursor", "metaManaged", "metaLastInboundAt", "sectionId", "boardVersion"],
  AttentionMessage: ["metaWamid", "metaPhoneNumberId", "attachment", "deliveryStatus", "deliveryAt", "replyToWamid", "teamReadReply"],
  AttentionAudit: ["actorKind", "actorKey"],
  AttentionMetaOutbox: ["template"],
};
const tableNames = Object.keys(expectedColumns);
const foreignKeys = {
  AttentionDaptaEvent: { conversationId: "AttentionConversation" },
  AttentionPushDelivery: {notificationId:"AttentionWorkNotification",subscriptionId:"AttentionPushSubscription"},
  AttentionWorkNotification: {workId:"AttentionWorkRequest"},
  AttentionWorkFile: {workId:"AttentionWorkRequest"},
  AttentionWorkCaptureSession: {workId:"AttentionWorkRequest"},
  AttentionWorkRequest: {conversationId:"AttentionConversation",sellerId:"Vendedor",userId:"Usuario",sedeId:"Sede"},
  AttentionSticker: { userId: "Usuario" },
  AttentionConversation: { sedeId: "Sede", assigneeUserId: "Usuario", assigneeSellerId: "Vendedor", linkedCreditId: "Credito", sectionId: "AttentionBoardSection" },
  AttentionBoardSection: { createdByUserId: "Usuario" },
  AttentionMessage: { conversationId: "AttentionConversation" },
  AttentionReadState: { conversationId: "AttentionConversation", userId: "Usuario", messageId: "AttentionMessage" },
  AttentionTeamReadState: { conversationId: "AttentionConversation", actorUserId: "Usuario", messageId: "AttentionMessage", replyMessageId: "AttentionMessage" },
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
    if (!hasConstraint(table, "p", table === "AttentionRequest" ? ["actorKey", "requestId"] : table === "AttentionReadState" ? ["userId", "messageId"] : table === "AttentionTeamReadState" ? ["messageId"] : ["id"])) throw new AttentionSchemaMismatch(`${table}.PRIMARY_KEY`);
    for (const [column, target] of Object.entries(foreignKeys[table] || {})) {
      if(beforeInstallation && additiveColumns[table]?.includes(column) && !rows.some(row=>row.tableName===table&&row.columnName===column))continue;
      if (!constraints.some(row => row.tableName === table && row.contype === "f" && row.convalidated &&
          row.columns.length === 1 && row.columns[0] === column && row.foreignSchema === "public" && row.foreignTable === target &&
          row.foreignColumns.length === 1 && row.foreignColumns[0] === "id")) throw new AttentionSchemaMismatch(`${table}.${column}.FOREIGN_KEY`);
    }
  }
  for (const [table, columns] of [["AttentionDaptaEvent",["deliveryId"]],["AttentionDaptaEvent",["workspaceId","agentChannelId","messageId"]],["AttentionPushSubscription",["endpoint"]],["AttentionPushDelivery",["notificationId","subscriptionId"]],["AttentionWorkNotification", ["recipientKey", "eventKey"]], ["AttentionConversation", ["externalId"]], ["AttentionMessage", ["conversationId", "externalId"]],
    ["AttentionWorkCaptureSession", ["actorKey", "requestId"]], ["AttentionWorkCaptureSession", ["tokenHash"]],
    ["AttentionMetaBinding", ["phoneNumberId", "contactId"]], ["AttentionMetaOutbox", ["actorKey", "requestId"]],
    ["AttentionMetaOutbox", ["phoneNumberId", "wamid"]], ["AttentionMetaDelivery", ["phoneNumberId", "wamid", "status", "eventAt"]]]) {
    if ((!beforeInstallation || present.has(table)) && !hasConstraint(table, "u", columns)) throw new AttentionSchemaMismatch(`${table}.EXTERNAL_ID_UNIQUE`);
  }
  if (!beforeInstallation) {
    for(const column of ["event","status","fingerprint","attempts","phone"]){
      if(!constraints.some(row=>row.tableName==="AttentionDaptaEvent"&&row.contype==="c"&&row.convalidated&&row.columns.includes(column)))throw new AttentionSchemaMismatch(`AttentionDaptaEvent.${column}.CHECK`);
    }
    if(!constraints.some(row=>row.tableName==="AttentionDaptaEvent"&&row.contype==="c"&&row.convalidated&&row.columns.includes("leaseToken")&&row.columns.includes("leaseUntil")))throw new AttentionSchemaMismatch("AttentionDaptaEvent.LEASE_CHECK");
    for (const column of ["actor","requestVersion","tokenHash","bindingHash","uploadedCount"]) {
      if (!constraints.some(row => row.tableName === "AttentionWorkCaptureSession" && row.contype === "c" && row.convalidated && row.columns.includes(column))) throw new AttentionSchemaMismatch(`AttentionWorkCaptureSession.${column}.CHECK`);
    }
    for(const columns of [["messageId","conversationId"],["replyMessageId","conversationId"]]){
      if(!constraints.some(row=>row.tableName==="AttentionTeamReadState"&&row.contype==="f"&&row.convalidated&&
        JSON.stringify(row.columns)===JSON.stringify(columns)&&row.foreignSchema==="public"&&row.foreignTable==="AttentionMessage"&&
        JSON.stringify(row.foreignColumns)===JSON.stringify(["id","conversationId"])))throw new AttentionSchemaMismatch("AttentionTeamReadState.CONVERSATION_FOREIGN_KEY");
    }
    if(!constraints.some(row=>row.tableName==="AttentionTeamReadState"&&row.contype==="c"&&row.convalidated&&row.columns.includes("source")&&row.columns.includes("actorUserId")&&row.columns.includes("replyMessageId")))throw new AttentionSchemaMismatch("AttentionTeamReadState.PROVENANCE_CHECK");
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
    const {rows:board}=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='AttentionBoardSection' AND t.tgname='attention_realtime_board'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND (t.tgtype::integer & 23)=21
      AND pn.nspname='public' AND p.proname='attention_board_notify' AND NOT p.prosecdef) AS active`);
    if(board[0]?.active!==true)throw new AttentionSchemaMismatch("AttentionBoardSection.REALTIME_TRIGGER");
    const {rows:boardIndex}=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='AttentionBoardSection' AND i.indisunique AND i.indisvalid AND i.indnatts=1
      AND pg_get_expr(i.indexprs,i.indrelid)='lower(name)' AND pg_get_expr(i.indpred,i.indrelid)='("archivedAt" IS NULL)') AS active`);
    if(boardIndex[0]?.active!==true)throw new AttentionSchemaMismatch("AttentionBoardSection.ACTIVE_NAME_UNIQUE");
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
  await client.query(await readFile(new URL("./setup-atencion-push.sql", import.meta.url), "utf8"));
  await verifySchema(client, false);
  console.log(`Esquema de atención verificado: ${tableNames.length} tablas, columnas y claves compatibles; tablero con versión independiente, lectura nominal, persistencia Meta, auditoría inmutable y eventos transaccionales activos. No se conectó ni modificó ningún proveedor.`);
} catch (error) {
  if (error instanceof AttentionSchemaMismatch) throw error;
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error(`No se pudo preparar atención${code ? ` (${code})` : ""}.`);
} finally { await client.end().catch(() => undefined); }
