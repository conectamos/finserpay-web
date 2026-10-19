import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: vmModule, exports: vmModule.exports, URL, Request, Response, console,
    fetch: () => assert.fail("La simulación no debe consultar proveedores"),
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return vmModule.exports;
}

const policy = load("lib/datacredito/policy.ts");
const roles = load("lib/roles.ts");
const allies = load("lib/aliados.ts");
const policyAccess = load("lib/datacredito/policy-access.ts");
const operationAccess = load("lib/solicitud-operation-access.ts");
const central = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoId: 1 };
const allyAdmin = { id: 2, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoId: 2 };

function createPolicy(allyId, decision = "APROBADO") {
  return {
    version: allyId + 3,
    revisionId: `revision-${allyId}`,
    createdAt: "2026-10-18T05:00:00.000Z",
    financialSettings: policy.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS,
    priorityRules: {
      telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 100_000, IPHONE: 200_000 } },
    },
    bands: ["ANDROID", "IPHONE"].map((platform) => ({
      id: `${allyId}-${platform}`, platform, scoreMin: -1, scoreMax: -1, decision,
      initialPaymentPercentage: 30, suretyPercentage: 75,
      maxFinancedAmount: allyId * 1_000_000, installmentCount: 24,
      maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null,
    })),
  };
}

function fixture({ user = allyAdmin, enabled = true, assignedPolicy = createPolicy(user?.aliadoId || 2) } = {}) {
  const reads = [];
  const unavailable = () => assert.fail("La simulación no debe consultar cupos, expedientes ni modificar configuración");
  const route = load("app/api/creditos/datacredito/politica/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": allies,
    "@/lib/roles": roles,
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled, configured: true }) },
    "@/lib/datacredito/policy-access": policyAccess,
    "@/lib/datacredito/policy": policy,
    "@/lib/credit-settings": { getCreditSettings: unavailable },
    "@/lib/seller-auth": { getSellerSessionUser: unavailable },
    "@/lib/solicitud-operation-access": operationAccess,
    "@/lib/datacredito/storage": {
      DataCreditoStorageConfigurationError: class extends Error {},
      DataCreditoPolicyConflictError: class extends Error {},
      DATACREDITO_CONSENT_HASH: "test-hash",
      DATACREDITO_CONSENT_TEXT: "Autorización de prueba",
      DATACREDITO_CONSENT_VERSION: "test-version",
      isDataCreditoAuditConfigured: () => true,
      getAssignedDataCreditoPolicy: async (allyId) => {
        reads.push(allyId);
        return assignedPolicy ? { kind: "READY", policy: assignedPolicy } : { kind: "NOT_ASSIGNED" };
      },
      getDataCreditoDailyQuotaSnapshot: unavailable,
      getDataCreditoQuotaSolicitudOwner: unavailable,
      createDataCreditoPolicyVersion: unavailable,
    },
  });
  return {
    reads,
    async request(platform = "ANDROID", search = "", method = "GET") {
      const response = await route[method](new Request(
        `https://finserpay.test/api/creditos/datacredito/politica?purpose=simulation&platform=${platform}${search}`,
        { method },
      ));
      return { status: response.status, data: await response.json() };
    },
  };
}

test("el administrador aliado simula Android e iPhone con su política local sin consultar ni consumir DataCrédito", async () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    const f = fixture();
    const result = await f.request(platform);
    assert.equal(result.status, 200);
    assert.deepEqual(f.reads, [2]);
    assert.equal(result.data.simulation.platform, platform);
    assert.equal(result.data.simulation.simulationOnly, true);
    assert.equal(result.data.simulation.decision, "APROBADO");
    assert.equal(result.data.simulation.offer.maxFinancedAmount, 2_000_000);
    assert.equal(result.data.simulation.offer.initialPaymentPercentage, 30);
    assert.equal(result.data.simulation.offer.installmentCount, 24);
    assert.equal(result.data.simulation.offer.maxInstallmentAmount, platform === "IPHONE" ? 160_000 : null);
    assert.deepEqual(result.data.policy, { version: 5, createdAt: "2026-10-18T05:00:00.000Z" });
    for (const field of ["dailyQuota", "assessmentId", "bands", "priorityRules"]) {
      assert.equal(result.data[field], undefined, field);
      assert.equal(result.data.simulation[field], undefined, field);
      assert.equal(result.data.policy[field], undefined, field);
    }
  }
});

test("un aliado no puede cambiar la política simulada enviando otro aliado, documento o solicitud", async () => {
  const f = fixture();
  const result = await f.request("IPHONE", "&aliadoId=1&allyId=1&documento=00112233&solicitudId=999&includeDisabledPolicy=true");
  assert.equal(result.status, 200);
  assert.deepEqual(f.reads, [2]);
  assert.equal(result.data.simulation.policyRevisionId, "revision-2");
  assert.equal(result.data.simulation.offer.maxFinancedAmount, 2_000_000);
  assert.equal(result.data.policy.bands, undefined);
});

test("simular no autoriza al administrador aliado a publicar condiciones financieras", async () => {
  const f = fixture();
  const result = await f.request("ANDROID", "", "PATCH");
  assert.equal(result.status, 403);
  assert.match(result.data.error, /administrador central/);
  assert.deepEqual(f.reads, []);
});

test("el simulador aliado conserva rechazo, falta de asignación e integración deshabilitada", async () => {
  const rejected = fixture({ assignedPolicy: createPolicy(2, "RECHAZADO") });
  const denied = await rejected.request("IPHONE");
  assert.equal(denied.status, 200);
  assert.equal(denied.data.simulation.decision, "RECHAZADO");
  assert.equal(denied.data.simulation.offer, null);
  for (const f of [fixture({ assignedPolicy: null }), fixture({ enabled: false })]) {
    const result = await f.request();
    assert.equal(result.status, 200);
    assert.equal(result.data.simulation, null);
    assert.equal(result.data.hasPolicy, false);
    assert.equal(result.data.configured, false);
  }
});

test("sesión y plataforma se validan antes de leer la política", async () => {
  const anonymous = fixture({ user: null });
  assert.equal((await anonymous.request()).status, 401);
  assert.deepEqual(anonymous.reads, []);
  for (const platform of ["", "TABLET", "null"]) {
    const f = fixture();
    assert.equal((await f.request(platform)).status, 400);
    assert.deepEqual(f.reads, []);
  }
});

test("el administrador central conserva su simulador con las mismas reglas y sin sustituir su asignación", async () => {
  const f = fixture({ user: central });
  const result = await f.request("IPHONE", "&aliadoId=2");
  assert.equal(result.status, 200);
  assert.deepEqual(f.reads, [1]);
  assert.equal(result.data.simulation.offer.maxFinancedAmount, 1_000_000);
  assert.deepEqual(result.data.policy.bands, plain(createPolicy(1).bands));
});
