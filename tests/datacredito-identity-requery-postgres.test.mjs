import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Execute the real preflight and PostgreSQL guards in memory. No credentials,
// provider queries, application data or external database are used here.
// Production stores UTC in timestamp columns; keep the test driver's parsing
// deterministic on Windows hosts configured for America/Bogota as well.
process.env.TZ = "UTC";
const setup = await readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const recoverySql = setup.slice(
  setup.indexOf("-- BEGIN AUDITED SAME-DOCUMENT IDENTITY REQUERY"),
  setup.indexOf("-- END AUDITED SAME-DOCUMENT IDENTITY REQUERY"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const revisionId = "00000000-0000-5000-a000-000000000001";

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "estado" TEXT, "montoCredito" NUMERIC);
    CREATE TABLE "CreditoAbono" ("id" INTEGER PRIMARY KEY, "creditoId" INTEGER, "estado" TEXT, "valor" NUMERIC);
    INSERT INTO "Aliado" VALUES (1);
    INSERT INTO "Usuario" VALUES (1);
  `);
  await db.exec(setup);
  const dates = (await db.query(`SELECT
    CURRENT_TIMESTAMP - INTERVAL '1 day' AS "createdAt",
    CURRENT_TIMESTAMP + INTERVAL '14 days' AS "expiresAt",
    CURRENT_TIMESTAMP + INTERVAL '90 days' AS "retainedUntil",
    CURRENT_TIMESTAMP - INTERVAL '1 hour' AS "authorizedAt",
    CURRENT_TIMESTAMP AS "now"`)).rows[0];
  const insert = async (table, row) => db.query(
    `INSERT INTO "${table}" (${Object.keys(row).map((key) => `"${key}"`).join(",")})
     VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row).map((value) => value && typeof value === "object" && !(value instanceof Date)
      ? JSON.stringify(value) : value),
  );
  const assessment = async (name, changes = {}) => {
    const row = {
      id: randomUUID(), documentHash: hash(name), documentLast4: "0000", surnameHash: hash("OLD SURNAME"),
      platform: "IPHONE", providerEnvironment: "production", status: "APROBADO", score: 658,
      decision: "APROBADO", offer: { approved: true, maxFinancedAmount: 1500000 },
      policyVersion: 1, policyRevisionId: revisionId, consentVersion: "test-v1", consentHash: hash("consent"),
      consentAt: dates.createdAt, userId: 1, sedeId: 1, aliadoId: 1, correlationId: randomUUID(),
      transactionCode: "01", providerStatus: "ACCEPTED", durationMs: 178,
      createdAt: dates.createdAt, updatedAt: dates.createdAt,
      expiresAt: dates.expiresAt, retainedUntil: dates.retainedUntil, ...changes,
    };
    await insert("DataCreditoAssessment", row);
    return row;
  };
  const audit = async (root, changes = {}, metadataChanges = {}) => {
    const metadata = {
      version: 1, code: "SAME_DOCUMENT_SURNAME_CORRECTION", originalStatus: "APROBADO",
      documentHash: root.documentHash, providerEnvironment: root.providerEnvironment,
      originalSurnameHash: root.surnameHash, oldQuerySurname: "OLD SURNAME", newQuerySurname: "CORRECT SURNAME",
      reason: "Authorized correction of the surname before a fresh inquiry.",
      originalExpiresAt: root.expiresAt.toISOString(), targetDraftId: 1, ...metadataChanges,
    };
    const row = {
      id: randomUUID(), assessmentId: root.id, actorUserId: 1,
      action: "OPS_IDENTITY_REQUERY_AUTHORIZED", outcome: "AUTHORIZED", requestCorrelationId: randomUUID(),
      retainedUntil: root.retainedUntil, createdAt: dates.authorizedAt, metadata, ...changes,
    };
    await insert("DataCreditoAdminAccessAudit", row);
    return row;
  };
  const rows = async (table = "DataCreditoAssessment") =>
    (await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows;
  return { db, dates, assessment, audit, rows, insert };
}

