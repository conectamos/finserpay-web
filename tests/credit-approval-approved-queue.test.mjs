import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import pg from "pg";

function load(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(output, { module: loaded, exports: loaded.exports, Buffer, Date, URL, Request, Response, Uint8Array,
    require(name) { if (name === "server-only") return {}; assert.ok(name in dependencies, `${path}: ${name}`); return dependencies[name]; },
  }, { filename: path });
  return loaded.exports;
}
const actors = load("lib/credit-approval-actor.ts");
const errors = load("lib/credit-approval-errors.ts");
const policy = load("lib/credit-approval-policy.ts", { "./credit-import-flags": load("lib/credit-import-flags.ts") });
const queue = load("lib/credit-approval-queue.ts", {
  "@/lib/credit-approval-actor": actors, "@/lib/credit-approval-errors": errors, "@/lib/credit-approval-policy": policy,
});
const plain = value => JSON.parse(JSON.stringify(value));
const stamp = "2026-09-11T18:30:00.000Z";
const cursor = value => Buffer.from(JSON.stringify(value)).toString("base64url");

test("Aprobadas pagina por fecha de OK e id y rechaza cursores de otra bandeja", () => {
  const page = queue.approvedQueuePage([{ id: 12, approvedAt: stamp }, { id: 11, approvedAt: stamp }], 1);
  assert.equal(page.hasMore, true); assert.equal(page.items.length, 1);
  assert.deepEqual(plain(queue.parseApprovedQueueCursor(page.nextCursor)), { view: "approved", approvedAt: stamp, id: 12 });
  assert.throws(() => queue.parseApprovalQueueCursor(page.nextCursor), { code: "INVALID_CURSOR" });
  assert.throws(() => queue.parseApprovedQueueCursor(cursor({ createdAt: stamp, id: 12 })), { code: "INVALID_CURSOR" });
  for (const bad of ["garbage", "%invalid", "a".repeat(257), ...[
    { view: "pending", approvedAt: stamp, id: 12 }, { view: "approved", approvedAt: "invalid", id: 12 },
    { view: "approved", approvedAt: stamp, id: 0 }, { view: "approved", approvedAt: stamp, id: 2147483648 },
    { view: "approved", approvedAt: stamp, id: "12" }, { view: "approved", approvedAt: stamp, id: 12, other: true },
    { view: "approved", approvedAt: "2026-09-11T18:30:00-05:00", id: 12 },
  ].map(cursor)]) assert.throws(() => queue.parseApprovedQueueCursor(bad), { code: "INVALID_CURSOR" });
  assert.deepEqual(plain(queue.approvedQueuePage([], 50)), { items: [], hasMore: false, nextCursor: null });
});

