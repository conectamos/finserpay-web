import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "lib/approval-initial-signature.ts"), "utf8");
const schema = await readFile(path.join(root, "lib/approval-initial-signature-schema.ts"), "utf8");

function extracted(start, end, name, dependencies = {}) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, name);
  const code = stripTypeScriptTypes(source.slice(from, to).replace(/^export /, ""));
  return new Function(...Object.keys(dependencies), `${code}\nreturn ${name};`)(...Object.values(dependencies));
}

test("el primer envío exige revisión y hash vistos, motivo e idempotencia válidos", () => {
  const ErrorType = class extends Error { constructor(code, message, status) {
    super(message); this.code = code; this.status = status;
  } };
  const parse = extracted("function parsedInput(", "async function creditForSignature(", "parsedInput", {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    hash: /^[a-f0-9]{64}$/,
    invalid: (code, message, status) => new ErrorType(code, message, status),
  });
  const valid = { idempotencyKey: "192e255c-8d20-4e23-8363-a1ed30f9fb81",
    expectedProcessUuid: null, expectedRevision: 4, expectedReviewHash: "a".repeat(64),
    reason: "Primer envío solicitado por la analista" };
  assert.deepEqual(parse(valid), { id: valid.idempotencyKey, reason: valid.reason,
    revision: 4, reviewHash: valid.expectedReviewHash });
  for (const invalidInput of [
    { ...valid, expectedProcessUuid: "already-sent" },
    { ...valid, expectedRevision: 0 },
    { ...valid, expectedReviewHash: "stale" },
    { ...valid, reason: "ok" },
    { ...valid, idempotencyKey: "not-uuid" },
  ]) assert.throws(() => parse(invalidInput), { code: "INVALID_INITIAL_SIGNATURE" });
});

test("el primer envío no se repite si hay firma activa, firmada en borrador o despacho pendiente", async () => {
  const ErrorType = class extends Error { constructor(code, message) { super(message); this.code = code; } };
  const guard = extracted("async function assertNoOtherSignature(", "async function frozenSource(",
    "assertNoOtherSignature", { pendingStatuses: "('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')",
      invalid: (code, message) => new ErrorType(code, message) });
  const mock = (active, historical, pending) => ({ $queryRawUnsafe: async (sql) =>
    sql.includes('AND "supersededAt" IS NULL') ? active ? [{ processUuid: "active" }] : []
      : sql.includes('LEFT(COALESCE(process."signedDocumentBase64"') ? [{ found: historical }]
        : [{ found: pending }] });
  await assert.rejects(guard(mock(true, false, false), 9), { code: "SIGNATURE_ALREADY_EXISTS" });
  await assert.rejects(guard(mock(false, true, false), 9), { code: "SIGNED_SOURCE_REVIEW_REQUIRED" });
  await assert.rejects(guard(mock(false, false, true), 9), { code: "SIGNATURE_PENDING" });
  await guard(mock(false, false, false), 9);
});

test("el callback solo confirma el PDF firmado del proceso exacto", async () => {
  const complete = extracted("export async function completeInitialApprovalSignature(",
    "/** Terminal provider outcomes", "completeInitialApprovalSignature");
  const calls = [];
  const db = { $queryRawUnsafe: async () => [{ present: true }],
    $executeRawUnsafe: async (sql, ...params) => { calls.push({ sql, params }); return 1; } };
  assert.equal(await complete(db, 7, "firma-1", null), false);
  assert.equal(await complete(db, 7, "firma-1", Buffer.from("<html>").toString("base64")), false);
  assert.equal(calls.length, 0);
  assert.equal(await complete(db, 7, "firma-1", Buffer.from("%PDF-1.7\nprueba").toString("base64")), true);
  assert.deepEqual(calls[0].params, [7, "firma-1"]);
  assert.match(calls[0].sql, /"status" IN \('AWAITING_SIGNATURE','UNCERTAIN','TECHNICAL_ERROR'\)/);
});

test("el esquema impide otro envío o aprobar/liquidar mientras espera FirmaSeguro", async () => {
  const statements = [...schema.matchAll(/await prisma\.\$executeRawUnsafe\(`([\s\S]*?)`\);/g)]
    .map((match) => match[1]);
  assert.ok(statements.length >= 10);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "CreditApprovalReview" ("creditoId" INTEGER PRIMARY KEY, "status" TEXT);
      CREATE TABLE "LiquidacionAliadoCredito" ("creditoId" INTEGER NOT NULL);
      INSERT INTO "Credito" VALUES (7); INSERT INTO "Usuario" VALUES (3);
      INSERT INTO "CreditApprovalReview" VALUES (7,'PENDING');`);
    for (const statement of statements) await db.exec(statement);
    const row = (id) => `INSERT INTO "CreditApprovalInitialSignature"
      ("id","creditoId","sourceRevision","sourceReviewHash","reservedRevision","termsHash",
       "frozenCredit","sourceSeal","reason","actorUserId","actorName","status")
      VALUES ('${id}',7,2,'${"a".repeat(64)}',3,'${"b".repeat(64)}','{}','{}',
        'Primer envío validado',3,'Analista','PREPARING')`;
    await db.exec(row("192e255c-8d20-4e23-8363-a1ed30f9fb81"));
    await assert.rejects(db.exec(row("ba524510-1575-436e-a967-f77689069c61")));
    await assert.rejects(db.exec(`UPDATE "CreditApprovalReview" SET "status"='APPROVED' WHERE "creditoId"=7`),
      /INITIAL_SIGNATURE_PENDING/);
    await assert.rejects(db.exec(`INSERT INTO "LiquidacionAliadoCredito"("creditoId") VALUES (7)`),
      /INITIAL_SIGNATURE_PENDING/);
  } finally { await db.close(); }
});
