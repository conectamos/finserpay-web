import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const draftApproval = jiti("../lib/datacredito/draft-approval.ts");
const storage = readFileSync(new URL("../lib/datacredito/storage.ts", import.meta.url), "utf8");
const setup = readFileSync(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const guardStart = setup.indexOf('CREATE OR REPLACE FUNCTION "finser_has_bound_datacredito_draft_v1"(');
const guardEndMarker = 'EXECUTE FUNCTION "finser_guard_datacredito_global_usage_v1"();';
const guardEnd = setup.indexOf(guardEndMarker, guardStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart, "el preflight debe incluir el helper y el trigger reales de aprobación");
const usageGuardSql = setup.slice(guardStart, guardEnd + guardEndMarker.length);
const pendingGuardStart = setup.indexOf('CREATE OR REPLACE FUNCTION "finser_guard_datacredito_pending_global"()');
const pendingGuardEndMarker = 'EXECUTE FUNCTION "finser_guard_datacredito_pending_global"();';
const pendingGuardEnd = setup.indexOf(pendingGuardEndMarker, pendingGuardStart);
assert.ok(pendingGuardStart >= 0 && pendingGuardEnd > pendingGuardStart, "el preflight debe conservar el trigger real de consultas pendientes");
const pendingGuardSql = setup.slice(pendingGuardStart, pendingGuardEnd + pendingGuardEndMarker.length);
const ast = ts.createSourceFile("storage.ts", storage, ts.ScriptTarget.Latest, true);
const declarations = ["isUuid", "normalizeDataCreditoDocument", "normalizeDataCreditoSurname",
  "hmacDataCreditoValue", "buildDataCreditoIdentityHashes", "assessmentMatchParams",
  "dataCreditoDocumentLockKey", "getApprovedDataCreditoAssessmentForCredit",
  "claimDataCreditoAssessment", "consumeDataCreditoAssessmentInTransaction"];
const source = declarations.map(name => {
  const declaration = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(declaration, name);
  const text = declaration.getText(ast);
  return text.startsWith("export ") ? text : `export ${text}`;
}).join("\n");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function databaseFor(client) {
  return {
    $executeRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).affectedRows,
    $queryRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rows,
    $transaction: callback => client.transaction(transaction => callback(databaseFor(transaction))),
  };
}

