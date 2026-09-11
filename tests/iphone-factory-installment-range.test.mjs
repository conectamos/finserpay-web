import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { validateIphoneInstallmentLimit, getCreditInstallmentOptions, shouldPreserveIphoneFactoryInstallments } =
  await jiti.import("../lib/credit-factory.ts");
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const validate = (valorCuota, overrides = {}) => validateIphoneInstallmentLimit({
  platform: "IPHONE",
  valorCuota,
  iphoneMaxInstallmentValue: 160_000,
  enforceFactoryRange: true,
  ...overrides,
});

test("fabrica iPhone acepta ambos limites y rechaza importes fuera del rango exacto", () => {
  assert.equal(validate(90_000).outsideRange, false);
  assert.equal(validate(160_000).outsideRange, false);
  assert.equal(validate(89_999.99).belowMinimum, true);
  assert.equal(validate(89_999.99).outsideRange, true);
  // No relajar el tope anterior por el redondeo comercial a $50.
  assert.equal(validate(160_000.01).exceeded, true);
  assert.equal(validate(160_000.01).outsideRange, true);
  for (const value of [0, -1, null, undefined, NaN, Infinity]) {
    assert.equal(validate(value).outsideRange, true);
  }
});

test("la politica puede reducir el tope, pero no elevarlo sobre 160000", () => {
  assert.equal(validate(120_000, { iphoneMaxInstallmentValue: 120_000 }).outsideRange, false);
  assert.equal(validate(120_000.01, { iphoneMaxInstallmentValue: 120_000 }).outsideRange, true);
  assert.equal(validate(170_000, { iphoneMaxInstallmentValue: 200_000 }).outsideRange, true);
  assert.equal(validate(100_000, { iphoneMaxInstallmentValue: 200_000 }).maxInstallment, 160_000);
  assert.match(validate(85_000, { iphoneMaxInstallmentValue: 80_000 }).message, /No hay un rango/);
});

test("Android, simulador y condiciones antiguas conservan su validacion", () => {
  assert.equal(validate(77_700, { platform: "ANDROID" }).outsideRange, false);
  assert.equal(validate(170_000, { platform: "ANDROID" }).outsideRange, false);
  assert.equal(validate(77_700, { enforceFactoryRange: false }).outsideRange, false);
  assert.equal(validateIphoneInstallmentLimit({ platform: "IPHONE", valorCuota: 77_700 }).outsideRange, false);
  assert.equal(validate(170_000, { enforceFactoryRange: false, iphoneMaxInstallmentValue: 200_000 }).outsideRange, false);
});

function optionsFor({ sale = 2_600_000, initial = 780_000, maxCount = 48, maxAmount = 160_000 } = {}) {
  return getCreditInstallmentOptions(maxCount).map((count) => {
    const plan = calculateFrenchAmortization({
      calculoVersion: "ARES_FRANCES_V1",
      valorVenta: sale,
      cuotaInicial: initial,
      numeroCuotas: Number(count),
      tasaInteresEa: 29.24,
      fianzaCuotaPorcentaje: 75 / Number(count),
      seguroCuotaPorcentaje: 0.03,
      frecuenciaPago: "QUINCENAL",
      fechaPrimerPago: "2026-10-02",
    });
    return { count: Number(count), exact: plan.cuotaTotal, commercial: plan.cuotaComercial };
  }).filter((option) => !validate(option.exact, { iphoneMaxInstallmentValue: maxAmount }).outsideRange);
}

test("solo quedan plazos en el rango y cambian al variar el precio o la inicial", () => {
  const options = optionsFor();
  assert.ok(options.length > 1);
  assert.ok(options.every((option) => option.exact >= 90_000 && option.exact <= 160_000));
  assert.ok(options.every((option) => option.commercial >= 90_000 && option.commercial <= 160_000));
  assert.ok(!options.some((option) => option.count === 48)); // ARES da $77.700 a 48.
  assert.notDeepEqual(options.map((option) => option.count), optionsFor({ initial: 1_000_000 }).map((option) => option.count));
  assert.notDeepEqual(options.map((option) => option.count), optionsFor({ sale: 3_000_000 }).map((option) => option.count));
  assert.ok(optionsFor({ maxCount: 30 }).every((option) => option.count <= 30));
});