test("preflight real: retira solo la familia autorizada y conserva aprobación, evidencia, auditoría y consumo", async (t) => {
  const { db, dates, assessment, audit, rows } = await createDatabase(t);
  const root = await assessment("authorized family");
  const clone = await assessment("authorized family", { reusedFromAssessmentId: root.id, platform: "ANDROID" });
  const rejectedClone = await assessment("authorized family", {
    reusedFromAssessmentId: root.id, status: "RECHAZADO", decision: "RECHAZADO",
  });
  const noAudit = await assessment("without authorization");
  await assessment("without authorization", { reusedFromAssessmentId: noAudit.id });
  const newRoot = await assessment("authorized family", {
    surnameHash: hash("CORRECT SURNAME"), createdAt: dates.now,
    expiresAt: new Date(dates.now.getTime() + 15 * 86400000),
  });
  await audit(root);
  await audit(root, { createdAt: new Date(dates.authorizedAt.getTime() + 1000) });
  await db.query(`INSERT INTO "DataCreditoAssessmentSecurePayload"
    ("assessmentId","algorithm","keyId","aadVersion","plaintextVersion","nonce","authTag","ciphertext","plaintextBytes")
    VALUES ($1,'AES-256-GCM','test-key',1,1,decode(repeat('ab',12),'hex'),decode(repeat('cd',16),'hex'),decode('aa','hex'),1)`, [root.id]);
  await db.exec(`INSERT INTO "DataCreditoDailyQuotaUsage" ("allyId","businessDate","usedCount") VALUES (1,CURRENT_DATE,7)`);
  const before = await rows();
  const auditBefore = await rows("DataCreditoAdminAccessAudit");
  const secureBefore = (await db.query('SELECT * FROM "DataCreditoAssessmentSecurePayload"')).rows;
  const quotaBefore = (await db.query('SELECT * FROM "DataCreditoDailyQuotaUsage"')).rows;
  const family = new Set([root.id, clone.id, rejectedClone.id]);
  const expected = before.map((row) => family.has(row.id) ? { ...row, expiresAt: dates.authorizedAt } : row);
  for (let run = 0; run < 3; run += 1) {
    await db.exec(setup);
    assert.deepEqual(await rows(), expected, `El preflight ${run + 1} no reabre la familia ni cambia otra columna`);
    assert.deepEqual(await rows("DataCreditoAdminAccessAudit"), auditBefore);
    assert.deepEqual((await db.query('SELECT * FROM "DataCreditoAssessmentSecurePayload"')).rows, secureBefore);
    assert.deepEqual((await db.query('SELECT * FROM "DataCreditoDailyQuotaUsage"')).rows, quotaBefore);
  }
  assert.equal((await rows()).find((row) => row.id === newRoot.id).expiresAt.getTime(), newRoot.expiresAt.getTime(),
    "La autorización histórica no vence una consulta nueva del mismo documento");
});

test("preflight real: no aplica autorizaciones incompletas, ajenas, anteriores ni resultados distintos", async (t) => {
  const { db, dates, assessment, audit, rows } = await createDatabase(t);
  const fixtures = [
    { name: "wrong-action", audit: { action: "DETAIL_VIEW" } },
    { name: "wrong-outcome", audit: { outcome: "AUTHORIZED_WITH_RISK_ACK" } },
    { name: "denied", audit: { outcome: "DENIED" } },
    { name: "no-metadata", audit: { metadata: {} } },
    { name: "wrong-version", metadata: { version: 2 } },
    { name: "text-version", metadata: { version: "1" } },
    { name: "wrong-code", metadata: { code: "TX06" } },
    { name: "wrong-original-status", metadata: { originalStatus: "RECHAZADO" } },
    { name: "foreign-document", metadata: { documentHash: hash("other document") } },
    { name: "foreign-environment", metadata: { providerEnvironment: "sandbox" } },
    { name: "foreign-surname", metadata: { originalSurnameHash: hash("other surname") } },
    { name: "missing-old-surname", metadata: { oldQuerySurname: null } },
    { name: "blank-new-surname", metadata: { newQuerySurname: "  " } },
    { name: "unchanged-surname", metadata: { newQuerySurname: " old   surname " } },
    { name: "nontext-surname", metadata: { newQuerySurname: 123 } },
    { name: "missing-reason", metadata: { reason: null } },
    { name: "short-reason", metadata: { reason: "ok" } },
    { name: "missing-expiry", metadata: { originalExpiresAt: null } },
    { name: "malformed-expiry", metadata: { originalExpiresAt: "not-a-date" } },
    { name: "invalid-draft", metadata: { targetDraftId: 0 } },
    { name: "text-draft", metadata: { targetDraftId: "1" } },
    { name: "before-inquiry", audit: { createdAt: new Date(dates.createdAt.getTime() - 1000) } },
    { name: "rejected", row: { status: "RECHAZADO", decision: "RECHAZADO" } },
    { name: "not-evaluated", row: { status: "NO_EVALUADO", errorCode: "NO_EVALUABLE_INFORMATION" } },
    { name: "other-provider-status", row: { providerStatus: "PENDING" } },
    { name: "other-transaction", row: { transactionCode: "07" } },
    { name: "error", row: { errorCode: "PROVIDER_OUTCOME_AMBIGUOUS" } },
    { name: "without-score", row: { score: null } },
    { name: "without-decision", row: { decision: null } },
    { name: "without-offer", row: { offer: null } },
  ];
  for (const fixture of fixtures) {
    const root = await assessment(fixture.name, fixture.row);
    await audit(root, fixture.audit, fixture.metadata);
  }
  const parent = await assessment("audit on clone");
  const clone = await assessment("audit on clone", { reusedFromAssessmentId: parent.id });
  await audit(clone);
  const before = await rows();
  await db.exec(setup);
  assert.deepEqual(await rows(), before, "Ninguna autorización ajena o incompleta puede modificar vigencias");
});

