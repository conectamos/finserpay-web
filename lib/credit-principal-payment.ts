/** Versioned, reconciled principal payments. Never guesses historical principal. */
export const CAPITAL_PLAN_VERSION = "CAPITAL_REDUCCION_PLAZO_V1" as const;

export class CapitalPaymentValidationError extends Error {}

export type CapitalConciliation = {
  capitalPendiente: number;
  tasaPeriodo: number;
  cuotaCredito: number;
  fianzaCuota: number;
  seguroCuota: number;
  numeroProximaCuota: number;
  fuente: string;
};
export type CapitalPlanRow = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonadoAlCorte: number;
  eliminada: boolean;
  capital?: number;
  interes?: number;
  fianza?: number;
  seguro?: number;
  saldoCapital?: number;
};
export type CapitalPlanSnapshot = {
  version: typeof CAPITAL_PLAN_VERSION;
  revision: number;
  totalAbonadoAlCorte: number;
  abonosAlCorte: Array<{ id: number; valor: number }>;
  saldoCapitalAlCorte: number;
  numeroCuotasOriginal: number;
  parametros: CapitalConciliation;
  cuotas: CapitalPlanRow[];
};

type CurrentPlanRow = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  eliminada?: boolean;
};
type CurrentPlan = {
  installments: CurrentPlanRow[];
  totalPaid: number;
  saldoPendiente: number;
  overdueCount: number;
};
type AllocatedComponents = { capital: number; interes: number; fianza: number; seguro: number };

