import {
  CAPITAL_PLAN_VERSION,
  parseCapitalPlanSnapshot,
  type CapitalPlanComponents,
  type CapitalPlanRow,
} from "@/lib/credit-principal-payment";

export const HISTORICAL_PLAN_CORRECTION_VERSION = "CORRECCION_PLAN_HISTORICO_V1" as const;
export const HISTORICAL_CHARGE_ALLOCATION_METHOD = "CAPITAL_CONSERVADO_CARGOS_HISTORICOS_PROPORCIONALES_V1" as const;
const FREQUENCIES = ["SEMANAL", "CATORCENAL", "QUINCENAL", "MENSUAL"] as const;
type Frequency = typeof FREQUENCIES[number];
type Components = { saldoCapital: number; saldoFianza: number; saldoIntereses: number; saldoSeguro?: number };
export type HistoricalPlanCorrectionTerms = {
  plazoMeses: number;
  cuotasPagadas: number;
  valorCuota: number;
  frecuenciaPago: Frequency;
  fechaProximaCuota: string;
  motivo: string;
};
export type HistoricalPlanCorrectionPayment = { id: number; valor: number; fechaAbono?: Date | string | null };
export type HistoricalPlanCorrectionInput = HistoricalPlanCorrectionTerms & {
  abonos: HistoricalPlanCorrectionPayment[];
  componentesPendientesAlCorte: Components;
  planActual: {
    totalPaid: number;
    saldoPendiente: number;
    installments: Array<{ numero: number; fechaVencimiento: string; valorProgramado: number; valorAbonado: number; saldoPendiente: number }>;
  };
  /** Next revision, not the revision being replaced. */
  revision?: number;
};
export class HistoricalPlanCorrectionError extends Error {}
function fail(message: string): never { throw new HistoricalPlanCorrectionError(message); }
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
function cents(value: unknown, label: string) {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 &&
    Math.round(value * 100) / 100 === value, `${label} debe ser un importe no negativo con máximo dos decimales.`);
  return Math.round(value * 100);
}
function money(value: number) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= 1e14, "Importe fuera del rango permitido.");
  return value / 100;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, `${label} inválido.`);
  return value;
}
function date(value: unknown, label: string): string {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), `${label} inválida.`);
  const parsed = new Date(`${value}T12:00:00.000Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, `${label} inválida.`);
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** A correction must be explicit: no rounding, coercion, guessed frequency or fictitious paid quota. */
export function parseHistoricalPlanCorrectionTerms(value: unknown): HistoricalPlanCorrectionTerms {
  check(object(value), "Faltan las condiciones de la corrección histórica.");
  const plazoMeses = integer(value.plazoMeses, 1, 60, "Número total de cuotas");
  const cuotasPagadas = integer(value.cuotasPagadas, 0, plazoMeses - 1, "Número de cuotas reconocidas como pagadas");
  const valorCuota = money(cents(value.valorCuota, "Valor de cuota"));
  check(valorCuota > 0, "La cuota debe ser mayor a cero.");
  const frecuenciaPago = value.frecuenciaPago;
  check(typeof frecuenciaPago === "string" && (FREQUENCIES as readonly string[]).includes(frecuenciaPago), "Frecuencia de pago inválida.");
  const fechaProximaCuota = date(value.fechaProximaCuota, "Fecha de la próxima cuota");
  if (frecuenciaPago === "QUINCENAL") {
    check([2, 17].includes(Number(fechaProximaCuota.slice(8))), "El calendario quincenal vence los días 2 y 17.");
  }
  const motivo = typeof value.motivo === "string" ? value.motivo.trim() : "";
  check(motivo.length >= 10 && motivo.length <= 1000, "Indica el motivo de la corrección (10 a 1000 caracteres).");
  return { plazoMeses, cuotasPagadas, valorCuota, frecuenciaPago: frecuenciaPago as Frequency, fechaProximaCuota, motivo };
}

function calendarDate(anchor: string, frequency: Frequency, periods: number) {
  const [year, month, day] = anchor.split("-").map(Number);
  let result: Date;
  if (frequency === "QUINCENAL") {
    const half = (month - 1) * 2 + (day === 17 ? 1 : 0) + periods;
    const targetYear = year + Math.floor(half / 24);
    const targetHalf = ((half % 24) + 24) % 24;
    result = new Date(Date.UTC(targetYear, Math.floor(targetHalf / 2), targetHalf % 2 === 0 ? 2 : 17, 12));
  } else if (frequency === "MENSUAL") {
    result = new Date(Date.UTC(year, month - 1 + periods, 1, 12));
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0, 12)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
  } else {
    result = new Date(Date.UTC(year, month - 1, day + periods * (frequency === "SEMANAL" ? 7 : 14), 12));
  }
  check(Number.isFinite(result.getTime()), "Calendario fuera del rango permitido.");
  return date(result.toISOString().slice(0, 10), "Fecha del calendario");
}

/** Largest remainder, integer cents. The same rule reconciles both row and column totals. */
function apportion(total: number, weights: number[]) {
  const denominator = weights.reduce((sum, weight) => sum + BigInt(weight), BigInt(0));
  if (denominator === BigInt(0)) {
    check(total === 0, "Falta una clasificación histórica de cargos para distribuir la obligación corregida.");
    return weights.map(() => 0);
  }
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, value: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let unassigned = total - parts.reduce((sum, part) => sum + part.value, 0);
  for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (unassigned === 0) break;
    part.value += 1;
    unassigned -= 1;
  }
  check(unassigned === 0, "No se pudo conciliar la distribución del calendario.");
  return parts.map(part => part.value);
}

/**
 * Administrative schedule correction. It neither creates a receipt nor infers a new rate.
 * The current principal is retained; only the agreed remaining charges are re-expressed
 * using their existing classification. The actual cash cut is deliberately independent
 * of the newly recognized nominal paid installments, and both are returned for the audit.
 */
export function createHistoricalPlanCorrectionQuote(input: HistoricalPlanCorrectionInput) {
  check(object(input), "Falta la corrección histórica.");
  const terms = parseHistoricalPlanCorrectionTerms(input);
  const revision = integer(input.revision ?? 1, 1, 2147483647, "Revisión del plan");
  check(Array.isArray(input.abonos) && input.abonos.length <= 10000, "Historial de abonos inválido.");
  const ids = new Set<number>();
  let cashCut = 0;
  const abonosConservados = input.abonos.map(payment => {
    check(object(payment), "Abono histórico inválido.");
    const id = integer(payment.id, 1, Number.MAX_SAFE_INTEGER, "Identificador del abono");
    check(!ids.has(id), "El historial contiene abonos duplicados.");
    ids.add(id);
    const value = cents(payment.valor, "Valor del abono");
    check(value > 0, "El abono histórico debe ser mayor a cero.");
    cashCut += value;
    money(cashCut);
    const fechaAbono = payment.fechaAbono instanceof Date ? payment.fechaAbono.toISOString() : payment.fechaAbono;
    check(fechaAbono == null || (typeof fechaAbono === "string" && fechaAbono.trim().length > 0 && Number.isFinite(new Date(fechaAbono).getTime())), "Fecha del abono histórico inválida.");
    return { id, valor: money(value), ...(fechaAbono === undefined ? {} : { fechaAbono }) };
  });
  const current = input.planActual;
  check(object(current) && Array.isArray(current.installments) && current.installments.length > 0 && current.installments.length <= 600, "Falta el calendario vigente que se va a corregir.");
  check(cents(current.totalPaid, "Total recaudado actual") === cashCut, "Los recibos conservados no concilian con el total recaudado actual.");
  const pendingBefore = cents(current.saldoPendiente, "Saldo pendiente actual");
  check(pendingBefore > 0, "El crédito no tiene saldo pendiente para corregir.");
  let rowPaid = 0;
  let rowPending = 0;
  let priorDate = "";
  for (const [index, row] of current.installments.entries()) {
    check(object(row) && row.numero === index + 1, "El calendario vigente no conserva una numeración completa.");
    const due = date(row.fechaVencimiento, "Fecha del calendario vigente");
    check(due > priorDate, "El calendario vigente contiene fechas desordenadas.");
    priorDate = due;
    const programmed = cents(row.valorProgramado, "Cuota vigente");
    const paid = cents(row.valorAbonado, "Pago de cuota vigente");
    const pending = cents(row.saldoPendiente, "Saldo de cuota vigente");
    check(paid + pending === programmed, "Una cuota vigente no concilia con sus abonos y saldo.");
    rowPaid += paid;
    rowPending += pending;
    money(rowPaid);
    money(rowPending);
  }
  check(rowPaid === cashCut && rowPending === pendingBefore, "El calendario vigente no concilia con los recibos y el saldo actual.");
  const quota = cents(terms.valorCuota, "Valor de cuota");
  const nominalPaid = quota * terms.cuotasPagadas;
  const pendingCount = terms.plazoMeses - terms.cuotasPagadas;
  const pendingAfter = quota * pendingCount;
  const nominalTotal = quota * terms.plazoMeses;
  money(nominalTotal);
  check(cashCut >= nominalPaid, "Los recibos existentes no alcanzan para reconocer las cuotas pagadas solicitadas.");
  const priorComponents = input.componentesPendientesAlCorte;
  check(object(priorComponents), "Falta el desglose del saldo histórico vigente.");
  const principal = cents(priorComponents.saldoCapital, "Capital pendiente actual");
  const originalCharges = [
    cents(priorComponents.saldoFianza, "Fianza pendiente actual"),
    cents(priorComponents.saldoIntereses, "Intereses pendientes actuales"),
    cents(priorComponents.saldoSeguro ?? 0, "Seguro pendiente actual"),
  ];
  check(principal > 0 && principal + originalCharges.reduce((sum, value) => sum + value, 0) === pendingBefore,
    "El desglose histórico no concilia con el saldo pendiente vigente.");
  check(principal <= pendingAfter, "Las cuotas solicitadas no cubren el capital pendiente histórico.");
  const charges = apportion(pendingAfter - principal, originalCharges);
  let remaining = [principal, charges[1], charges[0], charges[2]];
  const cuotas: CapitalPlanRow[] = Array.from({ length: terms.plazoMeses }, (_, index) => {
    const numero = index + 1;
    const fechaVencimiento = calendarDate(terms.fechaProximaCuota, terms.frecuenciaPago, index - terms.cuotasPagadas);
    if (index < terms.cuotasPagadas) {
      return { numero, fechaVencimiento, valorProgramado: terms.valorCuota, valorAbonadoAlCorte: terms.valorCuota, eliminada: false };
    }
    const allocated = apportion(quota, remaining);
    remaining = remaining.map((value, component) => value - allocated[component]);
    const components: CapitalPlanComponents = {
      capital: money(allocated[0]), interes: money(allocated[1]), fianza: money(allocated[2]), seguro: money(allocated[3]),
    };
    return { numero, fechaVencimiento, valorProgramado: terms.valorCuota, valorAbonadoAlCorte: 0, eliminada: false,
      ...components, saldoCapital: money(remaining[0]) };
  });
  check(remaining.every(value => value === 0), "El calendario corregido no cierra sus componentes financieros.");
  const next = cuotas[terms.cuotasPagadas];
  const planCapitalVigente = parseCapitalPlanSnapshot({
    version: CAPITAL_PLAN_VERSION, revision, requiereConciliacionTasaPeriodo: true,
    totalAbonadoAlCorte: money(cashCut), abonosAlCorte: abonosConservados.map(({ id, valor }) => ({ id, valor })),
    saldoCapitalAlCorte: money(principal), numeroCuotasOriginal: terms.plazoMeses,
    parametros: {
      capitalPendiente: money(principal), tasaPeriodo: 0,
      cuotaCredito: money(cents(next.capital, "Capital de la próxima cuota") + cents(next.interes, "Interés de la próxima cuota")),
      fianzaCuota: next.fianza, seguroCuota: next.seguro, numeroProximaCuota: next.numero,
      fuente: `Corrección administrativa de calendario: capital vigente conservado y cargos históricos redistribuidos proporcionalmente. No se infiere tasa periódica; requiere conciliación documental antes de un abono a capital. Motivo: ${terms.motivo}`.slice(0, 1000),
    }, cuotas,
  })!;
  const last = cuotas[cuotas.length - 1];
  return {
    ...terms,
    version: HISTORICAL_PLAN_CORRECTION_VERSION,
    metodoAsignacionCargos: HISTORICAL_CHARGE_ALLOCATION_METHOD,
    planCapitalVigente,
    montoCreditoActualizado: money(cashCut + pendingAfter),
    totalPlanNominal: money(nominalTotal),
    totalAbonadoAlCorte: money(cashCut),
    totalNominalCuotasPagadas: money(nominalPaid),
    diferenciaHistorica: money(cashCut - nominalPaid),
    saldoPendiente: money(pendingAfter),
    saldoPendienteAntes: money(pendingBefore),
    cuotasPendientes: pendingCount,
    fechaPrimerPago: cuotas[0].fechaVencimiento,
    proximaCuota: { numero: next.numero, fechaVencimiento: next.fechaVencimiento, valor: next.valorProgramado },
    ultimaCuota: { numero: last.numero, fechaVencimiento: last.fechaVencimiento, valor: last.valorProgramado },
    componentesPendientesAlCorte: { saldoCapital: money(principal), saldoFianza: money(originalCharges[0]), saldoIntereses: money(originalCharges[1]), saldoSeguro: money(originalCharges[2]) },
    componentesPendientes: { saldoCapital: money(principal), saldoFianza: money(charges[0]), saldoIntereses: money(charges[1]), saldoSeguro: money(charges[2]) },
    abonosConservados,
  };
}

export type HistoricalPlanCorrectionQuote = ReturnType<typeof createHistoricalPlanCorrectionQuote>;
