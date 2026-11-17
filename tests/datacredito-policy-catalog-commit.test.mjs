import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module: vmModule, exports: vmModule.exports, Request, Response, console: { error() {} },
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name]; },
  });
  return vmModule.exports;
}

const policy = load("lib/datacredito/policy.ts");
const policyId = "00000000-0000-4000-8000-000000000002";
const previousPolicyId = "00000000-0000-4000-8000-000000000001";
const deletionResult = { policyId, currentVersion: 3, alreadyRetired: false,
  preservedRevisionCount: 3, preservedAssignmentAuditCount: 2, preservedAssessmentCount: 4 };
const catalog = { profiles: [{ id: policyId, version: 3 }], allies: [{ id: 8, policyId }] };
const financialSettings = policy.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS;
const bands = ["ANDROID", "IPHONE"].flatMap(platform => [-1, 0].map(scoreMin => ({
  id: `${platform}-${scoreMin}`, platform, scoreMin, scoreMax: scoreMin < 0 ? -1 : 950,
  decision: "APROBADO", initialPaymentPercentage: 30, suretyPercentage: 75,
  maxFinancedAmount: 2_000_000, installmentCount: 24, maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null,
})));
const priorityRules = { telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 100_000, IPHONE: 100_000 } },
  totalDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 100_000, IPHONE: 100_000 } } };
class NameConflict extends Error {}
class VersionConflict extends Error { currentVersion = 4; }
class AssignmentConflict extends Error { currentPolicyId = previousPolicyId; }
class QuotaConflict extends Error { currentDailyQueryLimit = 8; }
class QuotaValidation extends Error {}
class BranchQuotaConflict extends Error {}
class BranchQuotaValidation extends Error {}
class DeleteVersionConflict extends Error { currentVersion = 4; }
class StorageConfiguration extends Error { code = "TEST_STORAGE_NOT_READY"; }
class ProfileNotFound extends Error {}
class PolicyNotFound extends Error {}
class DeleteDefault extends Error {}
class DeleteAssigned extends Error {}
class DeleteNotFound extends Error {}

const cases = [
  { operation: "CREATE_POLICY", method: "POST", status: 201,
    body: { name: "Política de prueba", bands, financialSettings, priorityRules },
    extra: { createdPolicyId: policyId }, conflict: new NameConflict("Nombre ocupado"), code: "POLICY_NAME_CONFLICT" },
  { operation: "SAVE_REVISION", method: "PATCH", status: 200,
    body: { action: "SAVE_REVISION", policyId, expectedVersion: 3, bands, financialSettings, priorityRules },
    extra: { updatedPolicyId: policyId }, conflict: new VersionConflict("Versión distinta"), code: "POLICY_VERSION_CONFLICT" },
  { operation: "ASSIGN_ALLY", method: "PATCH", status: 200,
    body: { action: "ASSIGN_ALLY", allyId: 8, policyId, expectedPolicyId: previousPolicyId },
    extra: { assignedAllyId: 8 }, conflict: new AssignmentConflict("Asignación distinta"), code: "POLICY_ASSIGNMENT_CONFLICT" },
  { operation: "SET_ALLY_DAILY_QUOTA", method: "PATCH", status: 200,
    body: { action: "SET_ALLY_DAILY_QUOTA", allyId: 8, dailyQueryLimit: 10, expectedDailyQueryLimit: 5 },
    extra: { dailyQuotaUpdatedAllyId: 8 }, conflict: new QuotaConflict("Cupo distinto"), code: "ALLY_DAILY_QUERY_LIMIT_CONFLICT" },
  { operation: "RETIRE_POLICY", method: "DELETE", status: 200,
    body: { policyId, expectedVersion: 3 }, extra: { deletionMode: "RETIRED", policy: deletionResult },
    conflict: new DeleteVersionConflict("Versión distinta"), code: "POLICY_DELETE_VERSION_CONFLICT" },
];

