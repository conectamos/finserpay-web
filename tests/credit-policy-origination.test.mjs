import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const factory = await jiti.import("../lib/credit-factory.ts");
const amortization = await jiti.import("../lib/credit-amortization.ts");
const phones = await jiti.import("../lib/credit-contact-phones.ts");
const policy = await jiti.import("../lib/datacredito/policy.ts");
const currentTerms = await jiti.import("../lib/credit-current-origination-terms.ts");
const financial = await jiti.import("../lib/credit-policy-financial-settings.ts");
const { createFinancingTermsSeal } = await jiti.import("../lib/credit-amortization-contract.ts");
const { buildSignedCreditClosePayload, resolveSignedCreditPolicyFinancialSettings } =
  await jiti.import("../lib/signed-credit-close.ts");

// Compile the complete server modules, replacing only their external services.
// Financial resolution, policy decisions, guards and amortization are real.
function serverModule(relativePath, dependencies) {
  const source = readFileSync(path.join(root, relativePath), "utf8")
    .replace(/^import\b[^;]*;\r?\n/gm, "");
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, Error, Date,
    process: { env: { NODE_ENV: "test" } }, ...dependencies });
  return module.exports;
}

const { buildInternalExceptionOffer } = serverModule("lib/datacredito/risk-exception.ts", {
  ...policy, ...currentTerms,
});
const policyFinancialSettings = {
  calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24,
  fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
function approvedPolicy(platform, bandSurety, settings = policyFinancialSettings, exception = false) {
  return { version: 8, financialSettings: settings, bands: [{
    id: "approved", platform, scoreMin: exception ? -1 : 0, scoreMax: exception ? -1 : 950,
    decision: "APROBADO", initialPaymentPercentage: 30, suretyPercentage: bandSurety,
    maxFinancedAmount: 3_500_000, installmentCount: 40,
    maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null,
  }] };
}

function draftFixture(platform, { bandSurety = 60, settings = policyFinancialSettings, exception = false } = {}) {
  const revision = approvedPolicy(platform, bandSurety, settings, exception);
  const offer = exception ? buildInternalExceptionOffer(revision, platform)
    : policy.resolveDataCreditoDecision(revision, platform, 700).offer;
  const assessment = { id: "assessment-policy", policyVersion: 8, policyRevisionId: "revision-policy", offer };
  let calculationCalls = 0;
  let authorizationCalls = 0;
  const checkScope = input => {
    assert.equal(input.platform, platform);
    assert.equal(input.userId, 23); assert.equal(input.sellerId, 45);
    assert.equal(input.sedeId, 1); assert.equal(input.aliadoId, 7);
    assert.equal(input.documentNumber, "123456789");
  };
  const operations = serverModule("lib/firmaseguro-draft-credit-builder.ts", {
    ...factory, ...amortization, ...phones, ...policy, ...currentTerms, ...financial,
    calculateFrenchAmortization: input => { calculationCalls++; return amortization.calculateFrenchAmortization(input); },
    enforceDataCreditoCustomerIdentity: async () => null,
    getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, environment: "test" }),
    isDataCreditoAuditConfigured: () => true,
    getApprovedDataCreditoAssessmentForCredit: async input => {
      assert.equal(exception, false); checkScope(input); authorizationCalls++; return assessment;
    },
    require: name => {
      assert.equal(name, "@/lib/datacredito/risk-exception");
      return { getCreditRiskAuthorizationForDraft: async input => {
        assert.equal(exception, true); checkScope(input); assert.equal(input.solicitudId, 530);
        authorizationCalls++;
        return { source: "INTERNAL_EXCEPTION", exceptionId: "exception-authorized", assessment,
          offer, policyVersion: 8, policyRevisionId: "revision-policy" };
      } };
    },
    resolveDataCreditoManualCreditLimit: async input => ({ source: "POLICY",
      maxFinancedAmount: input.policyMaxFinancedAmount, manualLimit: null }),
    getEffectiveCreditSettings: async (document, actualPlatform) => {
      assert.equal(document, undefined); assert.equal(actualPlatform, platform);
      return { globalSettings: {
        calculoVersion: "FRANCES_V1", tasaInteresEa: 10, fianzaTotalPorcentaje: 20,
        fianzaCuotaPorcentaje: 0, seguroCuotaPorcentaje: 0.5, frecuenciaPago: "MENSUAL",
        cuotaInicialPorcentaje: 20, iphoneTopeFinanciado: 3_500_000, iphoneTopeCuota: 160_000,
        plazoCuotas: 12, plazoMaximoCuotas: 48,
      } };
    },
    findEquipmentCatalogItem: async identity => ({ ...identity, activo: true, precioBaseVenta: 2_600_000 }),
    findEquipmentCatalogItemById: async () => null,
  });
  const row = { id: 530, estado: "ABIERTO", usuarioId: 23, vendedorId: 45, sedeId: 1, sedeAliadoId: 7,
    clienteDocumento: "123456789", currentStep: 4, payload: {
      clienteNombre: "Cliente Prueba", clientePrimerNombre: "Cliente", clientePrimerApellido: "Prueba",
      clienteDocumento: "123456789", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
      clienteTelefono: "3001234567", clienteCorreo: "cliente@example.com", clienteDireccion: "Calle 1",
      referenciaFamiliar1Telefono: "3101234567", referenciaFamiliar2Telefono: "3201234567",
      equipoMarca: platform === "IPHONE" ? "Apple" : "Samsung",
      equipoModelo: platform === "IPHONE" ? "iPhone 15" : "Galaxy A55",
      plataformaDispositivo: platform, imei: "123456789012345", firmaSeguroDraftFolio: "FP-POLICY-TEST",
      valorEquipoTotal: "2600000", cuotaInicial: "780000", plazoMeses: "40",
      dataCreditoAssessmentId: assessment.id,
      ...(exception ? { creditRiskExceptionId: "exception-authorized" } : {}),
      fianzaPorcentaje: 0, fianzaCuotaPorcentaje: 0, fianzaTotalPorcentaje: 0,
      tasaInteresEa: 0, seguroCuotaPorcentaje: 0, calculoVersion: "FRANCES_V1",
      frecuenciaPago: "MENSUAL", valorCuota: 1, montoCredito: 1,
      financialSettings: { ...policyFinancialSettings, fianzaTotalPorcentaje: 0 },
    } };
  return { ...operations, row, offer, calculationCalls: () => calculationCalls,
    authorizationCalls: () => authorizationCalls };
}

