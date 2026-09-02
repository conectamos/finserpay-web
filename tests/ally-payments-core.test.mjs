import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLY_PAYMENTS_AVAILABLE_FROM,
  ALLY_PAYMENTS_AVAILABLE_FROM_LABEL,
  applyAllyPaymentIntermediationAdjustments,
  calculateAllyPaymentAmounts,
  isAnnulledCreditState,
  normalizeBankApprovalNumber,
  normalizeAllyPaymentIntermediationAdjustments,
  resolveAllyPaymentPlatform,
  resolveAvailableAllyPaymentPeriod,
  resolveColombiaPaymentPeriod,
  roundAllyPaymentMoney,
  summarizeAllyPayments,
} from "../lib/ally-payments-core.ts";

test("fija la disponibilidad de pagos desde el 1 de septiembre de 2026", () => {
  assert.equal(ALLY_PAYMENTS_AVAILABLE_FROM, "2026-09-01");
  assert.equal(ALLY_PAYMENTS_AVAILABLE_FROM_LABEL, "1 de septiembre de 2026");
  assert.throws(
    () => resolveAvailableAllyPaymentPeriod("2026-08-31", "2026-09-01"),
    /disponible desde el 1 de septiembre de 2026/
  );
  assert.equal(
    resolveAvailableAllyPaymentPeriod("2026-09-01", "2026-09-01").startDate,
    "2026-09-01"
  );
});

test("calcula el pago al aliado con la formula financiera confirmada", () => {
  assert.deepEqual(
    calculateAllyPaymentAmounts({
      valorVenta: 4_000_000,
      cuotaInicial: 1_500_000,
      porcentajeIntermediacion: 10,
    }),
    {
      valorVenta: 4_000_000,
      cuotaInicial: 1_500_000,
      porcentajeIntermediacion: 10,
      creditoAutorizado: 2_500_000,
      valorIntermediacion: 250_000,
      valorPagar: 2_250_000,
    }
  );
});

test("normaliza ajustes manuales por credito y conserva el cero explicito", () => {
  assert.deepEqual(
    normalizeAllyPaymentIntermediationAdjustments([
      { creditoId: 22, porcentajeIntermediacion: 5 },
      { creditoId: 11, porcentajeIntermediacion: 0 },
      { creditoId: 33, porcentajeIntermediacion: 10.25 },
      { creditoId: 44, porcentajeIntermediacion: 100 },
    ]),
    [
      { creditoId: 11, porcentajeIntermediacion: 0 },
      { creditoId: 22, porcentajeIntermediacion: 5 },
      { creditoId: 33, porcentajeIntermediacion: 10.25 },
      { creditoId: 44, porcentajeIntermediacion: 100 },
    ]
  );
  assert.throws(
    () => normalizeAllyPaymentIntermediationAdjustments([
      { creditoId: 11, porcentajeIntermediacion: "5" },
    ]),
    /entre 0 y 100/
  );
  assert.throws(
    () => normalizeAllyPaymentIntermediationAdjustments([
      { creditoId: 11, porcentajeIntermediacion: 5.123 },
    ]),
    /maximo dos decimales/
  );
  assert.throws(
    () => normalizeAllyPaymentIntermediationAdjustments([
      { creditoId: 11, porcentajeIntermediacion: 5 },
      { creditoId: 11, porcentajeIntermediacion: 0 },
    ]),
    /ajustes duplicados/
  );
});

test("recalcula 0 y 5 por ciento sin aceptar creditos ajenos", () => {
  const base = {
    creditId: 101,
    plataforma: "IPHONE",
    ...calculateAllyPaymentAmounts({
      valorVenta: 2_915_000,
      cuotaInicial: 874_500,
      porcentajeIntermediacion: 10,
    }),
  };
  const zero = applyAllyPaymentIntermediationAdjustments(
    [{ ...base, creditoId: 101 }],
    [{ creditoId: 101, porcentajeIntermediacion: 0 }]
  )[0];
  assert.equal(zero.creditoAutorizado, 2_040_500);
  assert.equal(zero.valorIntermediacion, 0);
  assert.equal(zero.valorPagar, 2_040_500);

  const five = applyAllyPaymentIntermediationAdjustments(
    [{ ...base, creditoId: 101 }],
    [{ creditoId: 101, porcentajeIntermediacion: 5 }]
  )[0];
  assert.equal(five.valorIntermediacion, 102_025);
  assert.equal(five.valorPagar, 1_938_475);
  assert.throws(
    () => applyAllyPaymentIntermediationAdjustments(
      [{ ...base, creditoId: 101 }],
      [{ creditoId: 999, porcentajeIntermediacion: 5 }]
    ),
    /no pertenece a la previsualizacion vigente/
  );
});

test("redondea dinero a dos decimales y nunca autoriza saldo negativo", () => {
  assert.equal(roundAllyPaymentMoney(1.005), 1.01);
  assert.deepEqual(
    calculateAllyPaymentAmounts({
      valorVenta: 100,
      cuotaInicial: 150,
      porcentajeIntermediacion: "10,25",
    }),
    {
      valorVenta: 100,
      cuotaInicial: 150,
      porcentajeIntermediacion: 10.25,
      creditoAutorizado: 0,
      valorIntermediacion: 0,
      valorPagar: 0,
    }
  );
});

