import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  formatCarteraPercentageCell,
  isExcludedCarteraCreditState,
  resolveCarteraExportRates,
  shouldIncludeCarteraExportCredit,
} = await jiti.import("../lib/cartera-export.ts");

test("distingue pagados al 100% de créditos anulados o cancelados", () => {
  for (const state of ["ANULADO", " anulada ", "CANCELADO", "cancelada"]) {
    assert.equal(isExcludedCarteraCreditState(state), true);
  }

  for (const state of ["PAZ_Y_SALVO", "PAGADO", "ACTIVO", "GENERADO"]) {
    assert.equal(isExcludedCarteraCreditState(state), false);
  }
});

test("la cartera general incluye saldos activos y pagados, mientras mora exige saldo vencido", () => {
  assert.equal(
    shouldIncludeCarteraExportCredit({
      scope: "cartera",
      saldoPendiente: 500_000,
      hasOverdueInstallment: false,
    }),
    true
  );
  assert.equal(
    shouldIncludeCarteraExportCredit({
      scope: "cartera",
      saldoPendiente: 0,
      hasOverdueInstallment: false,
    }),
    true
  );
  assert.equal(
    shouldIncludeCarteraExportCredit({
      scope: "mora",
      saldoPendiente: 0,
      hasOverdueInstallment: true,
    }),
    false
  );
  assert.equal(
    shouldIncludeCarteraExportCredit({
      scope: "mora",
      saldoPendiente: 500_000,
      hasOverdueInstallment: false,
    }),
    false
  );
  assert.equal(
    shouldIncludeCarteraExportCredit({
      scope: "mora",
      saldoPendiente: 500_000,
      hasOverdueInstallment: true,
    }),
    true
  );
});

test("resuelve interes mensual, fianza total y seguro desde la amortizacion contractual", () => {
  const rates = resolveCarteraExportRates({
    tasaInteresEa: 5,
    fianzaPorcentaje: 10,
    contratoSnapshot: {
      financiero: {
        tasaInteresEa: 25,
        fianzaTotalPorcentaje: 60,
        seguroCuotaPorcentaje: 0.05,
      },
    },
    amortizacion: {
      tasaInteresEaPorcentaje: 29.24,
      fianzaCuotaPorcentaje: 75 / 36,
      seguroCuotaPorcentaje: 0.03,
      numeroCuotas: 36,
    },
  });

  assert.equal(rates.interesMensual, 0.021605);
  assert.ok(Math.abs(rates.fianza - 0.75) < 1e-12);
  assert.equal(rates.seguro, 0.0003);
});

test("usa el snapshot historico y deja vacio el seguro que nunca fue registrado", () => {
  const snapshotRates = resolveCarteraExportRates({
    tasaInteresEa: 10,
    fianzaPorcentaje: 15,
    contratoSnapshot: {
      financiero: {
        tasaInteresEa: 25,
        fianzaTotalPorcentaje: 65,
        fianzaCuotaPorcentaje: 2,
        cuotas: 30,
        seguroCuotaPorcentaje: 0.05,
      },
    },
    amortizacion: null,
  });
  const legacyRates = resolveCarteraExportRates({
    tasaInteresEa: 0,
    fianzaPorcentaje: 0,
    contratoSnapshot: null,
    amortizacion: null,
  });

  assert.equal(snapshotRates.interesMensual, 0.018769);
  assert.equal(snapshotRates.fianza, 0.65);
  assert.equal(snapshotRates.seguro, 0.0005);
  assert.equal(legacyRates.interesMensual, 0);
  assert.equal(legacyRates.fianza, 0);
  assert.equal(legacyRates.seguro, null);
});

test("genera celdas porcentuales numericas y conserva cero frente a ausencia", () => {
  assert.equal(
    formatCarteraPercentageCell(0.021605),
    '<td style=\'mso-number-format:"0.0000%";\'>0.021605</td>'
  );
  assert.equal(
    formatCarteraPercentageCell(0),
    '<td style=\'mso-number-format:"0.0000%";\'>0</td>'
  );
  assert.equal(formatCarteraPercentageCell(null), "<td></td>");
});
