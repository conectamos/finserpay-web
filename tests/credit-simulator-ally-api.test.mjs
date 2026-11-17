import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const plain = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: vmModule, exports: vmModule.exports, URL, Request, Response,
    console: { ...console, error() {} },
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
const creditSettingsModule = load("lib/credit-settings.ts", {
  "@/lib/prisma": {},
  "@/lib/credit-factory": { DEFAULT_PAYMENT_FREQUENCY: "QUINCENAL" },
  "@/lib/credit-amortization": {}, "@/lib/datacredito/policy": policy,
});
const central = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoId: 1 };
const allyAdmin = { id: 2, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoId: 2 };
const baseSettings = {
  calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24,
  fianzaPorcentaje: 75, fianzaTotalPorcentaje: 75, fianzaCuotaPorcentaje: 4.6875,
  seguroCuotaPorcentaje: 0.03, tasaPeriodoDecimales: 6,
  redondeoComercialModo: "PISO", redondeoComercialMultiplo: 50,
  cuotaInicialPorcentaje: 20, plazoCuotas: 16, plazoMaximoCuotas: 24,
  iphoneCuotaInicialPorcentaje: 30, iphonePlazoCuotas: 40, iphonePlazoMaximoCuotas: 48,
  iphoneTopeFinanciado: 3_500_000, iphoneTopeCuota: 160_000,
  frecuenciaPago: "MENSUAL", updatedAt: "2026-11-17T05:00:00.000Z",
};

function fixture({ user = allyAdmin, enabled = true, globalSettings = baseSettings,
  settingsError = null, allowPolicyReads = false } = {}) {
  const reads = { settings: 0, provider: 0, audit: 0, policy: [], quota: [] };
  const unavailable = () => assert.fail("La simulación general no debe leer políticas, cupos o expedientes ni modificar configuración");
  const route = load("app/api/creditos/datacredito/politica/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": allies, "@/lib/roles": roles,
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => {
      reads.provider += 1;
      if (!allowPolicyReads) unavailable();
      return { enabled, configured: true };
    } },
    "@/lib/datacredito/policy-access": policyAccess, "@/lib/datacredito/policy": policy,
    "@/lib/credit-settings": {
      getPlatformCreditSettings: creditSettingsModule.getPlatformCreditSettings,
      getCreditSettings: async () => {
        reads.settings += 1;
        if (settingsError) throw settingsError;
        return globalSettings;
      },
    },
    "@/lib/seller-auth": { getSellerSessionUser: unavailable },
    "@/lib/solicitud-operation-access": operationAccess,
    "@/lib/datacredito/storage": {
      DataCreditoStorageConfigurationError: class extends Error {},
      DataCreditoPolicyConflictError: class extends Error {},
      DATACREDITO_CONSENT_HASH: "test-hash", DATACREDITO_CONSENT_TEXT: "Autorización de prueba",
      DATACREDITO_CONSENT_VERSION: "test-version",
      isDataCreditoAuditConfigured: () => {
        reads.audit += 1;
        if (!allowPolicyReads) unavailable();
        return true;
      },
      getAssignedDataCreditoPolicy: async (allyId) => {
        if (!allowPolicyReads) unavailable();
        reads.policy.push(allyId);
        return { kind: "READY", policy: { version: 7, revisionId: "assigned-policy",
          createdAt: "2026-11-16T05:00:00.000Z", bands: [] } };
      },
      getDataCreditoDailyQuotaSnapshot: async (allyId) => {
        if (!allowPolicyReads) unavailable();
        reads.quota.push(allyId);
        return { used: 2, limit: 5, remaining: 3 };
      },
      getDataCreditoQuotaSolicitudOwner: unavailable, createDataCreditoPolicyVersion: unavailable,
    },
  });
  return {
    reads,
    async request(search = "?purpose=simulation&platform=ANDROID", method = "GET") {
      const response = await route[method](new Request(
        `https://finserpay.test/api/creditos/datacredito/politica${search}`, { method }
      ));
      return { status: response.status, data: await response.json() };
    },
  };
}

test("Android e iPhone usan parámetros generales sin depender del aliado, políticas o proveedor", async () => {
  for (const user of [central, allyAdmin, { ...allyAdmin, aliadoId: 99, rolNombre: "ASESOR" },
    { ...allyAdmin, aliadoId: null }]) {
    const f = fixture({ user, enabled: false });
    for (const platform of ["ANDROID", "IPHONE"]) {
      const result = await f.request(`?purpose=simulation&platform=${platform}`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data, { ok: true, simulation: {
        kind: "GENERAL_CREDIT_SETTINGS", simulationOnly: true, platform,
        settings: plain(creditSettingsModule.getPlatformCreditSettings(baseSettings, platform)),
        globalSettings: baseSettings,
      } });
      for (const field of ["offer", "conditions", "decision", "score", "policyVersion", "policyRevisionId",
        "bands", "priorityRules", "assessmentId", "dailyQuota", "consent", "provider", "policy"]) {
        assert.equal(result.data[field], undefined, field);
        assert.equal(result.data.simulation[field], undefined, field);
      }
    }
    assert.deepEqual(f.reads, { settings: 2, provider: 0, audit: 0, policy: [], quota: [] });
  }
});

