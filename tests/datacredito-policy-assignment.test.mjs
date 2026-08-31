import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { parseDataCreditoPolicyBands, resolveDataCreditoDecision } =
  await jiti.import("../lib/datacredito/policy.ts");

const [schema, setupSql, storage, adminStorage, evaluationRoute, catalogRoute, legacyPolicyRoute] =
  await Promise.all([
    readProjectFile("prisma/schema.prisma"),
    readProjectFile("scripts/setup-datacredito.sql"),
    readProjectFile("lib/datacredito/storage.ts"),
    readProjectFile("lib/datacredito/admin-storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile("app/api/creditos/datacredito/politicas/route.ts"),
    readProjectFile("app/api/creditos/datacredito/politica/route.ts"),
  ]);

function section(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontro ${startMarker}`);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `No se encontro ${endMarker}`);
  return contents.slice(start, end);
}

test("el esquema asigna exactamente un perfil requerido a cada aliado", () => {
  const ally = section(schema, "model Aliado {", "model DataCreditoPolicyProfile {");
  assert.match(ally, /dataCreditoPolicyId\s+String\s+@default\(dbgenerated/);
  assert.match(ally, /dataCreditoPolicy\s+DataCreditoPolicyProfile\s+@relation/);
  assert.doesNotMatch(ally, /dataCreditoPolicyId\s+String\?/);
  assert.match(schema, /model DataCreditoPolicyRevision \{/);
  assert.match(schema, /@@unique\(\[profileId, version\]\)/);
  assert.match(schema, /model DataCreditoPolicyAssignmentAudit \{/);
  assert.match(setupSql, /ALTER COLUMN "dataCreditoPolicyId" SET NOT NULL/);
  assert.match(setupSql, /Aliado_dataCreditoPolicy_fkey/);
  assert.match(setupSql, /ON DELETE RESTRICT/);
});

test("la migracion conserva la tabla global y copia todas sus versiones al perfil general", () => {
  assert.match(setupSql, /CREATE TABLE IF NOT EXISTS "DataCreditoPolicy"/);
  assert.match(setupSql, /CREATE TABLE IF NOT EXISTS "DataCreditoPolicyProfile"/);
  assert.match(setupSql, /CREATE TABLE IF NOT EXISTS "DataCreditoPolicyRevision"/);
  assert.match(setupSql, /FROM "DataCreditoPolicy" legacy/);
  assert.match(setupSql, /ON CONFLICT \("profileId", "version"\) DO NOTHING/);
  assert.match(setupSql, /DataCreditoPolicy_sync_profile_revision/);
  assert.match(setupSql, /DataCreditoPolicyRevision_immutable/);
  assert.match(setupSql, /DataCreditoAssessment_resolve_legacy_revision/);
  assert.match(setupSql, /DataCreditoAssessment_terminal_expiry/);
  assert.match(setupSql, /OLD."status" = 'PENDING'/);
  assert.match(setupSql, /NEW."reusedFromAssessmentId" IS NULL/);
  assert.match(setupSql, /BEFORE UPDATE OF "status"/);
  assert.match(setupSql, /ALTER COLUMN "policyRevisionId" SET NOT NULL/);
  assert.match(setupSql, /DataCreditoAssessment_policyRevision_fkey/);
  assert.match(setupSql, /Bootstrap fail-closed/);
  assert.match(setupSql, /WHERE NOT EXISTS \(SELECT 1 FROM "DataCreditoPolicyRevision"\)/);
  assert.match(setupSql, /bootstrap_android_noinfo/);
  assert.match(setupSql, /bootstrap_iphone_all/);
});

test("catalogo y asignaciones solo exponen mutaciones al administrador central", () => {
  assert.match(catalogRoute, /getDataCreditoCentralAdmin/);
  for (const handler of ["GET", "POST", "PATCH"]) {
    const handlerSource = catalogRoute.slice(
      catalogRoute.indexOf(`export async function ${handler}`)
    );
    assert.match(handlerSource, /getDataCreditoCentralAdmin\(\)/);
  }
  assert.match(catalogRoute, /action === "SAVE_REVISION"/);
  assert.match(catalogRoute, /action === "ASSIGN_ALLY"/);
  assert.doesNotMatch(catalogRoute, /UPDATE_PROFILE/);
  assert.match(catalogRoute, /createdPolicyId/);
  assert.match(catalogRoute, /updatedPolicyId/);
  assert.match(catalogRoute, /assignedAllyId/);
  assert.match(catalogRoute, /POLICY_VERSION_CONFLICT/);
  assert.match(catalogRoute, /POLICY_ASSIGNMENT_CONFLICT/);
  assert.match(catalogRoute, /POLICY_NAME_CONFLICT/);
  assert.equal(
    catalogRoute.match(/requireFinancingTerms:\s*true/g)?.length,
    2
  );
  assert.equal(
    catalogRoute.match(/parseDataCreditoPolicyPriorityRules\(/g)?.length,
    2,
    "POST y PATCH deben exigir la regla prioritaria versionada"
  );
  assert.equal(
    catalogRoute.match(/requireTotalDelinquency:\s*true/g)?.length,
    2,
    "POST y PATCH deben exigir también la regla versionada de mora total"
  );
});

test("el endpoint legado exige la regla al publicar una revision historica que no la tiene", () => {
  const patchHandler = legacyPolicyRoute.slice(
    legacyPolicyRoute.indexOf("export async function PATCH")
  );
  assert.match(
    patchHandler,
    /body\.priorityRules \?\? assigned\.policy\.priorityRules/
  );
  assert.match(
    patchHandler,
    /priorityRulesInput === null[\s\S]*?priorityRulesInput === undefined[\s\S]*?status: 400/
  );
  assert.match(
    patchHandler,
    /parseDataCreditoPolicyPriorityRules\([\s\S]*?priorityRulesInput,[\s\S]*?requireTotalDelinquency:\s*true[\s\S]*?\)/
  );
  assert.doesNotMatch(patchHandler, /rejectAboveCop:\s*2_000_000/);
});

test("el detalle admin normaliza terminos de ofertas historicas", () => {
  const serializer = section(
    adminStorage,
    "function serializeOffer(",
    "function serializeAdminAssessment"
  );
  assert.match(serializer, /platform: "ANDROID" \| "IPHONE"/);
  assert.match(
    serializer,
    /resolveDataCreditoOfferFinancingTerms\(platform, value\)/
  );
  assert.match(
    serializer,
    /installmentCount: financingTerms\.installmentCount/
  );
  assert.match(
    serializer,
    /maxInstallmentAmount: financingTerms\.maxInstallmentAmount/
  );
  assert.match(adminStorage, /serializeOffer\(row\.offer, row\.platform\)/);
});

test("asignar serializa el perfil y el aliado y deja auditoria", () => {
  const assignment = adminStorage.slice(
    adminStorage.indexOf("export async function assignDataCreditoPolicyToAlly")
  );
  const profileLock = assignment.indexOf('FROM "DataCreditoPolicyProfile" profile');
  const allyLock = assignment.indexOf('FROM "Aliado"');
  assert.ok(profileLock >= 0 && profileLock < allyLock);
  assert.match(assignment.slice(profileLock, allyLock), /FOR UPDATE/);
  assert.match(assignment.slice(allyLock), /FOR UPDATE/);
  assert.match(assignment, /expectedPolicyId/);
  assert.match(assignment, /DataCreditoPolicyAssignmentConflictError/);
  assert.match(assignment, /INSERT INTO "DataCreditoPolicyAssignmentAudit"/);
  assert.match(assignment, /actorUserId/);
});

test("evaluacion resuelve la politica por aliado y falla antes del proveedor", () => {
  const policyLookup = evaluationRoute.indexOf("getAssignedDataCreditoPolicy(");
  const reservation = evaluationRoute.indexOf("reserveDataCreditoAssessment({");
  const providerCall = evaluationRoute.indexOf("queryDataCreditoNaturalPerson({");
  assert.ok(policyLookup >= 0 && policyLookup < reservation);
  assert.ok(policyLookup < providerCall);
  assert.match(evaluationRoute, /assignedPolicy\.kind !== "READY"/);
  assert.match(evaluationRoute, /POLICY_NOT_ASSIGNED/);
  assert.match(evaluationRoute, /POLICY_INACTIVE/);
  assert.match(evaluationRoute, /POLICY_NO_REVISION/);
  assert.match(evaluationRoute, /policyRevisionId:\s*policy\.revisionId/);
  assert.match(
    evaluationRoute,
    /buildDataCreditoAdminRiskSummary\([\s\S]*?result\.providerPayload[\s\S]*?\)/
  );
  assert.match(evaluationRoute, /riskSummary\?\.telcos\.delinquentBalance/);
  assert.match(evaluationRoute, /telcoDelinquencyInformationAvailable/);
  assert.match(evaluationRoute, /riskSummary\?\.totals\?\.delinquentBalance/);
  assert.match(evaluationRoute, /totalDelinquencyInformationAvailable/);
});

test("la llave anticonsulta es cedula y ambiente para todo FINSER PAY", () => {
  const reusable = section(
    storage,
    "async function findReusableDataCreditoAssessment",
    "async function findRecentConsumedDataCreditoAssessment"
  );
  assert.match(reusable, /assessment\."documentHash" = \$1/);
  assert.match(reusable, /assessment\."providerEnvironment" = \$2/);
  const reusableWhere = reusable.slice(
    reusable.indexOf("WHERE "),
    reusable.indexOf("ORDER BY")
  );
  assert.doesNotMatch(
    reusableWhere,
    /assessment\."(?:aliadoId|sedeId|surnameHash|platform|policyRevisionId)"/
  );
  const canonicalOrder = reusable.slice(
    reusable.indexOf("ORDER BY"),
    reusable.indexOf("LIMIT 1")
  );
  assert.match(
    canonicalOrder,
    /root\."expiresAt" DESC[\s\S]*root\."createdAt" DESC[\s\S]*root\."id" DESC/
  );
  const reusableOrderStart = reusable.lastIndexOf("ORDER BY");
  const reusableOrder = reusable.slice(
    reusableOrderStart,
    reusable.indexOf("LIMIT 1", reusableOrderStart)
  );
  for (const field of [
    "surnameHash",
    "platform",
    "userId",
    "sellerId",
    "sedeId",
    "aliadoId",
    "policyRevisionId",
  ]) {
    assert.match(reusableOrder, new RegExp(`assessment\\."${field}"`));
  }

  const documentLock = section(
    storage,
    "function dataCreditoDocumentLockKey",
    "export async function reuseDataCreditoAssessment"
  );
  assert.match(
    documentLock,
    /"datacredito-document"[\s\S]*input\.providerEnvironment[\s\S]*input\.documentHash/
  );
  assert.doesNotMatch(documentLock, /aliadoId|sedeId|surnameHash|platform/);

  const legacyIndexes = section(
    setupSql,
    'CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_document_key"',
    'DROP INDEX IF EXISTS "DataCreditoAssessment_pending_global_key"'
  );
  assert.match(legacyIndexes, /COALESCE\("aliadoId", 0\)/);
  assert.doesNotMatch(
    legacyIndexes,
    /DROP INDEX IF EXISTS "DataCreditoAssessment_(?:pending_document_key|reuse_idx|reuse_environment_idx)"/
  );

  const globalIndexes = section(
    setupSql,
    'DROP INDEX IF EXISTS "DataCreditoAssessment_pending_global_key"',
    'CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_rate_idx"'
  );
  assert.match(globalIndexes, /CREATE UNIQUE INDEX "DataCreditoAssessment_pending_global_key"/);
  assert.match(globalIndexes, /"documentHash",\s*"providerEnvironment"\s*\)/);
  assert.match(
    globalIndexes,
    /"documentHash",\s*"providerEnvironment",\s*"expiresAt" DESC,\s*"createdAt" DESC/
  );
  assert.doesNotMatch(globalIndexes, /aliadoId|sedeId|surnameHash|platform/);
  assert.match(setupSql, /INTERVAL '6 minutes'/);
  assert.doesNotMatch(setupSql, /ROW_NUMBER\(\)|DUPLICATE_PENDING_GLOBAL/);
  const tableLock = setupSql.indexOf(
    'LOCK TABLE "DataCreditoAssessment" IN SHARE ROW EXCLUSIVE MODE'
  );
  const staleCleanup = setupSql.indexOf(
    "'PROVIDER_OUTCOME_AMBIGUOUS'",
    tableLock
  );
  const globalIndex = setupSql.indexOf('DROP INDEX IF EXISTS "DataCreditoAssessment_pending_global_key"');
  assert.ok(tableLock >= 0 && tableLock < staleCleanup && staleCleanup < globalIndex);
  assert.match(
    setupSql,
    /CREATE TRIGGER "DataCreditoAssessment_guard_pending_global"[\s\S]*BEFORE INSERT/
  );
  assert.match(
    setupSql,
    /'datacredito-document:' \|\| NEW\."providerEnvironment" \|\| ':' \|\|[\s\S]*NEW\."documentHash"/
  );
  assert.match(setupSql, /assessment\."status" = 'PENDING'/);
  assert.match(
    setupSql,
    /assessment\."status" IN \('APROBADO', 'RECHAZADO'\)[\s\S]*assessment\."expiresAt" > CURRENT_TIMESTAMP/
  );
  assert.match(setupSql, /ERRCODE = '23505'/);
  assert.match(
    setupSql,
    /CREATE TRIGGER "DataCreditoAssessment_guard_global_usage"[\s\S]*BEFORE UPDATE OF[\s\S]*"claimTokenHash"[\s\S]*"consumedAt"/
  );
  assert.match(setupSql, /finser_guard_datacredito_global_usage_v1/);
  assert.match(setupSql, /RETURN NULL;[\s\S]*Old runtimes|Old runtimes[\s\S]*RETURN NULL;/);
  assert.match(storage, /globalUsageGuardPresent/);
  assert.match(storage, /usage_guard\.tgtype = 19/);
  assert.match(storage, /pending_guard\.tgtype = 7/);
  assert.match(storage, /pending_guard\.tgenabled IN \('O', 'A'\)/);

  const legacyPendingExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(pendingIndex, {",
    "!matchesDataCreditoSchemaIndex(reuseIndex, {"
  );
  assert.match(legacyPendingExpectation, /COALESCE\("aliadoId", 0\)/);

  const legacyReuseExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(reuseIndex, {",
    "!matchesDataCreditoSchemaIndex(reuseEnvironmentIndex, {"
  );
  assert.match(legacyReuseExpectation, /COALESCE\("aliadoId", 0\)/);

  const legacyEnvironmentExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(reuseEnvironmentIndex, {",
    "!matchesDataCreditoSchemaIndex(pendingGlobalIndex, {"
  );
  assert.match(legacyEnvironmentExpectation, /COALESCE\("aliadoId", 0\)/);

  const pendingGlobalExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(pendingGlobalIndex, {",
    "!matchesDataCreditoSchemaIndex(reuseGlobalIndex, {"
  );
  assert.match(pendingGlobalExpectation, /column: "documentHash"/);
  assert.match(pendingGlobalExpectation, /column: "providerEnvironment"/);
  assert.doesNotMatch(pendingGlobalExpectation, /aliadoId|sedeId|surnameHash|platform/);

  const reuseGlobalExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(reuseGlobalIndex, {",
    "!matchesDataCreditoSchemaIndex(reuseEnvironmentGlobalIndex, {"
  );
  for (const field of ["documentHash", "expiresAt", "createdAt"]) {
    assert.match(reuseGlobalExpectation, new RegExp(`column: "${field}"`));
  }
  assert.doesNotMatch(
    reuseGlobalExpectation,
    /aliadoId|providerEnvironment|sedeId|surnameHash|platform/
  );

  const reuseEnvironmentGlobalExpectation = section(
    storage,
    "!matchesDataCreditoSchemaIndex(reuseEnvironmentGlobalIndex, {",
    "!matchesDataCreditoSchemaIndex(secureKeyNonceIndex, {"
  );
  for (const field of [
    "documentHash",
    "providerEnvironment",
    "expiresAt",
    "createdAt",
  ]) {
    assert.match(
      reuseEnvironmentGlobalExpectation,
      new RegExp(`column: "${field}"`)
    );
  }
  assert.doesNotMatch(
    reuseEnvironmentGlobalExpectation,
    /aliadoId|sedeId|surnameHash|platform/
  );
  assert.match(storage, /DataCreditoAssessment_guard_pending_global/);
  assert.match(storage, /finser_guard_datacredito_pending_global/);
  const earlyReuse = section(
    storage,
    "export async function reuseDataCreditoAssessment",
    "async function countRecentDataCreditoAssessments"
  );
  const earlyPending = earlyReuse.match(
    /SELECT "id"[\s\S]*?WHERE "status" = 'PENDING'[\s\S]*?LIMIT 1/
  )?.[0];
  assert.ok(earlyPending);
  assert.match(earlyPending, /"documentHash" = \$\d+/);
  assert.match(earlyPending, /"providerEnvironment" = \$\d+/);
  assert.doesNotMatch(earlyPending, /aliadoId|sedeId|surnameHash|platform/);

  const reserve = section(
    storage,
    "export async function reserveDataCreditoAssessment",
    "export async function completeDataCreditoAssessment"
  );
  const actorLock = reserve.search(/actorLockKey\r?\n\s*\);/);
  const documentLockPosition = reserve.search(/documentLockKey\r?\n\s*\);/);
  assert.ok(actorLock >= 0 && actorLock < documentLockPosition);
  assert.doesNotMatch(reserve, /lockKeys|\.sort\(\)/);

  const activePending = reserve.match(
    /SELECT "id"[\s\S]*?WHERE "status" = 'PENDING'[\s\S]*?LIMIT 1/
  )?.[0];
  assert.ok(activePending);
  assert.match(activePending, /"documentHash" = \$\d+/);
  assert.match(activePending, /"providerEnvironment" = \$\d+/);
  assert.doesNotMatch(activePending, /aliadoId|sedeId|surnameHash|platform/);
});

test("repetir conserva la consulta raiz y aplica la revision vigente de destino", () => {
  const clone = section(
    storage,
    "async function cloneReusableDataCreditoAssessment",
    "async function tryReuseDataCreditoAssessment"
  );
  assert.match(clone, /currentPolicy/);
  assert.match(clone, /resolveDataCreditoDecision\([\s\S]*?currentPolicy,[\s\S]*?input\.platform/);
  assert.match(clone, /input\.surnameHash/);
  assert.match(clone, /input\.platform/);
  assert.match(clone, /input\.policyVersion/);
  assert.match(clone, /input\.policyRevisionId/);
  for (const targetScopeField of [
    "input.userId",
    "input.sellerId",
    "input.sedeId",
    "input.aliadoId",
  ]) {
    assert.ok(clone.includes(targetScopeField), `Falta scope destino: ${targetScopeField}`);
  }
  assert.match(clone, /source\."score"/);
  assert.doesNotMatch(clone, /historicalPolicy|source\."policyRevisionId"/);
  assert.match(clone, /source\."expiresAt", source\."retainedUntil"/);
  assert.match(clone, /"reusedFromAssessmentId"/);
  assert.match(clone, /readReusableDataCreditoRiskContext/);
  assert.match(clone, /telcoDelinquentBalanceCop/);
  assert.match(clone, /telcoDelinquencyInformationAvailable/);
  assert.match(clone, /totalDelinquentBalanceCop/);
  assert.match(clone, /totalDelinquencyInformationAvailable/);
  assert.match(clone, /telcoPriorityRuleEnabled/);
  assert.match(clone, /totalPriorityRuleEnabled/);
  assert.match(clone, /reusableTelcoRiskMetricUnavailable/);
  assert.match(clone, /reusableTotalRiskMetricUnavailable/);
  assert.doesNotMatch(clone, /queryDataCreditoNaturalPerson/);
  assert.match(storage, /DataCreditoAssessmentSecurePayload/);
  assert.match(storage, /decryptDataCreditoSecureRecord/);
  assert.match(storage, /riskSummary\?\.telcos\.delinquentBalance/);
  assert.match(storage, /riskSummary\?\.totals\?\.delinquentBalance/);
  assert.match(storage, /No se realizo una nueva consulta/);
  assert.match(storage, /TELCO_RISK_METRIC_UNAVAILABLE/);
  assert.match(storage, /TOTAL_DELINQUENCY_RISK_METRIC_UNAVAILABLE/);
  assert.match(setupSql, /TOTAL_DELINQUENCY_RISK_METRIC_UNAVAILABLE/);
  assert.match(storage, /JSON\.stringify\(\{ bands, financialSettings, priorityRules \}\)/);
  assert.match(adminStorage, /priorityRules:\s*payload\.priorityRules/);
  assert.match(adminStorage, /parseDataCreditoPolicyPriorityRules/);
});

test("una reutilizacion termina antes del unico consumo facturable", () => {
  const cachedReuse = section(
    evaluationRoute,
    'if (cached?.kind === "REUSED")',
    'if (cached?.kind === "ALREADY_CONSUMED")'
  );
  assert.match(cachedReuse, /return NextResponse\.json/);
  assert.doesNotMatch(cachedReuse, /queryDataCreditoNaturalPerson/);

  const reservedReuse = section(
    evaluationRoute,
    'if (reservation.kind === "REUSED")',
    'if (reservation.kind === "ALREADY_CONSUMED")'
  );
  assert.match(reservedReuse, /return NextResponse\.json/);
  assert.doesNotMatch(reservedReuse, /queryDataCreditoNaturalPerson/);
  assert.equal(
    evaluationRoute.match(/await queryDataCreditoNaturalPerson\(/g)?.length,
    1
  );
});

test("reintentos del mismo scope devuelven el assessment existente sin crecer filas", () => {
  assert.match(storage, /dataCreditoAssessmentHasCurrentIdentityAndScope/);
  assert.match(storage, /row\.policyRevisionId === input\.policyRevisionId/);
  assert.match(
    storage,
    /if \(dataCreditoAssessmentHasCurrentIdentityAndScope\(reusable, input\)\) \{[\s\S]*?assessment: reusable/
  );
  const lookup = section(
    storage,
    "async function findReusableDataCreditoAssessment",
    "async function findRecentConsumedDataCreditoAssessment"
  );
  const lookupOrderStart = lookup.lastIndexOf("ORDER BY");
  const lookupOrder = lookup.slice(
    lookupOrderStart,
    lookup.indexOf("LIMIT 1", lookupOrderStart)
  );
  for (const field of [
    "surnameHash",
    "platform",
    "userId",
    "sellerId",
    "sedeId",
    "aliadoId",
    "policyRevisionId",
  ]) {
    assert.match(lookupOrder, new RegExp(`assessment\\."${field}"`));
  }
});

test("un apellido distinto bloquea el cache global sin consultar ni crear un clon", () => {
  const lookup = section(
    storage,
    "async function findReusableDataCreditoAssessment",
    "async function findRecentConsumedDataCreditoAssessment"
  );
  assert.match(lookup, /root\."surnameHash"/);
  assert.match(lookup, /canonicalRootSurnameHash/);

  const reuse = section(
    storage,
    "async function tryReuseDataCreditoAssessment",
    "function dataCreditoDocumentLockKey"
  );
  const mismatch = reuse.indexOf("reusable.canonicalRootSurnameHash !== input.surnameHash");
  const clone = reuse.indexOf("cloneReusableDataCreditoAssessment");
  assert.ok(mismatch >= 0 && mismatch < clone);
  assert.match(reuse, /kind: "IDENTITY_MISMATCH"/);
  assert.equal(evaluationRoute.match(/code: "ASSESSMENT_IDENTITY_MISMATCH"/g)?.length, 2);
  assert.ok(
    evaluationRoute.indexOf('cached?.kind === "IDENTITY_MISMATCH"') <
      evaluationRoute.indexOf("queryDataCreditoNaturalPerson({")
  );
});

test("cambiar Android a iPhone recalcula la oferta historica sin consultar", () => {
  const bands = parseDataCreditoPolicyBands([
    { id: "a-none", platform: "ANDROID", scoreMin: -1, scoreMax: -1, decision: "RECHAZADO", initialPaymentPercentage: 0, suretyPercentage: 0, maxFinancedAmount: 1 },
    { id: "a", platform: "ANDROID", scoreMin: 0, scoreMax: 950, decision: "APROBADO", initialPaymentPercentage: 30, suretyPercentage: 80, maxFinancedAmount: 850000 },
    { id: "i-none", platform: "IPHONE", scoreMin: -1, scoreMax: -1, decision: "RECHAZADO", initialPaymentPercentage: 0, suretyPercentage: 0, maxFinancedAmount: 1 },
    { id: "i", platform: "IPHONE", scoreMin: 0, scoreMax: 950, decision: "APROBADO", initialPaymentPercentage: 5, suretyPercentage: 40, maxFinancedAmount: 2200000 },
  ]);
  const historicalPolicy = { version: 8, bands };
  assert.equal(
    resolveDataCreditoDecision(historicalPolicy, "ANDROID", 700).offer
      .initialPaymentPercentage,
    30
  );
  assert.equal(
    resolveDataCreditoDecision(historicalPolicy, "IPHONE", 700).offer
      .initialPaymentPercentage,
    5
  );

  const reuseStart = evaluationRoute.indexOf("reuseDataCreditoAssessment({");
  const providerCall = evaluationRoute.indexOf("queryDataCreditoNaturalPerson({");
  assert.ok(reuseStart >= 0 && reuseStart < providerCall);
  const reuseInput = evaluationRoute.slice(
    reuseStart,
    evaluationRoute.indexOf("if (cached?.kind", reuseStart)
  );
  assert.match(reuseInput, /policyVersion:\s*policy\.version/);
  assert.match(reuseInput, /policyRevisionId:\s*policy\.revisionId/);
});

test("vigencia exacta de 15 dias no es deslizable ni heredable del env historico", () => {
  assert.match(
    storage,
    /DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES = 21_600/
  );
  const ttlGetter = section(
    storage,
    "export function getDataCreditoAssessmentTtlMinutes",
    "export function getDataCreditoRetentionDays"
  );
  assert.match(ttlGetter, /return DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES/);
  assert.doesNotMatch(ttlGetter, /process\.env|readBoundedInteger/);
  const rootBackfill = section(
    setupSql,
    '-- The root owns the contractual 15-day clock.',
    'UPDATE "DataCreditoAssessment" clone'
  );
  assert.match(rootBackfill, /root\."reusedFromAssessmentId" IS NULL/);
  assert.match(rootBackfill, /root\."createdAt" \+ INTERVAL '15 days'/);
  const cloneBackfill = section(
    setupSql,
    'UPDATE "DataCreditoAssessment" clone',
    'UPDATE "DataCreditoAssessment" assessment'
  );
  assert.match(cloneBackfill, /root\."expiresAt"/);
  assert.doesNotMatch(cloneBackfill, /clone\."createdAt" \+ INTERVAL '15 days'/);
  assert.match(setupSql, /"createdAt" \+ INTERVAL '15 days'/);
  assert.doesNotMatch(setupSql, /CURRENT_TIMESTAMP \+ INTERVAL '15 days'[\s\S]*APROBADO/);
  assert.match(storage, /assessment\."expiresAt" > CURRENT_TIMESTAMP/);

  const created = Date.UTC(2026, 7, 1);
  const expiry = created + 21_600 * 60_000;
  assert.ok(created + 14 * 86_400_000 < expiry);
  assert.equal(created + 15 * 86_400_000, expiry);
});

test("una oferta consumida vigente bloquea antes del proveedor sin renovar los 15 dias", () => {
  const consumedLookup = section(
    storage,
    "async function findRecentConsumedDataCreditoAssessment",
    "function dataCreditoAssessmentHasCurrentIdentityAndScope"
  );
  assert.match(consumedLookup, /assessment\."documentHash" = \$1/);
  assert.match(consumedLookup, /assessment\."providerEnvironment" = \$2/);
  assert.doesNotMatch(consumedLookup, /aliadoId|sedeId|surnameHash|platform/);
  assert.match(consumedLookup, /assessment\."expiresAt" > CURRENT_TIMESTAMP/);
  assert.match(consumedLookup, /assessment\."consumedAt" IS NOT NULL/);
  assert.doesNotMatch(consumedLookup, /CURRENT_TIMESTAMP \+|INTERVAL '15 days'/);

  const earlyReuse = section(
    storage,
    "export async function reuseDataCreditoAssessment",
    "async function countRecentDataCreditoAssessments"
  );
  const consumedGuard = earlyReuse.indexOf("findRecentConsumedDataCreditoAssessment");
  const reusableAttempt = earlyReuse.indexOf("tryReuseDataCreditoAssessment");
  const pendingLookup = earlyReuse.indexOf('SELECT "id" FROM "DataCreditoAssessment"');
  assert.ok(
    consumedGuard >= 0 &&
      consumedGuard < reusableAttempt &&
      reusableAttempt < pendingLookup
  );
  assert.match(earlyReuse, /kind: "ALREADY_CONSUMED"/);

  const reserve = section(
    storage,
    "export async function reserveDataCreditoAssessment",
    "export async function completeDataCreditoAssessment"
  );
  assert.ok(
    reserve.indexOf("findRecentConsumedDataCreditoAssessment") <
      reserve.indexOf("tryReuseDataCreditoAssessment")
  );
  assert.ok(
    reserve.indexOf("tryReuseDataCreditoAssessment") <
      reserve.indexOf("insertPendingDataCreditoAssessment")
  );

  const reuseCall = evaluationRoute.indexOf("reuseDataCreditoAssessment({");
  const consumedResponse = evaluationRoute.indexOf('cached?.kind === "ALREADY_CONSUMED"');
  const providerCall = evaluationRoute.indexOf("queryDataCreditoNaturalPerson({");
  assert.ok(reuseCall >= 0 && reuseCall < consumedResponse && consumedResponse < providerCall);
  assert.equal(evaluationRoute.match(/code: "ASSESSMENT_ALREADY_CONSUMED"/g)?.length, 2);
});

test("un resultado pagado ambiguo queda bloqueado sin una segunda consulta", () => {
  const reviewGuard = section(
    storage,
    "async function hasRecentDataCreditoReviewBlock",
    "function dataCreditoAssessmentHasCurrentIdentityAndScope"
  );
  assert.match(reviewGuard, /assessment\."durationMs" IS NOT NULL/);
  assert.match(reviewGuard, /PROVIDER_OUTCOME_AMBIGUOUS/);
  assert.doesNotMatch(reviewGuard, /aliadoId|sedeId|surnameHash|platform/);

  const earlyReuse = section(
    storage,
    "export async function reuseDataCreditoAssessment",
    "async function countRecentDataCreditoAssessments"
  );
  assert.ok(
    earlyReuse.indexOf("hasRecentDataCreditoReviewBlock") <
      earlyReuse.indexOf("tryReuseDataCreditoAssessment")
  );
  const reserve = section(
    storage,
    "export async function reserveDataCreditoAssessment",
    "export async function completeDataCreditoAssessment"
  );
  assert.match(reserve, /"errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS'/);
  assert.ok(
    reserve.indexOf("hasRecentDataCreditoReviewBlock") <
      reserve.indexOf("insertPendingDataCreditoAssessment")
  );
  assert.match(evaluationRoute, /providerStartedAt[\s\S]*PROVIDER_OUTCOME_AMBIGUOUS/);
  assert.equal(evaluationRoute.match(/code: "ASSESSMENT_REQUIRES_REVIEW"/g)?.length, 2);
  assert.match(setupSql, /NEW\."errorCode" := 'PROVIDER_OUTCOME_AMBIGUOUS'/);
});

test("claim y consumo bloquean globalmente sin exponer creditos entre aliados", () => {
  const claim = section(
    storage,
    "export async function claimDataCreditoAssessment",
    "async function consumeDataCreditoAssessmentInTransaction"
  );
  assert.match(claim, /dataCreditoDocumentLockKey\(target\)/);
  assert.doesNotMatch(claim, /datacredito-assessment-group/);
  assert.match(claim, /consumed\."documentHash" = target\."documentHash"/);
  assert.match(claim, /claimed\."providerEnvironment" = target\."providerEnvironment"/);
  for (const targetPredicate of [
    'target."surnameHash" = $3',
    'target."platform" = $4',
    'target."userId" = $6',
    'target."sellerId" IS NOT DISTINCT FROM $7',
    'target."sedeId" = $8',
    'target."aliadoId" IS NOT DISTINCT FROM $9',
  ]) {
    assert.ok(claim.includes(targetPredicate), `Falta match destino: ${targetPredicate}`);
  }

  const consume = section(
    storage,
    "async function consumeDataCreditoAssessmentInTransaction",
    "export async function consumeDataCreditoAssessment"
  );
  assert.match(consume, /dataCreditoDocumentLockKey\(target\)/);
  assert.match(consume, /consumed\."documentHash" = target\."documentHash"/);
  assert.match(consume, /claimed\."id" <> target\."id"/);
  const consumeUpdate = consume.slice(
    consume.lastIndexOf('UPDATE "DataCreditoAssessment"'),
    consume.lastIndexOf("RETURNING *")
  );
  assert.match(consumeUpdate, /WHERE "id" = \$1/);
  assert.match(consumeUpdate, /"consumedAt" = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(consumeUpdate, /reusedFromAssessmentId|documentHash|providerEnvironment/);
});
test("produccion bloquea DEMO antes del cache pero cachea antes de credenciales y proveedor", () => {
  const guard = evaluationRoute.indexOf('process.env.NODE_ENV === "production"');
  const reuse = evaluationRoute.indexOf("reuseDataCreditoAssessment({");
  const configured = evaluationRoute.indexOf("if (!provider.configured)");
  const provider = evaluationRoute.indexOf("queryDataCreditoNaturalPerson({");
  assert.ok(guard >= 0 && guard < reuse);
  assert.ok(reuse < configured);
  assert.ok(configured < provider);
});

test("el detalle admin abre el expediente del inquiry raiz sin duplicar cifrado", () => {
  assert.match(adminStorage, /assessment\."reusedFromAssessmentId"/);
  assert.match(adminStorage, /COALESCE\(origin\."id", assessment\."id"\)/);
  assert.match(adminStorage, /secureAssessmentId/);
  assert.match(adminStorage, /secureCorrelationId/);
});
