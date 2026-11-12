import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const setup = await readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const auditStart = setup.indexOf('CREATE TABLE IF NOT EXISTS "DataCreditoAdminAccessAudit" (');
const recoveryStart = setup.indexOf("-- An explicitly authorized TX06 surname correction");
const ambiguousRecoveryStart = setup.indexOf("-- An ambiguous timeout or HTTP 5xx can be released only after");
const noEvaluableRecoveryStart = setup.indexOf("-- An explicitly risk-acknowledged retry of a non-evaluable ACCEPTED/TX07");
const recoveryEnd = setup.indexOf('CREATE TABLE IF NOT EXISTS "DataCreditoPolicyAssignmentAudit"', noEvaluableRecoveryStart);
const recoverySql = setup.slice(recoveryStart, ambiguousRecoveryStart);
const ambiguousRecoverySql = setup.slice(ambiguousRecoveryStart, noEvaluableRecoveryStart);
const noEvaluableRecoverySql = setup.slice(noEvaluableRecoveryStart, recoveryEnd);
const rootStart = setup.indexOf('UPDATE "DataCreditoAssessment" root');
const rootEnd = setup.indexOf('UPDATE "DataCreditoAssessment" clone', rootStart);
const rootBackfill = setup.slice(rootStart, rootEnd);

const retryStorage = await readFile(new URL("../lib/datacredito/admin-retry-storage.ts", import.meta.url), "utf8");

