import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const storage = readFileSync(new URL("../lib/datacredito/storage.ts", import.meta.url), "utf8");
const setup = readFileSync(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const ast = ts.createSourceFile("storage.ts", storage, ts.ScriptTarget.Latest, true);
const declarations = ["isUuid", "findRecentConsumedDataCreditoAssessment", "findReusableDataCreditoAssessment",
  "getDataCreditoAssessmentDocumentState", "assessmentMatchParams", "classifyDataCreditoAssessmentForCredit",
  "getApprovedDataCreditoAssessmentForCredit", "dataCreditoDocumentLockKey", "claimDataCreditoAssessment",
  "consumeDataCreditoAssessmentInTransaction"];

function functions(database) {
  const source = declarations.map(name => {
    const declaration = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(declaration, name);
    const text = declaration.getText(ast);
    return text.startsWith("export ") ? text : `export ${text}`;
  }).join("\n");
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: loaded, exports: loaded.exports, prisma: database,
    randomBytes, Date, Number, String, ensureDataCreditoSchema: async () => {},
    buildDataCreditoIdentityHashes: () => ({ documentHash: "paid-client", surnameHash: "surname", documentLast4: "3090" }),
    hmacDataCreditoValue: (label, value) => `${label}:${value}`,
  });
  return loaded.exports;
}

