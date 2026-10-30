import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { createAttentionStore } = await jiti.import("../lib/atencion-storage.ts");
const migration = readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8");
const central = { userId: 1, sellerId: null, key: "user:1", name: "Central", central: true, admin: true, supervisor: false, aliadoId: 1, sedeId: 10 };
const ally = { ...central, userId: 2, key: "user:2", name: "Aliado", central: false, aliadoId: 2, sedeId: 20 };
const seller = { ...ally, userId: 3, sellerId: 100, key: "seller:100", name: "Asesora", admin: false };
const otherSeller = { ...seller, sellerId: 101, key: "seller:101", name: "Otro asesor" };
const supervisor = { ...seller, sellerId: 102, key: "seller:102", name: "Supervisor", supervisor: true };
const filters = { search: "", filter: "all", page: 1 };
const fixtureSql = `
CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer,activa boolean DEFAULT true);
CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean DEFAULT true,"sedeId" integer,"rolId" integer);
CREATE TABLE "Vendedor"(id integer PRIMARY KEY,nombre text,activo boolean DEFAULT true);
CREATE TABLE "SedeVendedor"("sedeId" integer,"vendedorId" integer,activo boolean DEFAULT true);
CREATE TABLE "Credito"(id integer PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,"clienteTelefono" text,
 "sedeId" integer,"vendedorId" integer,estado text,"referenciaEquipo" text,"equipoMarca" text,"equipoModelo" text,
 "montoCredito" float,"valorCuota" float,"plazoMeses" integer,"frecuenciaPago" text,"fechaPrimerPago" timestamp,"fechaProximoPago" timestamp,
 "pazYSalvoEmitidoAt" timestamp,"planCapitalVigente" jsonb,"contratoSnapshot" jsonb);
CREATE TABLE "CreditoAbono"(id integer PRIMARY KEY,"creditoId" integer,valor float,estado text,"anuladoAt" timestamp,"metodoPago" text,"fechaAbono" timestamp);
CREATE TABLE "DataCreditoAssessment"(id uuid PRIMARY KEY,"creditId" integer,status text,"createdAt" timestamp,"sedeId" integer,"aliadoId" integer,"sellerId" integer);
CREATE TABLE "CreditoBorrador"(id integer PRIMARY KEY,"creditoId" integer,"clienteNombre" text,"clienteDocumento" text,"clienteTelefono" text,
  "sedeId" integer,"vendedorId" integer,estado text,"dataCreditoAssessmentId" uuid,"createdAt" timestamp,payload jsonb);
INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR');
INSERT INTO "Sede" VALUES(10,'Central',1,true),(20,'Sede propia',2,true),(21,'Otra sede propia',2,true),(30,'Ajena',3,true);
INSERT INTO "Usuario" VALUES(1,'Central',true,10,1),(2,'Aliado',true,20,1),(3,'Acceso sede',true,20,2),(4,'Admin ajeno',true,30,1);
INSERT INTO "Vendedor" VALUES(100,'Asesora',true),(101,'Otro asesor',true),(102,'Supervisor',true),(200,'Ajeno',true),(300,'Inactivo',false);
INSERT INTO "SedeVendedor" VALUES(20,100,true),(20,101,true),(20,102,true),(30,200,true),(20,300,true);
INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono","sedeId","vendedorId",estado,"referenciaEquipo","montoCredito","valorCuota","plazoMeses","frecuenciaPago","fechaPrimerPago","contratoSnapshot") VALUES
 (1,'CR1','Persona uno','12345678','3001234567',20,100,'ACTIVO','Equipo A',300,100,3,'QUINCENAL','2026-11-02','{"secret":"DO_NOT_EXPOSE"}'),
 (2,'CR2','Persona uno','12345678','+573001234567',20,100,'ACTIVO','Equipo B',300,100,3,'QUINCENAL','2026-11-02','{}'),
 (3,'CR3','Persona ajena','9999','3001234567',30,200,'ACTIVO','Equipo C',300,100,3,'QUINCENAL','2026-11-02','{}'),
 (4,'CR4','Otro cliente','7777','3000000002',20,101,'ACTIVO','Equipo D',300,100,3,'QUINCENAL',null,'{}');
INSERT INTO "CreditoAbono" VALUES(1,1,100,'ACTIVO',null,'EFECTIVO','2026-10-30'),(2,1,100,'ANULADO','2026-10-30','EFECTIVO','2026-10-30');
INSERT INTO "DataCreditoAssessment" VALUES('00000000-0000-4000-8000-000000000001',1,'APROBADO','2026-10-30',20,2,100);
`;
function adapter(db) {
  return { $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows,
    $transaction: (fn) => db.transaction(tx => fn(adapter(tx))) };
}
async function fixture(t, install = true) {
  const db = new PGlite({ parsers: { 1114: value => new Date(`${value.replace(" ", "T")}Z`) } });
  t.after(() => db.close()); await db.exec(fixtureSql); if (install) await db.exec(migration);
  const store = createAttentionStore(adapter(db));
  const create = (actor = seller, input = {}) => store.createAttentionCase(actor, { phone: "3001234567", name: "Contacto real", sedeId: actor.sedeId, requestId: randomUUID(), ...input });
  const mutation = (action, data = {}) => ({ action, requestId: randomUUID(), version: 1, ...data });
  return { db, store, create, mutation };
}
test("sin esquema: bandeja explícitamente pendiente y escrituras rechazadas", async t => {
  const { store, create } = await fixture(t, false);
  assert.equal((await store.getAttentionInbox(central, filters)).schemaReady, false);
  await assert.rejects(create(), { status: 503 });
});
test("bandeja aísla aliado, sede y asesor; un chat transferido desaparece del asesor anterior", async t => {
  const { store, create, mutation } = await fixture(t);
  const own = await create(); const other = await create(otherSeller); await create(central, { sedeId: 30 }); await create(central, { sedeId: 21 });
  assert.equal((await store.getAttentionInbox(seller, filters)).total, 1);
  assert.equal((await store.getAttentionInbox(supervisor, filters)).total, 2);
  assert.equal((await store.getAttentionInbox(ally, filters)).total, 3);
  assert.equal((await store.getAttentionInbox(central, filters)).total, 4);
  await assert.rejects(store.getAttentionDetail(seller, other.id), { status: 404 });
  await store.mutateAttentionConversation(seller, own.id, mutation("transfer", { assigneeKey: "seller:101" }));
  await assert.rejects(store.getAttentionDetail(seller, own.id), { status: 404 });
  assert.equal((await store.getAttentionDetail(otherSeller, own.id)).conversation.assigneeKey, "seller:101");
});
test("transferencias validan sede/perfil activo y ningún cliente cambia datos canónicos", async t => {
  const { store, create, mutation, db } = await fixture(t); const { id } = await create();
  const before = (await db.query('SELECT * FROM "Credito" ORDER BY id')).rows;
  for (const key of ["seller:200", "seller:300", "user:4"]) await assert.rejects(store.mutateAttentionConversation(seller, id, mutation("transfer", { assigneeKey: key })), { status: 403 });
  await store.mutateAttentionConversation(seller, id, mutation("note", { text: "Seguimiento interno" }));
  assert.deepEqual((await db.query('SELECT * FROM "Credito" ORDER BY id')).rows, before);
});
test("crear/reintentar/notas son idempotentes y la versión evita sobrescribir cambios", async t => {
  const { store, create, mutation } = await fixture(t); const requestId = randomUUID();
  const first = await create(seller, { requestId }); assert.deepEqual(await create(seller, { requestId }), first);
  await assert.rejects(create(seller, { requestId, name: "Alterado" }), { status: 409 });
  const note = mutation("note", { text: "Una sola nota" });
  await store.mutateAttentionConversation(seller, first.id, note); await store.mutateAttentionConversation(seller, first.id, note);
  const detail = await store.getAttentionDetail(seller, first.id); assert.equal(detail.notes.length, 1); assert.equal(detail.conversation.version, 2);
  await assert.rejects(store.mutateAttentionConversation(seller, first.id, mutation("close")), { status: 409 });
});
test("ficha usa créditos existentes, no expone finanzas a asesor y excluye abonos anulados", async t => {
  const { store, create, db } = await fixture(t); const { id } = await create();
  const own = await store.getAttentionDetail(seller, id);
  assert.equal(own.customer.match, "linked"); assert.deepEqual(own.customer.credits.map(c => c.id), [2,1]);
  assert.equal(own.customer.financialAllowed, false); assert.equal(own.customer.credits[1].balance, null); assert.deepEqual(own.customer.credits[1].payments, []);
  assert.ok(!JSON.stringify(own).includes("DO_NOT_EXPOSE"));
  const admin = await store.getAttentionDetail(ally, id); assert.equal(admin.customer.credits.find(c => c.id === 1).balance, 200);
  assert.equal(admin.customer.studies.length, 1);
  assert.ok((await db.query('SELECT count(*)::integer AS n FROM "AttentionAudit" WHERE action=\'CONVERSATION_VIEWED\'')).rows[0].n >= 2);
  await assert.rejects(db.query('DELETE FROM "AttentionAudit"'));
});
test("teléfono compartido queda ambiguo y vinculación explícita nunca cruza sedes", async t => {
  const { store, create, mutation, db } = await fixture(t); const { id } = await create();
  await db.query('UPDATE "Credito" SET "clienteDocumento"=$1 WHERE id=2', ["87654321"]);
  const detail = await store.getAttentionDetail(ally, id); assert.equal(detail.customer.match, "ambiguous"); assert.equal(detail.customer.credits.length, 0);
  await assert.rejects(store.mutateAttentionConversation(ally, id, mutation("link", { creditId: 3 })), { status: 403 });
  await store.mutateAttentionConversation(ally, id, mutation("link", { creditId: 1 }));
  assert.deepEqual((await store.getAttentionDetail(ally, id)).customer.credits.map(c => c.id), [1]);
});
test("tareas/notas internas y solicitud humana no fabrican mensajes ni estados remotos", async t => {
  const { store, create, mutation } = await fixture(t); const { id } = await create();
  await store.mutateAttentionConversation(seller, id, mutation("task", { text: "Revisar documentación", dueAt: "2026-11-01T15:00:00Z" }));
  const detail = await store.getAttentionDetail(seller, id);
  await store.mutateAttentionConversation(seller, id, mutation("complete_task", { version: 2, taskId: detail.tasks[0].id }));
  await store.mutateAttentionConversation(seller, id, mutation("human_request", { version: 3 }));
  const after = await store.getAttentionDetail(seller, id); assert.equal(after.conversation.mode, "human_requested"); assert.equal(after.messages.length, 0); assert.ok(after.tasks[0].completedAt);
});
test("importación solo central deduplica mensajes, conserva gestión y bloquea cambio de sede", async t => {
  const { store, mutation } = await fixture(t);
  const snapshots = [{ externalId: "provider-chat-1", phone: "+573001234567", name: "Contacto", mode: "ai", lastContactAt: "2026-10-30T15:00:00Z", historyTruncated: false, historyCursor: null,
    messages: [{ id: "provider-msg-1", direction: "inbound", text: "Consulta", sentAt: "2026-10-30T15:00:00Z", author: null }] }];
  await assert.rejects(store.importAttentionSnapshots(ally, 20, snapshots), { status: 403 });
  assert.equal((await store.importAttentionSnapshots(central, 20, snapshots)).imported, 1);
  const { conversations } = await store.getAttentionInbox(seller, filters); assert.equal(conversations.length, 1);
  const id = conversations[0].id; await store.mutateAttentionConversation(seller, id, mutation("claim"));
  await store.mutateAttentionConversation(seller, id, mutation("close", { version: 2 }));
  assert.equal((await store.importAttentionSnapshots(central, 20, snapshots)).imported, 0);
  const detail = await store.getAttentionDetail(seller, id); assert.equal(detail.messages.length, 1); assert.equal(detail.conversation.status, "closed"); assert.equal(detail.conversation.version, 3);
  await assert.rejects(store.importAttentionSnapshots(central, 21, snapshots), { status: 409 });
});
test("respuestas rápidas solo tras aprobación central y sin duplicación en reintentos", async t => {
  const { store } = await fixture(t); const input = { title: "Saludo aprobado", text: "Texto aprobado explícitamente", requestId: randomUUID() };
  await assert.rejects(store.saveAttentionQuickReply(ally, input), { status: 403 });
  await store.saveAttentionQuickReply(central, input); await store.saveAttentionQuickReply(central, input);
  assert.equal((await store.getAttentionInbox(seller, filters)).quickReplies.length, 1);
});
test("prospecto existente se resuelve desde borrador sin crédito, sin duplicar ni exponer payload", async t => {
  const { store, create, db } = await fixture(t);
  await db.query(`INSERT INTO "CreditoBorrador" VALUES(1,null,'Prospecto oficial','123456','003001111111',20,100,'ABIERTO',null,'2026-10-30','{"secret":"DRAFT_PRIVATE"}')`);
  const { id } = await create(seller, { phone: "3001111111", name: "+573001111111" });
  const detail = await store.getAttentionDetail(seller, id);
  assert.equal(detail.customer.match, "linked"); assert.equal(detail.customer.name, "Prospecto oficial");
  assert.equal(detail.conversation.name, "Prospecto oficial"); assert.equal(detail.customer.credits.length, 0);
  assert.equal(detail.customer.studies[0].id, "D-1"); assert.ok(!JSON.stringify(detail).includes("DRAFT_PRIVATE"));
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM "CreditoBorrador"')).rows[0].n, 1);
  assert.equal((await store.getAttentionInbox(seller, { ...filters, search: "Prospecto oficial" })).total, 1);
});
test("búsqueda por nombre canónico no revela cliente de otro asesor, y draft de otra identidad hace ambiguo", async t => {
  const { store, create, db } = await fixture(t); const { id } = await create(seller, { name: "3001234567" });
  assert.equal((await store.getAttentionInbox(seller, { ...filters, search: "Persona uno" })).total, 1);
  await db.query(`INSERT INTO "CreditoBorrador" VALUES(1,null,'Nombre privado ajeno','444444','3001234567',20,101,'ABIERTO',null,'2026-10-30','{}')`);
  assert.equal((await store.getAttentionInbox(seller, { ...filters, search: "Nombre privado ajeno" })).total, 0);
  assert.equal((await store.getAttentionDetail(seller, id)).customer.match, "linked");
  assert.equal((await store.getAttentionDetail(ally, id)).customer.match, "ambiguous");
});
test("batch de mensajes nuevos reabre finalizada y conserva solicitud humana local", async t => {
  const { store, mutation } = await fixture(t);
  const initial = [{ externalId: "chat-reopen", phone: "3001234567", name: null, mode: "ai", lastContactAt: "2026-10-01T10:00:00Z", historyTruncated: true, historyCursor: null, messages: [] }];
  await store.importAttentionSnapshots(central, 20, initial);
  const id = (await store.getAttentionInbox(seller, filters)).conversations[0].id;
  await store.mutateAttentionConversation(seller, id, mutation("claim"));
  await store.mutateAttentionConversation(seller, id, mutation("human_request", { version: 2 }));
  await store.mutateAttentionConversation(seller, id, mutation("close", { version: 3 }));
  const sentAt = new Date(Date.now() + 60000).toISOString();
  const update = [{ ...initial[0], mode: "human", lastContactAt: sentAt, messages: Array.from({ length: 300 }, (_, i) => ({ id: `new-${i}`, direction: "inbound", text: `Texto ${i}`, sentAt, author: null })) }];
  await store.importAttentionSnapshots(central, 20, update);
  const detail = await store.getAttentionDetail(seller, id);
  assert.equal(detail.conversation.status, "pending"); assert.equal(detail.conversation.mode, "human_requested"); assert.equal(detail.messages.length, 300);
  assert.equal((await store.importAttentionSnapshots(central, 20, update)).imported, 0);
  assert.equal((await store.getAttentionDetail(seller, id)).messages.length, 300);
});
test("mensaje posterior al cierre reabre aunque una nota local posterior cambie updatedAt", async t => {
  const { store, db, mutation } = await fixture(t);
  const snapshots = [{ externalId: "closure-boundary", phone: "3001234567", name: null, mode: "ai", lastContactAt: "2026-10-30T09:00:00Z", historyTruncated: false, historyCursor: null, messages: [] }];
  await store.importAttentionSnapshots(central, 20, snapshots);
  const id = (await store.getAttentionInbox(seller, filters)).conversations[0].id;
  await store.mutateAttentionConversation(seller, id, mutation("claim"));
  await store.mutateAttentionConversation(seller, id, mutation("close", { version: 2 }));
  await db.query(`UPDATE "AttentionConversation" SET "closedAt"='2026-10-30T10:00:00Z',"updatedAt"='2026-10-30T10:00:00Z' WHERE id=$1`, [id]);
  await store.mutateAttentionConversation(seller, id, mutation("note", { version: 3, text: "Nota después del cierre" }));
  await db.query(`UPDATE "AttentionConversation" SET "updatedAt"='2026-10-30T10:06:00Z' WHERE id=$1`, [id]);
  const oldMessage = { id: "pre-close", direction: "inbound", text: "Anterior al cierre", sentAt: "2026-10-30T09:59:00Z", author: null };
  await store.importAttentionSnapshots(central, 20, [{ ...snapshots[0], messages: [oldMessage] }]);
  assert.equal((await store.getAttentionDetail(seller, id)).conversation.status, "closed");
  const newMessage = { ...oldMessage, id: "post-close", sentAt: "2026-10-30T10:05:00Z" };
  await store.importAttentionSnapshots(central, 20, [{ ...snapshots[0], messages: [oldMessage, newMessage] }]);
  assert.equal((await store.getAttentionDetail(seller, id)).conversation.status, "pending");
  assert.equal((await db.query('SELECT "closedAt" FROM "AttentionConversation" WHERE id=$1', [id])).rows[0].closedAt, null);
});
test("historial interno devuelve notas recientes y prioriza tareas pendientes con límite visible", async t => {
  const { store, db, create, mutation } = await fixture(t); const { id } = await create();
  const notes = Array.from({ length: 300 }, (_, i) => ({ id: randomUUID(), text: `Nota antigua ${i}`, createdAt: new Date(Date.UTC(2026,0,1,0,i)).toISOString() }));
  await db.query(`INSERT INTO "AttentionNote"(id,"conversationId",text,author,"userId","sellerId","createdAt")
    SELECT n.id,$1::uuid,n.text,'Asesora',3,100,n."createdAt" FROM jsonb_to_recordset($2::jsonb) AS n(id uuid,text text,"createdAt" timestamptz)`, [id, JSON.stringify(notes)]);
  await store.mutateAttentionConversation(seller, id, mutation("note", { text: "Nota más reciente visible" }));
  const tasks = Array.from({ length: 300 }, (_, i) => ({ id: randomUUID(), title: `Tarea finalizada ${i}` }));
  await db.query(`INSERT INTO "AttentionTask"(id,"conversationId",title,author,"userId","sellerId","completedAt")
    SELECT t.id,$1::uuid,t.title,'Asesora',3,100,now() FROM jsonb_to_recordset($2::jsonb) AS t(id uuid,title text)`, [id, JSON.stringify(tasks)]);
  await store.mutateAttentionConversation(seller, id, mutation("task", { version: 2, text: "Pendiente prioritaria", dueAt: "2026-11-01T15:00:00Z" }));
  const detail = await store.getAttentionDetail(seller, id);
  assert.equal(detail.notesTruncated, true); assert.equal(detail.tasksTruncated, true);
  assert.equal(detail.notes.length, 300); assert.equal(detail.notes.at(-1).text, "Nota más reciente visible");
  assert.equal(detail.tasks[0].title, "Pendiente prioritaria");
});
test("checkpoint del historial avanza de forma atómica y permanece privado por sede", async t => {
  const { store } = await fixture(t);
  const snapshot = { externalId: "checkpoint", phone: "3001234567", name: null, mode: "ai", lastContactAt: null,
    historyTruncated: true, historyCursor: "opaque-page-300", messages: [] };
  await store.importAttentionSnapshots(central, 20, [snapshot]);
  await store.importAttentionSnapshots(central, 30, [{ ...snapshot, externalId: "other-branch", historyCursor: "foreign-checkpoint" }]);
  await assert.rejects(store.getAttentionHistoryCursors(ally, 20), { status: 403 });
  assert.deepEqual(await store.getAttentionHistoryCursors(central, 20), { checkpoint: "opaque-page-300" });
  await assert.rejects(store.importAttentionSnapshots(central, 20, [
    { ...snapshot, historyCursor: "opaque-page-600" }, { ...snapshot, externalId: "zz-invalid", historyCursor: "bad cursor" },
  ]), { status: 400 });
  assert.deepEqual(await store.getAttentionHistoryCursors(central, 20), { checkpoint: "opaque-page-300" });
  await store.importAttentionSnapshots(central, 20, [{ ...snapshot, historyCursor: "opaque-page-600" }]);
  assert.deepEqual(await store.getAttentionHistoryCursors(central, 20), { checkpoint: "opaque-page-600" });
  const inbox = await store.getAttentionInbox(central, filters);
  const detail = await store.getAttentionDetail(central, inbox.conversations.find(c => c.externalId === "checkpoint").id);
  for (const output of [inbox, detail]) {
    assert.ok(!JSON.stringify(output).includes("opaque-page")); assert.ok(!JSON.stringify(output).includes("foreign-checkpoint"));
    assert.ok(!JSON.stringify(output).includes("daptaMessagesCursor"));
  }
});
