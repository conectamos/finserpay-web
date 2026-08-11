import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { isDataCreditoUniqueViolation } = await jiti.import(
  "../lib/datacredito/database-errors.ts"
);

const [
  storage,
  evaluationRoute,
  assessmentRoute,
  policyRoute,
  retentionRoute,
  creditRoute,
  factoryConsole,
  prequalificationGate,
  policyConsole,
  setupSql,
  railwayCron,
  packageJson,
  dockerfile,
] =
  await Promise.all([
    readProjectFile("lib/datacredito/storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
    readProjectFile("app/api/creditos/datacredito/politica/route.ts"),
    readProjectFile("app/api/creditos/datacredito/retencion/route.ts"),
    readProjectFile("app/api/creditos/route.ts"),
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
    readProjectFile(
      "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
    ),
    readProjectFile(
      "app/dashboard/parametros-credito/datacredito-policy-console.tsx"
    ),
    readProjectFile("scripts/setup-datacredito.sql"),
    readProjectFile("scripts/railway-cron.mjs"),
    readProjectFile("package.json"),
    readProjectFile("Dockerfile"),
  ]);

test("reserva reutilizacion, rate limit e insercion bajo locks de base de datos", () => {
  assert.match(storage, /reserveDataCreditoAssessment/);
  assert.match(storage, /pg_advisory_xact_lock/);
  assert.match(storage, /datacredito-rate/);
  assert.match(storage, /datacredito-document/);
  assert.match(storage, /return \{ kind: "RATE_LIMITED" \}/);
  assert.match(storage, /insertPendingDataCreditoAssessment\(input, transaction\)/);
  assert.match(evaluationRoute, /reserveDataCreditoAssessment/);
  assert.doesNotMatch(evaluationRoute, /countRecentDataCreditoAssessments/);
});

test("el lock documental serializa plataformas que comparten el mismo limite", () => {
  const lockDefinition = storage.match(
    /const documentLockKey = \[([\s\S]*?)\]\.join\(":"\);/
  )?.[1];
  assert.ok(lockDefinition);
  assert.match(lockDefinition, /input\.documentHash/);
  assert.doesNotMatch(lockDefinition, /input\.platform/);
});

test("solo libera pendientes antiguos del mismo documento, aliado y sede", () => {
  assert.match(storage, /maximumProviderSequenceMs = timeoutMs \* 4/);
  assert.match(storage, /Math\.max\(5,/);
  assert.match(storage, /"documentHash" = \$1/);
  assert.match(storage, /"sedeId" = \$3/);
  assert.match(storage, /"aliadoId" IS NOT DISTINCT FROM \$4/);
  assert.doesNotMatch(storage, /INTERVAL '2 minutes'/);
});

test("reconoce errores unique directos y envueltos por Prisma 7", () => {
  assert.equal(isDataCreditoUniqueViolation({ code: "23505" }), true);
  assert.equal(isDataCreditoUniqueViolation({ code: "P2002" }), true);
  assert.equal(
    isDataCreditoUniqueViolation({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "23505" },
        },
      },
    }),
    true
  );
  assert.equal(
    isDataCreditoUniqueViolation({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    }),
    false
  );
  assert.match(evaluationRoute, /isDataCreditoUniqueViolation/);
});