function fixture({ catalogError = null, mutationError = null, providerError = null, auditError = null,
  access = { ok: true, user: { id: 7 } } } = {}) {
  const mutations = [];
  const committed = [];
  let catalogReads = 0;
  let currentCatalogError = catalogError;
  function mutate(operation, result) {
    return async input => {
      mutations.push({ operation, input });
      if (mutationError) throw mutationError;
      committed.push(operation);
      return result;
    };
  }
  const route = load("app/api/creditos/datacredito/politicas/route.ts", {
    "node:crypto": { randomUUID },
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => {
      if (providerError) throw providerError;
      return { enabled: true, configured: true, environment: "production", productionReady: true };
    } },
    "@/lib/datacredito/admin-access": { getDataCreditoCentralAdmin: async () => access },
    "@/lib/datacredito/policy": policy,
    "@/lib/datacredito/admin-storage": {
      assignDataCreditoPolicyToAlly: mutate("ASSIGN_ALLY"),
      createDataCreditoPolicyProfile: mutate("CREATE_POLICY", policyId),
      setDataCreditoDailyQueryLimitForAlly: mutate("SET_ALLY_DAILY_QUOTA"),
      listDataCreditoPolicyCatalog: async () => { catalogReads += 1; if (currentCatalogError) throw currentCatalogError; return catalog; },
      parseDataCreditoDailyQueryLimit: value => {
        if (value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 10_000)) return value;
        throw new QuotaValidation("Cupo inválido");
      },
      DataCreditoDailyQueryLimitConflictError: QuotaConflict,
      DataCreditoDailyQueryLimitValidationError: QuotaValidation,
      DataCreditoBranchDailyQuotaConflictError: BranchQuotaConflict,
      DataCreditoBranchDailyQuotaValidationError: BranchQuotaValidation,
      DataCreditoPolicyAssignmentConflictError: AssignmentConflict,
      DataCreditoPolicyProfileNameConflictError: NameConflict,
      DataCreditoPolicyProfileNotFoundError: ProfileNotFound,
    },
    "@/lib/datacredito/storage": {
      createDataCreditoPolicyRevision: mutate("SAVE_REVISION"),
      isDataCreditoAuditConfigured: () => { if (auditError) throw auditError; return true; },
      DataCreditoPolicyConflictError: VersionConflict,
      DataCreditoPolicyNotFoundError: PolicyNotFound,
      DataCreditoStorageConfigurationError: StorageConfiguration,
    },
    "@/lib/datacredito/policy-deletion": {
      retireDataCreditoPolicyProfile: mutate("RETIRE_POLICY", deletionResult),
      DataCreditoPolicyDeleteAssignedError: DeleteAssigned,
      DataCreditoPolicyDeleteDefaultError: DeleteDefault,
      DataCreditoPolicyDeleteNotFoundError: DeleteNotFound,
      DataCreditoPolicyDeleteVersionConflictError: DeleteVersionConflict,
    },
  });
  return { mutations, committed, get catalogReads() { return catalogReads; },
    recoverCatalog() { currentCatalogError = null; },
    async request({ method = "GET", body } = {}) {
      const response = await route[method](new Request("https://finserpay.test/api/creditos/datacredito/politicas", {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }));
      return { status: response.status, headers: response.headers, data: await response.json() };
    },
  };
}

test("cada mutación confirmada conserva su éxito si falla recargar el catálogo y permite recuperar con GET sin repetirla", async () => {
  for (const item of cases) {
    const f = fixture({ catalogError: new Error("private database detail") });
    const result = await f.request(item);
    assert.equal(result.status, item.status, item.operation);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.operationCommitted, true);
    assert.equal(result.data.catalogReloadRequired, true);
    assert.equal(result.data.code, "POLICY_CATALOG_REFRESH_FAILED");
    assert.equal(result.data.committedOperation, item.operation);
    assert.match(result.data.message, /quedó guardado.*listado/);
    assert.match(result.data.correlationId, /^[a-f0-9-]{36}$/);
    for (const [key, value] of Object.entries(item.extra)) assert.deepEqual(result.data[key], value);
    assert.equal(result.data.profiles, undefined, "No simula un catálogo vacío");
    assert.equal(result.data.allies, undefined);
    assert.equal(result.data.error, undefined);
    assert.doesNotMatch(JSON.stringify(result.data), /private database detail/);
    assert.match(result.headers.get("Cache-Control"), /no-store/);
    assert.deepEqual(f.committed, [item.operation]);
    assert.equal(f.mutations.length, 1);
    f.recoverCatalog();
    const recovered = await f.request();
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.data.profiles, catalog.profiles);
    assert.equal(recovered.data.operationCommitted, undefined);
    assert.equal(f.mutations.length, 1, "GET recupera sin reejecutar la operación");
  }
});