async function fixture(t, documentNumber = "123456789") {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "Sede" ("id" integer PRIMARY KEY, "aliadoId" integer);
    CREATE TABLE "Credito" ("id" integer PRIMARY KEY, "estado" text, "montoCredito" double precision);
    CREATE TABLE "CreditoAbono" ("creditoId" integer, "valor" double precision, "estado" text);
    CREATE TABLE "CreditRiskException" ("documentHash" text, "providerEnvironment" text,
      "claimTokenHash" text, "claimExpiresAt" timestamptz, "consumedAt" timestamptz, "creditId" integer);
    CREATE TABLE "DataCreditoAssessment" (
      "id" uuid PRIMARY KEY, "documentHash" text, "surnameHash" text, "documentLast4" text,
      "providerEnvironment" text, "platform" text, "status" text, "score" integer,
      "durationMs" integer, "errorCode" text,
      "offer" jsonb, "policyVersion" integer, "policyRevisionId" uuid,
      "expiresAt" timestamptz, "retainedUntil" timestamptz,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
      "consumedAt" timestamptz, "creditId" integer, "reusedFromAssessmentId" uuid,
      "claimTokenHash" text, "claimExpiresAt" timestamptz, "claimedAt" timestamptz,
      "userId" integer, "sellerId" integer, "sedeId" integer, "aliadoId" integer
    );
    CREATE TABLE "CreditoBorrador" (
      "id" integer PRIMARY KEY, "estado" text, "creditoId" integer, "closedReason" text,
      "createdAt" timestamptz, "expiresAt" timestamptz, "dataCreditoAssessmentId" uuid,
      "payload" jsonb, "clienteDocumento" text, "plataforma" text,
      "usuarioId" integer, "vendedorId" integer, "sedeId" integer
    );
  `);
  await pg.exec(pendingGuardSql);
  await pg.exec(usageGuardSql);
  const database = databaseFor(pg);
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, prisma: database,
    ...draftApproval, createHmac, randomBytes, Date, Number, String,
    ensureDataCreditoSchema: async () => {}, getAuditHmacSecret: () => "fictitious-draft-approval-test-key",
  });
  const operations = loaded.exports;
  const assessmentId = randomUUID(), revisionId = randomUUID();
  const match = { assessmentId, solicitudId: 92, documentNumber, firstSurname: "PRUEBA",
    platform: "IPHONE", providerEnvironment: "production", userId: 77, sellerId: 78, sedeId: 79, aliadoId: 80 };
  const hashes = operations.buildDataCreditoIdentityHashes(match);
  const offer = { initialPaymentPercentage: 20, suretyPercentage: 60, installmentCount: 18,
    maxFinancedAmount: 2500000, maxInstallmentAmount: 250000,
    financialSettings: { calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66,
      fianzaTotalPorcentaje: 60, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
      tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } } };
  const reset = async () => {
    await pg.exec(`TRUNCATE "CreditoBorrador", "DataCreditoAssessment", "CreditRiskException", "CreditoAbono", "Credito", "Sede";
      INSERT INTO "Sede" VALUES (79,80),(81,82);
      INSERT INTO "Credito" VALUES (1,'GENERADO',1000000),(2,'GENERADO',1500000);`);
    await pg.query(`INSERT INTO "DataCreditoAssessment"
      ("id","documentHash","surnameHash","documentLast4","providerEnvironment","platform","status","score",
       "offer","policyVersion","policyRevisionId","expiresAt","retainedUntil","userId","sellerId","sedeId","aliadoId")
      VALUES ($1,$2,$3,$4,'production','IPHONE','APROBADO',800,$5,3,$6,
        CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP+INTERVAL '90 days',77,78,79,80)`,
      [assessmentId, hashes.documentHash, hashes.surnameHash, hashes.documentLast4, JSON.stringify(offer), revisionId]);
    await pg.query(`INSERT INTO "CreditoBorrador"
      ("id","estado","createdAt","expiresAt","dataCreditoAssessmentId","payload","clienteDocumento","plataforma","usuarioId","vendedorId","sedeId")
      VALUES (92,'ABIERTO',CURRENT_TIMESTAMP-INTERVAL '12 days',CURRENT_TIMESTAMP+INTERVAL '3 days',
        $1,$2,$3,'IPHONE',77,78,79)`,
      [assessmentId, JSON.stringify({ dataCreditoAssessmentId: assessmentId, plataformaDispositivo: "IPHONE", clienteDocumento: documentNumber }), documentNumber]);
  };
  const row = async () => (await pg.query('SELECT * FROM "DataCreditoAssessment" WHERE "id"=$1', [assessmentId])).rows[0];
  const read = overrides => operations.getApprovedDataCreditoAssessmentForCredit({ ...match, ...overrides });
  const claim = overrides => operations.claimDataCreditoAssessment({ ...match, ...overrides });
  const consume = (claimToken, overrides) => database.$transaction(transaction =>
    operations.consumeDataCreditoAssessmentInTransaction({ assessmentId, solicitudId: 92,
      documentNumber: match.documentNumber, creditId: 2, claimToken, ...overrides }, transaction));
  const finalize = () => pg.exec(`UPDATE "CreditoBorrador"
    SET "estado"='CERRADO',"closedReason"='FINALIZADA',"creditoId"=2 WHERE "id"=92`);
  const rawClaim = async () => (await pg.query(`UPDATE "DataCreditoAssessment"
    SET "claimTokenHash"=$2,"claimExpiresAt"=CURRENT_TIMESTAMP+INTERVAL '5 minutes'
    WHERE "id"=$1 RETURNING *`, [assessmentId, operations.hmacDataCreditoValue("claim", "direct-test-claim")])).rows;
  const rawConsume = async (creditId = 2) => (await pg.query(`UPDATE "DataCreditoAssessment"
    SET "consumedAt"=CURRENT_TIMESTAMP,"creditId"=$2,"claimTokenHash"=NULL,"claimExpiresAt"=NULL
    WHERE "id"=$1 RETURNING *`, [assessmentId, creditId])).rows;
  const addSibling = async ({ claimed = false, consumed = false, sameRoot = true } = {}) => {
    const id = randomUUID();
    // Seed historical/conflicting rows only. Production methods below always run
    // with the actual trigger enabled, including when revalidating consumption.
    await pg.transaction(async transaction => {
      await transaction.exec('ALTER TABLE "DataCreditoAssessment" DISABLE TRIGGER "DataCreditoAssessment_guard_global_usage"');
      await transaction.query(`INSERT INTO "DataCreditoAssessment"
      ("id","documentHash","surnameHash","documentLast4","providerEnvironment","platform","status","score",
       "offer","policyVersion","policyRevisionId","expiresAt","retainedUntil","userId","sellerId","sedeId","aliadoId",
       "reusedFromAssessmentId","claimTokenHash","claimExpiresAt","consumedAt","creditId")
      SELECT $2,"documentHash","surnameHash","documentLast4","providerEnvironment","platform","status","score",
        "offer","policyVersion","policyRevisionId",CURRENT_TIMESTAMP-INTERVAL '2 days',"retainedUntil",
        "userId","sellerId","sedeId","aliadoId",$3,$4,
        CASE WHEN $4::text IS NOT NULL THEN CURRENT_TIMESTAMP+INTERVAL '5 minutes' END,
        CASE WHEN $5::boolean THEN CURRENT_TIMESTAMP END,CASE WHEN $5::boolean THEN 1 END
      FROM "DataCreditoAssessment" WHERE "id"=$1`,
        [assessmentId, id, sameRoot ? assessmentId : null, claimed ? "fictitious-sibling-claim" : null, consumed]);
      await transaction.exec('ALTER TABLE "DataCreditoAssessment" ENABLE TRIGGER "DataCreditoAssessment_guard_global_usage"');
    });
    assert.equal((await pg.query(`SELECT "tgenabled" FROM pg_trigger
      WHERE "tgname"='DataCreditoAssessment_guard_global_usage'`)).rows[0].tgenabled, "O");
    return id;
  };
  await reset();
  return { pg, operations, match, offer, assessmentId, revisionId, reset, row, read, claim, consume, finalize, rawClaim, rawConsume, addSibling };
}

function assertOriginalTerms(row, original) {
  assert.equal(new Date(row.expiresAt).getTime(), new Date(original.expiresAt).getTime());
  assert.equal(new Date(row.retainedUntil).getTime(), new Date(original.retainedUntil).getTime());
  assert.equal(row.policyVersion, original.policyVersion);
  assert.equal(row.policyRevisionId, original.policyRevisionId);
  assert.deepEqual(row.offer, original.offer);
}

test("la aprobación vinculada sobrevive a la consulta vencida sin cambiar oferta, revisión ni vencimientos", async t => {
  const f = await fixture(t), original = await f.row();
  assert.ok(new Date(original.expiresAt).getTime() < Date.now());
  const approved = await f.read();
  assert.ok(approved);
  assertOriginalTerms(approved, original);
  const draft = (await f.pg.query('SELECT "expiresAt" FROM "CreditoBorrador" WHERE "id"=92')).rows[0];
  assert.equal(new Date(approved.draftApprovalExpiresAt).getTime(), new Date(draft.expiresAt).getTime());
  const claimed = await f.claim();
  assert.ok(claimed?.claimToken);
  assertOriginalTerms(claimed.assessment, original);
  assert.equal(await f.claim(), null, "el mismo assessment no puede reservarse dos veces");
  assert.equal(await f.read(), null, "una reserva activa sigue bloqueando otra operación");
  assert.equal(await f.consume(claimed.claimToken), null, "la consulta vencida requiere finalizar primero el borrador");
  assert.equal((await f.row()).consumedAt, null);
  await f.finalize();
  const consumed = await f.consume(claimed.claimToken);
  assert.ok(consumed?.consumedAt);
  assert.equal(consumed.creditId, 2);
  assertOriginalTerms(consumed, original);
  assert.equal(await f.consume(claimed.claimToken), null);
  assert.equal(await f.claim(), null);
  assert.equal(await f.read(), null);
});

test("una consulta vigente conserva el consumo legado antes de cerrar un borrador", async t => {
  const f = await fixture(t);
  await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "expiresAt"=CURRENT_TIMESTAMP+INTERVAL '1 day'`);
  const original = await f.row();
  const claimed = await f.claim({ solicitudId: undefined });
  assert.ok(claimed);
  const consumed = await f.consume(claimed.claimToken, { solicitudId: undefined, documentNumber: undefined });
  assert.ok(consumed?.consumedAt);
  assertOriginalTerms(consumed, original);
  assert.equal((await f.pg.query('SELECT "estado" FROM "CreditoBorrador" WHERE "id"=92')).rows[0].estado, "ABIERTO");
});