test("preflight real: una reserva, consumo, crédito o familia inconsistente impide retirar la familia entera", async (t) => {
  const { db, dates, assessment, audit, rows } = await createDatabase(t);
  const protections = [
    { claimedAt: dates.now }, { claimTokenHash: hash("active claim") }, { claimExpiresAt: dates.now },
    { consumedAt: dates.now }, { creditId: 7 },
    { status: "PENDING", createdAt: dates.now },
    { documentHash: hash("wrong family document") }, { providerEnvironment: "sandbox" },
  ];
  for (let i = 0; i < protections.length; i += 1) {
    const root = await assessment(`protected family ${i}`);
    // A PENDING insert correctly rejects a live approval. Seed that historical
    // inconsistency as terminal then transition it; the migration must fail closed.
    const protection = protections[i];
    const clone = await assessment(`protected family ${i}`, {
      ...protection, status: "APROBADO",
      reusedFromAssessmentId: root.id,
    });
    if (protection.status === "PENDING") {
      await db.query('UPDATE "DataCreditoAssessment" SET "status"=\'PENDING\' WHERE "id"=$1', [clone.id]);
    }
    await audit(root);
  }
  const claimedRoot = await assessment("claimed original", { claimedAt: dates.now });
  await audit(claimedRoot);
  const before = await rows();
  await db.exec(setup);
  assert.deepEqual(await rows(), before, "El impedimento de un miembro protege a toda la familia");
});

test("guard real: un reintento nuevo funciona solo tras retirar raíz y clones y conserva el bloqueo de duplicados", async (t) => {
  const { db, dates, assessment, audit, rows } = await createDatabase(t);
  const root = await assessment("new reservation");
  await assessment("new reservation", { reusedFromAssessmentId: root.id });
  const pendingFields = {
    status: "PENDING", score: null, decision: null, offer: null,
    providerStatus: null, transactionCode: null, durationMs: null,
    createdAt: dates.now, surnameHash: hash("CORRECT SURNAME"),
  };
  await assert.rejects(assessment("new reservation", pendingFields), /consulta DataCredito activa/);
  await audit(root);
  await db.exec(setup);
  assert.equal((await rows()).find((row) => row.id === root.id).expiresAt.getTime(), dates.authorizedAt.getTime());
  const pending = await assessment("new reservation", pendingFields);
  const before = await rows();
  await assert.rejects(assessment("new reservation", { ...pendingFields, platform: "ANDROID" }), /consulta DataCredito activa/);
  await db.exec(recoverySql);
  assert.deepEqual(await rows(), before, "La autorización no modifica la nueva reserva ni duplica operaciones");
  assert.equal((await rows()).find((row) => row.id === pending.id).status, "PENDING");
});
