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

const [schema, setupSql, storage, adminStorage, evaluationRoute, catalogRoute] =
  await Promise.all([
    readProjectFile("prisma/schema.prisma"),
    readProjectFile("scripts/setup-datacredito.sql"),
    readProjectFile("lib/datacredito/storage.ts"),
    readProjectFile("lib/datacredito/admin-storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile("app/api/creditos/datacredito/politicas/route.ts"),
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
});

test("la llave anticonsulta es cedula, ambiente y aliado, no apellido ni plataforma", () => {
  const reusable = section(
    storage,
    "async function findReusableDataCreditoAssessment",
    "async function hasActiveClaimForDataCreditoAssessmentGroup"
  );
  assert.match(reusable, /assessment\."documentHash" = \$1/);
  assert.match(reusable, /assessment\."providerEnvironment" = \$2/);
  assert.match(reusable, /assessment\."aliadoId" IS NOT DISTINCT FROM \$3/);
  const reusableWhere = reusable.slice(
    reusable.indexOf("WHERE "),
    reusable.indexOf("ORDER BY")
  );
  assert.doesNotMatch(reusableWhere, /assessment\."surnameHash"/);
  assert.doesNotMatch(reusableWhere, /assessment\."platform"/);
  assert.match(reusable, /ORDER BY \([\s\S]*assessment\."surnameHash" = \$4/);
  assert.match(reusable, /assessment\."platform" = \$5/);

  const documentLock = section(
    storage,
    "function dataCreditoDocumentLockKey",
    "export async function reuseDataCreditoAssessment"
  );
  assert.match(documentLock, /documentHash/);
  assert.match(documentLock, /providerEnvironment/);
  assert.match(documentLock, /aliadoId/);
  assert.doesNotMatch(documentLock, /surnameHash|platform/);

  const pendingIndex = section(
    setupSql,
    'CREATE UNIQUE INDEX "DataCreditoAssessment_pending_document_key"',
    'DROP INDEX IF EXISTS "DataCreditoAssessment_reuse_idx"'
  );
  assert.match(pendingIndex, /"documentHash", "providerEnvironment", COALESCE\("aliadoId", 0\)/);
  assert.doesNotMatch(pendingIndex, /surnameHash|platform/);
});

test("repetir registra un assessment actual y conserva vencimiento y revision del origen", () => {
  const clone = section(
    storage,
    "async function cloneReusableDataCreditoAssessment",
    "async function tryReuseDataCreditoAssessment"
  );
  assert.match(clone, /historicalPolicy/);
  assert.match(clone, /resolveDataCreditoDecision\(historicalPolicy, input\.platform/);
  assert.match(clone, /input\.surnameHash/);
  assert.match(clone, /input\.platform/);
  assert.match(clone, /source\."policyRevisionId"/);
  assert.match(clone, /source\."expiresAt", source\."retainedUntil"/);
  assert.match(clone, /"reusedFromAssessmentId"/);
  assert.doesNotMatch(clone, /SecurePayload|ciphertext/);
});

test("reintentos del mismo scope devuelven el assessment existente sin crecer filas", () => {
  assert.match(storage, /dataCreditoAssessmentHasCurrentIdentityAndScope/);
  assert.match(
    storage,
    /if \(dataCreditoAssessmentHasCurrentIdentityAndScope\(reusable, input\)\) \{[\s\S]*?assessment: reusable/
  );
  const lookup = section(
    storage,
    "async function findReusableDataCreditoAssessment",
    "function dataCreditoAssessmentHasCurrentIdentityAndScope"
  );
  assert.match(lookup, /assessment\."surnameHash" = \$4/);
  assert.match(lookup, /assessment\."platform" = \$5/);
  assert.match(lookup, /assessment\."userId" = \$6/);
  assert.match(lookup, /assessment\."sellerId" IS NOT DISTINCT FROM \$7/);
  assert.match(lookup, /assessment\."sedeId" = \$8/);
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
  assert.match(setupSql, /"createdAt" \+ INTERVAL '15 days'/);
  assert.doesNotMatch(setupSql, /CURRENT_TIMESTAMP \+ INTERVAL '15 days'[\s\S]*APROBADO/);
  assert.match(storage, /assessment\."expiresAt" > CURRENT_TIMESTAMP/);

  const created = Date.UTC(2026, 7, 1);
  const expiry = created + 21_600 * 60_000;
  assert.ok(created + 14 * 86_400_000 < expiry);
  assert.equal(created + 15 * 86_400_000, expiry);
});

test("claim y consumo bloquean todo el grupo para impedir doble credito", () => {
  const claim = section(
    storage,
    "export async function claimDataCreditoAssessment",
    "async function consumeDataCreditoAssessmentInTransaction"
  );
  assert.match(claim, /datacredito-assessment-group/);
  assert.match(claim, /NOT EXISTS[\s\S]*consumed\."consumedAt" IS NOT NULL/);
  assert.match(claim, /NOT EXISTS[\s\S]*claimed\."claimExpiresAt" > CURRENT_TIMESTAMP/);

  const consume = section(
    storage,
    "async function consumeDataCreditoAssessmentInTransaction",
    "export async function consumeDataCreditoAssessment"
  );
  assert.match(consume, /datacredito-assessment-group/);
  assert.match(consume, /\("id" = \$1 OR "reusedFromAssessmentId" = \$1\)/);
  assert.match(consume, /"consumedAt" = CURRENT_TIMESTAMP/);
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