async function retryFixture() {
  // Match Prisma's adapter-pg UTC interpretation of PostgreSQL timestamp (OID 1114).
  const pg = new PGlite({parsers: {1114: value => new Date(value.replace(' ', 'T') + 'Z')}});
  const assessmentId = randomUUID();
  await pg.exec(`
    CREATE TABLE "DataCreditoAssessment" (
      id uuid PRIMARY KEY, "documentHash" text, "documentLast4" text, "surnameHash" text,
      platform text, "providerEnvironment" text, status text, score integer, decision text, offer jsonb,
      "transactionCode" text, "providerStatus" text, "errorCode" text, "durationMs" integer,
      "reusedFromAssessmentId" uuid, "claimedAt" timestamp, "claimTokenHash" text, "claimExpiresAt" timestamp,
      "consumedAt" timestamp, "creditId" integer, "expiresAt" timestamp, "retainedUntil" timestamp,
      "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP,
      "userId" integer DEFAULT 1, "sellerId" integer, "aliadoId" integer DEFAULT 1, "sedeId" integer DEFAULT 1
    );
    CREATE TABLE "CreditoBorrador" (
      id integer PRIMARY KEY, estado text, "closedReason" text, "currentStep" integer,
      "clienteDocumento" text, plataforma text, imei text, "creditoId" integer, "dataCreditoAssessmentId" uuid,
      "dataCreditoStatus" text, "dataCreditoErrorCode" text, payload jsonb,
      "expiresAt" timestamp, "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "Usuario" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "Vendedor" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "Aliado" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "Sede" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "DataCreditoAdminAccessAudit" (
      id uuid PRIMARY KEY, "assessmentId" uuid, "actorUserId" integer, action text, outcome text,
      "requestCorrelationId" uuid, "ipHash" text, "userAgentHash" text, "retainedUntil" timestamp,
      "createdAt" timestamp, metadata jsonb
    );
    INSERT INTO "Usuario" VALUES (1,'Prueba'); INSERT INTO "Aliado" VALUES(1,'Central'); INSERT INTO "Sede" VALUES(1,'Central');
  `);
  await pg.query(`INSERT INTO "DataCreditoAssessment" (id,"documentHash","documentLast4","surnameHash",platform,
    "providerEnvironment",status,"providerStatus","errorCode","durationMs","expiresAt","retainedUntil")
    VALUES($1,'document:1234567','4567','surname:ANTERIOR','IPHONE','production','NO_EVALUADO','HTTP 500',
      'PROVIDER_OUTCOME_AMBIGUOUS',15566,CURRENT_TIMESTAMP+INTERVAL '15 days',CURRENT_TIMESTAMP+INTERVAL '90 days')`, [assessmentId]);
  await pg.query(`INSERT INTO "CreditoBorrador" (id,estado,"closedReason","currentStep","clienteDocumento",plataforma,
    "dataCreditoAssessmentId","dataCreditoStatus","dataCreditoErrorCode",payload,"expiresAt")
    VALUES(81,'CERRADO','DESISTIDA',1,'1234567','IPHONE',$1::uuid,'NO_EVALUADO','PROVIDER_OUTCOME_AMBIGUOUS',
      jsonb_build_object('clientePrimerApellido','ANTERIOR','dataCreditoAssessmentId',($1::uuid)::text),CURRENT_TIMESTAMP+INTERVAL '15 days')`, [assessmentId]);
  const locks = [];
  let beforeTransaction = async () => {};
  let failAudit = false;
  // Prisma sends Date parameters in UTC. PGlite's direct Date binding uses the host timezone.
  const prismaArgs = args => args.map(value => value instanceof Date ? value.toISOString() : value);
  const db = {
    $queryRawUnsafe: async (sql, ...args) => (await pg.query(sql, prismaArgs(args))).rows,
    $executeRawUnsafe: async (sql, ...args) => {
      if (sql.includes('pg_advisory_xact_lock')) { locks.push('document'); return 1; }
      if (failAudit && sql.includes('INSERT INTO "DataCreditoAdminAccessAudit"')) throw new Error('AUDIT_UNAVAILABLE');
      return (await pg.query(sql, prismaArgs(args))).affectedRows;
    },
    $transaction: async callback => {
      await beforeTransaction();
      await pg.exec('BEGIN');
      try { const result = await callback(db); await pg.exec('COMMIT'); return result; }
      catch (error) { await pg.exec('ROLLBACK'); throw error; }
    },
  };
  const dependencies = {
    'server-only': {}, 'node:crypto': {randomUUID}, '@/lib/prisma': {default: db},
    '@/lib/datacredito/storage': {ensureDataCreditoSchema: async () => {},
      hmacDataCreditoValue: (kind, value) => `${kind}:${value}`,
      normalizeDataCreditoDocument: value => String(value ?? '').replace(/\D/g, ''),
      normalizeDataCreditoSurname: value => String(value ?? '').trim().toUpperCase()},
    '@/lib/solicitudes-storage': {ensureSolicitudSchema: async () => {}},
    '@/lib/firmaseguro-storage': {lockSolicitudOperationMutation: async () => {locks.push('solicitud');}},
  };
  const loaded = {exports: {}};
  runInNewContext(ts.transpileModule(retryStorage, {compilerOptions: {target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS}}).outputText, {module: loaded, exports: loaded.exports,
    require: name => {assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];},
    Date, Number, String, Object, Array, Set, JSON, RegExp, Error});
  const input = {assessmentId, documentNumber: '1234567', providerEnvironment: 'production', actorUserId: 1,
    mutationId: randomUUID(), ipHash: null, userAgentHash: null, canAuthorizeAmbiguousRetry: true, riskAcknowledged: true};
  const root = async () => (await pg.query('SELECT * FROM "DataCreditoAssessment" WHERE id=$1',[assessmentId])).rows[0];
  const draft = async () => (await pg.query('SELECT * FROM "CreditoBorrador" WHERE id=81')).rows[0];
  return {pg, input, operations: loaded.exports, root, draft, locks,
    setBeforeTransaction: fn => {beforeTransaction = fn;}, setFailAudit: value => {failAudit = value;}};
}