test("el listado aprobado exige política y no usa auditoría, blobs ni escrituras", async () => {
  await assert.rejects(queue.listApprovedCreditQueue({ $queryRawUnsafe: async () => [] }), { code: "APPROVAL_UNAVAILABLE" });
  const calls = [];
  await queue.listApprovedCreditQueue({ $queryRawUnsafe: async (sql, ...params) => {
    calls.push({ sql, params }); return calls.length === 1 ? [{ id: 1 }] : [];
  } }, { documento: "123456", limit: 25, cursor: cursor({ view: "approved", approvedAt: stamp, id: 12 }) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, ["123456", stamp, 12, 26]);
  assert.doesNotMatch(calls[1].sql, /CreditApprovalEvent|signedDocumentBase64|fotoEntregaDataUrl|audioBytes|INSERT|UPDATE|DELETE/);
  assert.match(calls[1].sql, /ORDER BY review\."approvedAt" DESC,credit\."id" DESC/);
  assert.throws(() => actors.buildCurrentCreditApprovalSql("credit; DROP TABLE", "review"), /Invalid approval SQL alias/);
});

test("búsqueda limitada y literal se aplica solo a cliente, folio y aliado", async () => {
  assert.equal(queue.approvalQueueSearch("  Cliente  "), "Cliente");
  for (const empty of [null, undefined, "", "   "]) assert.equal(queue.approvalQueueSearch(empty), null);
  for (const invalid of [1, {}, "x".repeat(101), "x\u0000", "x\n"]) assert.throws(() => queue.approvalQueueSearch(invalid), { code: "INVALID_SEARCH" });
  assert.equal(queue.approvalQueueSearch("x".repeat(100)).length, 100);
  for (const method of ["listCreditApprovalQueue", "listApprovedCreditQueue", "countCreditApprovalQueues"]) {
    const calls = [], value = "_%' OR 1=1 --";
    await queue[method]({ $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params }); return calls.length === 1 ? [{ id: 1 }] : [];
    } }, { q: value });
    assert.equal(calls[1].params.at(-1), value); assert.ok(!calls[1].sql.includes(value));
    assert.match(calls[1].sql, /strpos\(lower\(COALESCE\(credit\."clienteNombre"/);
    assert.match(calls[1].sql, /strpos\(lower\(COALESCE\(credit\."folio"/);
    assert.match(calls[1].sql, /strpos\(lower\(COALESCE\(ally\."nombre"/);
    assert.doesNotMatch(calls[1].sql, /strpos\(lower\(COALESCE\(credit\."clienteDocumento"/);
  }
  await assert.rejects(queue.countCreditApprovalQueues({ $queryRawUnsafe: async () => [] }), { code: "APPROVAL_UNAVAILABLE" });
});

test("los GET de ficha, PDF y fotos usan el permiso de lectura, antes de leer cada archivo", async () => {
  const actor = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId: randomUUID(), sessionId: randomUUID() };
  for (const [path, operation] of [
    ["app/api/aprobaciones/[id]/route.ts", "getCreditApprovalDetail"],
    ["app/api/aprobaciones/[id]/documento/route.ts", "getApprovalDocument"],
    ["app/api/aprobaciones/[id]/evidencias/route.ts", "getApprovalEvidence"],
  ]) for (const allowed of [true, false]) {
    const order = [];
    const route = load(path, {
      "next/server": { NextResponse: Response },
      "@/lib/prisma": { default: { $transaction: async fn => fn({}) } },
      "@/lib/credit-approval-actor": { assertApprovalActorCreditReadAccess: async (_db, id, received) => {
        assert.equal(id, 81); assert.equal(received, actor); order.push("read-access");
        if (!allowed) throw new actors.ApprovalActorCreditAccessError();
      } },
      "@/lib/credit-approval": { approvalCreditId: Number, [operation]: async () => {
        order.push(operation); return operation === "getCreditApprovalDetail" ? { id: 81 } : { bytes: Buffer.from("synthetic"), mime: "image/png", fileName: "document.pdf" };
      } },
      "@/lib/credit-approval-evidence": {},
      "@/lib/credit-approval-http": { getApprovalActor: async () => actor,
        approvalPrivateHeaders: { "Cache-Control": "private, no-store" },
        approvalErrorResponse: error => Response.json({ ok: false }, { status: error.status || 500 }) },
    });
    const response = await route.GET(new Request("https://test.invalid/api/aprobaciones/81?tipo=cedula-frente"), { params: Promise.resolve({ id: "81" }) });
    assert.equal(response.status, allowed ? 200 : 404);
    assert.deepEqual(order, allowed ? ["read-access", operation] : ["read-access"]);
    if (allowed) assert.match(response.headers.get("cache-control"), /no-store/);
  }
});

// Local synthetic database only; deliberately nullable reviews exercise fail-closed list filtering.
pg.types.setTypeParser(1114, value => new Date(value.replace(" ", "T") + "Z"));
const connectionString = process.env.CREDIT_APPROVAL_QUEUE_TEST_DATABASE_URL;
test("PostgreSQL aislado: bandejas actuales, paginación y lectura de aprobados liquidados", {
  skip: connectionString ? false : "Requiere CREDIT_APPROVAL_QUEUE_TEST_DATABASE_URL local approval_queue_test",
}, async t => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/approval_queue_test");
  const db = new pg.Client({ connectionString }); await db.connect(); t.after(() => db.end());
  const tables = ["CreditApprovalSharedSession", "CreditApprovalSharedGrant", "CreditApprovalNoveltyItem", "CreditApprovalNovelty", "CreditApprovalReissue",
    "CreditApprovalReview", "CreditApprovalPolicy", "LiquidacionAliadoCredito", "Credito", "Sede", "Aliado"];
  const existing = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
  assert.ok(existing.every(row => tables.includes(row.tablename)), "No eliminar tablas ajenas al fixture");
  for (const table of tables) await db.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
  await db.query(`
    CREATE TABLE "CreditApprovalPolicy" ("id" INT PRIMARY KEY,"activatedAt" TIMESTAMP(3));
    INSERT INTO "CreditApprovalPolicy" VALUES (1,'2026-09-09');
    CREATE TABLE "Aliado" ("id" INT PRIMARY KEY,"nombre" TEXT,"codigo" TEXT);
    INSERT INTO "Aliado" VALUES (10,'Aliado sintético','ALLY'),(20,'Central','FINSERPAY');
    CREATE TABLE "Sede" ("id" INT PRIMARY KEY,"aliadoId" INT,"nombre" TEXT DEFAULT 'Sede sintética');
    INSERT INTO "Sede" ("id","aliadoId") VALUES (10,10),(20,20);
    CREATE TABLE "Credito" ("id" SERIAL PRIMARY KEY,"folio" TEXT DEFAULT 'FNS-SYNTHETIC',"clienteNombre" TEXT DEFAULT 'Cliente sintético',
      "clienteDocumento" TEXT,"sedeId" INT DEFAULT 10,"createdAt" TIMESTAMP(3) DEFAULT '2026-09-10',
      "fechaCredito" TIMESTAMP(3) DEFAULT '2026-09-10',"estado" TEXT DEFAULT 'INSCRITO',"equalityService" TEXT,"contratoSnapshot" JSONB DEFAULT '{}');
    CREATE TABLE "CreditApprovalReview" ("creditoId" INT PRIMARY KEY,"status" TEXT DEFAULT 'PENDING',"revision" INT DEFAULT 1,
      "approvedRevision" INT,"approvedAt" TIMESTAMP(3),"approvedByName" TEXT,"approvedByUserId" INT,"approvedByKind" TEXT,
      "approvedByGrantId" UUID,"approvedBySessionId" UUID,"reviewHash" TEXT);
    CREATE TABLE "LiquidacionAliadoCredito" ("creditoId" INT PRIMARY KEY);
    CREATE TABLE "CreditApprovalNovelty" ("id" UUID PRIMARY KEY,"creditoId" INT,"status" TEXT,"version" INT DEFAULT 1);
    CREATE TABLE "CreditApprovalNoveltyItem" ("id" UUID PRIMARY KEY,"noveltyId" UUID,"status" TEXT);
    CREATE TABLE "CreditApprovalReissue" ("id" UUID PRIMARY KEY,"creditoId" INT,"status" TEXT,"requestedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "CreditApprovalSharedGrant" ("id" UUID PRIMARY KEY,"scope" TEXT DEFAULT 'CREDIT_APPROVAL',"revokedAt" TIMESTAMP(3));
    CREATE TABLE "CreditApprovalSharedSession" ("id" UUID PRIMARY KEY,"grantId" UUID,"revokedAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3));
  `);
  const api = { $queryRawUnsafe: async (sql, ...params) => (await db.query(sql, params)).rows };
  const shared = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId: randomUUID(), sessionId: randomUUID() };
  await db.query('INSERT INTO "CreditApprovalSharedGrant" ("id") VALUES ($1)', [shared.grantId]);
  await db.query('INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt") VALUES ($1,$2,\'2099-01-01\')', [shared.sessionId, shared.grantId]);
  const create = async (documento, values = {}) => {
    const fields = { clienteDocumento: documento, ...values };
    const id = (await db.query(`INSERT INTO "Credito" (${Object.keys(fields).map(k => `"${k}"`).join(",")}) VALUES (${Object.keys(fields).map((_, i) => `$${i+1}`).join(",")}) RETURNING "id"`, Object.values(fields))).rows[0].id;
    await db.query('INSERT INTO "CreditApprovalReview" ("creditoId") VALUES ($1)', [id]); return id;
  };
  const approve = async (id, values = {}) => {
    const fields = { status: "APPROVED", approvedRevision: 1, revision: 1, approvedAt: stamp, approvedByName: "Analista sintético", approvedByKind: "USER",
      approvedByUserId: 7, approvedByGrantId: null, approvedBySessionId: null, reviewHash: "a".repeat(64), ...values };
    await db.query(`UPDATE "CreditApprovalReview" SET ${Object.keys(fields).map((k, i) => `"${k}"=$${i+2}`).join(",")} WHERE "creditoId"=$1`, [id, ...Object.values(fields)]);
  };
  const approvedIds = async documento => (await queue.listApprovedCreditQueue(api, { documento, limit: 100 })).items.map(row => row.id);
  const pendingIds = async documento => (await queue.listCreditApprovalQueue(api, { documento, limit: 100 })).items.map(row => row.id);

  await t.test("Pendiente, OK, invalidación y nuevo OK muestran solo el estado actual", async () => {
    const id = await create("transition");
    assert.deepEqual(await pendingIds("transition"), [id]); assert.deepEqual(await approvedIds("transition"), []);
    await approve(id); assert.deepEqual(await pendingIds("transition"), []); assert.deepEqual(await approvedIds("transition"), [id]);
    await db.query('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\',"revision"=2,"approvedRevision"=NULL,"approvedAt"=NULL,"approvedByName"=NULL,"reviewHash"=NULL WHERE "creditoId"=$1', [id]);
    assert.deepEqual(await pendingIds("transition"), [id]); assert.deepEqual(await approvedIds("transition"), []);
    await approve(id, { revision: 2, approvedRevision: 2 }); assert.deepEqual(await pendingIds("transition"), []);
    assert.deepEqual(await approvedIds("transition"), [id]);
  });
  await t.test("Novedad respondida sigue pendiente hasta resolver y dar OK", async () => {
    const id = await create("novelty"); const noveltyId = randomUUID();
    await db.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId","status") VALUES ($1,$2,\'WAITING_ALLY\')', [noveltyId, id]);
    await db.query('INSERT INTO "CreditApprovalNoveltyItem" VALUES ($1,$2,\'OPEN\')', [randomUUID(), noveltyId]);
    assert.deepEqual(await approvedIds("novelty"), []);
    await db.query('UPDATE "CreditApprovalNovelty" SET "status"=\'RESPONDED\' WHERE "id"=$1', [noveltyId]);
    await db.query('UPDATE "CreditApprovalNoveltyItem" SET "status"=\'RESPONDED\' WHERE "noveltyId"=$1', [noveltyId]);
    assert.deepEqual(await pendingIds("novelty"), [id]); assert.deepEqual(await approvedIds("novelty"), []);
    await approve(id); assert.deepEqual(await approvedIds("novelty"), [], "A corrupt OK with unresolved novelty never enters Aprobadas");
    await db.query('UPDATE "CreditApprovalNovelty" SET "status"=\'RESOLVED\' WHERE "id"=$1', [noveltyId]);
    assert.deepEqual(await approvedIds("novelty"), [id]);
  });
  await t.test("Históricos, importados, central y cancelados quedan fuera aun con revisión aprobada", async () => {
    const excluded = [];
    for (const fields of [{ createdAt: "2020-01-01" }, { equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } },
      { sedeId: 20 }, { estado: "ANULADO" }, { estado: "CANCELADA" }]) {
      const id = await create("scope", fields); await approve(id); excluded.push(id);
    }
    const valid = await create("scope"); await approve(valid);
    assert.deepEqual(await approvedIds("scope"), [valid]);
    for (const id of excluded) await assert.rejects(actors.assertApprovalActorCreditReadAccess(api, id, shared), { status: 404 });
  });
  await t.test("Una revisión corrupta o una firma pendiente no se presentan como aprobadas", async () => {
    for (const bad of [{ approvedRevision: 2 }, { approvedAt: null }, { approvedByName: " " }, { reviewHash: "invalid" },
      { approvedByKind: null }, { approvedByKind: "USER", approvedByUserId: null }, { approvedByKind: "SHARED_LINK", approvedByUserId: null }]) {
      const id = await create("invalid"); await approve(id, bad);
    }
    for (const status of ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE", "UNCERTAIN", "CORRUPT", null]) {
      const id = await create("invalid"); await approve(id);
      await db.query('INSERT INTO "CreditApprovalReissue" ("id","creditoId","status") VALUES ($1,$2,$3)', [randomUUID(), id, status]);
    }
    assert.deepEqual(await approvedIds("invalid"), []);
    const valid = await create("valid-shared"); await approve(valid, { approvedByName: "Acceso compartido", approvedByKind: "SHARED_LINK", approvedByUserId: null, approvedByGrantId: shared.grantId, approvedBySessionId: shared.sessionId });
    await db.query('INSERT INTO "CreditApprovalReissue" ("id","creditoId","status") VALUES ($1,$2,\'COMPLETED\')', [randomUUID(), valid]);
    assert.deepEqual(await approvedIds("valid-shared"), [valid]);
  });
  await t.test("Fecha de aprobación e id ordenan páginas sin duplicados ni blobs", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) { const id = await create("pages"); await approve(id, { approvedAt: i === 0 ? "2026-09-10T12:00:00Z" : stamp }); ids.push(id); }
    let next = null; const rows = [];
    do { const page = await queue.listApprovedCreditQueue(api, { documento: "pages", limit: 2, cursor: next }); rows.push(...page.items); next = page.nextCursor; } while (next);
    assert.deepEqual(rows.map(row => row.id), ids.reverse());
    assert.ok(rows.every(row => row.status === "APPROVED" && row.required === true && row.paid === false));
    assert.ok(rows.every(row => Object.keys(row).sort().join(",") === "aliadoNombre,approvedAt,approvedByName,clienteDocumento,clienteNombre,createdAt,fechaCredito,folio,id,paid,required,revision,sedeNombre,status"));
  });
  await t.test("El liquidado con OK vigente sigue visible y legible; el permiso de escritura no cambia", async () => {
    const id = await create("paid"); await approve(id);
    await db.query('INSERT INTO "LiquidacionAliadoCredito" VALUES ($1)', [id]);
    const before = await db.query('SELECT to_jsonb(c) AS credit,to_jsonb(r) AS review FROM "Credito" c JOIN "CreditApprovalReview" r ON r."creditoId"=c."id" WHERE c."id"=$1', [id]);
    const page = await queue.listApprovedCreditQueue(api, { documento: "paid" });
    assert.equal(page.items[0].paid, true); assert.deepEqual(await pendingIds("paid"), []);
    await actors.assertApprovalActorCreditReadAccess(api, id, shared);
    await assert.rejects(actors.assertApprovalActorCreditAccess(api, id, shared), { status: 404 });
    assert.deepEqual((await db.query('SELECT to_jsonb(c) AS credit,to_jsonb(r) AS review FROM "Credito" c JOIN "CreditApprovalReview" r ON r."creditoId"=c."id" WHERE c."id"=$1', [id])).rows, before.rows);
    await db.query('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\',"approvedRevision"=NULL WHERE "creditoId"=$1', [id]);
    assert.deepEqual(await approvedIds("paid"), []);
    await assert.rejects(actors.assertApprovalActorCreditReadAccess(api, id, shared), { status: 404 });
  });
  await t.test("búsqueda real por nombre, folio y aliado mantiene filtros y caracteres literales", async () => {
    const a = await create("searchDoc", { clienteNombre: "Persona Muro Qax", folio: "MRO-A%_1" });
    const b = await create("searchDoc", { clienteNombre: "Persona Distinta", folio: "MRO-B" }); await approve(b);
    for (const [q, pending, approved] of [["persona muro", [a], []], ["mro-b", [], [b]], ["aliado sintético", [a], [b]],
      ["%_", [a], []], ["' OR 1=1 --", [], []], ["searchDoc", [], []]]) {
      assert.deepEqual((await queue.listCreditApprovalQueue(api, { documento: "searchDoc", q })).items.map(row => row.id), pending);
      assert.deepEqual((await queue.listApprovedCreditQueue(api, { documento: "searchDoc", q })).items.map(row => row.id), approved);
      assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, { documento: "searchDoc", q })), { pending: pending.length, approved: approved.length });
    }
  });
  await t.test("contadores reales superan el tamaño de página y preservan el orden con búsqueda", async () => {
    await db.query(`INSERT INTO "Credito" ("clienteDocumento","clienteNombre","folio")
      SELECT 'countPages','Muro Contador','COUNT-'||n FROM generate_series(1,105) n`);
    const approved = await create("countPages", { clienteNombre: "Muro Contador" }); await approve(approved);
    await db.query('INSERT INTO "LiquidacionAliadoCredito" VALUES ($1)', [approved]);
    const filter = { documento: "countPages", q: "muro contador" };
    const first = await queue.listCreditApprovalQueue(api, { ...filter, limit: 2 });
    const next = await queue.listCreditApprovalQueue(api, { ...filter, limit: 2, cursor: first.nextCursor });
    assert.equal(first.items.length, 2); assert.equal(next.items.length, 2); assert.ok(first.items[1].id < next.items[0].id);
    assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, filter)), { pending: 105, approved: 1 });
    const id = first.items[0].id;
    await db.query('INSERT INTO "CreditApprovalReview" ("creditoId") VALUES ($1)', [id]); await approve(id);
    assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, filter)), { pending: 104, approved: 2 });
    assert.deepEqual((await queue.listApprovedCreditQueue(api, { ...filter, limit: 1 })).items.map(row => row.id), [approved]);
  });
  await t.test("contadores excluyen históricos, importados, central, cancelados y OK corruptos", async () => {
    assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, { documento: "scope" })), { pending: 0, approved: 1 });
    const invalidCounts = await queue.countCreditApprovalQueues(api, { documento: "invalid" });
    assert.equal(invalidCounts.approved, 0);
    assert.equal(invalidCounts.pending, (await pendingIds("invalid")).length);
    assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, { documento: "inexistente" })), { pending: 0, approved: 0 });
  });
  await t.test("snapshot mantiene página y contadores coherentes ante un OK concurrente", async () => {
    const id = await create("snapshotCounts"), second = new pg.Client({ connectionString }); await second.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      assert.deepEqual((await queue.listCreditApprovalQueue(api, { documento: "snapshotCounts" })).items.map(row => row.id), [id]);
      await second.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"=1,"approvedAt"=$2,
        "approvedByName"='Analista sintético',"approvedByKind"='USER',"approvedByUserId"=7,"reviewHash"=$3 WHERE "creditoId"=$1`, [id, stamp, "a".repeat(64)]);
      assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, { documento: "snapshotCounts" })), { pending: 1, approved: 0 });
      await db.query("COMMIT");
      assert.deepEqual(plain(await queue.countCreditApprovalQueues(api, { documento: "snapshotCounts" })), { pending: 0, approved: 1 });
    } finally { await db.query("ROLLBACK"); await second.end(); }
  });
  await t.test("El nuevo lector valida revocación, vencimiento y existencia antes del crédito", async () => {
    const id = await create("access"); await approve(id);
    await actors.assertApprovalActorCreditReadAccess(api, id, shared);
    await assert.rejects(actors.assertApprovalActorCreditReadAccess(api, 2147483647, shared), { status: 404 });
    for (const [table, idValue, column, value] of [["CreditApprovalSharedGrant", shared.grantId, "revokedAt", stamp],
      ["CreditApprovalSharedSession", shared.sessionId, "revokedAt", stamp], ["CreditApprovalSharedSession", shared.sessionId, "expiresAt", "2020-01-01"]]) {
      await db.query(`UPDATE "${table}" SET "${column}"=$2 WHERE "id"=$1`, [idValue, value]);
      await assert.rejects(actors.assertApprovalActorCreditReadAccess(api, id, shared), { status: 401 });
      await db.query(`UPDATE "${table}" SET "${column}"=$2 WHERE "id"=$1`, [idValue, column === "expiresAt" ? "2099-01-01" : null]);
    }
  });
});