function fail(message: string): never {
  throw new CapitalPaymentValidationError(message);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} invalido.`);
  return value as Record<string, unknown>;
}
function cash(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12 ||
      Math.round(value * 100) / 100 !== value) fail(`${field} debe ser un importe valido con maximo dos decimales.`);
  return value;
}
function cents(value: number): number { return Math.round(value * 100); }
function fromCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("Importe fuera del rango permitido.");
  return value / 100;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(`${field} invalido.`);
  return value;
}
function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("Fecha del calendario invalida.");
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("Fecha del calendario invalida.");
  return value;
}
export function parseCapitalConciliation(value: unknown): CapitalConciliation {
  const obj = record(value, "Conciliacion documental");
  const rate = obj.tasaPeriodo;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1 ||
      Math.round(rate * 1e12) / 1e12 !== rate) fail("La tasa periodica debe ser decimal, entre 0 y 1, con maximo 12 decimales.");
  const fuente = typeof obj.fuente === "string" ? obj.fuente.trim() : "";
  if (fuente.length < 10 || fuente.length > 1000) fail("Indica el documento y la fecha del saldo conciliado (10 a 1000 caracteres).");
  const result: CapitalConciliation = {
    capitalPendiente: cash(obj.capitalPendiente, "Capital pendiente"), tasaPeriodo: rate,
    cuotaCredito: cash(obj.cuotaCredito, "Cuota capital e interes"),
    fianzaCuota: cash(obj.fianzaCuota, "Aval por cuota"), seguroCuota: cash(obj.seguroCuota, "Seguro por cuota"),
    numeroProximaCuota: integer(obj.numeroProximaCuota, "Proxima cuota"), fuente,
  };
  if (!result.capitalPendiente || !result.cuotaCredito) fail("El capital y la cuota del credito deben ser positivos.");
  return result;
}

/** Invalid non-null snapshots must fail closed, never revert to the original FIFO plan. */
export function parseCapitalPlanSnapshot(value: unknown): CapitalPlanSnapshot | null {
  if (value === undefined || value === null) return null;
  const obj = record(value, "Plan vigente de capital");
  if (obj.version !== CAPITAL_PLAN_VERSION) fail("Version del plan de capital no reconocida.");
  const parametros = parseCapitalConciliation(obj.parametros);
  const numeroCuotasOriginal = integer(obj.numeroCuotasOriginal, "Plazo original");
  if (numeroCuotasOriginal > 600 || !Array.isArray(obj.cuotas) || obj.cuotas.length !== numeroCuotasOriginal) fail("Calendario de capital incompleto.");
  let priorDate = "";
  let removed = false;
  const cuotas = obj.cuotas.map((value, index): CapitalPlanRow => {
    const row = record(value, "Cuota");
    const numero = integer(row.numero, "Numero de cuota");
    if (numero !== index + 1) fail("El calendario debe conservar la numeracion original.");
    const date = validDate(row.fechaVencimiento);
    if (date <= priorDate) fail("Los vencimientos deben estar ordenados.");
    priorDate = date;
    const valorProgramado = cash(row.valorProgramado, "Valor programado");
    const valorAbonadoAlCorte = cash(row.valorAbonadoAlCorte, "Abonado al corte");
    if (valorAbonadoAlCorte > valorProgramado || typeof row.eliminada !== "boolean") fail("Estado de cuota invalido.");
    if (removed && !row.eliminada) fail("No pueden existir cuotas activas despues del cierre del capital.");
    removed = removed || row.eliminada;
    const result: CapitalPlanRow = { numero, fechaVencimiento: date, valorProgramado, valorAbonadoAlCorte, eliminada: row.eliminada };
    if (row.capital !== undefined) {
      result.capital = cash(row.capital, "Capital de cuota");
      result.interes = cash(row.interes, "Interes de cuota");
      result.fianza = cash(row.fianza, "Aval de cuota");
      result.seguro = cash(row.seguro, "Seguro de cuota");
      result.saldoCapital = cash(row.saldoCapital, "Saldo capital de cuota");
      if (cents(result.capital) + cents(result.interes) + cents(result.fianza) + cents(result.seguro) !== cents(valorProgramado)) fail("Los componentes no concilian con la cuota.");
    } else if (valorProgramado !== valorAbonadoAlCorte) {
      fail("Una cuota pendiente requiere desglose financiero.");
    }
    if (result.eliminada && (valorProgramado !== 0 || valorAbonadoAlCorte !== 0 || (result.saldoCapital || 0) !== 0)) fail("Una cuota eliminada debe estar en cero.");
    return result;
  });
  if (!Array.isArray(obj.abonosAlCorte)) fail("Falta el registro de recaudos al corte.");
  const ids = new Set<number>();
  const abonosAlCorte = obj.abonosAlCorte.map((value) => {
    const abono = record(value, "Abono al corte");
    const id = integer(abono.id, "Id del abono");
    if (ids.has(id)) fail("Abono duplicado en el corte.");
    ids.add(id);
    return { id, valor: cash(abono.valor, "Valor del abono") };
  });
  const totalAbonadoAlCorte = cash(obj.totalAbonadoAlCorte, "Total abonado al corte");
  if (abonosAlCorte.reduce((sum, abono) => sum + cents(abono.valor), 0) !== cents(totalAbonadoAlCorte)) fail("Los recaudos del corte no concilian.");
  const saldoCapitalAlCorte = cash(obj.saldoCapitalAlCorte, "Saldo capital al corte");
  const remaining = cuotas.reduce((sum, row) => sum + (row.capital === undefined ? 0 : cents(row.capital) - cents(allocateComponents(row, row.valorAbonadoAlCorte).capital)), 0);
  if (remaining !== cents(saldoCapitalAlCorte)) fail("El saldo capital del calendario no concilia.");
  return { version: CAPITAL_PLAN_VERSION, revision: integer(obj.revision, "Revision"), numeroCuotasOriginal,
    totalAbonadoAlCorte, abonosAlCorte, saldoCapitalAlCorte, parametros, cuotas };
}

function allocateComponents(row: CapitalPlanRow, paid: number): AllocatedComponents {
  let available = cents(paid);
  const result: AllocatedComponents = { capital: 0, interes: 0, fianza: 0, seguro: 0 };
  // Ordinary payments after the reconciled cut: interest, fixed charges, principal.
  for (const key of ["interes", "fianza", "seguro", "capital"] as const) {
    const allocated = Math.min(available, cents(row[key] || 0));
    result[key] = fromCents(allocated);
    available -= allocated;
  }
  return result;
}

export function resolveCapitalPlanRows(snapshot: CapitalPlanSnapshot, totalPaid: number) {
  let available = cents(cash(totalPaid, "Total recaudado")) - cents(snapshot.totalAbonadoAlCorte);
  if (available < 0) fail("Los recaudos anteriores al abono a capital cambiaron. Se requiere conciliacion.");
  const rows = snapshot.cuotas.map((row) => {
    const room = cents(row.valorProgramado) - cents(row.valorAbonadoAlCorte);
    const added = Math.min(room, available);
    available -= added;
    const paid = fromCents(cents(row.valorAbonadoAlCorte) + added);
    const componentsPaid = allocateComponents(row, paid);
    return { ...row, valorAbonado: paid, saldoPendiente: fromCents(cents(row.valorProgramado) - cents(paid)),
      capitalPendiente: row.capital === undefined ? 0 : fromCents(cents(row.capital) - cents(componentsPaid.capital)), componentsPaid };
  });
  if (available > 0) fail("El recaudo supera el saldo del plan de capital vigente.");
  return rows;
}

export function getCapitalOutstandingBalance(value: unknown, totalPaid: number) {
  const snapshot = parseCapitalPlanSnapshot(value);
  if (!snapshot) return null;
  const rows = resolveCapitalPlanRows(snapshot, totalPaid);
  const pending = (key: keyof AllocatedComponents) => fromCents(rows.reduce((sum, row) =>
    sum + (row[key] === undefined ? 0 : cents(row[key]) - cents(row.componentsPaid[key])), 0));
  return { saldoCapital: pending("capital"), saldoFianza: pending("fianza"),
    saldoIntereses: pending("interes"), saldoSeguro: pending("seguro") };
}

/** Peso rounding on EACH period, with integer arithmetic, not floating tie guesses. */
function interestCents(principalCents: number, rate: number) {
  const denominator = BigInt(100) * BigInt(1_000_000_000_000);
  const numerator = BigInt(principalCents) * BigInt(Math.round(rate * 1e12));
  return Number((numerator + denominator / BigInt(2)) / denominator) * 100;
}

export function createPrincipalPaymentQuote(input: {
  plan: CurrentPlan;
  planCapitalVigente?: unknown;
  conciliacion?: unknown;
  valor: number;
  capitalOriginal: number;
  cuotaHabitual: number;
  abonos: Array<{ id: number; valor: number }>;
}) {
  const valor = cash(input.valor, "Abono extraordinario");
  if (!valor) fail("El abono a capital debe ser mayor a cero.");
  if (input.plan.overdueCount > 0) fail("Paga primero las cuotas vencidas antes de abonar a capital.");
  const original = cash(input.capitalOriginal, "Capital original");
  if (!original) fail("Falta el capital original documentado del credito.");
  const habitual = cash(input.cuotaHabitual, "Cuota habitual");
  const snapshot = parseCapitalPlanSnapshot(input.planCapitalVigente);
  const abonos = input.abonos.map((abono) => ({ id: integer(abono.id, "Id abono"), valor: cash(abono.valor, "Valor abono") }));
  if (new Set(abonos.map((abono) => abono.id)).size !== abonos.length ||
      abonos.reduce((sum, abono) => sum + cents(abono.valor), 0) !== cents(input.plan.totalPaid)) fail("El historial de recaudos no concilia.");
  if (snapshot && snapshot.abonosAlCorte.some((before) => !abonos.some((now) => now.id === before.id && now.valor === before.valor))) fail("Cambió un recaudo que sustenta el plan de capital.");
  const actual = snapshot ? resolveCapitalPlanRows(snapshot, input.plan.totalPaid) : null;
  const next = input.plan.installments.find((row) => row.saldoPendiente > 0);
  if (!next) fail("El credito no tiene cuotas pendientes.");
  const parametros = snapshot ? snapshot.parametros : parseCapitalConciliation(input.conciliacion);
  if (!snapshot && parametros.numeroProximaCuota !== next.numero) fail("La proxima cuota no coincide: registra primero las cuotas ordinarias y vuelve a consultar.");
  if (cents(parametros.cuotaCredito) + cents(parametros.fianzaCuota) + cents(parametros.seguroCuota) !== cents(habitual)) fail("Capital/interes, aval y seguro deben sumar la cuota habitual pactada.");
  const before = actual ? fromCents(actual.reduce((sum, row) => sum + cents(row.capitalPendiente), 0)) : parametros.capitalPendiente;
  if (before > original) fail("El capital conciliado supera el capital original.");
  const pendingBefore = cash(input.plan.saldoPendiente, "Saldo pendiente actual");
  if (before > pendingBefore) fail("El capital conciliado supera el saldo total exigible. Revisa la conciliacion antes de continuar.");
  if (valor >= before) fail("El abono parcial debe ser menor al capital pendiente. La liquidacion total requiere otro procedimiento.");
  const after = fromCents(cents(before) - cents(valor));
  let balance = cents(after);
  let lastActive: CapitalPlanRow | null = null;
  const cuotas: CapitalPlanRow[] = input.plan.installments.map((row) => {
    if (row.numero < next.numero) {
      const existing = actual?.find((item) => item.numero === row.numero);
      return { ...(existing ? { capital: existing.capital, interes: existing.interes, fianza: existing.fianza, seguro: existing.seguro, saldoCapital: existing.saldoCapital } : {}),
        numero: row.numero, fechaVencimiento: row.fechaVencimiento, valorProgramado: row.valorProgramado,
        valorAbonadoAlCorte: row.valorAbonado, eliminada: Boolean(row.eliminada) };
    }
    const eliminated = balance === 0;
    const interest = eliminated ? 0 : interestCents(balance, parametros.tasaPeriodo);
    const fixed = cents(parametros.cuotaCredito);
    if (!eliminated && fixed <= interest) fail("La cuota no alcanza a amortizar capital con los parametros documentados.");
    const principal = eliminated ? 0 : Math.min(balance, fixed - interest);
    const paid = row.numero === next.numero ? cents(row.valorAbonado) : 0;
    if (paid > interest) fail("La cuota parcial contiene pagos superiores al nuevo interes. Completa esa cuota o solicita conciliacion antes del abono.");
    balance -= principal;
    const surety = eliminated ? 0 : cents(parametros.fianzaCuota);
    const insurance = eliminated ? 0 : cents(parametros.seguroCuota);
    const result: CapitalPlanRow = { numero: row.numero, fechaVencimiento: row.fechaVencimiento,
      valorProgramado: fromCents(principal + interest + surety + insurance), valorAbonadoAlCorte: fromCents(paid),
      eliminada: eliminated, capital: fromCents(principal), interes: fromCents(interest),
      fianza: fromCents(surety), seguro: fromCents(insurance), saldoCapital: fromCents(balance) };
    if (!eliminated) lastActive = result;
    return result;
  });
  if (balance > 0 || !lastActive) fail("El calendario disponible no permite liquidar el capital sin ampliar el plazo.");
  const saldoPendienteDespues = fromCents(cuotas.reduce((sum, row) => sum + cents(row.valorProgramado) - cents(row.valorAbonadoAlCorte), 0));
  if (cents(saldoPendienteDespues) > cents(pendingBefore) - cents(valor)) {
    fail("La conciliacion aumentaria la obligacion total. Un abono a capital no puede generar una deuda mayor; verifica los parametros documentados.");
  }
  const totalAbonadoAlCorte = fromCents(cents(input.plan.totalPaid) + cents(valor));
  const cuotasPendientesAntes = input.plan.installments.filter((row) => row.saldoPendiente > 0).length;
  const cuotasPendientesDespues = cuotas.filter((row) => row.valorProgramado > row.valorAbonadoAlCorte).length;
  const planCapitalVigente: CapitalPlanSnapshot = { version: CAPITAL_PLAN_VERSION, revision: (snapshot?.revision || 0) + 1,
    totalAbonadoAlCorte, abonosAlCorte: abonos, saldoCapitalAlCorte: after, numeroCuotasOriginal: cuotas.length, parametros, cuotas };
  // The new receipt id is appended atomically by the persistence layer before validation/storage.
  const last = lastActive as CapitalPlanRow;
  return { planCapitalVigente, montoCreditoActualizado: fromCents(cents(totalAbonadoAlCorte) + cents(saldoPendienteDespues)),
    saldoCapitalAntes: before, saldoCapitalDespues: after, abonoCapital: valor, cuotaHabitual: habitual,
    ultimaCuota: { numero: last.numero, fechaVencimiento: last.fechaVencimiento, valor: last.valorProgramado },
    cuotasPendientesAntes, cuotasPendientesDespues, cuotasEliminadas: cuotasPendientesAntes - cuotasPendientesDespues,
    saldoPendienteAntes: input.plan.saldoPendiente, saldoPendienteDespues };
}
