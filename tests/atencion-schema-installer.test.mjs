import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const installerUrl = new URL("../scripts/ensure-atencion-schema.mjs", import.meta.url);
const sqlUrl = new URL("../scripts/setup-atencion.sql", import.meta.url);
const source = (await readFile(installerUrl, "utf8")).replace(/^import .+;\r?\n/gm, "").replaceAll("import.meta.url", "scriptUrl");
const run = new (Object.getPrototypeOf(async function() {}).constructor)("readFile", "pg", "console", "process", "scriptUrl", source);
const setupSql = await readFile(sqlUrl, "utf8");

async function fixture(t, overrides = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec('CREATE TABLE public."Sede"(id integer PRIMARY KEY); CREATE TABLE public."Usuario"(id integer PRIMARY KEY); CREATE TABLE public."Vendedor"(id integer PRIMARY KEY); CREATE TABLE public."Credito"(id integer PRIMARY KEY)');
  const calls = []; const logs = []; const metadataFields = []; let ended = false;
  class Client {
    async connect() { calls.push("connect"); }
    async query(sql, values) {
      calls.push(sql);
      // PGlite is single-process; test lock ordering, and delegate all schema/metadata
      // operations to real PostgreSQL execution instead of mocking their results.
      if (sql.startsWith("SELECT pg_advisory_lock(")) return { rows: [] };
      if (sql === setupSql) {
        await database.exec(sql);
        if (overrides.afterSql) await overrides.afterSql(database);
        return { rows: [] };
      }
      const result = await database.query(sql, values);
      if (sql.includes("FROM pg_catalog.pg_constraint c")) {
        metadataFields.push(result.fields);
        if (overrides.nodePgArrays) {
          for (const field of result.fields.filter(field => ["columns", "foreignColumns"].includes(field.name))) {
            const parser = pg.types.getTypeParser(field.dataTypeID, "text");
            for (const row of result.rows) {
              const wireValue = `{${row[field.name].map(value => JSON.stringify(value)).join(",")}}`;
              row[field.name] = parser(wireValue);
            }
          }
        }
      }
      return result;
    }
    async end() { ended = true; }
  }
  return { database, calls, logs, metadataFields, ended: () => ended,
    install: () => run(readFile, { Client }, { log: message => logs.push(message) },
      { env: { DATABASE_URL: "postgresql://test-only:no-network@example.invalid/database" } }, installerUrl.href) };
}