test("no inventa un plazo cuando ninguno satisface la politica", () => {
  assert.deepEqual(optionsFor({ maxCount: 1 }), []);
  assert.deepEqual(optionsFor({ maxAmount: 80_000 }), []);
  assert.deepEqual(optionsFor({ sale: 10_000, initial: 3_000 }), []);
});

test("selector y avance usan el mismo rango y no cambian plazos enviados o firmados", () => {
  const source = read("app/dashboard/creditos/credit-factory-console.tsx");
  assert.match(source, /const iphoneFactoryTermsLocked = shouldPreserveIphoneFactoryInstallments\(\{[\s\S]{0,250}signatureLoading: iphoneFactorySignaturePending,[\s\S]{0,100}signatureState: firmaSeguroProcessUiState/);
  assert.match(source, /const iphoneFactoryRangeActive =\s*dataCreditoCreditCreationMode && iphoneFactory && !iphoneFactoryTermsLocked/);
  assert.match(source, /if \(iphoneFactoryTermsLocked\) return policyInstallmentOptions/);
  assert.match(source, /enforceFactoryRange: iphoneFactoryRangeActive,[\s\S]{0,100}\.outsideRange/);
  assert.match(source, /!iphoneFactoryRangeActive \|\| creditInstallmentOptions\.includes\(plazoMeses\)/);
  assert.match(source, /!iphoneFactory \|\|\s*iphoneFactoryTermsLocked \|\|\s*creditInstallmentOptions.length === 0/);
  assert.match(source, /Sin plazos dentro del rango/);
  assert.match(source, /No hay plazos disponibles/);
  assert.match(source, /draftResumeHydrating \|\| Boolean\(draftId && firmaSeguroPendingDraftId === draftId\)/);
  assert.match(source, /setFirmaSeguroPendingDraftId\(draft.id\)/);
  assert.match(source, /else if \(!cancelled\) \{[\s\S]{0,250}setFirmaSeguroPendingDraftId/);
  assert.match(source, /plazoMesesNumero > 0 &&\s*!iphoneFactorySignaturePending/);
  const publicMessage = source.slice(source.indexOf("const visibleIphoneInstallmentLimitMessage"), source.indexOf("const frecuenciaPagoLabel"));
  assert.match(publicMessage, /: iphoneFactoryRangeActive\s*\? `Elige un plazo cuya cuota/);
  assert.doesNotMatch(publicMessage.split(": iphoneFactoryRangeActive")[1], /iphoneInstallmentLimitMessage|valorCuota/);
});

test("DataCredito rapido y FirmaSeguro lento o fallido nunca alteran un plazo previo", () => {
  const preserve = (signatureLoading, signatureState, overrides = {}) =>
    shouldPreserveIphoneFactoryInstallments({
      platform: "IPHONE", isFactoryMode: true, signatureLoading, signatureState, ...overrides,
    });
  // With the approved offer already restored, the process is still unknown.
  // A failed GET keeps signatureLoading=true; only a successful GET clears it.
  for (const response of ["pending", "waiting", "signed", "error"]) {
    assert.equal(preserve(true, response), true);
  }
  assert.equal(preserve(false, "signed"), true);
  assert.equal(preserve(false, "waiting"), true);
  assert.equal(preserve(false, "pending"), false); // confirmed no process
  assert.equal(preserve(false, "error"), false); // new agreement must meet range
  assert.equal(preserve(true, "signed", { platform: "ANDROID" }), false);
  assert.equal(preserve(true, "signed", { isFactoryMode: false }), false);
  const originalCount = 48;
  const available = optionsFor().map((option) => option.count);
  for (const [loading, state] of [[true, "pending"], [true, "error"], [false, "signed"]]) {
    const selected = preserve(loading, state) ? originalCount : available[0];
    assert.equal(selected, originalCount);
  }
  assert.notEqual(available[0], originalCount);
});

test("firma y cierre validan el rango en servidor sin invalidar el sello anterior", () => {
  const signature = read("app/api/creditos/borradores/[id]/firma-seguro/route.ts");
  const close = read("app/api/creditos/route.ts");
  assert.match(signature, /validateIphoneInstallmentLimit\(\{[\s\S]{0,160}enforceFactoryRange: true/);
  assert.match(signature, /if \(iphoneInstallmentLimit.outsideRange\)/);
  assert.match(close, /enforceFactoryRange: !signedTermsSnapshot/);
  assert.match(close, /if \(!signedTermsSnapshot && iphoneInstallmentLimit.outsideRange\)/);
});