test("incluye preflight idempotente antes de habilitar la integracion", () => {
  assert.match(setupSql, /CREATE TABLE IF NOT EXISTS "DataCreditoPolicy"/);
  assert.match(setupSql, /CREATE TABLE IF NOT EXISTS "DataCreditoAssessment"/);
  assert.match(setupSql, /DataCreditoAssessment_pending_document_key/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(
    scripts["db:setup-datacredito"],
    "npx prisma db execute --file scripts/setup-datacredito.sql"
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/scripts\/setup-datacredito\.sql \.\/scripts\/setup-datacredito\.sql/
  );
  assert.match(setupSql, /ALTER COLUMN "retainedUntil" SET NOT NULL/);
});

test("produccion verifica el preflight sin ejecutar DDL en runtime", () => {
  assert.match(storage, /async function verifyDataCreditoSchema\(\)/);
  assert.match(storage, /to_regclass\('\"DataCreditoPolicy\"'\)/);
  assert.match(storage, /FROM pg_attribute/);
  assert.match(storage, /a\.attnotnull AS "isNotNull"/);
  assert.match(storage, /FROM pg_index/);
  assert.match(storage, /pg_get_indexdef/);
  assert.match(storage, /DataCreditoAssessment_pending_key/);
  assert.match(storage, /SCHEMA_NOT_READY/);

  const initializer = storage.match(
    /async function initializeDataCreditoSchema\(\) \{([\s\S]*?)\n\}/
  )?.[1];
  assert.ok(initializer);
  assert.match(
    initializer,
    /if \(process\.env\.NODE_ENV === "production"\) \{\s*await verifyDataCreditoSchema\(\);\s*return;/
  );
  assert.match(initializer, /await setupDataCreditoSchema\(\);/);
  assert.match(policyRoute, /DataCreditoStorageConfigurationError/);
  assert.match(policyRoute, /\{ status: 503 \}/);
  assert.match(evaluationRoute, /\? error\.code/);
});

test("la retencion tiene endpoint protegido y tarea HTTPS con timeout", () => {
  assert.match(
    storage,
    /DATACREDITO_RETENTION_DAYS debe ser un entero entre 1 y 730/
  );
  assert.match(retentionRoute, /DATACREDITO_RETENTION_TOKEN/);
  assert.match(retentionRoute, /timingSafeEqual/);
  assert.match(retentionRoute, /purgeExpiredDataCreditoAssessments/);
  assert.match(railwayCron, /"datacredito-retention"/);
  assert.match(railwayCron, /requireHttps: true/);
  assert.match(railwayCron, /timeoutMs: 30_000/);
  assert.match(railwayCron, /AbortSignal\.timeout\(task\.timeoutMs\)/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(
    scripts["cron:datacredito-retention"],
    "node scripts/railway-cron.mjs datacredito-retention"
  );
});

test("el credito exige, consume y recupera una precalificacion sin bypass", () => {
  assert.match(creditRoute, /getApprovedDataCreditoAssessmentForCredit/);
  assert.match(creditRoute, /classifyDataCreditoAssessmentForCredit/);
  assert.match(creditRoute, /recoverDataCreditoCredit/);
  assert.match(creditRoute, /dataCreditoRecoveredCreditResponse/);
  assert.match(creditRoute, /DATACREDITO_ASSESSMENT_IN_PROGRESS/);
  assert.match(creditRoute, /claimDataCreditoAssessment/);
  assert.match(creditRoute, /consumeDataCreditoAssessment\([\s\S]*?transaction/);
  assert.match(creditRoute, /dataCreditoRequired \|\| isVeriffRequired\(\)/);
  assert.match(creditRoute, /DATACREDITO_ASSESSMENT_INVALID/);
  assert.match(factoryConsole, /DatacreditoPrequalificationGate/);
  assert.match(factoryConsole, /handleDataCreditoAssessmentInvalidated\(\)/);
  assert.match(
    factoryConsole,
    /result\.data\?\.code === "DATACREDITO_ASSESSMENT_INVALID"/
  );
});

test("la interfaz recupera borradores, vencimientos y conflictos sin repetir consultas", () => {
  assert.ok(
    assessmentRoute.indexOf("if (row.consumedAt)") <
      assessmentRoute.indexOf("const expiresAt")
  );
  assert.match(
    prequalificationGate,
    /if \(code === ['"]ASSESSMENT_CONSUMED['"]\) return false/
  );
  assert.match(prequalificationGate, /response\.status === 404/);
  assert.match(prequalificationGate, /setConsumedCreditId/);
  assert.match(prequalificationGate, /El cr[eé]dito ya fue creado/);
  assert.match(factoryConsole, /Date\.parse\(dataCreditoApproval\.expiresAt\)/);
  assert.match(factoryConsole, /invalidateExpiredAssessment/);
  assert.match(factoryConsole, /noticeRef\.current\?\.focus/);
  assert.match(factoryConsole, /aria-live="polite"/);
  assert.match(factoryConsole, /veriffConfigLoadFailed/);
  assert.match(factoryConsole, /Reintentar verificación/);
  assert.match(policyConsole, /POLICY_VERSION_CONFLICT/);
  assert.match(policyConsole, /hasUnsavedChanges/);
  assert.match(policyConsole, /Descartar y recargar/);
});

test("la vigencia predeterminada cubre identidad y contratos", () => {
  assert.match(
    storage,
    /readBoundedInteger\("DATACREDITO_ASSESSMENT_TTL_MINUTES", 120, 1, 1_440\)/
  );
});

test("la clasificacion posfallo no filtra evaluaciones fuera de identidad y scope", () => {
  const classifier = storage.match(
    /export async function classifyDataCreditoAssessmentForCredit\([\s\S]*?\n\}/
  )?.[0];
  assert.ok(classifier);
  assert.doesNotMatch(classifier, /SELECT \*/);
  for (const predicate of [
    '"id" = $1',
    '"documentHash" = $2',
    '"surnameHash" = $3',
    '"platform" = $4',
    '"userId" = $5',
    '"sellerId" IS NOT DISTINCT FROM $6',
    '"sedeId" = $7',
    '"aliadoId" IS NOT DISTINCT FROM $8',
  ]) {
    assert.ok(classifier.includes(predicate), `Falta scope seguro: ${predicate}`);
  }
  assert.match(classifier, /row\.consumedAt/);
  assert.match(classifier, /status: "CONSUMED", creditId/);
  assert.match(classifier, /status: "IN_PROGRESS"/);
  assert.match(classifier, /status: "EXPIRED"/);
  assert.match(classifier, /status: "INVALID"/);
});