test("el catálogo normal y las mutaciones completas mantienen su contrato existente", async () => {
  for (const item of cases) {
    const f = fixture();
    const result = await f.request(item);
    assert.equal(result.status, item.status);
    assert.equal(result.data.ok, true);
    assert.deepEqual(result.data.profiles, catalog.profiles);
    assert.deepEqual(result.data.allies, catalog.allies);
    for (const [key, value] of Object.entries(item.extra)) assert.deepEqual(result.data[key], value);
    assert.equal(result.data.operationCommitted, undefined);
    assert.equal(result.data.catalogReloadRequired, undefined);
    assert.deepEqual(f.committed, [item.operation]);
  }
});

test("un conflicto de la mutación sigue siendo 409 sin marcador de commit ni lectura del catálogo", async () => {
  for (const item of cases) {
    const f = fixture({ mutationError: item.conflict });
    const result = await f.request(item);
    assert.equal(result.status, 409);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.code, item.code);
    assert.equal(result.data.operationCommitted, undefined);
    assert.equal(result.data.catalogReloadRequired, undefined);
    assert.deepEqual(f.committed, []);
    assert.equal(f.catalogReads, 0);
  }
});

test("fallos de escritura o validación conservan 500/400 y nunca se anuncian como guardados", async () => {
  const failedWrite = fixture({ mutationError: new Error("write failed") });
  const failure = await failedWrite.request(cases[0]);
  assert.equal(failure.status, 500);
  assert.equal(failure.data.code, "POLICY_CATALOG_ERROR");
  assert.equal(failure.data.operationCommitted, undefined);
  assert.equal(failedWrite.catalogReads, 0);
  assert.deepEqual(failedWrite.committed, []);
  for (const invalid of [
    { method: "POST", body: { ...cases[0].body, name: "" } },
    { method: "PATCH", body: { action: "SAVE_REVISION", policyId: "invalid", expectedVersion: 3 } },
    { method: "PATCH", body: { ...cases[1].body, expectedVersion: 0 } },
    { method: "PATCH", body: { ...cases[3].body, dailyQueryLimit: -1 } },
    { method: "DELETE", body: { ...cases[4].body, expectedVersion: 0 } },
  ]) {
    const f = fixture();
    const result = await f.request(invalid);
    assert.equal(result.status, 400);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.operationCommitted, undefined);
    assert.equal(f.mutations.length, 0);
    assert.equal(f.catalogReads, 0);
  }
});

test("el contexto postcommit domina la clasificación del error posterior del catálogo o proveedor", async () => {
  for (const input of [{ catalogError: new NameConflict("catalog parse failed") },
    { providerError: new Error("provider config failed") }, { auditError: new StorageConfiguration("audit unavailable") },
    { catalogError: new Error("catalog failed"), providerError: new Error("provider failed") }]) {
    const f = fixture(input);
    const result = await f.request(cases[0]);
    assert.equal(result.status, 201);
    assert.equal(result.data.operationCommitted, true);
    assert.equal(result.data.code, "POLICY_CATALOG_REFRESH_FAILED");
    assert.equal(f.mutations.length, 1);
  }
});

test("GET fallido conserva 500 normal y los accesos 401/403 no mutan ni leen catálogo", async () => {
  const f = fixture({ catalogError: new Error("catalog unavailable") });
  const result = await f.request();
  assert.equal(result.status, 500);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.code, "POLICY_CATALOG_ERROR");
  assert.equal(result.data.operationCommitted, undefined);
  assert.equal(f.mutations.length, 0);
  for (const status of [401, 403]) {
    const denied = fixture({ access: { ok: false, status } });
    for (const item of [{ method: "GET" }, ...cases]) assert.equal((await denied.request(item)).status, status);
    assert.equal(denied.mutations.length, 0);
    assert.equal(denied.catalogReads, 0);
  }
});