test("el trigger real también exige cierre exacto en un consumo SQL directo de consulta vencida", async t => {
  const f = await fixture(t), original = await f.row();
  assert.equal((await f.rawClaim()).length, 1);
  assert.equal((await f.rawConsume()).length, 0, "el trigger debe impedir consumir mientras el borrador siga abierto");
  assert.equal((await f.row()).consumedAt, null);
  await f.finalize();
  assert.equal((await f.rawConsume(1)).length, 0, "el trigger debe cotejar el crédito finalizado");
  const consumed = await f.rawConsume();
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].creditId, 2);
  assertOriginalTerms(consumed[0], original);
  assert.equal((await f.rawConsume(1)).length, 0, "un consumo confirmado no puede trasladarse a otro crédito");
});

test("el trigger rechaza renovar expiresAt en el mismo UPDATE de reserva o consumo", async t => {
  const f = await fixture(t), original = await f.row();
  await assert.rejects(f.pg.query(`UPDATE "DataCreditoAssessment"
    SET "expiresAt"=CURRENT_TIMESTAMP+INTERVAL '15 days',"claimTokenHash"='attempted-renewal',
      "claimExpiresAt"=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE "id"=$1`, [f.assessmentId]),
    error => error.code === "23514");
  assert.equal((await f.row()).claimTokenHash, null);
  assertOriginalTerms(await f.row(), original);
  assert.equal((await f.rawClaim()).length, 1);
  await f.finalize();
  await assert.rejects(f.pg.query(`UPDATE "DataCreditoAssessment"
    SET "expiresAt"=CURRENT_TIMESTAMP+INTERVAL '15 days',"consumedAt"=CURRENT_TIMESTAMP,
      "creditId"=2,"claimTokenHash"=NULL,"claimExpiresAt"=NULL WHERE "id"=$1`, [f.assessmentId]),
    error => error.code === "23514");
  assert.equal((await f.row()).consumedAt, null);
  assertOriginalTerms(await f.row(), original);
  assert.equal((await f.rawConsume()).length, 1);
});

