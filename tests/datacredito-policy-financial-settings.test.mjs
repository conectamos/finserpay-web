import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": projectRoot },
});
const {
  parseDataCreditoPolicyFinancialSettings,
  resolveDataCreditoDecision,
} = await jiti.import("../lib/datacredito/policy.ts");
const { resolveCreditPolicyFinancialSettings } = await jiti.import(
  "../lib/credit-policy-financial-settings.ts"
);

const financialSettings = {
  calculoVersion: "ARES_FRANCES_V1",
  tasaInteresEa: 29.66,
  fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL",
  tasaPeriodoDecimales: 6,
  redondeoComercial: {
    modo: "PISO",
    multiplo: 50,
  },
};

test("valida y congela los parametros financieros en la oferta", () => {
  assert.deepEqual(
    parseDataCreditoPolicyFinancialSettings(financialSettings),
    financialSettings
  );
  const policy = {
    version: 4,
    financialSettings,
    bands: [
      {
        id: "all",
        platform: "ANDROID",
        scoreMin: 0,
        scoreMax: 950,
        decision: "APROBADO",
        initialPaymentPercentage: 20,
        suretyPercentage: 75,
        maxFinancedAmount: 2_000_000,
      },
    ],
  };
  assert.deepEqual(
    resolveDataCreditoDecision(policy, "ANDROID", 700).offer.financialSettings,
    financialSettings
  );
});

test("la excepcion explicita por cedula gana sin perder valores cero", () => {
  const resolved = resolveCreditPolicyFinancialSettings({
    globalSettings: {
      calculoVersion: "ARES_FRANCES_V1",
      tasaInteresEa: 25,
      fianzaTotalPorcentaje: 75,
      fianzaCuotaPorcentaje: 3,
      seguroCuotaPorcentaje: 0.05,
      frecuenciaPago: "MENSUAL",
      tasaPeriodoDecimales: 6,
      redondeoComercialModo: "PISO",
      redondeoComercialMultiplo: 50,
    },
    documentException: {
      tasaInteresEa: 0,
      fianzaPorcentaje: null,
      fianzaCuotaPorcentaje: 0,
      seguroCuotaPorcentaje: 0,
      frecuenciaPago: "SEMANAL",
    },
    policyFinancialSettings: financialSettings,
    legacyOfferSuretyPercentage: 80,
    numeroCuotas: 16,
  });
  assert.equal(resolved.tasaInteresEa, 0);
  assert.equal(resolved.fianzaCuotaPorcentaje, 0);
  assert.equal(resolved.seguroCuotaPorcentaje, 0);
  assert.equal(resolved.frecuenciaPago, "SEMANAL");
  assert.equal(resolved.fianzaSource, "CLIENTE_POR_CUOTA");
});

test("ARES divide la fianza total por plazo y FRANCES_V1 conserva fianza por cuota", () => {
  const base = {
    calculoVersion: "ARES_FRANCES_V1",
    tasaInteresEa: 25,
    fianzaTotalPorcentaje: 70,
    fianzaCuotaPorcentaje: 3,
    seguroCuotaPorcentaje: 0.05,
    frecuenciaPago: "MENSUAL",
    tasaPeriodoDecimales: 6,
    redondeoComercialModo: "PISO",
    redondeoComercialMultiplo: 50,
  };
  const current = resolveCreditPolicyFinancialSettings({
    globalSettings: base,
    policyFinancialSettings: financialSettings,
    legacyOfferSuretyPercentage: 75,
    numeroCuotas: 36,
  });
  assert.equal(current.fianzaCuotaPorcentaje, 75 / 36);
  assert.equal(current.fianzaTotalPorcentaje, 75);
  assert.equal(current.fianzaModalidad, "TOTAL_CREDITO");
  assert.equal(current.calculoVersion, "ARES_FRANCES_V1");
  assert.deepEqual(current.redondeoComercial, { modo: "PISO", multiplo: 50 });
  assert.equal(current.fianzaSource, "POLITICA");

  const legacyPolicy = resolveCreditPolicyFinancialSettings({
    globalSettings: base,
    policyFinancialSettings: {
      calculoVersion: "FRANCES_V1",
      tasaInteresEa: 25,
      fianzaCuotaPorcentaje: 2.083333,
      seguroCuotaPorcentaje: 0.03,
      frecuenciaPago: "QUINCENAL",
    },
    legacyOfferSuretyPercentage: 75,
    numeroCuotas: 36,
  });
  assert.equal(legacyPolicy.fianzaCuotaPorcentaje, 2.083333);
  assert.equal(legacyPolicy.fianzaModalidad, "POR_CUOTA");
  assert.equal(legacyPolicy.calculoVersion, "FRANCES_V1");
  assert.equal(legacyPolicy.tasaPeriodoDecimales, 12);
  assert.deepEqual(legacyPolicy.redondeoComercial, {
    modo: "REDONDEO",
    multiplo: 100,
  });

  const historical = resolveCreditPolicyFinancialSettings({
    globalSettings: {
      ...base,
      calculoVersion: "FRANCES_V1",
    },
    policyFinancialSettings: null,
    legacyOfferSuretyPercentage: 75,
    numeroCuotas: 36,
  });
  assert.equal(historical.fianzaCuotaPorcentaje, 75 / 36);
  assert.equal(historical.fianzaModalidad, "TOTAL_CREDITO");
  assert.equal(historical.fianzaSource, "OFERTA_LEGACY_TOTAL");
});

