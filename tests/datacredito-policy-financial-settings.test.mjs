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
  calculoVersion: "FRANCES_V1",
  tasaInteresEa: 29.66,
  fianzaCuotaPorcentaje: 2.083333,
  seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL",
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
      tasaInteresEa: 25,
      fianzaCuotaPorcentaje: 3,
      seguroCuotaPorcentaje: 0.05,
      frecuenciaPago: "MENSUAL",
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

test("una politica nueva usa fianza por cuota y una historica conserva total dividido", () => {
  const base = {
    tasaInteresEa: 25,
    fianzaCuotaPorcentaje: 3,
    seguroCuotaPorcentaje: 0.05,
    frecuenciaPago: "MENSUAL",
  };
  const current = resolveCreditPolicyFinancialSettings({
    globalSettings: base,
    policyFinancialSettings: financialSettings,
    legacyOfferSuretyPercentage: 75,
    numeroCuotas: 36,
  });
  assert.equal(current.fianzaCuotaPorcentaje, 2.083333);
  assert.equal(current.fianzaSource, "POLITICA");

  const historical = resolveCreditPolicyFinancialSettings({
    globalSettings: base,
    policyFinancialSettings: null,
    legacyOfferSuretyPercentage: 75,
    numeroCuotas: 36,
  });
  assert.equal(historical.fianzaCuotaPorcentaje, 75 / 36);
  assert.equal(historical.fianzaSource, "OFERTA_LEGACY_TOTAL");
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
  assert.match(ui, /Fianza por cuota/);
  assert.match(ui, /Seguro por cuota/);
  assert.match(ui, /FRANCES_V1/);
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