test("el helper y trigger reales aceptan los extremos de 3 y 13 dígitos y rechazan longitudes inválidas", async t => {
  for (const documentNumber of ["123", "1234567890123", "12", "12345678901234"]) await t.test(
    `${documentNumber.length} dígitos`, async child => {
      const f = await fixture(child, documentNumber);
      const valid = documentNumber.length >= 3 && documentNumber.length <= 13;
      if (!valid) {
        assert.equal(await f.read(), null);
        assert.equal(await f.claim(), null);
        assert.equal((await f.rawClaim()).length, 0);
        return;
      }
      assert.ok(await f.read());
      const claim = await f.claim();
      assert.ok(claim);
      await f.finalize();
      assert.equal((await f.consume(claim.claimToken)).creditId, 2);
    },
  );
});

test("la vigencia del borrador exige vínculo, identidad, propietario, plataforma y retención exactos", async t => {
  const f = await fixture(t);
  const anotherId = randomUUID();
  const cases = [
    ["sin solicitud", null, { solicitudId: undefined }],
    ["solicitud inexistente", null, { solicitudId: 999 }],
    ["id inválido", null, { solicitudId: 0 }],
    ["id como texto", null, { solicitudId: "92" }],
    ["vínculo canónico distinto", `UPDATE "CreditoBorrador" SET "dataCreditoAssessmentId"='${anotherId}'`],
    ["payload con otro assessment", `UPDATE "CreditoBorrador" SET "payload"=jsonb_build_object('dataCreditoAssessmentId','${anotherId}')`],
    ["sin vínculo", `UPDATE "CreditoBorrador" SET "dataCreditoAssessmentId"=NULL,"payload"='{}'`],
    ["usuario del borrador distinto", `UPDATE "CreditoBorrador" SET "usuarioId"=999`],
    ["vendedor del borrador distinto", `UPDATE "CreditoBorrador" SET "vendedorId"=NULL`],
    ["sede del borrador distinta", `UPDATE "CreditoBorrador" SET "sedeId"=81`],
    ["aliado de la sede distinto", `UPDATE "Sede" SET "aliadoId"=999 WHERE "id"=79`],
    ["documento del borrador distinto", `UPDATE "CreditoBorrador" SET "clienteDocumento"='987654321'`],
    ["documento del payload distinto", `UPDATE "CreditoBorrador" SET "payload"=jsonb_set("payload",'{clienteDocumento}','"987654321"')`],
    ["plataforma del borrador distinta", `UPDATE "CreditoBorrador" SET "plataforma"='ANDROID'`],
    ["borrador cerrado", `UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='CANCELADA'`],
    ["borrador vencido", `UPDATE "CreditoBorrador" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '1 minute'`],
    ["borrador convertido", `UPDATE "CreditoBorrador" SET "creditoId"=2`],
    ["borrador finalizado", `UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='FINALIZADA',"creditoId"=2`],
    ["retención vencida", `UPDATE "DataCreditoAssessment" SET "retainedUntil"=CURRENT_TIMESTAMP-INTERVAL '1 minute'`],
    ["últimos dígitos contradictorios", `UPDATE "DataCreditoAssessment" SET "documentLast4"='0000'`],
    ["documento recibido distinto", null, { documentNumber: "987654321" }],
    ["apellido recibido distinto", null, { firstSurname: "DISTINTO" }],
    ["propietario recibido distinto", null, { userId: 999 }],
    ["plataforma recibida distinta", null, { platform: "ANDROID" }],
    ["entorno recibido distinto", null, { providerEnvironment: "sandbox" }],
  ];
  for (const [name, mutation, input] of cases) await t.test(name, async () => {
    await f.reset();
    if (mutation) await f.pg.exec(mutation);
    assert.equal(await f.read(input), null);
    assert.equal(await f.claim(input), null);
    if (mutation) assert.equal((await f.rawClaim()).length, 0, "el trigger real protege también el vínculo persistido");
    const unchanged = await f.row();
    assert.equal(unchanged.claimTokenHash, null);
    assert.equal(unchanged.consumedAt, null);
  });
});