test("liberacion ambigua ejecuta la mutacion real una sola vez y conserva evidencia, solicitud y consumo", async () => {
  const f = await retryFixture();
  try {
    const before = await f.root(); const draftBefore = await f.draft();
    const candidate = await f.operations.findDataCreditoAdminRetryCandidate(f.input);
    assert.equal(candidate.retryKind, 'AMBIGUOUS_PROVIDER'); assert.equal(candidate.eligible, true);
    const result = await f.operations.authorizeDataCreditoAdminRetry(f.input);
    assert.equal(result.retryKind, 'AMBIGUOUS_PROVIDER'); assert.equal(result.requiresNewSolicitud, true);
    const after = await f.root();
    assert.ok(after.expiresAt < before.expiresAt);
    assert.equal(after.expiresAt.toISOString(), result.authorizedAt);
    assert.deepEqual({...after, expiresAt: before.expiresAt}, before);
    assert.deepEqual(await f.draft(), draftBefore);
    const audit = (await f.pg.query('SELECT * FROM "DataCreditoAdminAccessAudit"')).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].action, 'OPS_AMBIGUOUS_RETRY_AUTHORIZED');
    assert.equal(audit[0].outcome, 'AUTHORIZED_WITH_RISK_ACK');
    assert.equal(audit[0].metadata.riskAcknowledged, true);
    const replay = await f.operations.authorizeDataCreditoAdminRetry({...f.input, mutationId: randomUUID()});
    assert.equal(replay.alreadyAuthorized, true);
    assert.equal((await f.pg.query('SELECT count(*)::int AS n FROM "DataCreditoAdminAccessAudit"')).rows[0].n, 1);
    assert.deepEqual(f.locks, ['solicitud', 'document']);
    assert.equal((await f.operations.findDataCreditoAdminRetryCandidate(f.input)).alreadyAuthorized, true);
  } finally {await f.pg.close();}
});

test("liberacion ambigua requiere administrador central y aceptacion booleana explicita", async () => {
  const f = await retryFixture();
  try {
    const before = await f.root();
    for (const riskAcknowledged of [undefined, false, 'true', 1]) {
      await assert.rejects(f.operations.authorizeDataCreditoAdminRetry({...f.input, riskAcknowledged}),
        error => error.code === 'RETRY_RISK_ACK_REQUIRED');
    }
    await assert.rejects(f.operations.authorizeDataCreditoAdminRetry({...f.input, canAuthorizeAmbiguousRetry: false}),
      error => error.code === 'RETRY_CENTRAL_ADMIN_REQUIRED' && error.status === 403);
    assert.deepEqual(await f.root(), before); assert.deepEqual(f.locks, []);
  } finally {await f.pg.close();}
});

test("una autorizacion anterior a la consulta no cuenta como liberacion ni replay", async () => {
  const f = await retryFixture();
  try {
    await f.pg.query(`INSERT INTO "DataCreditoAdminAccessAudit" (id,"assessmentId",action,outcome,"createdAt")
      VALUES($1,$2,'OPS_AMBIGUOUS_RETRY_AUTHORIZED','AUTHORIZED_WITH_RISK_ACK',CURRENT_TIMESTAMP-INTERVAL '1 hour')`, [randomUUID(),f.input.assessmentId]);
    const candidate = await f.operations.findDataCreditoAdminRetryCandidate(f.input);
    assert.equal(candidate.alreadyAuthorized,false); assert.equal(candidate.eligible,true);
    const result = await f.operations.authorizeDataCreditoAdminRetry(f.input);
    assert.equal(result.alreadyAuthorized,false);
    assert.equal((await f.pg.query('SELECT count(*)::int AS n FROM "DataCreditoAdminAccessAudit"')).rows[0].n,2);
  } finally {await f.pg.close();}
});

test("liberacion ambigua revalida cambios concurrentes y revierte si falla auditoria", async () => {
  const f = await retryFixture();
  try {
    f.setBeforeTransaction(async () => {await f.pg.query('UPDATE "DataCreditoAssessment" SET score=600 WHERE id=$1',[f.input.assessmentId]);});
    await assert.rejects(f.operations.authorizeDataCreditoAdminRetry(f.input), error => error.code === 'RETRY_STATE_CHANGED');
    assert.equal((await f.pg.query('SELECT count(*)::int AS n FROM "DataCreditoAdminAccessAudit"')).rows[0].n,0);
    await f.pg.query('UPDATE "DataCreditoAssessment" SET score=NULL WHERE id=$1',[f.input.assessmentId]);
    f.setBeforeTransaction(async () => {}); f.setFailAudit(true);
    const before = await f.root();
    await assert.rejects(f.operations.authorizeDataCreditoAdminRetry(f.input), /AUDIT_UNAVAILABLE/);
    assert.deepEqual(await f.root(), before);
  } finally {await f.pg.close();}
});