function sqlSection(start, end) {
  const first = setup.indexOf(start), last = setup.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return setup.slice(first, last + end.length);
}

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Credito" ("id" integer PRIMARY KEY, "estado" text NOT NULL,
      "montoCredito" double precision NOT NULL, "cuotaInicial" double precision DEFAULT 0,
      "sedeId" integer, "usuarioId" integer, "pazYSalvoEmitidoAt" timestamp);
    CREATE TABLE "CreditoAbono" ("creditoId" integer NOT NULL, "valor" double precision NOT NULL,
      "estado" text NOT NULL);
    CREATE TABLE "DataCreditoAssessment" (
      "id" uuid PRIMARY KEY, "documentHash" text NOT NULL, "surnameHash" text DEFAULT 'surname',
      "documentLast4" text DEFAULT '3090', "providerEnvironment" text DEFAULT 'production',
      "platform" text DEFAULT 'IPHONE', "status" text NOT NULL,
      "expiresAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '2 days',
      "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP,
      "durationMs" integer, "errorCode" text, "consumedAt" timestamp, "creditId" integer,
      "reusedFromAssessmentId" uuid, "claimTokenHash" text, "claimExpiresAt" timestamp, "claimedAt" timestamp,
      "score" integer DEFAULT 800, "offer" jsonb DEFAULT '{}', "policyRevisionId" uuid,
      "userId" integer DEFAULT 77, "sellerId" integer DEFAULT 78, "sedeId" integer DEFAULT 79, "aliadoId" integer DEFAULT 80
    );
    INSERT INTO "Credito" ("id","estado","montoCredito","cuotaInicial","sedeId","usuarioId")
      VALUES (1,'GENERADO',1000000,300000,3,4), (2,'GENERADO',1500000,500000,79,77);
  `);
  await pg.exec(sqlSection('CREATE OR REPLACE FUNCTION "finser_guard_datacredito_pending_global"()',
    'EXECUTE FUNCTION "finser_guard_datacredito_pending_global"();'));
  await pg.exec(sqlSection('CREATE OR REPLACE FUNCTION "finser_guard_datacredito_global_usage_v1"()',
    'EXECUTE FUNCTION "finser_guard_datacredito_global_usage_v1"();'));
  const database = {
    $executeRawUnsafe: async (sql, ...params) => (await pg.query(sql, params)).affectedRows,
    $queryRawUnsafe: async (sql, ...params) => (await pg.query(sql, params)).rows,
    $transaction: async callback => callback(database),
  };
  const operations = functions(database);
  const addAssessment = async ({ status = "APROBADO", creditId = null, consumed = false,
    root = null, document = "paid-client" } = {}) => {
    const id = randomUUID();
    await pg.query(`INSERT INTO "DataCreditoAssessment"
      ("id","documentHash","status","creditId","consumedAt","reusedFromAssessmentId")
      VALUES ($1,$2,$3,$4,$5,$6)`, [id, document, status, creditId, consumed ? new Date() : null, root]);
    return id;
  };
  const match = assessmentId => ({ assessmentId, documentNumber: "1082873090", firstSurname: "PRUEBA",
    platform: "IPHONE", providerEnvironment: "production", userId: 77, sellerId: 78, sedeId: 79, aliadoId: 80 });
  const lookup = () => operations.findRecentConsumedDataCreditoAssessment({
    documentHash: "paid-client", providerEnvironment: "production",
  }, database);
  const reusable = () => operations.findReusableDataCreditoAssessment({ hashes: {
    documentHash: "paid-client", surnameHash: "surname", documentLast4: "3090" }, platform: "IPHONE",
    providerEnvironment: "production", policyRevisionId: randomUUID(), scope: match(null),
  }, database);
  return { pg, database, operations, addAssessment, match, lookup, reusable };
}

test("una nueva evaluación tras pago total pertenece al asesor actual y no reutiliza la oferta gastada", async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`INSERT INTO "CreditoAbono" VALUES (1,600000,'REGISTRADO'),(1,400000,'REGISTRADO')`);
    const previous = await f.addAssessment({ creditId: 1, consumed: true });
    await f.pg.query(`UPDATE "DataCreditoAssessment" SET "userId"=4,"sellerId"=5,"sedeId"=3,"aliadoId"=2
      WHERE "id"=$1`, [previous]);
    assert.equal(await f.lookup(), null);
    assert.equal(await f.reusable(), null, "La consulta consumida sigue siendo histórica");
    const current = await f.addAssessment({ status: "PENDING" });
    await assert.rejects(f.addAssessment({ status: "PENDING" }), /consulta DataCredito activa|document_guard_key/);
    await f.pg.query(`UPDATE "DataCreditoAssessment" SET "status"='APROBADO' WHERE "id"=$1`, [current]);
    const approved = await f.operations.getApprovedDataCreditoAssessmentForCredit(f.match(current));
    assert.equal(approved.id, current);
    assert.equal(approved.userId, 77);
    assert.equal(await f.operations.getApprovedDataCreditoAssessmentForCredit({ ...f.match(current), aliadoId: 3 }), null);
    assert.equal(await f.operations.claimDataCreditoAssessment({ ...f.match(current), sellerId: 999 }), null);
    const claim = await f.operations.claimDataCreditoAssessment(f.match(current));
    assert.equal(claim.assessment.id, current);
    assert.equal(await f.operations.claimDataCreditoAssessment(f.match(current)), null);
    const consumed = await f.operations.consumeDataCreditoAssessmentInTransaction({
      assessmentId: current, claimToken: claim.claimToken, creditId: 2,
    }, f.database);
    assert.equal(consumed.creditId, 2);
    assert.equal(await f.operations.consumeDataCreditoAssessmentInTransaction({
      assessmentId: current, claimToken: claim.claimToken, creditId: 2,
    }, f.database), null);
    const original = (await f.pg.query(`SELECT "creditId","consumedAt" FROM "DataCreditoAssessment" WHERE "id"=$1`, [previous])).rows[0];
    assert.equal(original.creditId, 1);
    assert.ok(original.consumedAt);
    assert.equal(await f.operations.claimDataCreditoAssessment(f.match(previous)), null);
  } finally { await f.pg.close(); }
});

test("el pago de un crédito consumido por un clon no libera la raíz histórica", async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`INSERT INTO "CreditoAbono" VALUES (1,1000000,'REGISTRADO')`);
    const root = await f.addAssessment();
    await f.addAssessment({ creditId: 1, consumed: true, root });
    assert.equal(await f.lookup(), null);
    assert.equal(await f.reusable(), null);
    assert.equal(await f.operations.getApprovedDataCreditoAssessmentForCredit(f.match(root)), null);
    assert.equal((await f.operations.classifyDataCreditoAssessmentForCredit(f.match(root))).status, "CONSUMED_ELSEWHERE");
    assert.equal(await f.operations.claimDataCreditoAssessment(f.match(root)), null);
    const rawClaim = await f.pg.query(`UPDATE "DataCreditoAssessment" SET "claimTokenHash"='raw',
      "claimExpiresAt"=CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id"=$1 RETURNING "id"`, [root]);
    assert.equal(rawClaim.rows.length, 0, "El trigger protege también runtimes antiguos");
    const current = await f.addAssessment({ status: "PENDING" });
    assert.notEqual(current, root);
    assert.equal((await f.operations.getDataCreditoAssessmentDocumentState({
      id: current, documentHash: "paid-client", providerEnvironment: "production",
    })).consumedElsewhere, false);
  } finally { await f.pg.close(); }
});

