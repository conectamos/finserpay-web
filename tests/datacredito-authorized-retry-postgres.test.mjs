import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const setup = await readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const auditStart = setup.indexOf('CREATE TABLE IF NOT EXISTS "DataCreditoAdminAccessAudit" (');
const recoveryStart = setup.indexOf("-- An explicitly authorized TX06 surname correction");
const recoveryEnd = setup.indexOf('CREATE TABLE IF NOT EXISTS "DataCreditoPolicyAssignmentAudit"', recoveryStart);
const recoverySql = setup.slice(recoveryStart, recoveryEnd);
const rootStart = setup.indexOf('UPDATE "DataCreditoAssessment" root');
const rootEnd = setup.indexOf('UPDATE "DataCreditoAssessment" clone', rootStart);
const rootBackfill = setup.slice(rootStart, rootEnd);

test("la excepcion TX06 requiere auditoria explicita y mantiene la migracion atomica", () => {
  assert.ok(rootStart > setup.indexOf("BEGIN;"));
  assert.ok(auditStart > rootStart && recoveryStart > auditStart);
  assert.ok(recoveryEnd > recoveryStart && recoveryEnd < setup.lastIndexOf("COMMIT;"));
  assert.match(recoverySql, /SET "expiresAt" = LEAST\(root\."expiresAt", retry_authorization\."authorizedAt"\)/);
  assert.match(recoverySql, /MIN\("createdAt"\)/);
  for (const condition of [
    `"action" = 'OPS_TX06_RETRY_AUTHORIZED'`, `"outcome" = 'AUTHORIZED'`,
    'root."id" = retry_authorization."assessmentId"', 'root."reusedFromAssessmentId" IS NULL',
    `root."status" = 'NO_EVALUADO'`, `root."errorCode" = 'NO_EVALUABLE_INFORMATION'`,
    `root."providerStatus" = 'ACCEPTED'`, `root."transactionCode" = '06'`,
    'root."consumedAt" IS NULL', 'root."creditId" IS NULL',
  ]) assert.ok(recoverySql.includes(condition), `Falta condicion: ${condition}`);
});

const connectionString = process.env.DATACREDITO_RETRY_TEST_DATABASE_URL;
test("PostgreSQL: solo TX06 autorizado vence y el preflight repetido conserva la excepcion", {
  skip: connectionString ? false : "Requiere DATACREDITO_RETRY_TEST_DATABASE_URL local; solo usa tablas temporales y ROLLBACK.",
}, async () => {
  const database = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname), "Solo PostgreSQL local");
  const { Client } = await import("pg");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_temp");
    // These session-local tables cannot address the application's permanent data.
    await client.query(`CREATE TEMP TABLE "DataCreditoAssessment" (
      "id" UUID PRIMARY KEY, "reusedFromAssessmentId" UUID,
      "status" TEXT, "errorCode" TEXT, "providerStatus" TEXT, "transactionCode" TEXT,
      "consumedAt" TIMESTAMP, "creditId" INTEGER, "durationMs" INTEGER,
      "createdAt" TIMESTAMP, "expiresAt" TIMESTAMP, "retainedUntil" TIMESTAMP,
      "payload" JSONB
    ) ON COMMIT DROP`);
    const auditSql = setup.slice(auditStart, recoveryStart)
      .replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE IF NOT EXISTS");
    await client.query(auditSql);
    const fixtures = [
      { name: "authorized" }, { name: "no-audit", audit: false },
      { name: "other-action", action: "DETAIL_VIEW" }, { name: "denied", outcome: "DENIED" },
      { name: "approved", status: "APROBADO" }, { name: "rejected", status: "RECHAZADO" },
      { name: "other-error", errorCode: "PROVIDER_OUTCOME_AMBIGUOUS" },
      { name: "other-status", providerStatus: "REJECTED" },
      { name: "other-transaction", transactionCode: "00" },
      { name: "clone", reusedFromAssessmentId: randomUUID() },
      { name: "consumed", consumedAt: "2026-01-02" }, { name: "credited", creditId: 123 },
      { name: "audit-before-query", auditDate: "2025-12-31" },
    ].map((fixture) => ({ id: randomUUID(), ...fixture }));
    for (const fixture of fixtures) {
      await client.query(`INSERT INTO "DataCreditoAssessment" VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,100,'2026-01-01','2026-01-16','2026-04-01','{"original":"preserved"}')`, [
        fixture.id, fixture.reusedFromAssessmentId || null,
        fixture.status || "NO_EVALUADO", fixture.errorCode || "NO_EVALUABLE_INFORMATION",
        fixture.providerStatus || "ACCEPTED", fixture.transactionCode || "06",
        fixture.consumedAt || null, fixture.creditId || null,
      ]);
    }
    const rows = () => client.query('SELECT * FROM "DataCreditoAssessment" ORDER BY "id"');
    const before = (await rows()).rows;
    await client.query(recoverySql);
    assert.deepEqual((await rows()).rows, before, "Sin autorizaciones ninguna consulta cambia");
    for (const fixture of fixtures.filter((item) => item.audit !== false)) {
      await client.query(`INSERT INTO "DataCreditoAdminAccessAudit"
        ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
        VALUES ($1,$2,0,$3,$4,$5,'2026-04-01',$6)`, [randomUUID(), fixture.id,
        fixture.action || "OPS_TX06_RETRY_AUTHORIZED", fixture.outcome || "AUTHORIZED",
        randomUUID(), fixture.auditDate || "2026-01-02"]);
    }
    const authorized = fixtures.find((fixture) => fixture.name === "authorized");
    await client.query(`INSERT INTO "DataCreditoAdminAccessAudit"
      ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
      VALUES ($1,$2,0,'OPS_TX06_RETRY_AUTHORIZED','AUTHORIZED',$3,'2026-04-01','2026-01-03')`,
    [randomUUID(), authorized.id, randomUUID()]);
    const authorization = (await client.query('SELECT MIN("createdAt") AS "createdAt" FROM "DataCreditoAdminAccessAudit" WHERE "assessmentId" = $1', [authorized.id])).rows[0];
    await client.query(recoverySql);
    const expected = before.map((row) => row.id === authorized.id
      ? { ...row, expiresAt: authorization.createdAt } : row);
    assert.deepEqual((await rows()).rows, expected, "Solo cambia expiresAt del TX06 autorizado; conserva respuesta y retencion");
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await client.query(rootBackfill);
      await client.query(recoverySql);
      assert.deepEqual((await rows()).rows, expected, "El preflight repetido conserva la autorizacion mas temprana");
    }
    await client.query('UPDATE "DataCreditoAssessment" SET "expiresAt" = $1 WHERE "id" = $2',
      ["2026-01-01 12:00:00", authorized.id]);
    const earlier = (await rows()).rows;
    await client.query(recoverySql);
    assert.deepEqual((await rows()).rows, earlier, "La excepcion nunca extiende un vencimiento anterior");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