test("el consumo revalida el borrador finalizado y solo acepta su mismo crédito", async t => {
  const f = await fixture(t), original = await f.row();
  const claimed = await f.claim();
  assert.ok(claimed);
  await f.finalize();
  assert.equal(await f.consume(claimed.claimToken, { creditId: 1 }), null);
  assert.equal(await f.consume(claimed.claimToken, { solicitudId: undefined }), null);
  assert.equal(await f.consume(claimed.claimToken, { documentNumber: "987654321" }), null);
  assert.equal(await f.consume("incorrect-claim-token"), null);
  assert.equal((await f.row()).consumedAt, null);
  const consumed = await f.consume(claimed.claimToken);
  assert.equal(consumed.creditId, 2);
  assertOriginalTerms(consumed, original);
  assert.equal(await f.consume(claimed.claimToken), null);
});

test("un claim hermano sigue bloqueando lectura, reserva y consumo aunque su consulta esté vencida", async t => {
  const f = await fixture(t);
  for (const sameRoot of [true, false]) await t.test(sameRoot ? "misma consulta raíz" : "otra consulta del mismo documento", async () => {
    await f.reset();
    await f.addSibling({ claimed: true, sameRoot });
    assert.equal(await f.read(), null);
    assert.equal(await f.claim(), null);
    assert.equal((await f.rawClaim()).length, 0);
    await f.reset();
    const claimed = await f.claim();
    assert.ok(claimed);
    const siblingId = await f.addSibling({ claimed: true, sameRoot });
    await f.finalize();
    assert.equal(await f.consume(claimed.claimToken), null, "consumo debe volver a comprobar reservas del documento");
    assert.equal((await f.rawConsume()).length, 0, "el trigger también debe comprobar la reserva hermana vencida");
    assert.equal((await f.row()).consumedAt, null);
    await f.pg.query('UPDATE "DataCreditoAssessment" SET "claimTokenHash"=NULL,"claimExpiresAt"=NULL WHERE "id"=$1', [siblingId]);
    assert.ok(await f.consume(claimed.claimToken));
  });
});