test("resuelve un periodo Colombia inclusivo con fin UTC exclusivo", () => {
  const period = resolveColombiaPaymentPeriod("2026-09-01", "2026-09-05");

  assert.equal(period.startDate, "2026-09-01");
  assert.equal(period.endDate, "2026-09-05");
  assert.equal(period.start.toISOString(), "2026-09-01T05:00:00.000Z");
  assert.equal(period.endExclusive.toISOString(), "2026-09-06T05:00:00.000Z");

  const firstInstant = new Date("2026-09-01T05:00:00.000Z");
  const lastInstant = new Date("2026-09-06T04:59:59.999Z");
  const excludedInstant = new Date("2026-09-06T05:00:00.000Z");
  assert.equal(firstInstant >= period.start, true);
  assert.equal(lastInstant < period.endExclusive, true);
  assert.equal(excludedInstant < period.endExclusive, false);
});

test("valida fechas calendario reales, bisiestos y orden del periodo", () => {
  assert.equal(
    resolveColombiaPaymentPeriod("2024-02-29", "2024-02-29").endExclusive.toISOString(),
    "2024-03-01T05:00:00.000Z"
  );
  assert.throws(
    () => resolveColombiaPaymentPeriod("2026-02-29", "2026-03-01"),
    RangeError
  );
  assert.throws(
    () => resolveColombiaPaymentPeriod("2026-09-05", "2026-09-01"),
    RangeError
  );
  assert.throws(
    () => resolveColombiaPaymentPeriod("01/09/2026", "2026-09-05"),
    RangeError
  );
});

test("prioriza la plataforma congelada y usa la marca solo como fallback", () => {
  assert.equal(
    resolveAllyPaymentPlatform(
      { equipo: { plataforma: " iphone " } },
      "Samsung"
    ),
    "IPHONE"
  );
  assert.equal(resolveAllyPaymentPlatform({}, "Apple iPhone"), "IPHONE");
  assert.equal(resolveAllyPaymentPlatform(null, "Samsung"), "ANDROID");
  assert.equal(resolveAllyPaymentPlatform({}, ""), null);
});

test("normaliza estados anulados y el numero de aprobacion bancaria", () => {
  for (const state of ["ANULADO", " anulada ", "cancelado", "CANCELADA"]) {
    assert.equal(isAnnulledCreditState(state), true);
  }
  assert.equal(isAnnulledCreditState("GENERADO"), false);
  assert.equal(
    normalizeBankApprovalNumber("  ab-123\t 45  "),
    "AB-123 45"
  );
  assert.equal(normalizeBankApprovalNumber(null), "");
});

test("resume Android, iPhone y el total consolidado", () => {
  const android = {
    plataforma: "ANDROID",
    ...calculateAllyPaymentAmounts({
      valorVenta: 4_000_000,
      cuotaInicial: 1_500_000,
      porcentajeIntermediacion: 10,
    }),
  };
  const iphone = {
    plataforma: "IPHONE",
    ...calculateAllyPaymentAmounts({
      valorVenta: 3_000_000,
      cuotaInicial: 500_000,
      porcentajeIntermediacion: 20,
    }),
  };

  assert.deepEqual(summarizeAllyPayments([android, iphone]), {
    ANDROID: {
      plataforma: "ANDROID",
      numeroCreditos: 1,
      valorVenta: 4_000_000,
      cuotaInicial: 1_500_000,
      creditoAutorizado: 2_500_000,
      valorIntermediacion: 250_000,
      valorPagar: 2_250_000,
      porcentajeIntermediacion: 10,
    },
    IPHONE: {
      plataforma: "IPHONE",
      numeroCreditos: 1,
      valorVenta: 3_000_000,
      cuotaInicial: 500_000,
      creditoAutorizado: 2_500_000,
      valorIntermediacion: 500_000,
      valorPagar: 2_000_000,
      porcentajeIntermediacion: 20,
    },
    total: {
      plataforma: "TOTAL",
      numeroCreditos: 2,
      valorVenta: 7_000_000,
      cuotaInicial: 2_000_000,
      creditoAutorizado: 5_000_000,
      valorIntermediacion: 750_000,
      valorPagar: 4_250_000,
      porcentajeIntermediacion: null,
    },
  });
});

test("conserva el porcentaje en el consolidado cuando todas las lineas coinciden", () => {
  const amounts = calculateAllyPaymentAmounts({
    valorVenta: 100_000,
    cuotaInicial: 20_000,
    porcentajeIntermediacion: 10,
  });
  const summary = summarizeAllyPayments([
    { plataforma: "ANDROID", ...amounts },
    { plataforma: "IPHONE", ...amounts },
  ]);

  assert.equal(summary.total.porcentajeIntermediacion, 10);
  assert.equal(summary.total.numeroCreditos, 2);
});