test("liberacion ambigua rechaza resultado evaluado, HTTP no admitido, reserva y expiracion", async () => {
  const f = await retryFixture();
  try {
    const variants = [
      ['score', '600'], ['decision', "'APROBADO'"], ['offer', "'{}'::jsonb"], ['status', "'RECHAZADO'"],
      ['providerStatus', "'HTTP 400'"], ['providerStatus', "'HTTP 500 EXTRA'"], ['transactionCode', "'06'"],
      ['claimedAt', 'CURRENT_TIMESTAMP'], ['claimTokenHash', "'token'"], ['claimExpiresAt', 'CURRENT_TIMESTAMP'],
      ['consumedAt', 'CURRENT_TIMESTAMP'], ['creditId', '1'], ['durationMs', 'NULL'], ['durationMs', '-1'],
      ['reusedFromAssessmentId', `'${randomUUID()}'::uuid`], ['expiresAt', "CURRENT_TIMESTAMP-INTERVAL '1 day'"],
    ];
    for (const [column, value] of variants) {
      await f.pg.exec('BEGIN');
      try {
        await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "${column}"=${value}`);
        const candidate = await f.operations.findDataCreditoAdminRetryCandidate(f.input);
        assert.equal(candidate.eligible, false, column);
        await assert.rejects(f.operations.authorizeDataCreditoAdminRetry(f.input), error => error.code === 'RETRY_NOT_ELIGIBLE', column);
      } finally {await f.pg.exec('ROLLBACK');}
    }
  } finally {await f.pg.close();}
});

test("TX06 conserva apellido corregido y ambiguo abierto conserva el apellido existente", async () => {
  for (const kind of ['TX06_SURNAME', 'AMBIGUOUS_PROVIDER']) {
    const f = await retryFixture();
    try {
      await f.pg.exec('UPDATE "CreditoBorrador" SET estado=\'ABIERTO\',"closedReason"=NULL');
      if (kind === 'TX06_SURNAME') await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "errorCode"='NO_EVALUABLE_INFORMATION',"providerStatus"='ACCEPTED',"transactionCode"='06'`);
      const result = await f.operations.authorizeDataCreditoAdminRetry({...f.input,
        firstSurname: kind === 'TX06_SURNAME' ? 'CORREGIDO' : undefined,
        riskAcknowledged: kind === 'TX06_SURNAME' ? undefined : true});
      assert.equal(result.retryKind, kind); assert.equal(result.requiresNewSolicitud, false);
      const draft = await f.draft();
      assert.equal(draft.dataCreditoAssessmentId, null); assert.equal(draft.dataCreditoStatus, 'PENDING');
      assert.equal(draft.payload.clientePrimerApellido, kind === 'TX06_SURNAME' ? 'CORREGIDO' : 'ANTERIOR');
    } finally {await f.pg.close();}
  }
});

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

test("la excepcion ambigua exige autorizacion con riesgo y conserva toda la evidencia", () => {
  assert.ok(ambiguousRecoveryStart > recoveryStart);
  assert.ok(recoveryEnd > ambiguousRecoveryStart && recoveryEnd < setup.lastIndexOf("COMMIT;"));
  assert.match(
    ambiguousRecoverySql,
    /SET "expiresAt" = LEAST\(root\."expiresAt", retry_authorization\."authorizedAt"\)/,
  );
  assert.match(ambiguousRecoverySql, /MIN\("createdAt"\)/);
  for (const condition of [
    `"action" = 'OPS_AMBIGUOUS_RETRY_AUTHORIZED'`,
    `"outcome" = 'AUTHORIZED_WITH_RISK_ACK'`,
    'root."id" = retry_authorization."assessmentId"',
    'root."reusedFromAssessmentId" IS NULL',
    `root."status" = 'NO_EVALUADO'`,
    `root."errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS'`,
    'root."score" IS NULL',
    'root."decision" IS NULL',
    'root."offer" IS NULL',
    'root."providerStatus" IS NULL',
    `OR root."providerStatus" ~ '^HTTP 5[0-9]{2}$'`,
    'root."transactionCode" IS NULL',
    'root."durationMs" IS NOT NULL',
    'root."claimedAt" IS NULL',
    'root."claimTokenHash" IS NULL',
    'root."claimExpiresAt" IS NULL',
    'root."consumedAt" IS NULL',
    'root."creditId" IS NULL',
    'retry_authorization."authorizedAt" >= root."createdAt"',
    'root."expiresAt" > retry_authorization."authorizedAt"',
  ]) assert.ok(ambiguousRecoverySql.includes(condition), `Falta condicion: ${condition}`);
  assert.doesNotMatch(ambiguousRecoverySql, /UPDATE\s+"DataCreditoDailyQuotaUsage"/);
  assert.doesNotMatch(
    ambiguousRecoverySql,
    /SET\s+"(?:status|errorCode|providerStatus|transactionCode|score|decision|offer)"/,
  );
});

