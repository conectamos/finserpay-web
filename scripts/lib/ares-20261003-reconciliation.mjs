/**
 * Documented ARES state after the 2026-10-03 receipt. This module prepares a
 * plan snapshot only; it never reads or writes a credit, payment, or cashbox.
 *
 * Sources: ARES historial (R0100001108, R0100001393) and the payment plan
 * supplied for this one imported credit. The reversed R0100001061 is excluded.
 */

export const ARES_20261003_RECEIPTS = Object.freeze([
  Object.freeze({
    document: "R0100001108", date: "2026-09-18", received: 400_000,
    ordinaryInstallment: 158_500, extraordinaryPrincipal: 241_449,
    additionalInterest: 0, lateFee: 51,
  }),
  Object.freeze({
    document: "R0100001393", date: "2026-10-03", received: 160_000,
    ordinaryInstallment: 158_500, extraordinaryPrincipal: 0,
    additionalInterest: 1_442, lateFee: 58,
  }),
]);

export const ARES_20261003_EXPECTED = Object.freeze({
  originalPrincipal: 1_452_000,
  ordinaryInstallment: 158_500,
  ordinaryCreditComponent: 94_560,
  suretyPerInstallment: 63_505,
  insurancePerInstallment: 435,
  periodicRate: 0.010881,
  totalReceived: 560_000,
  principalAfterReceipts: 1_058_115,
  nextInstallment: 3,
  nextDueDate: "2026-10-17",
  futureInstallmentsTotal: 1_901_700,
  revisedCreditTotal: 2_461_700,
});

// The two historical rows and every future row are transcribed from the ARES
// payment plan. Each row is [date, principal, interest, principal balance].
const SOURCE_ROWS = [
  ["2026-09-17", 70_283, 24_277, 1_381_717],
  ["2026-10-02", 82_153, 12_407, 1_058_115],
  ["2026-10-17", 83_047, 11_513, 975_068],
  ["2026-11-02", 83_950, 10_610, 891_118],
  ["2026-11-17", 84_864, 9_696, 806_254],
  ["2026-12-02", 85_787, 8_773, 720_467],
  ["2026-12-17", 86_721, 7_839, 633_746],
  ["2027-01-02", 87_664, 6_896, 546_082],
  ["2027-01-17", 88_618, 5_942, 457_464],
  ["2027-02-02", 89_582, 4_978, 367_882],
  ["2027-02-17", 90_557, 4_003, 277_325],
  ["2027-03-02", 91_542, 3_018, 185_783],
  ["2027-03-17", 92_538, 2_022, 93_245],
  ["2027-04-02", 93_245, 1_015, 0],
  ["2027-04-17", 0, 0, 0],
  ["2027-05-02", 0, 0, 0],
  ["2027-05-17", 0, 0, 0],
];

function requireMoney(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > 1e12 || Math.round(value * 100) / 100 !== value) {
    throw new Error(`${label} debe ser un importe valido con maximo dos decimales.`);
  }
  return value;
}

/**
 * Reconcile source amounts separately from FINSER payment IDs. In particular,
 * the 1,500 above the second scheduled installment is interest/mora, not an
 * advance to the third installment.
 */
export function assertAres20261003Source() {
  const expected = ARES_20261003_EXPECTED;
  const [first, second] = ARES_20261003_RECEIPTS;
  for (const receipt of ARES_20261003_RECEIPTS) {
    const allocated = receipt.ordinaryInstallment + receipt.extraordinaryPrincipal +
      receipt.additionalInterest + receipt.lateFee;
    if (allocated !== receipt.received) throw new Error(`El recibo ${receipt.document} no concilia.`);
  }
  if (first.ordinaryInstallment !== expected.ordinaryInstallment ||
      second.ordinaryInstallment !== expected.ordinaryInstallment ||
      first.received + second.received !== expected.totalReceived ||
      expected.originalPrincipal - SOURCE_ROWS[0][1] - first.extraordinaryPrincipal - SOURCE_ROWS[1][1] !== expected.principalAfterReceipts ||
      second.additionalInterest + second.lateFee !== second.received - second.ordinaryInstallment) {
    throw new Error("Los recibos ARES no concilian con el capital y las cuotas del plan.");
  }
  return true;
}

