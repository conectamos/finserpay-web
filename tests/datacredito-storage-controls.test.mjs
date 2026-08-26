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
const { shouldLoadDataCreditoPolicy } = await jiti.import(
  "../lib/datacredito/policy-access.ts"
);
const { matchesDataCreditoSchemaIndex } = await jiti.import(
  "../lib/datacredito/schema-index.ts"
);
const { proxy } = await jiti.import("../proxy.ts");
const { NextRequest } = await import("next/server.js");

const [
  storage,
  evaluationRoute,
  assessmentRoute,
  policyRoute,
  retentionRoute,
  creditRoute,
  firmaSeguroDraftRoute,
  factoryConsole,
  prequalificationGate,
  policyConsole,
  setupSql,
  railwayCron,
  packageJson,
  dockerfile,
  retentionServiceConfig,
] =
  await Promise.all([
    readProjectFile("lib/datacredito/storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
    readProjectFile("app/api/creditos/datacredito/politica/route.ts"),
    readProjectFile("app/api/creditos/datacredito/retencion/route.ts"),
    readProjectFile("app/api/creditos/route.ts"),
    readProjectFile(
      "app/api/creditos/borradores/[id]/firma-seguro/route.ts"
    ),
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
    readProjectFile("railway.datacredito-retention.json"),
  ]);

test("reserva reutilizacion, rate limit e insercion bajo locks de base de datos", () => {
  assert.match(storage, /reserveDataCreditoAssessment/);
  assert.match(storage, /pg_advisory_xact_lock/);
  assert.match(
    storage,
    /transaction\.\$executeRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/
  );
  assert.doesNotMatch(
    storage,
    /transaction\.\$queryRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/
  );
  assert.match(storage, /datacredito-rate/);
  assert.match(storage, /datacredito-document/);
  assert.match(storage, /return \{ kind: "RATE_LIMITED" \}/);
  assert.match(storage, /insertPendingDataCreditoAssessment\(input, transaction\)/);
  assert.match(evaluationRoute, /reserveDataCreditoAssessment/);
  assert.doesNotMatch(evaluationRoute, /countRecentDataCreditoAssessments/);
});

test("el lock documental serializa globalmente la misma cedula y ambiente", () => {
  const lockDefinition = storage.match(
    /function dataCreditoDocumentLockKey[\s\S]*?(?=export async function reuseDataCreditoAssessment)/
  )?.[0];
  assert.ok(lockDefinition);
  assert.match(
    lockDefinition,
    /"datacredito-document"[\s\S]*input\.providerEnvironment[\s\S]*input\.documentHash/
  );
  assert.doesNotMatch(
    lockDefinition,
    /input\.(aliadoId|sedeId|platform|surnameHash)/
  );
});

test("solo libera pendientes antiguos de la misma cedula y ambiente global", () => {
  assert.match(storage, /maximumProviderSequenceMs = timeoutMs \* 4/);
  assert.match(storage, /Math\.max\(5,/);
  const staleCleanup = storage.match(
    /UPDATE "DataCreditoAssessment"[\s\S]*?"errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS'[\s\S]*?createdAt" <[\s\S]*?\n        `/
  )?.[0];
  assert.ok(staleCleanup);
  assert.match(staleCleanup, /"documentHash" = \$1/);
  assert.match(staleCleanup, /"providerEnvironment" = \$2/);
  assert.doesNotMatch(staleCleanup, /aliadoId|sedeId|surnameHash|platform/);
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

test("migra STALE_PENDING historicos al bloqueo ambiguo antes del TTL global", () => {
  const legacyBackfill = setupSql.search(
    /UPDATE "DataCreditoAssessment"\r?\nSET "errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS',[\s\S]*?WHERE "status" = 'NO_EVALUADO'\r?\n  AND "errorCode" = 'STALE_PENDING';/
  );
  const rootTtlBackfill = setupSql.indexOf(
    'UPDATE "DataCreditoAssessment" root'
  );
  const cloneTtlBackfill = setupSql.indexOf(
    'UPDATE "DataCreditoAssessment" clone'
  );

  assert.ok(legacyBackfill >= 0);
  assert.match(setupSql.slice(0, rootTtlBackfill), /PROVIDER_OUTCOME_AMBIGUOUS/);
  assert.ok(legacyBackfill < rootTtlBackfill);
  assert.ok(rootTtlBackfill < cloneTtlBackfill);
});

test("produccion verifica el preflight sin ejecutar DDL en runtime", () => {
  assert.match(storage, /async function verifyDataCreditoSchema\(\)/);
  assert.match(storage, /to_regclass\('\"DataCreditoPolicy\"'\)/);
  assert.match(storage, /FROM pg_attribute/);
  assert.match(storage, /a\.attnotnull AS "isNotNull"/);
  assert.match(storage, /FROM pg_index/);
  assert.match(storage, /pg_get_indexdef/);
  assert.match(storage, /unnest\(index_state\.indkey::smallint\[\]\)/);
  assert.match(storage, /indexed_attribute\.attname::text/);
  assert.match(storage, /constraint_state\.contype::text AS "constraintType"/);
  assert.match(
    storage,
    /constraint_state\.confdeltype::text AS "deleteAction"/
  );
  assert.match(storage, /matchesDataCreditoSchemaIndex/);
  assert.match(storage, /DataCreditoAssessment_pending_key/);
  assert.match(storage, /SCHEMA_NOT_READY/);
  assert.match(
    storage,
    /pg_get_triggerdef\(pending_guard\.oid, false\)/
  );
  assert.doesNotMatch(
    storage,
    /pg_get_expr\(pending_guard\.tgqual, pending_guard\.tgrelid\)/
  );

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

test("valida indices por catalogo aunque PostgreSQL omita comillas", () => {
  const productionStylePendingIndex = {
    columnNames: [
      "documentHash",
      "surnameHash",
      "platform",
      "policyRevisionId",
      "userId",
      null,
      "sedeId",
      null,
    ],
    expressionDefinitions: [
      null,
      null,
      null,
      null,
      null,
      'COALESCE("sellerId", 0)',
      null,
      'COALESCE("aliadoId", 0)',
    ],
    isUnique: true,
    isValid: true,
    predicate: "(status = 'PENDING'::text)",
  };
  const expectation = {
    keys: [
      { column: "documentHash" },
      { column: "surnameHash" },
      { column: "platform" },
      { column: "policyRevisionId" },
      { column: "userId" },
      { expression: 'COALESCE("sellerId", 0)' },
      { column: "sedeId" },
      { expression: 'COALESCE("aliadoId", 0)' },
    ],
    predicate: "PENDING_STATUS",
    unique: true,
  };

  assert.equal(
    matchesDataCreditoSchemaIndex(productionStylePendingIndex, expectation),
    true
  );
  assert.equal(
    matchesDataCreditoSchemaIndex(
      { ...productionStylePendingIndex, predicate: "(status = 'APROBADO'::text)" },
      expectation
    ),
    false
  );
  assert.equal(
    matchesDataCreditoSchemaIndex(
      {
        ...productionStylePendingIndex,
        expressionDefinitions: productionStylePendingIndex.expressionDefinitions.map(
          (definition, position) =>
            position === 5 ? 'COALESCE("sellerId", 1)' : definition
        ),
      },
      expectation
    ),
    false
  );
});

test("la bandera apagada restaura ventas y reserva la politica al administrador", () => {
  assert.equal(
    shouldLoadDataCreditoPolicy({
      enabled: false,
      centralAdmin: true,
      includeDisabledPolicy: false,
    }),
    false
  );
  assert.equal(
    shouldLoadDataCreditoPolicy({
      enabled: false,
      centralAdmin: false,
      includeDisabledPolicy: true,
    }),
    false
  );
  assert.equal(
    shouldLoadDataCreditoPolicy({
      enabled: false,
      centralAdmin: true,
      includeDisabledPolicy: true,
    }),
    true
  );
  assert.equal(
    shouldLoadDataCreditoPolicy({
      enabled: true,
      centralAdmin: false,
      includeDisabledPolicy: false,
    }),
    true
  );
  assert.match(policyRoute, /export async function GET\(request: Request\)/);
  assert.match(policyRoute, /shouldLoadDataCreditoPolicy/);
  assert.match(policyConsole, /\/api\/creditos\/datacredito\/politicas/);
  assert.match(
    prequalificationGate,
    /policyPayload\.enabled === false[\s\S]*?finishBypass\(\)/
  );
});

test("la retencion tiene endpoint protegido y tarea HTTPS con timeout", () => {
  assert.match(
    storage,
    /DATACREDITO_RETENTION_DAYS debe ser un entero entre 15 y 730/
  );
  assert.match(
    storage,
    /readBoundedInteger\("DATACREDITO_RETENTION_DAYS", 90, 15, 730\)/
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
  const cronConfig = JSON.parse(retentionServiceConfig);
  assert.equal(cronConfig.build.builder, "DOCKERFILE");
  assert.equal(
    cronConfig.deploy.startCommand,
    "npm run cron:datacredito-retention"
  );
  assert.equal(cronConfig.deploy.healthcheckPath, null);
  assert.equal(cronConfig.deploy.cronSchedule, "30 6 * * *");
  assert.equal(cronConfig.deploy.restartPolicyType, "ON_FAILURE");
});

test("el proxy delega solo el POST exacto de retencion con Bearer a la ruta", () => {
  const retentionUrl =
    "https://finserpay.com/api/creditos/datacredito/retencion";
  const delegated = proxy(
    new NextRequest(retentionUrl, {
      method: "POST",
      headers: { authorization: "Bearer token-validado-por-la-ruta" },
    })
  );

  assert.equal(delegated.status, 200);
  assert.equal(delegated.headers.get("x-middleware-next"), "1");

  for (const request of [
    new NextRequest(retentionUrl, { method: "POST" }),
    new NextRequest(retentionUrl, {
      method: "GET",
      headers: { authorization: "Bearer token-validado-por-la-ruta" },
    }),
    new NextRequest(`${retentionUrl}/otra-ruta`, {
      method: "POST",
      headers: { authorization: "Bearer token-validado-por-la-ruta" },
    }),
    new NextRequest("https://finserpay.com/api/creditos", {
      method: "POST",
      headers: { authorization: "Bearer token-validado-por-la-ruta" },
    }),
  ]) {
    const blocked = proxy(request);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.headers.get("x-middleware-next"), null);
  }
});

test("el credito exige, consume y recupera una precalificacion sin bypass", () => {
  assert.match(creditRoute, /getApprovedDataCreditoAssessmentForCredit/);
  assert.match(creditRoute, /classifyDataCreditoAssessmentForCredit/);
  assert.match(creditRoute, /recoverDataCreditoCredit/);
  assert.match(creditRoute, /dataCreditoRecoveredCreditResponse/);
  assert.match(creditRoute, /DATACREDITO_ASSESSMENT_IN_PROGRESS/);
  assert.match(creditRoute, /DATACREDITO_ASSESSMENT_CONSUMED_ELSEWHERE/);
  assert.match(
    creditRoute,
    /prisma\.credito\.findFirst\([\s\S]*usuarioId: input\.userId[\s\S]*vendedorId: input\.sellerId[\s\S]*sedeId: input\.sedeId/
  );
  assert.doesNotMatch(
    creditRoute,
    /prisma\.credito\.findUnique\([\s\S]{0,200}classification\.creditId/
  );
  assert.match(creditRoute, /claimDataCreditoAssessment/);
  assert.match(creditRoute, /consumeDataCreditoAssessment\([\s\S]*?transaction/);
  assert.match(creditRoute, /dataCreditoRequired \|\| isVeriffRequired\(\)/);
  assert.match(creditRoute, /DATACREDITO_ASSESSMENT_INVALID/);
  assert.match(creditRoute, /!dataCreditoProvider\.productionReady/);
  assert.match(creditRoute, /allowsDataCreditoNonProductionProvider/);
  assert.match(
    creditRoute,
    /providerEnvironment:\s*dataCreditoProvider\.environment/
  );
  assert.match(factoryConsole, /DatacreditoPrequalificationGate/);
  assert.match(factoryConsole, /handleDataCreditoAssessmentInvalidated\(\)/);
  assert.match(
    factoryConsole,
    /result\.data\?\.code === "DATACREDITO_ASSESSMENT_INVALID"/
  );
});

test("la interfaz recupera borradores, vencimientos y conflictos sin repetir consultas", () => {
  const consumedCheck = assessmentRoute.indexOf("if (row.consumedAt)");
  const globalStateCheck = assessmentRoute.indexOf(
    "getDataCreditoAssessmentDocumentState(row)"
  );
  const environmentCheck = assessmentRoute.indexOf(
    "row.providerEnvironment !== provider.environment"
  );
  assert.ok(consumedCheck >= 0 && consumedCheck < globalStateCheck);
  assert.ok(globalStateCheck < environmentCheck);
  assert.match(assessmentRoute, /ASSESSMENT_CONSUMED_ELSEWHERE/);
  assert.match(assessmentRoute, /documentState\.inProgress/);
  assert.doesNotMatch(
    assessmentRoute,
    /ASSESSMENT_CONSUMED_ELSEWHERE[\s\S]{0,240}creditId/
  );
  assert.match(assessmentRoute, /ASSESSMENT_ENVIRONMENT_MISMATCH/);
  assert.match(assessmentRoute, /getDataCreditoPublicConfig/);
  assert.ok(environmentCheck < assessmentRoute.indexOf("const expiresAt"));
  assert.match(
    prequalificationGate,
    /code === "ASSESSMENT_ENVIRONMENT_MISMATCH"/
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
  assert.match(
    policyConsole,
    /disabled=\{[\s\S]{0,120}saving \|\|[\s\S]{0,120}!validation\.valid \|\|[\s\S]{0,120}!hasUnsavedChanges/
  );
  assert.match(policyConsole, /No hay cambios pendientes por publicar/);
  assert.match(policyConsole, /Descartar y recargar/);
});

test("la ausencia explicita usa politica y puede consumirse sin exponer el sentinel", () => {
  assert.match(evaluationRoute, /result\.outcome === "SIN_INFORMACION"/);
  assert.match(evaluationRoute, /isDataCreditoNoInformationScore/);
  assert.match(evaluationRoute, /DATACREDITO_NO_INFORMATION_SCORE/);
  assert.equal(
    (storage.match(/"score" BETWEEN -1 AND 950/g) || []).length,
    2
  );
  assert.doesNotMatch(prequalificationGate, /scoreMin|scoreMax|score:\s/);
  assert.match(policyConsole, /DATACREDITO_NO_INFORMATION_SCORE/);
  assert.match(policyConsole, /Sin información/);
});

test("la simulacion resuelve la banda sin informacion de la politica asignada", () => {
  const getter = policyRoute.slice(
    policyRoute.indexOf("export async function GET"),
    policyRoute.indexOf("export async function PATCH")
  );

  assert.match(getter, /searchParams\.get\(["']purpose["']\)/);
  assert.match(getter, /purpose\s*===\s*["']simulation["']/);
  assert.match(getter, /searchParams\.get\(["']platform["']\)/);
  assert.match(getter, /normalizeDataCreditoPlatform/);
  assert.match(getter, /DATACREDITO_NO_INFORMATION_SCORE/);
  assert.match(
    getter,
    /resolveDataCredito(?:Decision|PolicyBand)\([\s\S]{0,220}DATACREDITO_NO_INFORMATION_SCORE/
  );
  assert.match(
    getter,
    /\{\s*\.\.\.policy,\s*priorityRules:\s*null\s*\}/
  );
});

test("el DTO de simulacion es minimo y un rechazo nunca expone oferta", () => {
  const simulationMarker = policyRoute.indexOf("simulationOnly: true");
  assert.notEqual(simulationMarker, -1);

  const dtoSource = policyRoute.slice(
    Math.max(0, simulationMarker - 900),
    Math.min(policyRoute.length, simulationMarker + 1_500)
  );
  assert.doesNotMatch(
    dtoSource,
    /\b(?:bands|assessmentId|documentNumber|firstSurname|documentHash|surnameHash|cedula)\s*:/i
  );
  assert.match(dtoSource, /\bplatform\s*:/);
  assert.match(dtoSource, /\bdecision\s*:/);
  assert.match(dtoSource, /\boffer\s*:/);

  assert.match(
    policyRoute,
    /(?:offer\s*:|const\s+\w*offer\w*\s*=)[\s\S]{0,220}\.decision\s*===\s*["']APROBADO["'][\s\S]{0,160}\.offer[\s\S]{0,80}:\s*null/
  );
});

test("la consola usa la simulacion sin convertirla en assessment aprobado", () => {
  const endpointIndex = factoryConsole.indexOf(
    "/api/creditos/datacredito/politica"
  );
  assert.notEqual(endpointIndex, -1);

  const loaderSource = factoryConsole.slice(
    Math.max(0, endpointIndex - 2_500),
    Math.min(factoryConsole.length, endpointIndex + 2_500)
  );
  assert.match(loaderSource, /simulatorMode/);
  assert.match(
    loaderSource,
    /(?:purpose=simulation|["']purpose["']\s*,\s*["']simulation["']|purpose\s*:\s*["']simulation["'])/
  );
  assert.match(
    loaderSource,
    /(?:platform=\$\{|["']platform["']\s*,\s*dataCreditoPlatform|platform\s*:\s*dataCreditoPlatform)/
  );
  assert.match(loaderSource, /simulationOnly/);
  assert.match(loaderSource, /set\w*Simulation\w*\(/i);
  assert.doesNotMatch(loaderSource, /setDataCreditoApproval\s*\(/);
  assert.doesNotMatch(loaderSource, /setDataCreditoAssessmentId\s*\(/);
  assert.doesNotMatch(loaderSource, /\bassessmentId\s*:/);
});

test("la oferta activa conserva su plazo y nunca cae al tope global en pantalla", () => {
  assert.match(factoryConsole, /policyControlled:\s*true/);
  assert.match(
    factoryConsole,
    /preservedTerms\.policyControlled\s*\?\s*MAX_CREDIT_INSTALLMENTS/
  );

  const policyFirstMessages =
    factoryConsole.match(
      /activeDataCreditoOffer\s*\?\s*dataCreditoFinancingExcess\s*>\s*0/g
    ) || [];
  assert.equal(policyFirstMessages.length, 2);
  assert.doesNotMatch(
    factoryConsole,
    /activeDataCreditoOffer\s*&&\s*dataCreditoFinancingExcess\s*>\s*0/
  );
});

test("la vigencia contractual es exactamente 15 dias y no admite override historico", () => {
  assert.match(
    storage,
    /DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES = 21_600/
  );
  const ttlGetter = storage.match(
    /export function getDataCreditoAssessmentTtlMinutes\(\) \{([\s\S]*?)\n\}/
  )?.[1];
  assert.ok(ttlGetter);
  assert.match(ttlGetter, /return DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES/);
  assert.doesNotMatch(ttlGetter, /process\.env|readBoundedInteger/);
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
  assert.match(classifier, /status: "CONSUMED_ELSEWHERE"/);
  assert.match(classifier, /row\.globalConsumedElsewhere/);
  assert.match(classifier, /row\.globalClaimActive/);
  assert.ok(
    classifier.indexOf('status: "CONSUMED", creditId') <
      classifier.indexOf("row.providerEnvironment !== match.providerEnvironment")
  );
  assert.match(
    classifier,
    /row\.providerEnvironment !== match\.providerEnvironment/
  );
  assert.match(classifier, /status: "IN_PROGRESS"/);
  assert.match(classifier, /status: "EXPIRED"/);
  assert.match(classifier, /status: "INVALID"/);
});

test("la oferta persiste y serializa monto, plazo y tope de cuota", () => {
  assert.match(storage, /JSON\.stringify\(input\.offer\)/);
  const serializer = storage.match(
    /export function serializeDataCreditoAssessment\([\s\S]*?\n\}/
  )?.[0];
  assert.ok(serializer);
  assert.match(serializer, /platform: row\.platform/);
  assert.match(
    serializer,
    /maxFinancedAmount: Number\(row\.offer\?\.maxFinancedAmount\)/
  );
  assert.match(
    serializer,
    /resolveDataCreditoOfferFinancingTerms\(row\.platform, row\.offer\)/
  );
  assert.match(
    serializer,
    /installmentCount: financingTerms\.installmentCount/
  );
  assert.match(
    serializer,
    /maxInstallmentAmount: financingTerms\.maxInstallmentAmount/
  );
  assert.match(
    creditRoute,
    /parseCreditInstallmentSelection\(\s*body\.plazoMeses,\s*dataCreditoFinancingTerms\.installmentCount/
  );
  assert.match(
    creditRoute,
    /selectedDataCreditoInstallmentCount === null[\s\S]{0,300}status: 400/
  );
  assert.match(
    creditRoute,
    /const plazoMeses = dataCreditoFinancingTerms\s*\? selectedDataCreditoInstallmentCount!/
  );
  assert.doesNotMatch(
    creditRoute,
    /const plazoMeses = dataCreditoFinancingTerms\s*\? dataCreditoFinancingTerms\.installmentCount/
  );
  assert.match(
    creditRoute,
    /maxInstallmentCount: dataCreditoFinancingTerms\?\.installmentCount/
  );
  assert.match(
    creditRoute,
    /selectedInstallmentCount: plazoMeses/
  );
  assert.match(
    creditRoute,
    /iphoneMaxInstallmentValue: dataCreditoFinancingTerms[\s\S]*?dataCreditoFinancingTerms\.maxInstallmentAmount/
  );
  assert.doesNotMatch(creditRoute, /forcePaymentFrequency/);
  assert.doesNotMatch(firmaSeguroDraftRoute, /forcePaymentFrequency/);
  assert.doesNotMatch(factoryConsole, /forcePaymentFrequency/);
  assert.match(policyRoute, /requireFinancingTerms: true/);
});

test("separa la cuota exacta contable de la cuota comercial postventa", () => {
  assert.match(
    creditRoute,
    /amortizacion:\s*\{\s*select:\s*\{\s*cuotaComercial: true/
  );
  assert.match(
    creditRoute,
    /readCommercialInstallmentFromSnapshot\(item\.contratoSnapshot\)/
  );
  assert.match(
    creditRoute,
    /valorCuota: item\.valorCuota,\s*valorCuotaComercial,/
  );
  assert.match(
    factoryConsole,
    /selectedCredit\?\.valorCuotaComercial \?\? selectedCredit\?\.valorCuota \?\? 0/
  );
  assert.doesNotMatch(
    factoryConsole,
    /currency\(selectedCredit\.valorCuota\)/
  );
  assert.match(
    factoryConsole,
    /label="Cuota comercial"\s*value=\{currency\(selectedCreditCommercialInstallment\)\}/
  );
});

test("FirmaSeguro aplica la oferta DataCredito al PDF y conserva el legado apagado", () => {
  const offerResolver = firmaSeguroDraftRoute.match(
    /async function getDraftDataCreditoOffer\([\s\S]*?\n\}/
  )?.[0];
  const creditBuilder = firmaSeguroDraftRoute.match(
    /async function buildDraftCredit\([\s\S]*?\n\}/
  )?.[0];

  assert.ok(offerResolver);
  assert.ok(creditBuilder);
  assert.match(
    offerResolver,
    /if \(!dataCreditoProvider\.enabled\) \{\s*return null;\s*\}/
  );
  assert.match(offerResolver, /isDataCreditoAuditConfigured/);
  assert.match(offerResolver, /getApprovedDataCreditoAssessmentForCredit/);
  assert.match(offerResolver, /!dataCreditoProvider\.productionReady/);
  assert.match(offerResolver, /allowsDataCreditoNonProductionProvider/);
  assert.match(
    offerResolver,
    /providerEnvironment:\s*dataCreditoProvider\.environment/
  );
  assert.match(offerResolver, /\^\\d\{3,13\}\$/);
  for (const scope of [
    "userId: row.usuarioId",
    "sellerId: row.vendedorId",
    "sedeId: row.sedeId",
    "aliadoId: row.sedeAliadoId",
  ]) {
    assert.ok(offerResolver.includes(scope), `Falta scope de FirmaSeguro: ${scope}`);
  }
  assert.match(offerResolver, /Number\.isSafeInteger\(maxFinancedAmount\)/);
  assert.match(
    offerResolver,
    /maxFinancedAmount <= DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT/
  );
  assert.match(
    creditBuilder,
    /const creditSettings = dataCreditoOffer[\s\S]*?: effectiveCreditSettings\.globalSettings;/
  );
  assert.match(
    creditBuilder,
    /fianzaPorcentaje: dataCreditoOffer\.suretyPercentage/
  );
  assert.match(
    creditBuilder,
    /resolveEffectiveDataCreditoFinancingLimit\([\s\S]*?maxFinancedAmount: dataCreditoOffer\.maxFinancedAmount/
  );
  assert.match(
    creditBuilder,
    /calculateRequiredInitialPaymentForFinancingLimit\([\s\S]*?dataCreditoEffectiveMaxFinancedAmount/
  );
  assert.match(
    creditBuilder,
    /parseCreditInstallmentSelection\(\s*payload\.plazoMeses,\s*dataCreditoOffer\.installmentCount/
  );
  assert.match(
    creditBuilder,
    /selectedDataCreditoInstallmentCount === null[\s\S]{0,200}CreditValidationError/
  );
  assert.match(
    creditBuilder,
    /const plazoMeses = dataCreditoOffer\s*\? selectedDataCreditoInstallmentCount!/
  );
  assert.doesNotMatch(
    creditBuilder,
    /const plazoMeses = dataCreditoOffer\s*\? dataCreditoOffer\.installmentCount/
  );
  assert.match(
    creditBuilder,
    /maxInstallmentCount: dataCreditoOffer\.installmentCount/
  );
  assert.match(
    creditBuilder,
    /selectedInstallmentCount: plazoMeses/
  );
  assert.match(
    creditBuilder,
    /iphoneMaxInstallmentValue: dataCreditoOffer[\s\S]*?dataCreditoOffer\.maxInstallmentAmount/
  );
  assert.doesNotMatch(
    creditBuilder,
    /effectiveCreditSettings\.documentException/
  );
});

test("pantalla, cierre y FirmaSeguro respetan el menor tope financiable", () => {
  assert.match(
    factoryConsole,
    /resolveEffectiveDataCreditoFinancingLimit\([\s\S]*?maxFinancedAmount: dataCreditoMaxFinancedAmount[\s\S]*?precioBaseVenta:/
  );
  assert.match(
    factoryConsole,
    /calculateRequiredInitialPaymentForFinancingLimit\([\s\S]*?dataCreditoEffectiveMaxFinancedAmount/
  );
  assert.match(
    creditRoute,
    /resolveEffectiveDataCreditoFinancingLimit\([\s\S]*?maxFinancedAmount: dataCreditoMaxFinancedAmount[\s\S]*?precioBaseVenta: precioBaseVentaCatalogo/
  );
  assert.match(
    creditRoute,
    /calculateRequiredInitialPaymentForFinancingLimit\([\s\S]*?dataCreditoEffectiveMaxFinancedAmount/
  );
  assert.match(
    firmaSeguroDraftRoute,
    /resolveEffectiveDataCreditoFinancingLimit\([\s\S]*?maxFinancedAmount: dataCreditoOffer\.maxFinancedAmount[\s\S]*?precioBaseVenta: precioBaseVentaCatalogo/
  );
  assert.match(
    firmaSeguroDraftRoute,
    /calculateRequiredInitialPaymentForFinancingLimit\([\s\S]*?dataCreditoEffectiveMaxFinancedAmount/
  );
});

test("la fábrica presenta el plazo DataCredito como máximo seleccionable", () => {
  assert.doesNotMatch(factoryConsole, /dataCreditoLocksInstallmentCount/);
  assert.match(
    factoryConsole,
    /getCreditInstallmentOptions\(plazoMaximoCuotas\)/
  );
  assert.match(
    factoryConsole,
    /restoringDraftAssessment && restoredDraftSnapshot[\s\S]{0,240}parseCreditInstallmentSelection\([\s\S]{0,120}restoredDraftSnapshot\.plazoMeses/
  );
  assert.match(
    factoryConsole,
    /policyControlled: Boolean\(restoredAssessmentId\)[\s\S]{0,100}restoringDraft: true/
  );
  assert.match(
    factoryConsole,
    /Plazo máximo \{dataCreditoApproval\.offer\.installmentCount\} cuotas/
  );
  assert.match(
    prequalificationGate,
    /Plazo máximo autorizado/
  );
  assert.match(
    policyConsole,
    /Plazo máximo \(cuotas\)/
  );
  assert.match(
    factoryConsole,
    /Puedes elegir hasta \{plazoMaximoCuotas\} cuotas/
  );
});

test("muestra los resultados DataCredito aprobados y rechazados como ventanas emergentes", () => {
  assert.match(prequalificationGate, /createPortal\(/);
  assert.match(prequalificationGate, /role="dialog"/);
  assert.match(prequalificationGate, /aria-modal="true"/);
  assert.match(prequalificationGate, /fp-ui-dialog-backdrop/);
  assert.match(
    prequalificationGate,
    /document\.body\.style\.overflow = "hidden"/
  );
  assert.match(prequalificationGate, /event\.key === "Escape"/);
  assert.match(prequalificationGate, /event\.key !== "Tab"/);
  assert.match(
    prequalificationGate,
    /labelledBy="datacredito-approved-title"[\s\S]*?describedBy="datacredito-approved-description"/
  );
  assert.match(
    prequalificationGate,
    /labelledBy="datacredito-rejected-title"[\s\S]*?describedBy="datacredito-rejected-description"/
  );
  assert.doesNotMatch(
    prequalificationGate,
    /role="status"[\s\S]{0,120}datacredito-(approved|rejected)-title/
  );
});

test("muestra una ventana específica cuando el cliente ya tiene una solicitud activa", () => {
  const conflictBranch = prequalificationGate.indexOf(
    'getResponseCode(payload) === "SOLICITUD_ACTIVA_EXISTENTE"'
  );
  const activeRequestTransition = prequalificationGate.indexOf(
    'setView("active-request")',
    conflictBranch
  );
  const genericTechnicalTransition = prequalificationGate.indexOf(
    'setView("technical-error")',
    conflictBranch
  );

  assert.ok(conflictBranch >= 0);
  assert.ok(activeRequestTransition > conflictBranch);
  assert.ok(genericTechnicalTransition > activeRequestTransition);
  assert.ok(prequalificationGate.includes('view !== "active-request"'));
  assert.ok(
    prequalificationGate.includes(
      'labelledBy="datacredito-active-request-title"'
    )
  );
  assert.ok(
    prequalificationGate.includes(
      'describedBy="datacredito-active-request-description"'
    )
  );
  assert.ok(prequalificationGate.includes("Cliente ya existe"));
  assert.ok(
    prequalificationGate.includes(
      "Ya existe una solicitud para esta cédula. Debe retomarse o desistirse antes de iniciar otra."
    )
  );
  assert.ok(
    prequalificationGate.includes("Si eres el asesor titular, búscala en el muro")
  );
  assert.ok(prequalificationGate.includes("href={solicitudWallHref}"));
  assert.ok(prequalificationGate.includes("Buscar en mi muro"));
});

test("reserva espacio para los iconos de identificacion en la precalificacion", () => {
  const inputsWithLeadingIcon =
    prequalificationGate.match(
      /className="min-h-14 border-\[var\(--fp-lime-strong\)\] !pl-12 text-base/g
    ) || [];

  assert.equal(inputsWithLeadingIcon.length, 2);
});

test("oculta visualmente la fianza DataCredito para todos los perfiles", () => {
  assert.doesNotMatch(prequalificationGate, /showSurety/);
  assert.doesNotMatch(factoryConsole, /showSurety=/);
  assert.doesNotMatch(
    prequalificationGate,
    /puntaje consultado permanece oculto/
  );
  assert.doesNotMatch(factoryConsole, /El puntaje no se muestra/);
  assert.doesNotMatch(
    prequalificationGate,
    /formatPercentage\(approvedResult\.offer\.suretyPercentage\)/
  );
  assert.doesNotMatch(
    factoryConsole,
    /Fianza \{formatPercent\(dataCreditoApproval\.offer\.suretyPercentage\)\}/
  );
  assert.doesNotMatch(
    factoryConsole,
    /Fianza \{formatPercent\(financialPlan\.fianzaPorcentaje\)\}/
  );
});