test("respeta parámetros generales por plataforma y no los sustituye por términos de riesgo", async () => {
  const customized = { ...baseSettings, tasaInteresEa: 25.18, fianzaTotalPorcentaje: 68,
    seguroCuotaPorcentaje: 0.04, plazoCuotas: 12, plazoMaximoCuotas: 20,
    iphonePlazoCuotas: 30, iphonePlazoMaximoCuotas: 36, iphoneTopeCuota: 140_000 };
  const before = plain(customized);
  const f = fixture({ globalSettings: customized });
  const android = await f.request();
  const iphone = await f.request("?purpose=simulation&platform=IPHONE");
  assert.equal(android.data.simulation.settings.plazoCuotas, 12);
  assert.equal(android.data.simulation.settings.plazoMaximoCuotas, 20);
  assert.equal(android.data.simulation.settings.frecuenciaPago, "MENSUAL");
  assert.equal(iphone.data.simulation.settings.plazoCuotas, 30);
  assert.equal(iphone.data.simulation.settings.plazoMaximoCuotas, 36);
  assert.equal(iphone.data.simulation.settings.frecuenciaPago, "QUINCENAL");
  assert.equal(iphone.data.simulation.settings.iphoneTopeCuota, 140_000);
  for (const result of [android, iphone]) {
    assert.equal(result.data.simulation.settings.tasaInteresEa, 25.18);
    assert.equal(result.data.simulation.settings.fianzaTotalPorcentaje, 68);
    assert.equal(result.data.simulation.settings.seguroCuotaPorcentaje, 0.04);
    assert.deepEqual(result.data.simulation.globalSettings, before);
  }
  assert.deepEqual(customized, before);
});

test("documento, solicitud, aliado y revisión por URL no cambian la simulación general", async () => {
  const f = fixture();
  const result = await f.request("?purpose=simulation&platform=IPHONE&aliadoId=999&documento=123456&solicitudId=NaN&includeDisabledPolicy=true&policyRevisionId=otro");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.simulation.globalSettings, baseSettings);
  assert.deepEqual(f.reads, { settings: 1, provider: 0, audit: 0, policy: [], quota: [] });
});

test("valida sesión, propósito y plataforma antes de leer parámetros generales", async () => {
  const anonymous = fixture({ user: null });
  assert.equal((await anonymous.request()).status, 401);
  assert.equal(anonymous.reads.settings, 0);
  for (const query of ["?purpose=otro&platform=ANDROID", "?purpose=simulation",
    "?purpose=simulation&platform=", "?purpose=simulation&platform=TABLET"]) {
    const f = fixture();
    assert.equal((await f.request(query)).status, 400);
    assert.deepEqual(f.reads, { settings: 0, provider: 0, audit: 0, policy: [], quota: [] });
  }
});

test("fallar parámetros generales devuelve error sin caer a otra política o aprobación", async () => {
  const f = fixture({ settingsError: new Error("private database detail") });
  const result = await f.request();
  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { ok: false, error: "No se pudo cargar la configuración general del simulador" });
  assert.deepEqual(f.reads, { settings: 1, provider: 0, audit: 0, policy: [], quota: [] });
});

test("la consulta de venta conserva política asignada, consentimiento y cupo del aliado", async () => {
  const f = fixture({ allowPolicyReads: true });
  const result = await f.request("?platform=IPHONE&aliadoId=999");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.policy, { version: 7, createdAt: "2026-11-16T05:00:00.000Z" });
  assert.deepEqual(result.data.dailyQuota, { used: 2, limit: 5, remaining: 3 });
  assert.equal(result.data.consent.version, "test-version");
  assert.equal(result.data.simulation, undefined);
  assert.deepEqual(f.reads, { settings: 0, provider: 1, audit: 1, policy: [2], quota: [2] });
});

test("ventas con proveedor deshabilitado conservan su estado sin consultar políticas", async () => {
  const f = fixture({ enabled: false, allowPolicyReads: true });
  const result = await f.request("");
  assert.equal(result.status, 200);
  assert.equal(result.data.enabled, false);
  assert.equal(result.data.hasPolicy, false);
  assert.equal(result.data.simulation, undefined);
  assert.deepEqual(f.reads, { settings: 0, provider: 1, audit: 1, policy: [], quota: [] });
});

test("simular no autoriza al administrador aliado a publicar condiciones financieras", async () => {
  const f = fixture();
  const result = await f.request("?purpose=simulation&platform=ANDROID", "PATCH");
  assert.equal(result.status, 403);
  assert.match(result.data.error, /administrador central/);
  assert.deepEqual(f.reads, { settings: 0, provider: 0, audit: 0, policy: [], quota: [] });
});