function validatedAbonos(abonos) {
  if (!Array.isArray(abonos) || abonos.length !== 2) {
    throw new Error("Se requieren exactamente los dos recaudos activos documentados por ARES.");
  }
  const result = abonos.map((abono) => {
    if (!abono || typeof abono !== "object" || Array.isArray(abono) ||
        !Number.isSafeInteger(abono.id) || abono.id <= 0) {
      throw new Error("Cada recaudo activo requiere un ID valido.");
    }
    return { id: abono.id, valor: requireMoney(abono.valor, "Valor del recaudo") };
  });
  if (new Set(result.map((abono) => abono.id)).size !== result.length) {
    throw new Error("Los recaudos activos no pueden tener IDs duplicados.");
  }
  const values = result.map((abono) => abono.valor).sort((a, b) => a - b);
  if (values[0] !== 160_000 || values[1] !== 400_000) {
    throw new Error("Los recaudos activos deben corresponder a $400.000 y $160.000 de ARES.");
  }
  return result.sort((a, b) => a.id - b.id);
}

/**
 * Build the exact post-03/10 cut for these two source receipts. The caller must
 * verify credit identity and payment dates against the live database before
 * persisting anything. This deliberately rejects partial or extra receipts.
 *
 * @param {Array<{id:number,valor:number}>} abonos Active FINSER payments.
 * @returns {import('../../lib/credit-principal-payment.ts').CapitalPlanSnapshot}
 */
export function buildAres20261003Snapshot(abonos) {
  assertAres20261003Source();
  const abonosAlCorte = validatedAbonos(abonos);
  const expected = ARES_20261003_EXPECTED;
  const cuotas = SOURCE_ROWS.map(([date, capital, interest, principalBalance], index) => {
    const eliminated = capital === 0 && interest === 0;
    const fianza = eliminated ? 0 : expected.suretyPerInstallment;
    const seguro = eliminated ? 0 : expected.insurancePerInstallment;
    return {
      numero: index + 1,
      fechaVencimiento: date,
      valorProgramado: capital + interest + fianza + seguro,
      valorAbonadoAlCorte: index < 2 ? expected.ordinaryInstallment : 0,
      eliminada: eliminated,
      capital, interes: interest, fianza, seguro,
      saldoCapital: principalBalance,
    };
  });
  const futureTotal = cuotas.slice(2).reduce((sum, row) => sum + row.valorProgramado, 0);
  const futurePrincipal = cuotas.slice(2).reduce((sum, row) => sum + row.capital, 0);
  if (cuotas.length !== 17 || futureTotal !== expected.futureInstallmentsTotal ||
      futurePrincipal !== expected.principalAfterReceipts ||
      cuotas[2].valorProgramado !== expected.ordinaryInstallment ||
      cuotas[2].fechaVencimiento !== expected.nextDueDate ||
      expected.totalReceived + futureTotal !== expected.revisedCreditTotal) {
    throw new Error("El calendario ARES no concilia con el corte financiero.");
  }
  return {
    version: "CAPITAL_REDUCCION_PLAZO_V1",
    revision: 1,
    totalAbonadoAlCorte: expected.totalReceived,
    abonosAlCorte,
    saldoCapitalAlCorte: expected.principalAfterReceipts,
    numeroCuotasOriginal: cuotas.length,
    parametros: {
      capitalPendiente: expected.principalAfterReceipts,
      tasaPeriodo: expected.periodicRate,
      cuotaCredito: expected.ordinaryCreditComponent,
      fianzaCuota: expected.suretyPerInstallment,
      seguroCuota: expected.insurancePerInstallment,
      numeroProximaCuota: expected.nextInstallment,
      fuente: "ARES historial R0100001108 (18/09/2026) y R0100001393 (03/10/2026); plan de pagos actual al 03/10/2026.",
    },
    cuotas,
  };
}