test("instalación aditiva verifica doce tablas y se puede repetir sin pérdida de datos", async t => {
  const { database, install, calls, logs, ended } = await fixture(t);
  await install();
  await database.query(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES('user:1','00000000-0000-4000-8000-000000000001','retained')`);
  await install();
  assert.equal((await database.query('SELECT fingerprint FROM "AttentionRequest"')).rows[0].fingerprint, "retained");
  assert.ok(calls.findIndex(sql => sql.startsWith("SELECT pg_advisory_lock(")) < calls.indexOf(setupSql));
  assert.ok(logs.every(message => message.includes("12 tablas") && message.includes("auditoría inmutable")));
  assert.ok(ended());
});

test("upgrade operativo añade lecturas y template sin cambiar mensajes existentes",async t=>{
  const {database,install}=await fixture(t);await database.exec(setupSql);
  await database.exec(`DROP TABLE "AttentionReadState"; ALTER TABLE "AttentionMetaOutbox" DROP COLUMN template;
    INSERT INTO "AttentionConversation"(id,channel,name) VALUES('00000000-0000-4000-8000-000000000011','internal','Conservar');
    INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011','legacy','inbound','Conservar',now());`);
  await install();await install();
  assert.equal((await database.query('SELECT count(*)::int n FROM "AttentionReadState"')).rows[0].n,0);
  assert.equal((await database.query('SELECT text FROM "AttentionMessage"')).rows[0].text,'Conservar');
  assert.equal((await database.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='AttentionMetaOutbox' AND column_name='template'`)).rows[0].is_nullable,'YES');
});

test("upgrade tablero añade sección y versión independiente, conserva chats y no restaura columnas archivadas",async t=>{
  const {database,install}=await fixture(t);await database.exec(setupSql);
  await database.exec(`ALTER TABLE "AttentionConversation" DROP COLUMN "sectionId",DROP COLUMN "boardVersion"; DROP TABLE "AttentionBoardSection";
    INSERT INTO "AttentionConversation"(id,channel,name,version) VALUES('00000000-0000-4000-8000-000000000099','internal','Conservar',7);`);
  await install();
  assert.deepEqual((await database.query('SELECT "sectionId","boardVersion",version FROM "AttentionConversation"')).rows,[{sectionId:null,boardVersion:1,version:7}]);
  assert.equal((await database.query('SELECT count(*)::int n FROM "AttentionBoardSection"')).rows[0].n,5);
  await database.exec(`UPDATE "AttentionBoardSection" SET name='Renombrada',"archivedAt"=now() WHERE position=1`);await install();
  assert.equal((await database.query('SELECT count(*)::int n FROM "AttentionBoardSection"')).rows[0].n,5);
  assert.equal((await database.query(`SELECT count(*)::int n FROM "AttentionBoardSection" WHERE name='Renombrada' AND "archivedAt" IS NOT NULL`)).rows[0].n,1);
});

test("postcheck rechaza índice homónimo incompatible de nombres del tablero",async t=>{
  const {install}=await fixture(t,{afterSql:db=>db.exec('DROP INDEX "AttentionBoardSection_active_name"; CREATE INDEX "AttentionBoardSection_active_name" ON "AttentionBoardSection"(name)')});
  await assert.rejects(install(),/ACTIVE_NAME_UNIQUE/);
});

test("schema previo incompatible se rechaza antes de aplicar SQL y sin tocar la tabla", async t => {
  const { database, install, calls, logs, ended } = await fixture(t);
  await database.exec('CREATE TABLE "AttentionConversation"(id text PRIMARY KEY); INSERT INTO "AttentionConversation" VALUES(\'conservar\')');
  await assert.rejects(install(), /AttentionConversation\.id/);
  assert.ok(!calls.includes(setupSql)); assert.deepEqual(logs, []); assert.ok(ended());
  assert.equal((await database.query('SELECT id FROM "AttentionConversation"')).rows[0].id, "conservar");
  assert.equal((await database.query(`SELECT to_regclass('public."AttentionMessage"') AS table_name`)).rows[0].table_name, null);
});

test("actualización permite columnas aditivas previstas y rechaza claves ausentes", async t => {
  const { database, install } = await fixture(t);
  await database.exec(setupSql);
  await database.exec('ALTER TABLE "AttentionConversation" DROP COLUMN "closedAt", DROP COLUMN "daptaMessagesCursor"');
  await install();
  const columns = (await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='AttentionConversation'`)).rows.map(row => row.column_name);
  assert.ok(columns.includes("closedAt")); assert.ok(columns.includes("daptaMessagesCursor"));
  await database.exec('ALTER TABLE "AttentionMessage" DROP CONSTRAINT "AttentionMessage_conversationId_externalId_key"');
  await assert.rejects(install(), /AttentionMessage\.EXTERNAL_ID_UNIQUE/);
});

test("upgrade desde siete tablas conserva historial y atribución y agrega almacenamiento Meta",async t=>{
  const {database,install}=await fixture(t);await database.exec(setupSql);
  await database.exec(`INSERT INTO "Usuario" VALUES(1);
    INSERT INTO "AttentionConversation"(id,channel,phone,name,"assigneeKey","assigneeUserId") VALUES('00000000-0000-4000-8000-000000000010','whatsapp','+573001234567','Histórico','analyst:1',1);
    INSERT INTO "AttentionAudit"("conversationId","userId",action) VALUES('00000000-0000-4000-8000-000000000010',1,'HISTORIC');
    DROP TRIGGER attention_realtime_conversation ON "AttentionConversation";
    DROP TRIGGER attention_realtime_message ON "AttentionMessage";
    DROP TABLE "AttentionMetaDelivery","AttentionMetaOutbox","AttentionMetaBinding";
    ALTER TABLE "AttentionConversation" DROP COLUMN "metaManaged",DROP COLUMN "metaLastInboundAt";
    ALTER TABLE "AttentionMessage" DROP COLUMN "metaWamid",DROP COLUMN "metaPhoneNumberId",DROP COLUMN attachment,DROP COLUMN "deliveryStatus",DROP COLUMN "deliveryAt",DROP COLUMN "replyToWamid";
    ALTER TABLE "AttentionAudit" DROP CONSTRAINT "AttentionAudit_actor",DROP COLUMN "actorKind",DROP COLUMN "actorKey",ALTER COLUMN "userId" SET NOT NULL;`);
  await install();
  assert.deepEqual((await database.query('SELECT "assigneeKey","assigneeUserId","metaManaged" FROM "AttentionConversation"')).rows,[{assigneeKey:'analyst:1',assigneeUserId:1,metaManaged:false}]);
  assert.deepEqual((await database.query('SELECT "actorKind","userId",action FROM "AttentionAudit"')).rows,[{actorKind:'user',userId:1,action:'HISTORIC'}]);
  await assert.rejects(database.query(`INSERT INTO "AttentionAudit"("actorKind",action) VALUES('system','ANONYMOUS')`));
  await database.query(`INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','SYSTEM_META','META_TEST')`);
});

test("postcheck rechaza identificadores Meta sin unicidad y constraint de actor ausente",async t=>{
  const missingIndex=await fixture(t,{afterSql:db=>db.exec('DROP INDEX "AttentionMessage_meta_identity"')});
  await assert.rejects(missingIndex.install(),/META_ID_UNIQUE/);
  const missingActor=await fixture(t,{afterSql:db=>db.exec('ALTER TABLE "AttentionAudit" DROP CONSTRAINT "AttentionAudit_actor"')});
  await assert.rejects(missingActor.install(),/SYSTEM_ACTOR_CHECK/);
});

test("postverificación rechaza auditoría desactivada en lugar de anunciar éxito", async t => {
  const { install, logs, ended } = await fixture(t, { afterSql: database => database.exec('ALTER TABLE "AttentionAudit" DISABLE TRIGGER attention_audit_immutable') });
  await assert.rejects(install(), /AttentionAudit\.APPEND_ONLY_TRIGGER/);
  assert.deepEqual(logs, []); assert.ok(ended());
});

test("postverificación rechaza eventos en vivo desactivados en lugar de anunciar éxito", async t => {
  const { install, logs } = await fixture(t, { afterSql: database => database.exec('ALTER TABLE "AttentionMessage" DISABLE TRIGGER attention_realtime_message') });
  await assert.rejects(install(), /REALTIME_TRIGGERS/);
  assert.deepEqual(logs, []);
});

test("SQL instala en public aunque el rol tenga un esquema de búsqueda distinto", async t => {
  const { database, install } = await fixture(t);
  await database.exec('CREATE SCHEMA tenant; SET search_path=tenant,public');
  await install();
  const rows = (await database.query(`SELECT table_schema FROM information_schema.tables WHERE table_name='AttentionConversation'`)).rows;
  assert.deepEqual(rows, [{ table_schema: "public" }]);
});

test("metadatos usan text[] OID1009 y se verifican con los parsers reales de node-pg", async t => {
  const { install, metadataFields } = await fixture(t, { nodePgArrays: true });
  // Unlike PGlite, node-pg leaves the catalog's name[] (1003) as a raw string.
  assert.equal(typeof pg.types.getTypeParser(1003, "text")('{"id"}'), "string");
  assert.deepEqual(pg.types.getTypeParser(1009, "text")('{"id"}'), ["id"]);
  await install();
  await install();
  assert.equal(metadataFields.length, 4, "preflight y postcheck de ambas ejecuciones");
  for (const fields of metadataFields) {
    for (const name of ["columns", "foreignColumns"]) assert.equal(fields.find(field => field.name === name)?.dataTypeID, 1009, name);
  }
});

test("upgrade permite sede y teléfono nullable conservando chats y asignaciones históricas", async t => {
  const { database, install } = await fixture(t);
  await database.exec(setupSql);
  await database.exec(`INSERT INTO "Sede" VALUES(1); INSERT INTO "Usuario" VALUES(1); INSERT INTO "Vendedor" VALUES(1);
    INSERT INTO "AttentionConversation"(id,channel,phone,name,"sedeId","assigneeKey","assigneeUserId","assigneeSellerId")
      VALUES('00000000-0000-4000-8000-000000000001','whatsapp','+573001234567','Histórico',1,'seller:1',1,1);
    ALTER TABLE "AttentionConversation" ALTER COLUMN "sedeId" SET NOT NULL, ALTER COLUMN phone SET NOT NULL;`);
  const before = (await database.query('SELECT * FROM "AttentionConversation"')).rows;
  await install();
  assert.deepEqual((await database.query('SELECT * FROM "AttentionConversation"')).rows, before);
  await database.query(`INSERT INTO "AttentionConversation"(id,channel,phone,name,"sedeId") VALUES('00000000-0000-4000-8000-000000000002','whatsapp',null,'Contacto de WhatsApp',null)`);
  const columns = (await database.query(`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public'
    AND table_name='AttentionConversation' AND column_name IN ('phone','sedeId') ORDER BY column_name`)).rows;
  assert.deepEqual(columns,[{column_name:"phone",is_nullable:"YES"},{column_name:"sedeId",is_nullable:"YES"}]);
});
