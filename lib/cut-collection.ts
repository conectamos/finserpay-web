import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { parseCapitalPlanSnapshot } from "@/lib/credit-principal-payment";
import type { CutBaselineInstallment, CutCredit, CutPayment, CutRow, CutSnapshot, CutSummary } from "@/lib/cut-collection-types";

export class CutCollectionError extends Error {
  constructor(message: string) { super(message); this.name = "CutCollectionError"; }
}

function cents(value: number) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) {
    throw new CutCollectionError("Existe un importe de recaudo inválido. Se requiere conciliación.");
  }
  return Math.round(value * 100);
}
function money(value: number) { return value / 100; }
function active(payment: CutPayment) {
  return !["ANULADO", "REVERSADO", "REVERTIDO"].includes(payment.state.trim().toUpperCase());
}
function paymentsById(payments: CutPayment[]) {
  const result = new Map<number, CutPayment>();
  for (const payment of payments) {
    if (!Number.isSafeInteger(payment.id) || payment.id <= 0) throw new CutCollectionError("Identificador de recaudo inválido.");
    cents(payment.value);
    const previous = result.get(payment.id);
    if (previous && (cents(previous.value) !== cents(payment.value) || previous.state !== payment.state)) {
      throw new CutCollectionError(`El recaudo ${payment.id} aparece con valores o estados distintos. Se requiere conciliación.`);
    }
    if (!previous) result.set(payment.id, payment);
  }
  return result;
}
function calendar(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new CutCollectionError("La fecha del corte es inválida.");
  }
  return value;
}
function requireCreditDate(credit: CutCredit, capitalFirstDate?: string) {
  const value = credit.plan.fechaPrimerPago || credit.plan.fechaProximoPago || capitalFirstDate;
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    throw new CutCollectionError(`El crédito ${credit.folio} no tiene un primer vencimiento válido. Se requiere conciliación.`);
  }
  return value;
}

/** The platform applies active receipts FIFO. Selection labels are not a payment ledger. */
function allocation(credit: CutCredit, today: string) {
  const payments = paymentsById(credit.payments);
  const capital = parseCapitalPlanSnapshot(credit.plan.planCapitalVigente);
  const firstDueDate = requireCreditDate(credit, capital?.cuotas[0]?.fechaVencimiento);
  const seedIds = new Set<number>();
  const seed = new Map<number, number>();
  if (capital) {
    for (const entry of capital.abonosAlCorte) {
      const payment = payments.get(entry.id);
      if (!payment || !active(payment) || cents(payment.value) !== cents(entry.valor)) {
        throw new CutCollectionError(`El crédito ${credit.folio} cambió un recaudo incluido en su conciliación de capital. Se requiere conciliación antes de consultar el corte.`);
      }
      seedIds.add(entry.id);
    }
    for (const row of capital.cuotas) seed.set(row.numero, cents(row.valorAbonadoAlCorte));
  }
  const activePayments = [...payments.values()].filter(active);
  const plan = buildCreditPaymentPlan({
    ...credit.plan,
    fechaPrimerPago: firstDueDate,
    // A settlement can waive charges. It must never create cash collections.
    settled: false,
    abonos: activePayments.map(payment => ({ valor: money(cents(payment.value)), fechaAbono: payment.paidAt })),
    today,
  });
  const assigned = new Map<number, Map<number, number>>(plan.installments.map(row => [row.numero, new Map()]));
  const room = new Map(plan.installments.map(row => [row.numero, cents(row.valorProgramado) - (seed.get(row.numero) || 0)]));
  // Match the platform's official receipt ordering. Identity, not this date,
  // determines whether a receipt was already known at projection time.
  const ordered = activePayments.filter(payment => !seedIds.has(payment.id)).sort((a, b) =>
    a.paidAt.localeCompare(b.paidAt) || a.id - b.id);
  let unallocated = 0;
  for (const payment of ordered) {
    let remaining = cents(payment.value);
    for (const row of plan.installments) {
      if (!remaining) break;
      const available = Math.max(0, room.get(row.numero) || 0);
      const amount = Math.min(remaining, available);
      if (amount) {
        assigned.get(row.numero)!.set(payment.id, amount);
        room.set(row.numero, available - amount);
        remaining -= amount;
      }
    }
    unallocated += remaining;
  }
  return { plan, payments, assigned, seed, capital, unallocated };
}

