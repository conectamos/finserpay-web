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

test("un plazo administrativo revisado exporta la fianza por cuota desde el importe vigente", () => {
  const input = {
    plazoMeses: 24, valorFianza: 960_000, saldoBaseFinanciado: 2_000_000,
    tasaInteresEa: 80, fianzaPorcentaje: 99,
    amortizacion: {
      numeroCuotas: 16, fianzaCuotaPorcentaje: 2,
      tasaInteresEaPorcentaje: 29.24, seguroCuotaPorcentaje: 0.03,
    },
  };
  const before = structuredClone(input);
  const rates = resolveCarteraExportRates(input);
  assert.equal(rates.fianza, 0.48);
  assert.equal(rates.interesMensual, 0.021605, "conserva la tasa anual aprobada");
  assert.equal(rates.seguro, 0.0003, "conserva el seguro por cuota aprobado");
  assert.deepEqual(input, before, "el exportador no modifica el crédito ni su amortización");
});

test("la modalidad fianza total conserva su porcentaje al cambiar de plazo", () => {
  const rates = resolveCarteraExportRates({
    plazoMeses: 24, valorFianza: 1_200_000, saldoBaseFinanciado: 2_000_000,
    contratoSnapshot: { financiero: { fianzaTotalPorcentaje: 60 } },
    amortizacion: { numeroCuotas: 16, fianzaCuotaPorcentaje: 3.75 },
  });
  assert.equal(rates.fianza, 0.6);
});

test("una revisión con fianza cero exporta cero sin rescatar el porcentaje original", () => {
  const rates = resolveCarteraExportRates({
    plazoMeses: 24, valorFianza: 0, saldoBaseFinanciado: 2_000_000,
    amortizacion: { numeroCuotas: 16, fianzaCuotaPorcentaje: 2 },
  });
  assert.equal(rates.fianza, 0);
});

for (const invalid of [
  { valorFianza: undefined }, { valorFianza: -1 }, { valorFianza: "invalid" },
  { saldoBaseFinanciado: 0 }, { saldoBaseFinanciado: null },
  { plazoMeses: undefined }, { plazoMeses: 0 }, { plazoMeses: 16.5 },
]) {
  test(`una revisión sin importes o plazo válidos conserva la fuente histórica: ${JSON.stringify(invalid)}`, () => {
    const rates = resolveCarteraExportRates({
      plazoMeses: 24, valorFianza: 960_000, saldoBaseFinanciado: 2_000_000,
      amortizacion: { numeroCuotas: 16, fianzaCuotaPorcentaje: 2 },
      ...invalid,
    });
    assert.equal(rates.fianza, 0.32);
  });
}

test("créditos sin cambio de plazo conservan la prioridad contractual aunque sus campos legados difieran", () => {
  const rates = resolveCarteraExportRates({
    plazoMeses: 16, valorFianza: 100_000, saldoBaseFinanciado: 2_000_000,
    amortizacion: { numeroCuotas: 16, fianzaCuotaPorcentaje: 2 },
  });
  assert.equal(rates.fianza, 0.32);
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