test("el global ARES aplica 29.66, aval total 75 y piso 50 sin assessment", () => {
  const resolved = resolveCreditPolicyFinancialSettings({
    globalSettings: {
      calculoVersion: "ARES_FRANCES_V1",
      tasaInteresEa: 29.66,
      fianzaTotalPorcentaje: 75,
      fianzaCuotaPorcentaje: 2.083333,
      seguroCuotaPorcentaje: 0.03,
      frecuenciaPago: "QUINCENAL",
      tasaPeriodoDecimales: 6,
      redondeoComercialModo: "PISO",
      redondeoComercialMultiplo: 50,
    },
    numeroCuotas: 16,
  });

  assert.equal(resolved.fianzaCuotaPorcentaje, 75 / 16);
  assert.equal(resolved.seguroCuotaPorcentaje, 0.03);
  assert.equal(resolved.tasaInteresEa, 29.66);
  assert.equal(resolved.tasaPeriodoDecimales, 6);
  assert.deepEqual(resolved.redondeoComercial, {
    modo: "PISO",
    multiplo: 50,
  });
});

test("retirar una politica es logico, bloqueado y conserva historia", async () => {
  const [deletion, route, adminStorage, ui] = await Promise.all([
    readProjectFile("lib/datacredito/policy-deletion.ts"),
    readProjectFile(
      "app/api/creditos/datacredito/politicas/route.ts"
    ),
    readProjectFile("lib/datacredito/admin-storage.ts"),
    readProjectFile(
      "app/dashboard/parametros-credito/datacredito-policy-console.tsx"
    ),
  ]);

  assert.match(route, /export async function DELETE/);
  assert.match(route, /getDataCreditoCentralAdmin/);
  assert.match(route, /POLICY_DELETE_DEFAULT_FORBIDDEN/);
  assert.match(route, /POLICY_DELETE_ASSIGNED/);
  assert.match(route, /POLICY_DELETE_VERSION_CONFLICT/);
  assert.match(deletion, /FOR UPDATE OF profile/);
  assert.match(deletion, /FROM "Aliado" ally[\s\S]*FOR UPDATE/);
  assert.match(deletion, /SET "active" = false/);
  assert.doesNotMatch(
    deletion,
    /DELETE FROM "DataCreditoPolicy(Profile|Revision|AssignmentAudit)"/
  );
  assert.match(deletion, /DataCreditoAssessment/);
  assert.match(adminStorage, /WHERE profile\."active" = true/);
  assert.match(ui, /Retirar política/);
  assert.match(ui, /Reasigna primero/);
  assert.match(ui, /Parámetros financieros de la política/);
  assert.match(ui, /Aval\/fianza total del crédito/);
  assert.match(ui, /Seguro por cuota/);
  assert.match(ui, /ARES_FRANCES_V1/);
  assert.match(ui, /Condiciones financieras de la nueva política/);
  assert.match(ui, /newPolicyFinancialSettings/);
  assert.match(
    ui,
    /financialSettings: newPolicyFinancialValidation\.canonical/
  );
  assert.doesNotMatch(
    ui,
    /financialSettings:\s*selectedProfile\.financialSettings/
  );
});
