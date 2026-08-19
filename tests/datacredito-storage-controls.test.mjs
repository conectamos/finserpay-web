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
  assert.match(storage, /unnest\(index_state\.indkey::smallint\[\]\)/);
  assert.match(storage, /indexed_attribute\.attname::text/);
  assert.match(storage, /matchesDataCreditoSchemaIndex/);
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

test("valida indices por catalogo aunque PostgreSQL omita comillas", () => {
  const productionStylePendingIndex = {
    columnNames: [
      "documentHash",
      "surnameHash",
      "platform",
      "policyVersion",
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
      { column: "policyVersion" },
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
  assert.match(
    policyConsole,
    /DATA_CREDITO_INCLUDE_DISABLED_POLICY_PARAM\}=true/
  );
  assert.match(
    prequalificationGate,
    /policyPayload\.enabled === false[\s\S]*?finishBypass\(\)/
  );
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
  const environmentCheck = assessmentRoute.indexOf(
    "row.providerEnvironment !== provider.environment"
  );
  assert.ok(consumedCheck >= 0 && consumedCheck < environmentCheck);
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
    /disabled=\{saving \|\| !validation\.valid \|\| !hasUnsavedChanges\}/
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

test("la oferta persiste y serializa el tope maximo financiado", () => {
  assert.match(storage, /JSON\.stringify\(input\.offer\)/);
  const serializer = storage.match(
    /export function serializeDataCreditoAssessment\([\s\S]*?\n\}/
  )?.[0];
  assert.ok(serializer);
  assert.match(
    serializer,
    /maxFinancedAmount: Number\(row\.offer\?\.maxFinancedAmount\)/
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
    /const creditSettings = dataCreditoOffer[\s\S]*?: effectiveCreditSettings\.settings;/
  );
  assert.match(
    creditBuilder,
    /fianzaPorcentaje: dataCreditoOffer\.suretyPercentage/
  );
  assert.match(
    creditBuilder,
    /maxFinancedAmount: dataCreditoOffer\?\.maxFinancedAmount/
  );
});