test("saldo parcial, abono anulado, etiqueta PAGADO y paz y salvo no autorizan otra consulta", async () => {
  const f = await fixture();
  try {
    await f.addAssessment({ creditId: 1, consumed: true });
    await f.pg.exec(`UPDATE "Credito" SET "estado"='PAGADO',"pazYSalvoEmitidoAt"=CURRENT_TIMESTAMP WHERE "id"=1;
      INSERT INTO "CreditoAbono" VALUES (1,700000,'REGISTRADO'),(1,300000,'ANULADO')`);
    assert.ok(await f.lookup(), "La inicial no se resta del crédito ni se cuentan abonos anulados");
    await assert.rejects(f.addAssessment({ status: "PENDING" }), /consulta DataCredito activa|document_guard_key/);
    await f.pg.exec(`DELETE FROM "CreditoAbono"; UPDATE "Credito" SET "estado"='ANULADO' WHERE "id"=1`);
    assert.equal(await f.lookup(), null);
    const current = await f.addAssessment({ status: "PENDING" });
    assert.ok(current);
  } finally { await f.pg.close(); }
});

test("se revalida el saldo en claim y consumo si un abono anterior se anula", async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`INSERT INTO "CreditoAbono" VALUES (1,1000000,'REGISTRADO')`);
    await f.addAssessment({ creditId: 1, consumed: true });
    const current = await f.addAssessment({ status: "PENDING" });
    await f.pg.query(`UPDATE "DataCreditoAssessment" SET "status"='APROBADO' WHERE "id"=$1`, [current]);
    await f.pg.exec(`UPDATE "CreditoAbono" SET "estado"='ANULADO'`);
    assert.equal(await f.operations.getApprovedDataCreditoAssessmentForCredit(f.match(current)), null);
    assert.equal(await f.operations.claimDataCreditoAssessment(f.match(current)), null);
    assert.equal((await f.operations.classifyDataCreditoAssessmentForCredit(f.match(current))).status, "CONSUMED_ELSEWHERE");
    await f.pg.exec(`UPDATE "CreditoAbono" SET "estado"='REGISTRADO'`);
    const claim = await f.operations.claimDataCreditoAssessment(f.match(current));
    assert.ok(claim);
    await f.pg.exec(`UPDATE "CreditoAbono" SET "estado"='ANULADO'`);
    assert.equal(await f.operations.consumeDataCreditoAssessmentInTransaction({
      assessmentId: current, claimToken: claim.claimToken, creditId: 2,
    }, f.database), null);
    const rawConsume = await f.pg.query(`UPDATE "DataCreditoAssessment"
      SET "consumedAt"=CURRENT_TIMESTAMP,"creditId"=2,"claimTokenHash"=NULL,"claimExpiresAt"=NULL
      WHERE "id"=$1 RETURNING "id"`, [current]);
    assert.equal(rawConsume.rows.length, 0, "El trigger revalida también un consumo directo");
  } finally { await f.pg.close(); }
});

test("un crédito consumidor inexistente falla cerrado y una respuesta ambigua sigue protegida", async () => {
  const f = await fixture();
  try {
    await f.addAssessment({ creditId: 999, consumed: true });
    assert.ok(await f.lookup());
    await assert.rejects(f.addAssessment({ status: "PENDING" }), /consulta DataCredito activa|document_guard_key/);
    await f.addAssessment({ status: "NO_EVALUADO", document: "ambiguous" });
    await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "durationMs"=1000,
      "errorCode"='PROVIDER_OUTCOME_AMBIGUOUS' WHERE "documentHash"='ambiguous'`);
    await assert.rejects(f.addAssessment({ status: "PENDING", document: "ambiguous" }), /consulta DataCredito activa|document_guard_key/);
  } finally { await f.pg.close(); }
});
