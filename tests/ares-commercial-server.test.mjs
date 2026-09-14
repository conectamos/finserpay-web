import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
const { createFinancingTermsSeal } = await jiti.import("../lib/credit-amortization-contract.ts");
const { resolveSignedCreditPolicyFinancialSettings } = await jiti.import("../lib/signed-credit-close.ts");
const { frozenReissueCredit } = await jiti.import("../lib/credit-approval-reissue-source.ts");
const {
  hasCurrentCreditOriginationTerms,
  CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE,
  CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE,
} = await jiti.import("../lib/credit-current-origination-terms.ts");

const current = {
  calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24,
  fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
  seguroCuotaPorcentaje: 0.03, tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
const routes = {
  create: "app/api/creditos/route.ts",
  sign: "app/api/creditos/borradores/[id]/firma-seguro/route.ts",
};

function fixture(version = "ARES_FRANCES_V2", annualRate = 29.24) {
  const plan = calculateFrenchAmortization({
    calculoVersion: version, valorVenta: 2_600_000, cuotaInicial: 780_000,
    numeroCuotas: 40, tasaInteresEa: annualRate, fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02",
  });
  const seal = createFinancingTermsSeal({
    folio: "FP-ARES-FROZEN", documento: "1234567890",
    contrato: {
      tipoDocumento: "CC", clienteNombre: "CLIENTE PRUEBA", clienteTelefono: "3000000000",
      clienteCorreo: "cliente@example.com", clienteDireccion: "CALLE 1",
      equipoMarca: "IPHONE", equipoModelo: "13 PRO", referenciaEquipo: "IPHONE 13 PRO",
      imei: "123456789012345",
    },
    amortizacion: plan,
    parametros: {
      fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO", fianzaFuente: "POLITICA",
      tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 7, policyRevisionId: "frozen-policy-revision",
    },
  });
  const terms = seal.snapshot;
  const credit = {
    folio: terms.folio, clienteNombre: terms.clienteNombre, clienteDocumento: terms.documento,
    clienteTelefono: terms.clienteTelefono, clienteCorreo: terms.clienteCorreo,
    clienteDireccion: terms.clienteDireccion, equipoMarca: terms.equipoMarca,
    equipoModelo: terms.equipoModelo, imei: terms.imei, frecuenciaPago: terms.frecuenciaPago,
    valorEquipoTotal: plan.valorVenta, cuotaInicial: plan.cuotaInicial,
    saldoBaseFinanciado: plan.valorFinanciado, montoCredito: Math.round(plan.montoTotal * 100) / 100,
    valorCuota: plan.cuotaCobro, plazoMeses: plan.numeroCuotas, tasaInteresEa: plan.tasaInteresEa,
    contratoSnapshot: { financiero: {
      selloFinanciero: seal, cuotaComercial: plan.cuotaComercial, cuotaTotalExacta: plan.cuotaTotal,
      fianzaCuotaPorcentaje: plan.fianzaCuotaPorcentaje, seguroCuotaPorcentaje: plan.seguroCuotaPorcentaje,
      ...(version === "ARES_FRANCES_V2" ? {
        cuotaPactada: plan.cuotaCobro, totalPagarExacto: plan.montoTotalExacto,
        descuentoRedondeo: plan.descuentoRedondeo,
      } : {}),
    } },
  };
  const process = { draftPayload: { financialTermsSeal: seal }, draftFolio: terms.folio,
    createdAt: "2026-09-14T12:00:00Z" };
  return { plan, seal, credit, process };
}

test("el guard acepta solo la configuracion completa ARES vigente sin reinterpretar cargos", () => {
  assert.equal(hasCurrentCreditOriginationTerms(current), true);
  assert.equal(hasCurrentCreditOriginationTerms({ ...current, fianzaModalidad: undefined }), true);
  assert.equal(hasCurrentCreditOriginationTerms({ ...current, tasaInteresEa: 29.24000000001 }), true);
  for (const invalid of [null, undefined, {}, [],
    { ...current, calculoVersion: "ARES_FRANCES_V1" },
    { ...current, tasaInteresEa: 29.66 }, { ...current, tasaInteresEa: NaN },
    { ...current, fianzaTotalPorcentaje: 70 }, { ...current, fianzaTotalPorcentaje: undefined },
    { ...current, fianzaModalidad: "POR_CUOTA" }, { ...current, seguroCuotaPorcentaje: 0.6 },
    { ...current, tasaPeriodoDecimales: 12 },
    { ...current, redondeoComercial: { modo: "REDONDEO", multiplo: 50 } },
    { ...current, redondeoComercial: { modo: "PISO", multiplo: 100 } },
  ]) assert.equal(hasCurrentCreditOriginationTerms(invalid), false);
  assert.equal(CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE, "DATACREDITO_FINANCIAL_TERMS_OUTDATED");
  assert.match(CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE, /reutilizando la consulta vigente/);
  assert.match(CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE, /sin generar una nueva consulta ni cobro/);
});

function actualRouteGuard(relativePath) {
  const source = readFileSync(path.join(root, relativePath), "utf8");
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  function walk(node) {
    if (ts.isIfStatement(node) &&
        node.expression.getText(file).includes("!hasCurrentCreditOriginationTerms(resolvedPolicyFinancialSettings)")) {
      found.push(node);
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
  assert.equal(found.length, 1, "Exactly one origination guard per route");
  const guard = found[0];
  const execute = new Function("signedTermsSnapshot", "resolvedPolicyFinancialSettings",
    "hasCurrentCreditOriginationTerms", "NextResponse", "CreditValidationError",
    "CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE", "CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE",
    guard.getText(file));
  class ValidationError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }
  return {
    source, guard,
    run: (settings, signed = null) => execute(signed, settings, hasCurrentCreditOriginationTerms,
      { json: (body, options) => ({ body, status: options.status }) }, ValidationError,
      CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE, CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE),
  };
}

test("el guard real de creacion responde 409 para nuevas ofertas viejas y no bloquea sellos existentes", () => {
  const guard = actualRouteGuard(routes.create);
  const blocked = guard.run({ ...current, tasaInteresEa: 29.66 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE);
  assert.equal(guard.run(current), undefined);
  assert.equal(guard.run({ ...current, calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66 },
    { calculoVersion: "ARES_FRANCES_V1" }), undefined);
  assert.ok(guard.source.indexOf("const amortizationPlan = calculateFrenchAmortization", guard.guard.pos) > guard.guard.pos);
});

test("el guard real de firma falla 409 antes de calcular y reutiliza procesos activos primero", () => {
  const guard = actualRouteGuard(routes.sign);
  assert.throws(() => guard.run({ ...current, calculoVersion: "ARES_FRANCES_V1" }),
    (error) => error.status === 409 && error.code === CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE);
  assert.equal(guard.run(current), undefined);
  const post = guard.source.slice(guard.source.indexOf("export async function POST"));
  assert.ok(post.indexOf("canReuseFirmaSeguroProcess(current)") < post.indexOf("await buildDraftCredit"));
  assert.ok(post.indexOf("canReuseFirmaSeguroProcess(lockedCurrent)") < post.indexOf("await buildDraftCredit"));
  assert.ok(guard.source.indexOf("async function buildDraftCredit") < guard.guard.pos);
  assert.ok(guard.source.indexOf("const amortizationPlan = calculateFrenchAmortization", guard.guard.pos) > guard.guard.pos);
});

test("firma y creacion usan la cuota cobrable para el importe y para validar limites", () => {
  for (const relativePath of Object.values(routes)) {
    const source = readFileSync(path.join(root, relativePath), "utf8");
    assert.match(source, /const financialPlan = \{[\s\S]{0,260}valorCuota: amortizationPlan\.cuotaCobro/);
    assert.match(source, /validateIphoneInstallmentLimit\(\{[\s\S]{0,160}valorCuota: amortizationPlan\.cuotaCobro/);
    assert.doesNotMatch(source, /valorCuota: amortizationPlan\.cuotaTotal\b/);
    assert.match(source, /version === ARES_COMMERCIAL_AMORTIZATION_VERSION[\s\S]{0,470}cuotaPactada: amortizationPlan\.cuotaCobro/);
    assert.match(source, /totalPagarExacto: amortizationPlan\.montoTotalExacto/);
    assert.match(source, /descuentoRedondeo: amortizationPlan\.descuentoRedondeo/);
  }
});

test("el cierre V2 reconstruye exclusivamente el sello y conserva cuota, descuento y checksum", () => {
  const { seal } = fixture();
  const terms = seal.snapshot;
  const resolved = resolveSignedCreditPolicyFinancialSettings(terms);
  assert.equal(resolved.calculoVersion, "ARES_FRANCES_V2");
  const plan = calculateFrenchAmortization({ ...resolved,
    valorVenta: Number(terms.valorVenta), cuotaInicial: Number(terms.cuotaInicial),
    numeroCuotas: terms.numeroCuotas, fechaPrimerPago: terms.fechaPrimerPago,
  });
  const reconstructed = createFinancingTermsSeal({
    folio: terms.folio, documento: terms.documento, contrato: terms, amortizacion: plan,
    parametros: {
      ...resolved, fianzaFuente: resolved.fianzaSource,
      policyVersion: terms.policyVersion, policyRevisionId: terms.policyRevisionId,
    },
  });
  assert.equal(plan.cuotaCobro, 90_850);
  assert.equal(plan.montoTotal, 3_634_000);
  assert.equal(reconstructed.checksum, seal.checksum);
  assert.deepEqual(reconstructed.snapshot, terms);
});

test("la reemision V2 mantiene cuota pactada, total y referencia exacta sin cobrar la diferencia", () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const result = frozenReissueCredit(original.credit, original.process);
  assert.equal(result.credit.valorCuota, 90_850);
  assert.equal(result.credit.montoCredito, 3_634_000);
  assert.equal(result.credit.calculoVersion, "ARES_FRANCES_V2");
  assert.equal(result.credit.cuotaTotalExacta, Number(original.seal.snapshot.cuotaTotalExacta));
  assert.equal(result.credit.descuentoRedondeo, Number(original.seal.snapshot.descuentoRedondeo));
  assert.equal(result.termsHash, original.seal.checksum);
  assert.equal(JSON.stringify(original), before);
  for (const change of [
    (f) => { f.credit.valorCuota = Number(f.seal.snapshot.cuotaTotalExacta); },
    (f) => { f.credit.contratoSnapshot.financiero.cuotaPactada += 50; },
    (f) => { f.credit.contratoSnapshot.financiero.descuentoRedondeo = 0; },
    (f) => { delete f.credit.contratoSnapshot.financiero.totalPagarExacto; },
  ]) {
    const changed = fixture(); change(changed);
    assert.throws(() => frozenReissueCredit(changed.credit, changed.process), /FROZEN_TERMS_/);
  }
});

test("reemisiones y cierre de contratos antiguos retienen 29.66% y su cuota exacta", () => {
  const original = fixture("ARES_FRANCES_V1", 29.66);
  const resolved = resolveSignedCreditPolicyFinancialSettings(original.seal.snapshot);
  assert.equal(resolved.calculoVersion, "ARES_FRANCES_V1");
  assert.equal(resolved.tasaInteresEa, 29.66);
  assert.equal(hasCurrentCreditOriginationTerms(resolved), false);
  const result = frozenReissueCredit(original.credit, original.process);
  assert.equal(result.credit.valorCuota, Number(original.seal.snapshot.cuotaTotalExacta));
  assert.notEqual(result.credit.valorCuota, result.credit.valorCuotaComercial);
  assert.equal(result.credit.tasaInteresEa, 29.66);
  assert.equal(result.termsHash, original.seal.checksum);
  assert.equal(Object.hasOwn(result.credit, "descuentoRedondeo"), false);
});