/** Stores all known receipt IDs, including annulled ones, and a private deep copy. */
export function captureCutSnapshot(credits: CutCredit[], cutDate: string, capturedAt: string): CutSnapshot {
  calendar(cutDate);
  if (!Number.isFinite(new Date(capturedAt).getTime())) throw new CutCollectionError("La fecha de proyección es inválida.");
  const unique = new Set<number>();
  const schedule: CutBaselineInstallment[] = [];
  const included = credits.filter(credit => {
    if (unique.has(credit.id)) throw new CutCollectionError(`El crédito ${credit.folio} está duplicado.`);
    unique.add(credit.id);
    if (["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.state.toUpperCase())) return false;
    // Records without any schedule (e.g. unfinished drafts) have no due installment.
    // Never synthesize a first due date from the reporting date.
    if (!credit.plan.planCapitalVigente && ((!credit.plan.fechaPrimerPago && !credit.plan.fechaProximoPago) || !(Number(credit.plan.montoCredito) > 0))) return false;
    const current = allocation(credit, capturedAt);
    const included = current.plan.installments.some(row => !row.eliminada && row.fechaVencimiento === cutDate);
    if (included) schedule.push(...current.plan.installments.map(row => ({
      creditId: credit.id, numero: row.numero, fechaVencimiento: row.fechaVencimiento,
      valorProgramado: row.valorProgramado, valorAbonado: row.valorAbonado,
      saldoPendiente: credit.plan.settled ? 0 : row.saldoPendiente, eliminada: Boolean(row.eliminada),
      applied: [...(current.assigned.get(row.numero) || [])].map(([id, value]) => ({ id, value: money(value) })),
    })));
    return included;
  });
  return JSON.parse(JSON.stringify({ version: 1, cutDate, capturedAt, credits: included, schedule })) as CutSnapshot;
}

export function buildCutRows(snapshot: CutSnapshot, currentCredits: CutCredit[]) {
  if (snapshot.version !== 1) throw new CutCollectionError("Versión de proyección no reconocida.");
  calendar(snapshot.cutDate);
  if (!Array.isArray(snapshot.schedule)) throw new CutCollectionError("La proyección no conserva los valores originales de sus cuotas. Se requiere conciliación.");
  const currentById = new Map(currentCredits.map(credit => [credit.id, credit]));
  if (currentById.size !== currentCredits.length) throw new CutCollectionError("Hay créditos duplicados en la consulta.");
  const scheduleByCredit = new Map<number, CutBaselineInstallment[]>();
  for (const installment of snapshot.schedule) {
    const installments = scheduleByCredit.get(installment.creditId) || [];
    installments.push(installment);
    scheduleByCredit.set(installment.creditId, installments);
  }
  const rows: CutRow[] = [];
  const warnings: string[] = [];
  let previousRecovery = 0;
  let futureAdvances = 0;
  for (const saved of snapshot.credits) {
    // Monetary baselines are persisted values, never recomputed by a newer allocator.
    const baseline = { payments: paymentsById(saved.payments), capital: parseCapitalPlanSnapshot(saved.plan.planCapitalVigente) };
    const savedSchedule = scheduleByCredit.get(saved.id) || [];
    const currentCredit = currentById.get(saved.id);
    // A physically deleted credit keeps its projection, with its former receipts reversed.
    const current = currentCredit ? allocation(currentCredit, snapshot.capturedAt) : null;
    if (current && JSON.stringify(current.capital) !== JSON.stringify(baseline.capital)) {
      throw new CutCollectionError(`El crédito ${saved.folio} cambió su plan de capital después de guardar la proyección. Falta una distribución histórica conciliada para comparar este corte.`);
    }
    const notes: string[] = [];
    if (!currentCredit) notes.push("El crédito ya no existe; la proyección conserva su esperado y los recaudos eliminados dejan de contar.");
    if (currentCredit && currentCredit.state.toUpperCase().includes("ANULAD")) notes.push("El crédito fue anulado; el esperado histórico se conserva y solo se cuentan recaudos vigentes.");
    if (currentCredit?.plan.settled) notes.push("Crédito finalizado: la condonación o el cierre no se cuenta como recaudo.");
    if (current && JSON.stringify(current.plan.installments.map(row => [row.numero, row.fechaVencimiento, row.valorProgramado, Boolean(row.eliminada)])) !==
      JSON.stringify(savedSchedule.map(row => [row.numero, row.fechaVencimiento, row.valorProgramado, Boolean(row.eliminada)]))) {
      notes.push("El cronograma cambió: se conserva el vencimiento y esperado guardados, y se compara el efectivo aplicado a los mismos números de cuota.");
    }
    if (current?.unallocated) notes.push(`Hay ${money(current.unallocated)} de recaudos sin cupo en el cronograma; no se incluyen en el cumplimiento.`);
    const savedIds = new Set(baseline.payments.keys());
    const newAmount = (number: number) => [...(current?.assigned.get(number) || [])]
      .reduce((sum, [id, amount]) => sum + (savedIds.has(id) ? 0 : amount), 0);
    let creditPrevious = 0;
    let creditFuture = 0;
    const baselineDates = new Map(savedSchedule.map(row => [row.numero, row.fechaVencimiento]));
    for (const row of current?.plan.installments || []) {
      // Cohorts retain the schedule that was saved, even if a due date is edited later.
      const date = baselineDates.get(row.numero) || row.fechaVencimiento;
      if (date < snapshot.cutDate) creditPrevious += newAmount(row.numero);
      if (date > snapshot.cutDate) creditFuture += newAmount(row.numero);
    }
    previousRecovery += creditPrevious;
    futureAdvances += creditFuture;
    for (const installment of savedSchedule) {
      if (installment.eliminada || installment.fechaVencimiento !== snapshot.cutDate) continue;
      const before = new Map(installment.applied.map(item => [item.id, cents(item.value)]));
      const now = current?.assigned.get(installment.numero) || new Map<number, number>();
      const priorPayments = cents(installment.valorAbonado);
      const expected = cents(installment.saldoPendiente);
      const currentPrior = (current?.seed.get(installment.numero) || 0) + [...now]
        .reduce((sum, [id, value]) => sum + (savedIds.has(id) ? value : 0), 0);
      const received = newAmount(installment.numero);
      const priorReversals = priorPayments - currentPrior;
      const pending = Math.max(0, expected - received + priorReversals);
      const payments = [...new Set([...before.keys(), ...now.keys()])].map(id => {
        const original = baseline.payments.get(id);
        const payment = current?.payments.get(id) || original!;
        return { id, paidAt: payment.paidAt, createdAt: payment.createdAt, method: payment.method,
          state: current?.payments.has(id) ? payment.state : "ELIMINADO",
          amount: payment.value, appliedBefore: money(before.get(id) || 0), appliedNow: money(now.get(id) || 0),
          received: savedIds.has(id) ? 0 : money(now.get(id) || 0), previous: savedIds.has(id) };
      });
      const capitalPrior = baseline.capital?.cuotas.find(row => row.numero === installment.numero)?.valorAbonadoAlCorte || 0;
      // A reconciled capital snapshot preserves an aggregate per installment,
      // not a receipt-to-installment ledger. Expose its source receipts without
      // pretending the entire receipt (or a guessed portion) belongs to this row.
      const sourcePayments = capitalPrior > 0 ? (baseline.capital?.abonosAlCorte || []).map(({ id }) => {
        const payment = current?.payments.get(id) || baseline.payments.get(id)!;
        return { id, paidAt: payment.paidAt, createdAt: payment.createdAt, method: payment.method,
          state: current?.payments.has(id) ? payment.state : "ELIMINADO", amount: payment.value };
      }) : [];
      const rowNotes = [...notes];
      if (sourcePayments.length) rowNotes.push("Los anticipos del plan de capital están conciliados por cuota; sus recaudos fuente no conservan una distribución individual. La fecha del último pago solo considera recaudos con atribución a esta cuota.");
      const lastPaymentAt = payments.filter(payment => payment.appliedNow > 0)
        .map(payment => payment.paidAt).sort().at(-1) || null;
      rows.push({ key: `${saved.id}:${installment.numero}`, creditId: saved.id, installment: installment.numero,
        clientName: saved.clientName, document: saved.document, folio: saved.folio,
        aliadoId: saved.aliadoId, aliado: saved.aliado, sedeId: saved.sedeId, sede: saved.sede,
        dueDate: installment.fechaVencimiento, installmentAmount: installment.valorProgramado,
        priorPayments: money(priorPayments), expected: money(expected), received: money(received), pending: money(pending),
        priorReversals: money(priorReversals), lastPaymentAt,
        status: pending <= 0 ? "pagado" : currentPrior + received > 0 ? "parcial" : "pendiente",
        warning: rowNotes.length ? rowNotes.join(" ") : null, payments, sourcePayments,
        previousRecovery: money(creditPrevious), futureAdvances: money(creditFuture) });
    }
    warnings.push(...notes.map(note => `${saved.folio}: ${note}`));
  }
  return { rows, previousRecovery: money(previousRecovery), futureAdvances: money(futureAdvances), warnings: [...new Set(warnings)] };
}

export function summarizeCutRows(rows: CutRow[], previousRecovery = 0, futureAdvances = 0): CutSummary {
  const sum = (field: "expected" | "received" | "pending" | "priorPayments" | "priorReversals") =>
    rows.reduce((total, row) => total + Math.round(row[field] * 100), 0);
  const expected = sum("expected");
  const received = sum("received");
  const visibleCredits = new Map(rows.map(row => [row.creditId, row]));
  const hasOtherAmounts = rows.some(row => row.previousRecovery !== undefined || row.futureAdvances !== undefined);
  return { expected: money(expected), received: money(received), pending: money(sum("pending")),
    completion: expected > 0 ? Math.round(received / expected * 10000) / 100 : null,
    pendingClients: new Set(rows.filter(row => row.pending > 0).map(row => row.document.replace(/[.\s-]/g, "").toUpperCase() || `credit:${row.creditId}`)).size,
    priorPayments: money(sum("priorPayments")), priorReversals: money(sum("priorReversals")),
    previousRecovery: hasOtherAmounts ? money([...visibleCredits.values()].reduce((total, row) => total + Math.round((row.previousRecovery || 0) * 100), 0)) : previousRecovery,
    futureAdvances: hasOtherAmounts ? money([...visibleCredits.values()].reduce((total, row) => total + Math.round((row.futureAdvances || 0) * 100), 0)) : futureAdvances };
}