function assertPolicyPlan(built) {
  const { credit, amortizationPlan: plan, financingParameters: parameters } = built;
  assert.equal(plan.version, "ARES_FRANCES_V2");
  assert.equal(plan.tasaInteresEa, 29.24); assert.equal(plan.seguroCuotaPorcentaje, 0.03);
  assert.equal(plan.fianzaCuotaPorcentaje, 75 / 40);
  assert.equal(plan.valorFianzaTotal, 1_365_000);
  assert.equal(plan.cuotaCobro, 90_850); assert.equal(plan.montoTotal, 3_634_000);
  assert.equal(credit.fianzaTotalPorcentaje, 75); assert.equal(credit.tasaInteresEa, 29.24);
  assert.equal(credit.seguroCuotaPorcentaje, 0.03); assert.equal(credit.frecuenciaPago, "QUINCENAL");
  assert.equal(parameters.fianzaFuente, "POLITICA"); assert.equal(parameters.fianzaTotalPorcentaje, 75);
  assert.equal(parameters.policyVersion, 8); assert.equal(parameters.policyRevisionId, "revision-policy");
}

for (const platform of ["ANDROID", "IPHONE"]) {
  test(`${platform}: firma real usa la politica aunque banda, globales y borrador discrepen`, async () => {
    for (const bandSurety of [0, 60, 100]) {
      const f = draftFixture(platform, { bandSurety });
      const before = JSON.stringify({ row: f.row, offer: f.offer });
      const built = await f.buildDraftCredit(f.row);
      assertPolicyPlan(built);
      assert.equal(f.authorizationCalls(), 1); assert.equal(f.calculationCalls(), 1);
      assert.equal(JSON.stringify({ row: f.row, offer: f.offer }), before);
      assert.equal(f.offer.suretyPercentage, bandSurety, "No se reescribe la evaluacion historica");
    }
  });

  test(`${platform}: cierre firmado conserva plan y checksum pese a nuevos importes del navegador`, async () => {
    const f = draftFixture(platform);
    const built = await f.buildDraftCredit(f.row);
    const seal = createFinancingTermsSeal({ folio: built.credit.folio, documento: built.credit.clienteDocumento,
      contrato: { ...built.credit, tipoDocumento: built.credit.clienteTipoDocumento },
      amortizacion: built.amortizationPlan, parametros: built.financingParameters });
    const closed = buildSignedCreditClosePayload(f.row.payload, {
      ...f.row.payload, valorEquipoTotal: 1, cuotaInicial: 0, plazoMeses: 1,
      fianzaPorcentaje: 99, tasaInteresEa: 99, seguroCuotaPorcentaje: 99,
      financialSettings: { ...policyFinancialSettings, fianzaTotalPorcentaje: 99 },
    }, seal.snapshot);
    const resolved = resolveSignedCreditPolicyFinancialSettings(seal.snapshot);
    assert.equal(currentTerms.hasCurrentCreditOriginationTerms(resolved), true);
    const activated = amortization.calculateFrenchAmortization({ ...resolved,
      valorVenta: Number(closed.valorEquipoTotal), cuotaInicial: Number(closed.cuotaInicial),
      numeroCuotas: Number(closed.plazoMeses), fechaPrimerPago: closed.fechaPrimerPago,
    });
    const restored = createFinancingTermsSeal({ folio: seal.snapshot.folio, documento: seal.snapshot.documento,
      contrato: seal.snapshot, amortizacion: activated, parametros: {
        ...resolved, fianzaFuente: resolved.fianzaSource,
        policyVersion: seal.snapshot.policyVersion, policyRevisionId: seal.snapshot.policyRevisionId,
      } });
    assert.deepEqual(activated, built.amortizationPlan);
    assert.equal(restored.checksum, seal.checksum);
  });

  test(`${platform}: condiciones viejas no se rescatan con valores vigentes enviados por el cliente`, async () => {
    for (const settings of [null,
      { ...policyFinancialSettings, fianzaTotalPorcentaje: 60 },
      { ...policyFinancialSettings, tasaInteresEa: 29.66 },
      { ...policyFinancialSettings, seguroCuotaPorcentaje: 0.04 },
    ]) {
      const f = draftFixture(platform, { settings });
      Object.assign(f.row.payload, policyFinancialSettings, { financialSettings: policyFinancialSettings });
      await assert.rejects(f.buildDraftCredit(f.row), error => error.status === 409 &&
        error.code === "DATACREDITO_FINANCIAL_TERMS_OUTDATED");
      assert.equal(f.calculationCalls(), 0, "Se rechaza antes de producir el plan para firma");
    }
  });

  test(`${platform}: excepcion autorizada conserva la misma politica financiera y guard vigente`, async () => {
    const f = draftFixture(platform, { exception: true, bandSurety: 0 });
    const built = await f.buildDraftCredit(f.row);
    assertPolicyPlan(built);
    assert.equal(f.authorizationCalls(), 1);
    assert.equal(built.credit.contratoSnapshot.creditAuthorization.source, "INTERNAL_EXCEPTION");
    assert.equal(built.credit.contratoSnapshot.creditAuthorization.exceptionId, "exception-authorized");
    assert.throws(() => buildInternalExceptionOffer(approvedPolicy(platform, 75,
      { ...policyFinancialSettings, fianzaTotalPorcentaje: 60 }, true), platform),
    error => error.code === "RISK_EXCEPTION_INVALID_TERMS");
  });
}