test("PostgreSQL: HTTP 500 solo se libera con riesgo autorizado y permanece liberado tras el preflight", async () => {
  const database = new PGlite();
  try {
    await database.exec(`BEGIN;
      CREATE TEMP TABLE "DataCreditoAssessment" (
        "id" UUID PRIMARY KEY, "reusedFromAssessmentId" UUID,
        "status" TEXT, "errorCode" TEXT, "providerStatus" TEXT, "transactionCode" TEXT,
        "score" INTEGER, "decision" TEXT, "offer" JSONB,
        "claimedAt" TIMESTAMP, "claimTokenHash" TEXT, "claimExpiresAt" TIMESTAMP,
        "consumedAt" TIMESTAMP, "creditId" INTEGER, "durationMs" INTEGER,
        "createdAt" TIMESTAMP, "expiresAt" TIMESTAMP, "retainedUntil" TIMESTAMP,
        "payload" JSONB
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "DataCreditoDailyQuotaUsage" ("used" INTEGER) ON COMMIT DROP;
      INSERT INTO "DataCreditoDailyQuotaUsage" VALUES (7);`);
    await database.exec(setup.slice(auditStart, recoveryStart)
      .replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE IF NOT EXISTS"));
    const fixtures = [
      { name: "timeout-authorized", providerStatus: null, eligible: true },
      { name: "http500-authorized", eligible: true },
      { name: "http503-authorized", providerStatus: "HTTP 503", eligible: true },
      { name: "http599-authorized", providerStatus: "HTTP 599", eligible: true },
      { name: "http500-no-audit", audit: false },
      { name: "http500-wrong-action", action: "DETAIL_VIEW" },
      { name: "http500-risk-not-acknowledged", outcome: "AUTHORIZED" },
      { name: "http500-denied", outcome: "DENIED" },
      { name: "http400-authorized", providerStatus: "HTTP 400" },
      { name: "http200-authorized", providerStatus: "HTTP 200" },
      { name: "malformed-status", providerStatus: "HTTP 500 EXTRA" },
      { name: "http500-with-score", score: 700 },
      { name: "http500-with-offer", offer: { approved: true } },
      { name: "http500-with-decision", decision: "APROBADO" },
      { name: "http500-with-transaction", transactionCode: "00" },
      { name: "http500-consumed", creditId: 1 },
      { name: "http500-claimed", claimedAt: "2026-01-02" },
      { name: "http500-clone", reusedFromAssessmentId: randomUUID() },
      { name: "http500-without-dispatch-time", durationMs: null },
      { name: "http500-audit-before-query", auditDate: "2025-12-31" },
      { name: "http500-valid-authorization-after-bad-timestamp", eligible: true, earlierInvalidAudit: true },
    ].map((fixture) => ({ id: randomUUID(), providerStatus: "HTTP 500", durationMs: 183, ...fixture }));
    for (const fixture of fixtures) {
      await database.query(`INSERT INTO "DataCreditoAssessment"
        ("id", "reusedFromAssessmentId", "status", "errorCode", "providerStatus", "transactionCode",
         "score", "decision", "offer", "claimedAt", "creditId", "durationMs",
         "createdAt", "expiresAt", "retainedUntil", "payload")
        VALUES ($1,$2,'NO_EVALUADO','PROVIDER_OUTCOME_AMBIGUOUS',$3,$4,$5,$6,$7,$8,$9,$10,
          '2026-01-01','2026-01-16','2026-04-01','{"status":"PENDING","evidence":"preserved"}')`, [
        fixture.id, fixture.reusedFromAssessmentId || null, fixture.providerStatus,
        fixture.transactionCode || null, fixture.score ?? null, fixture.decision || null,
        fixture.offer ? JSON.stringify(fixture.offer) : null, fixture.claimedAt || null,
        fixture.creditId || null, fixture.durationMs,
      ]);
    }
    const rows = async () => (await database.query('SELECT * FROM "DataCreditoAssessment" ORDER BY "id"')).rows;
    const before = await rows();
    await database.exec(ambiguousRecoverySql);
    assert.deepEqual(await rows(), before, "Sin autorización no se libera ningún HTTP 500");
    for (const fixture of fixtures.filter((item) => item.audit !== false)) {
      await database.query(`INSERT INTO "DataCreditoAdminAccessAudit"
        ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
        VALUES ($1,$2,1,$3,$4,$5,'2026-04-01',$6)`, [
        randomUUID(), fixture.id, fixture.action || "OPS_AMBIGUOUS_RETRY_AUTHORIZED",
        fixture.outcome || "AUTHORIZED_WITH_RISK_ACK", randomUUID(), fixture.auditDate || "2026-01-02",
      ]);
    }
    const authorizedAt = (await database.query(`SELECT TIMESTAMP '2026-01-02' AS value`)).rows[0].value;
    for (const fixture of fixtures.filter((item) => item.earlierInvalidAudit)) {
      await database.query(`INSERT INTO "DataCreditoAdminAccessAudit"
        ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
        VALUES ($1,$2,1,'OPS_AMBIGUOUS_RETRY_AUTHORIZED','AUTHORIZED_WITH_RISK_ACK',$3,'2026-04-01','2025-12-31')`,
      [randomUUID(), fixture.id, randomUUID()]);
    }
    const expected = before.map((row) => fixtures.find((fixture) => fixture.id === row.id).eligible
      ? { ...row, expiresAt: authorizedAt } : row);
    await database.exec(ambiguousRecoverySql);
    assert.deepEqual(await rows(), expected, "Solo vence la autorización elegible; HTTP 500, duración y evidencia se conservan");
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await database.exec(rootBackfill);
      await database.exec(ambiguousRecoverySql);
      assert.deepEqual(await rows(), expected, "El preflight no restablece el bloqueo autorizado");
    }
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoDailyQuotaUsage"')).rows, [{ used: 7 }],
      "La liberación conserva el consumo del cupo");
  } finally {
    await database.exec("ROLLBACK").catch(() => {});
    await database.close();
  }
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


test("la autorización TX07 no evaluable es explícita, acotada y distinta de una aprobación o corrección TX06", () => {
  assert.ok(noEvaluableRecoveryStart > ambiguousRecoveryStart);
  assert.ok(recoveryEnd > noEvaluableRecoveryStart && recoveryEnd < setup.lastIndexOf("COMMIT;"));
  assert.match(noEvaluableRecoverySql, /SET "expiresAt" = LEAST\(root\."expiresAt", retry_authorization\."authorizedAt"\)/);
  assert.match(noEvaluableRecoverySql, /MIN\("createdAt"\)/);
  for (const condition of [
    `"action" = 'OPS_NO_EVALUABLE_RETRY_AUTH'`, `"outcome" = 'AUTHORIZED_WITH_RISK_ACK'`,
    'root."id" = retry_authorization."assessmentId"', 'root."reusedFromAssessmentId" IS NULL',
    `root."status" = 'NO_EVALUADO'`, `root."errorCode" = 'NO_EVALUABLE_INFORMATION'`,
    `root."providerStatus" = 'ACCEPTED'`, `root."transactionCode" = '07'`,
    'root."score" IS NULL', 'root."decision" IS NULL', 'root."offer" IS NULL',
    'root."durationMs" IS NOT NULL', 'root."claimedAt" IS NULL', 'root."claimTokenHash" IS NULL',
    'root."claimExpiresAt" IS NULL', 'root."consumedAt" IS NULL', 'root."creditId" IS NULL',
    'retry_authorization."authorizedAt" >= root."createdAt"', 'root."expiresAt" > retry_authorization."authorizedAt"',
  ]) assert.ok(noEvaluableRecoverySql.includes(condition), `Falta condición: ${condition}`);
  assert.doesNotMatch(noEvaluableRecoverySql, /UPDATE\s+"DataCreditoDailyQuotaUsage"/);
  assert.doesNotMatch(noEvaluableRecoverySql, /SET\s+"(?:status|score|decision|offer|errorCode|providerStatus|transactionCode|durationMs|retainedUntil)"/);
});

test("PostgreSQL: sólo TX07 sin resultado y con riesgo autorizado vence; conserva evidencia/cupo tras backfill y replay", async () => {
  const database = new PGlite();
  try {
    await database.exec(`BEGIN;
      CREATE TEMP TABLE "DataCreditoAssessment" (
        "id" UUID PRIMARY KEY,"reusedFromAssessmentId" UUID,"status" TEXT,"errorCode" TEXT,
        "providerStatus" TEXT,"transactionCode" TEXT,"score" INTEGER,"decision" TEXT,"offer" JSONB,
        "durationMs" INTEGER,"claimedAt" TIMESTAMP,"claimTokenHash" TEXT,"claimExpiresAt" TIMESTAMP,
        "consumedAt" TIMESTAMP,"creditId" INTEGER,"createdAt" TIMESTAMP,"expiresAt" TIMESTAMP,
        "retainedUntil" TIMESTAMP,"payload" JSONB
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "DataCreditoDailyQuotaUsage" ("used" INTEGER) ON COMMIT DROP;
      INSERT INTO "DataCreditoDailyQuotaUsage" VALUES (7);
      CREATE TEMP TABLE "DataCreditoAssessmentSecurePayload" ("assessmentId" UUID,"ciphertext" BYTEA) ON COMMIT DROP;`);
    await database.exec(setup.slice(auditStart, recoveryStart).replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE IF NOT EXISTS"));
    const fixtures = [
      { name: "authorized", eligible: true },
      { name: "authorized-zero-duration", durationMs: 0, eligible: true },
      { name: "authorized-at-created-time", auditDate: "2026-01-01", eligible: true },
      { name: "without-audit", audit: false },
      { name: "wrong-action", action: "VIEW_DOSSIER" },
      { name: "tx06-authorization-is-not-tx07", action: "OPS_TX06_RETRY_AUTHORIZED", outcome: "AUTHORIZED" },
      { name: "ambiguous-authorization-is-not-tx07", action: "OPS_AMBIGUOUS_RETRY_AUTHORIZED" },
      { name: "without-risk-ack", outcome: "AUTHORIZED" },
      { name: "denied", outcome: "DENIED" },
      { name: "approved", status: "APROBADO" }, { name: "rejected", status: "RECHAZADO" }, { name: "pending", status: "PENDING" },
      { name: "ambiguous-error", errorCode: "PROVIDER_OUTCOME_AMBIGUOUS" },
      { name: "missing-error", errorCode: null },
      { name: "other-provider-status", providerStatus: "REJECTED" },
      { name: "missing-provider-status", providerStatus: null },
      { name: "tx06-result-is-not-tx07", transactionCode: "06" },
      { name: "other-transaction", transactionCode: "03" },
      { name: "missing-transaction", transactionCode: null },
      { name: "unformatted-transaction", transactionCode: "7" },
      { name: "with-score-zero", score: 0 }, { name: "with-no-information-score", score: -1 },
      { name: "with-decision", decision: "APROBADO" }, { name: "with-empty-offer", offer: {} },
      { name: "without-duration", durationMs: null },
      { name: "claimed", claimedAt: "2026-01-02" },
      { name: "claim-token", claimTokenHash: "fixture-token" },
      { name: "claim-expiry", claimExpiresAt: "2026-01-03" },
      { name: "consumed", consumedAt: "2026-01-02" }, { name: "credit-linked", creditId: 1 },
      { name: "clone", reusedFromAssessmentId: randomUUID() },
      { name: "audit-before-query", auditDate: "2025-12-31" },
      { name: "audit-at-expiry", auditDate: "2026-01-16" },
      { name: "audit-after-expiry", auditDate: "2026-01-17" },
    ].map(fixture => ({ id: randomUUID(), status: "NO_EVALUADO", errorCode: "NO_EVALUABLE_INFORMATION",
      providerStatus: "ACCEPTED", transactionCode: "07", durationMs: 1939, ...fixture }));
    for (const fixture of fixtures) {
      await database.query(`INSERT INTO "DataCreditoAssessment" VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'2026-01-01','2026-01-16','2026-04-01','{"originalEvidence":"preserved"}')`, [
        fixture.id, fixture.reusedFromAssessmentId ?? null, fixture.status, fixture.errorCode, fixture.providerStatus,
        fixture.transactionCode, fixture.score ?? null, fixture.decision ?? null,
        fixture.offer === undefined ? null : JSON.stringify(fixture.offer), fixture.durationMs,
        fixture.claimedAt ?? null, fixture.claimTokenHash ?? null, fixture.claimExpiresAt ?? null, fixture.consumedAt ?? null, fixture.creditId ?? null,
      ]);
      await database.query(`INSERT INTO "DataCreditoAssessmentSecurePayload" VALUES ($1,decode('abcdef','hex'))`, [fixture.id]);
    }
    const rows = async () => (await database.query('SELECT * FROM "DataCreditoAssessment" ORDER BY "id"')).rows;
    const before = await rows();
    const secureBefore = (await database.query('SELECT * FROM "DataCreditoAssessmentSecurePayload" ORDER BY "assessmentId"')).rows;
    await database.exec(noEvaluableRecoverySql);
    assert.deepEqual(await rows(), before, "Sin una autorización auditada no cambia ningún TX07");
    for (const fixture of fixtures.filter(item => item.audit !== false)) {
      await database.query(`INSERT INTO "DataCreditoAdminAccessAudit"
        ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
        VALUES ($1,$2,1,$3,$4,$5,'2026-04-01',$6)`, [randomUUID(), fixture.id,
        fixture.action || "OPS_NO_EVALUABLE_RETRY_AUTH", fixture.outcome || "AUTHORIZED_WITH_RISK_ACK", randomUUID(), fixture.auditDate || "2026-01-02"]);
    }
    const authorized = fixtures.find(fixture => fixture.name === "authorized");
    await database.query(`INSERT INTO "DataCreditoAdminAccessAudit"
      ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","retainedUntil","createdAt")
      VALUES ($1,$2,1,'OPS_NO_EVALUABLE_RETRY_AUTH','AUTHORIZED_WITH_RISK_ACK',$3,'2026-04-01','2026-01-03')`, [randomUUID(), authorized.id, randomUUID()]);
    const authorizations = (await database.query(`SELECT "assessmentId", MIN("createdAt") AS "createdAt" FROM "DataCreditoAdminAccessAudit"
      WHERE "action"='OPS_NO_EVALUABLE_RETRY_AUTH' AND "outcome"='AUTHORIZED_WITH_RISK_ACK' GROUP BY "assessmentId"`)).rows;
    const expected = before.map(row => fixtures.find(fixture => fixture.id === row.id).eligible
      ? { ...row, expiresAt: authorizations.find(audit => audit.assessmentId === row.id).createdAt } : row);
    const replay = async () => { await database.exec(recoverySql);await database.exec(ambiguousRecoverySql);await database.exec(noEvaluableRecoverySql); };
    await replay();
    assert.deepEqual(await rows(), expected, "Sólo cambia expiresAt del root TX07 expresamente autorizado sin datos de decisión");
    for (let repeat = 0; repeat < 3; repeat++) {
      await database.exec(rootBackfill);await replay();
      assert.deepEqual(await rows(), expected, "El preflight repetido mantiene la autorización más temprana y no autoriza otros casos");
    }
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoDailyQuotaUsage"')).rows, [{ used: 7 }], "El reintento autorizado no devuelve el cupo de la consulta enviada");
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoAssessmentSecurePayload" ORDER BY "assessmentId"')).rows, secureBefore, "La respuesta cifrada retenida permanece intacta");
    await database.query('UPDATE "DataCreditoAssessment" SET "expiresAt"=$1 WHERE "id"=$2', ["2026-01-01 12:00:00", authorized.id]);
    const earlier = await rows();await database.exec(noEvaluableRecoverySql);
    assert.deepEqual(await rows(), earlier, "La excepción nunca extiende un vencimiento anterior");
  } finally {
    await database.exec("ROLLBACK").catch(() => {});await database.close();
  }
});