test("un hermano consumido impide gastar otra vez la consulta vencida incluso tras pago total", async t => {
  const f = await fixture(t);
  await f.addSibling({ consumed: true });
  await f.pg.exec(`INSERT INTO "CreditoAbono" VALUES (1,1000000,'REGISTRADO')`);
  assert.equal(await f.read(), null);
  assert.equal(await f.claim(), null);
  assert.equal((await f.rawClaim()).length, 0);
  await f.reset();
  const claimed = await f.claim();
  assert.ok(claimed);
  await f.addSibling({ consumed: true });
  await f.pg.exec(`INSERT INTO "CreditoAbono" VALUES (1,1000000,'REGISTRADO')`);
  await f.finalize();
  assert.equal(await f.consume(claimed.claimToken), null);
  assert.equal((await f.rawConsume()).length, 0);
  assert.equal((await f.row()).consumedAt, null);
});

test("el trigger pending bloquea una nueva consulta durante un claim de aprobación conservada, hasta que venza esa reserva", async t => {
  const f = await fixture(t);
  const claimed = await f.claim();
  assert.ok(claimed);
  assert.ok(new Date((await f.row()).expiresAt).getTime() < Date.now(), "la consulta original ya está vencida");
  const pendingId = randomUUID();
  const insertPending = () => f.pg.query(`INSERT INTO "DataCreditoAssessment"
    ("id","documentHash","providerEnvironment","status","expiresAt","retainedUntil")
    SELECT $2,"documentHash","providerEnvironment",'PENDING',
      CURRENT_TIMESTAMP+INTERVAL '1 day',CURRENT_TIMESTAMP+INTERVAL '90 days'
    FROM "DataCreditoAssessment" WHERE "id"=$1 RETURNING "id","status"`, [f.assessmentId, pendingId]);
  await assert.rejects(insertPending(), error => error.code === "23505" &&
    error.constraint === "DataCreditoAssessment_document_guard_key");
  assert.equal((await f.pg.query('SELECT "id" FROM "DataCreditoAssessment" WHERE "id"=$1', [pendingId])).rows.length, 0);

  // Advance only this fixture's reservation timestamp; the pending trigger stays enabled throughout.
  // The usage trigger deliberately prevents altering an active reservation through the application path.
  await f.pg.exec('ALTER TABLE "DataCreditoAssessment" DISABLE TRIGGER "DataCreditoAssessment_guard_global_usage"');
  try {
    await f.pg.query('UPDATE "DataCreditoAssessment" SET "claimExpiresAt"=CURRENT_TIMESTAMP-INTERVAL \'1 minute\' WHERE "id"=$1', [f.assessmentId]);
  } finally {
    await f.pg.exec('ALTER TABLE "DataCreditoAssessment" ENABLE TRIGGER "DataCreditoAssessment_guard_global_usage"');
  }
  const guards = await f.pg.query(`SELECT "tgenabled" FROM pg_trigger WHERE "tgname" IN
    ('DataCreditoAssessment_guard_global_usage','DataCreditoAssessment_guard_pending_global')`);
  assert.equal(guards.rows.length, 2);
  assert.ok(guards.rows.every(row => row.tgenabled === "O"));
  const inserted = await insertPending();
  assert.equal(inserted.rows[0].id, pendingId);
  assert.equal(inserted.rows[0].status, "PENDING");
  assert.ok((await f.row()).claimTokenHash, "vence la reserva sin borrar su evidencia");
});
