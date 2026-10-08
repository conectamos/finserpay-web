import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const source = readFileSync(new URL("../lib/solicitudes-storage.ts", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const implementation = section("export async function desistSolicitudAsApprovalAnalyst", "export async function completeSolicitudForCredit");
const blocker = section("async function findBlockingSolicitudByDocument", "function solicitudConflictFromBlocker");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("desistimiento del analista: SQL real, expediente seleccionado y auditoría atómica", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
      "creditoId" INTEGER, "clienteDocumento" TEXT,
      "dataCreditoAssessmentId" UUID,
      "payload" JSONB NOT NULL DEFAULT '{"solicitudOrigen":"DATACREDITO"}',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMPTZ DEFAULT '2300-01-01',
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "closedAt" TIMESTAMPTZ, "closedReason" TEXT,
      "usuarioId" INTEGER NOT NULL DEFAULT 31, "vendedorId" INTEGER DEFAULT 41,
      "sedeId" INTEGER NOT NULL DEFAULT 51,
      "desistedByUserId" INTEGER, "desistedBySellerId" INTEGER
    );
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY, "estado" TEXT NOT NULL,
      "clienteDocumento" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const trace = [];
  let identityMutation = null;
  let failBlocker = false;
  const adapter = (db) => ({
    $queryRawUnsafe: async (sql, ...values) => {
      trace.push({ kind: "sql", sql, values });
      if (failBlocker && sql.includes("SELECT candidate.*")) throw new Error("TEST_LOOKUP_FAILURE");
      return (await db.query(sql, values)).rows;
    },
  });
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(`${blocker}\n${implementation}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module: loaded, exports: loaded.exports,
    prisma: { $transaction: (callback) => pg.transaction((db) => callback(adapter(db))) },
    ensureSolicitudSchema: async () => trace.push({ kind: "schema" }),
    expireStaleSolicitudes: async () => trace.push({ kind: "expire" }),
    normalizeDigits: (value) => String(value || "").replace(/\D/g, "").slice(0, 40),
    lockSolicitudOperationsInOrder: async (_db, ids) => trace.push({ kind: "operation-lock", ids: plain(ids) }),
    lockIdentity: async (db, kind, document) => {
      trace.push({ kind: "identity-lock", identityKind: kind, document });
      if (identityMutation) await identityMutation(db);
    },
  });
  const desist = loaded.exports.desistSolicitudAsApprovalAnalyst;
  let sequence = 0;
  async function seed(document = `10000${++sequence}`, options = {}) {
    const id = ++sequence;
    const payload = options.payload ?? {
      solicitudOrigen: "DATACREDITO", clienteDocumento: document,
      imei: "350000000000001", valorEquipoTotal: "4000000", cuotaInicial: "1000000",
      plazoMeses: "40", signedDocumentReference: "provider-original",
    };
    await pg.query(`INSERT INTO "CreditoBorrador" (
      "id","clienteDocumento","payload","estado","closedReason","creditoId","expiresAt","vendedorId","sedeId")
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::timestamptz,$8,$9)`, [
      id, document, JSON.stringify(payload), options.estado ?? "ABIERTO",
      options.closedReason ?? null, options.creditoId ?? null,
      options.expiresAt ?? "2300-01-01", options.vendedorId ?? 41, options.sedeId ?? 51,
    ]);
    return id;
  }
  const row = async (id) => (await pg.query(`SELECT * FROM "CreditoBorrador" WHERE "id"=$1`, [id])).rows[0];
  const run = (id, userId = 17) => desist({ solicitudId: id, userId });

  await t.test("cierra solo el caso seleccionado y conserva los duplicados de otras sedes y asesores", async () => {
    const id = await seed("1.000.000.123");
    const duplicate = await seed("1000000123", { vendedorId: 99, sedeId: 88 });
    const sameOwner = await seed("1000000123");
    const before = plain(await row(id));
    const duplicateBefore = plain(await row(duplicate));
    const sameOwnerBefore = plain(await row(sameOwner));
    trace.length = 0;
    assert.deepEqual(plain(await run(id)), { changed: true, identityReleased: false });
    const after = plain(await row(id));
    assert.equal(after.estado, "CERRADO");
    assert.equal(after.closedReason, "DESISTIDA");
    assert.equal(after.desistedByUserId, 17);
    assert.equal(after.desistedBySellerId, null);
    assert.ok(after.closedAt);
    assert.equal(after.updatedAt, after.closedAt);
    for (const field of ["payload", "creditoId", "clienteDocumento", "usuarioId", "vendedorId", "sedeId", "createdAt"])
      assert.deepEqual(after[field], before[field], field);
    assert.deepEqual(plain(await row(duplicate)), duplicateBefore);
    assert.deepEqual(plain(await row(sameOwner)), sameOwnerBefore);
    const operation = trace.findIndex((item) => item.kind === "operation-lock");
    const identity = trace.findIndex((item) => item.kind === "identity-lock");
    const update = trace.findIndex((item) => item.sql?.includes('UPDATE "CreditoBorrador"'));
    assert.ok(operation >= 0 && identity > operation && update > identity);
    assert.deepEqual(trace[operation].ids, [id]);
    assert.equal(trace[identity].document, "1000000123");
  });

  await t.test("libera la identidad si no queda otra obligación y acepta una rechazada vigente", async () => {
    const id = await seed(undefined, { estado: "CERRADO", closedReason: "RECHAZADA" });
    assert.deepEqual(plain(await run(id)), { changed: true, identityReleased: true });
    assert.equal((await row(id)).closedReason, "DESISTIDA");
  });

  await t.test("un crédito activo con la misma cédula impide anunciar identidad liberada", async () => {
    const document = `20000${++sequence}`;
    const id = await seed(document);
    await pg.query(`INSERT INTO "Credito" ("id","estado","clienteDocumento") VALUES ($1,'ACTIVO',$2)`, [id, document]);
    assert.deepEqual(plain(await run(id)), { changed: true, identityReleased: false });
  });

  await t.test("créditos convertidos, solicitudes expiradas, finales o sin origen no se modifican", async () => {
    const cases = [
      { creditoId: 701 },
      { expiresAt: "2000-01-01" },
      ...["DESISTIDA", "DESISTIDO", "EXPIRADA_15_DIAS", "EXPIRADA", "DUPLICADA", "FINALIZADA"]
        .map((closedReason) => ({ estado: "CERRADO", closedReason })),
      { payload: { valorEquipoTotal: "4000000" } },
    ];
    for (const options of cases) {
      const id = await seed(undefined, options);
      const before = plain(await row(id));
      assert.deepEqual(plain(await run(id)), { changed: false, identityReleased: false }, JSON.stringify(options));
      assert.deepEqual(plain(await row(id)), before);
    }
  });

  await t.test("un reintento no reescribe el analista ni la fecha de auditoría", async () => {
    const id = await seed();
    assert.equal((await run(id)).changed, true);
    const before = plain(await row(id));
    assert.deepEqual(plain(await run(id, 18)), { changed: false, identityReleased: false });
    assert.deepEqual(plain(await row(id)), before);
  });

  await t.test("la condición del UPDATE vuelve a comprobar conversión, cierre, vencimiento e identidad", async () => {
    for (const mutation of [
      '"creditoId"=801',
      '"estado"=\'CERRADO\',"closedReason"=\'FINALIZADA\'',
      '"expiresAt"=\'2000-01-01\'',
      '"clienteDocumento"=\'888888888\'',
    ]) {
      const id = await seed();
      identityMutation = (db) => db.$queryRawUnsafe(`UPDATE "CreditoBorrador" SET ${mutation} WHERE "id"=$1 RETURNING "id"`, id);
      try {
        assert.deepEqual(plain(await run(id)), { changed: false, identityReleased: false }, mutation);
        const saved = await row(id);
        assert.equal(saved.desistedByUserId, null);
        assert.equal(saved.closedAt, null);
      } finally {
        identityMutation = null;
      }
    }
  });

  await t.test("si falla la comprobación de identidad, el cierre y su auditoría retroceden juntos", async () => {
    const id = await seed();
    const before = plain(await row(id));
    failBlocker = true;
    try {
      await assert.rejects(run(id), /TEST_LOOKUP_FAILURE/);
      assert.deepEqual(plain(await row(id)), before);
    } finally {
      failBlocker = false;
    }
  });

  await t.test("IDs inválidos no llegan al almacenamiento", async () => {
    trace.length = 0;
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(plain(await run(value)), { changed: false, identityReleased: false });
      assert.deepEqual(plain(await desist({ solicitudId: 1, userId: value })), { changed: false, identityReleased: false });
    }
    assert.equal(trace.length, 0);
  });

  await t.test("documento ausente no bloquea otra identidad ni amplía el alcance del cierre", async () => {
    const id = await seed(null);
    const other = await seed(null);
    const before = plain(await row(other));
    trace.length = 0;
    assert.deepEqual(plain(await run(id)), { changed: true, identityReleased: true });
    assert.deepEqual(plain(await row(other)), before);
    assert.ok(!trace.some((item) => item.kind === "identity-lock"));
  });
});
