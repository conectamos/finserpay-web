import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { getCreditDueReminder, isCreditDueReminderWindow } = await jiti.import("../lib/credit-due-reminder-policy.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { resolveCarteraDaysPastDue } = await jiti.import("../lib/cartera-due-days.ts");
const today = new Date("2026-10-07T15:00:00.000Z");
const credit = changes => ({ id: 42, clienteNombre: " Ana Prueba ", clienteTelefono: "300 000 0042", estado: "GENERADO",
  pazYSalvoEmitidoAt: null, montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "CATORCENAL",
  fechaPrimerPago: "2026-10-08", fechaProximoPago: "2026-10-08", abonos: [], ...changes });
const payment = (valor, changes = {}) => ({ valor, fechaAbono: new Date("2026-10-07T13:00:00Z"), estado: "APROBADO", ...changes });

test("AD -1 selects a valid mobile and original installment identity, including historical credits", () => {
  const expected = { creditId: 42, installmentNumber: 1, dueDate: "2026-10-08", phone: "573000000042", name: "Ana Prueba" };
  assert.deepEqual(getCreditDueReminder(credit(), today), expected);
  assert.deepEqual(getCreditDueReminder(credit({ equalityService: "IMPORTACION_MASIVA" }), today), expected);
  assert.deepEqual(getCreditDueReminder(credit({ clienteTelefono: "+57 300 000 0042",
    fechaPrimerPago: new Date("2026-10-08T00:00:00.000Z"), fechaProximoPago: new Date("2026-10-08T00:00:00.000Z") }), today), expected);
});

test("only tomorrow is selected, using Bogotá's calendar date at its midnight boundary", () => {
  assert.ok(getCreditDueReminder(credit(), new Date("2026-10-08T04:59:59.999Z")));
  assert.equal(getCreditDueReminder(credit(), new Date("2026-10-08T05:00:00.000Z")), null);
  assert.equal(getCreditDueReminder(credit(), "2026-10-06"), null);
  assert.equal(getCreditDueReminder(credit(), "2026-10-08"), null);
  assert.equal(getCreditDueReminder(credit(), "2026-10-09"), null);
});

test("before-due and due-today campaigns select different days for the same unpaid installment", () => {
  const record = credit();
  assert.ok(getCreditDueReminder(record, "2026-10-07", "before_due"));
  assert.equal(getCreditDueReminder(record, "2026-10-07", "due_today"), null);
  assert.equal(getCreditDueReminder(record, "2026-10-08", "before_due"), null);
  assert.deepEqual(getCreditDueReminder(record, "2026-10-08", "due_today"), {
    creditId: 42, installmentNumber: 1, dueDate: "2026-10-08", phone: "573000000042", name: "Ana Prueba",
  });
  assert.equal(getCreditDueReminder(record, "2026-10-09", "due_today"), null);
  assert.equal(getCreditDueReminder(record, "2026-10-07", "unknown"), null);
});

test("due-today selects partial balances with AD zero and positive pending installment count", () => {
  const record = credit({ fechaPrimerPago: "2026-10-07", fechaProximoPago: "2026-10-07", abonos: [payment(50)] });
  const plan = buildCreditPaymentPlan({ ...record, today });
  assert.equal(resolveCarteraDaysPastDue(plan, today), 0);
  assert.equal(plan.pendingCount, 3);
  assert.equal(getCreditDueReminder(record, today, "due_today")?.installmentNumber, 1);
  assert.equal(getCreditDueReminder(record, today, "before_due"), null);
  assert.equal(getCreditDueReminder({ ...record, abonos: [payment(100)], fechaProximoPago: "2026-10-21" }, today, "due_today"), null);
});

test("AD zero with W zero or stale paid state does not send a due-today reminder", () => {
  const paid = credit({ fechaPrimerPago: "2026-09-09", fechaProximoPago: "2026-10-07", abonos: [payment(300)] });
  const plan = buildCreditPaymentPlan({ ...paid, today });
  assert.equal(resolveCarteraDaysPastDue(plan, today), 0);
  assert.equal(plan.pendingCount, 0);
  assert.equal(getCreditDueReminder(paid, today, "due_today"), null);
  const dueToday = credit({ fechaPrimerPago: "2026-10-07", fechaProximoPago: "2026-10-07" });
  for (const estado of ["PAGADO", "PAZ_Y_SALVO", "ANULADO", "CANCELADO"]) {
    assert.equal(getCreditDueReminder({ ...dueToday, estado }, today, "due_today"), null, estado);
  }
  assert.equal(getCreditDueReminder({ ...dueToday, pazYSalvoEmitidoAt: today }, today, "due_today"), null);
  assert.equal(getCreditDueReminder({ ...dueToday, montoCredito: 0 }, today, "due_today"), null);
});

test("due-today excludes other arrears and missing or invalid contacts and contractual dates", () => {
  assert.equal(getCreditDueReminder(credit({ fechaPrimerPago: "2026-09-01", fechaProximoPago: "2026-10-07" }), today, "due_today"), null);
  for (const changes of [
    { fechaPrimerPago: null, fechaProximoPago: null },
    { fechaPrimerPago: "invalid", fechaProximoPago: new Date("invalid") },
    { clienteTelefono: "123" },
    { clienteNombre: " " },
  ]) assert.equal(getCreditDueReminder(credit({ fechaPrimerPago: "2026-10-07", fechaProximoPago: "2026-10-07", ...changes }), today, "due_today"), null);
});

test("due-today changes at Bogotá midnight regardless of UTC date", () => {
  assert.equal(getCreditDueReminder(credit(), new Date("2026-10-08T04:59:59.999Z"), "due_today"), null);
  assert.ok(getCreditDueReminder(credit(), new Date("2026-10-08T05:00:00.000Z"), "due_today"));
  assert.ok(getCreditDueReminder(credit(), new Date("2026-10-09T04:59:59.999Z"), "due_today"));
  assert.equal(getCreditDueReminder(credit(), new Date("2026-10-09T05:00:00.000Z"), "due_today"), null);
});

test("missing or invalid registered dates cannot invent a biweekly reminder", () => {
  const missingDates = { frecuenciaPago: "QUINCENAL", fechaPrimerPago: null, fechaProximoPago: null };
  const beforeSeventeenth = new Date("2026-10-16T15:00:00.000Z");
  for (const changes of [
    {},
    { fechaPrimerPago: undefined, fechaProximoPago: undefined },
    { fechaPrimerPago: "", fechaProximoPago: "" },
    { fechaPrimerPago: new Date("invalid"), fechaProximoPago: new Date("invalid") },
    { fechaPrimerPago: "not-a-date", fechaProximoPago: "2026-10-17T25:00:00Z" },
    { fechaPrimerPago: "2026-02-30", fechaProximoPago: "2026-10-32" },
    { planCapitalVigente: {} },
  ]) assert.equal(getCreditDueReminder(credit({ ...missingDates, ...changes }), beforeSeventeenth), null);

  assert.equal(getCreditDueReminder(credit({ ...missingDates, fechaPrimerPago: "2026-10-17" }), beforeSeventeenth)?.dueDate, "2026-10-17");
  assert.equal(getCreditDueReminder(credit({ ...missingDates, fechaPrimerPago: "invalid", fechaProximoPago: "2026-10-17" }), beforeSeventeenth)?.dueDate, "2026-10-17");
  assert.equal(getCreditDueReminder(credit({ ...missingDates, fechaPrimerPago: "2026-10-17", fechaProximoPago: "invalid" }), beforeSeventeenth)?.dueDate, "2026-10-17");
});

test("a partially paid tomorrow installment remains eligible, paid installments advance the identity", () => {
  assert.equal(getCreditDueReminder(credit({ abonos: [payment(50)] }), today)?.installmentNumber, 1);
  assert.equal(getCreditDueReminder(credit({ abonos: [payment(100)], fechaProximoPago: "2026-10-22" }), today), null);
  const second = getCreditDueReminder(credit({ fechaPrimerPago: "2026-09-24", abonos: [payment(100)] }), today);
  assert.equal(second?.installmentNumber, 2);
  assert.equal(second?.dueDate, "2026-10-08");
  assert.equal(getCreditDueReminder(credit({ abonos: [payment(300)] }), today), null);
  assert.ok(getCreditDueReminder(credit({ abonos: [payment(300, { estado: "ANULADO" })] }), today));
});

test("paid, settled and cancelled states never create a reminder even with stale positive balances", () => {
  for (const estado of ["PAGADO", "PAZ_Y_SALVO", "ANULADO", "ANULADA", "CANCELADO", " cancelada "]) {
    assert.equal(getCreditDueReminder(credit({ estado }), today), null, estado);
  }
  assert.equal(getCreditDueReminder(credit({ pazYSalvoEmitidoAt: new Date("2026-10-06T15:00:00Z") }), today), null);
  assert.equal(getCreditDueReminder(credit({ montoCredito: 0 }), today), null);
});

test("a tomorrow override does not include a credit that still has another pending overdue installment", () => {
  assert.equal(getCreditDueReminder(credit({ fechaPrimerPago: "2026-09-01" }), today), null);
  assert.equal(getCreditDueReminder(credit({ fechaPrimerPago: "2026-10-01", fechaProximoPago: "2026-10-08" }), today)?.dueDate, "2026-10-08");
  assert.equal(getCreditDueReminder(credit({ fechaProximoPago: "2026-10-09" }), today), null);
});

test("valid revised capital plan preserves the original installment number and removed rows", () => {
  const planCapitalVigente = {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 2, totalAbonadoAlCorte: 100,
    abonosAlCorte: [{ id: 1, valor: 100 }], saldoCapitalAlCorte: 100, numeroCuotasOriginal: 3,
    parametros: { capitalPendiente: 100, tasaPeriodo: 0, cuotaCredito: 100, fianzaCuota: 0,
      seguroCuota: 0, numeroProximaCuota: 2, fuente: "Plan de capital sintético conciliado" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2026-09-24", valorProgramado: 100, valorAbonadoAlCorte: 100, eliminada: false },
      { numero: 2, fechaVencimiento: "2026-10-08", valorProgramado: 100, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 100, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
      { numero: 3, fechaVencimiento: "2026-10-22", valorProgramado: 0, valorAbonadoAlCorte: 0,
        eliminada: true, capital: 0, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
    ],
  };
  const reminder = getCreditDueReminder(credit({ planCapitalVigente, fechaPrimerPago: "2026-09-24", abonos: [payment(100)] }), today);
  assert.equal(reminder?.installmentNumber, 2);
  assert.equal(reminder?.dueDate, "2026-10-08");
  assert.equal(getCreditDueReminder(credit({ planCapitalVigente: { ...planCapitalVigente, version: "INVALID" } }), today), null);
  for (const dateFields of [
    { fechaPrimerPago: null, fechaProximoPago: null },
    { fechaPrimerPago: "invalid", fechaProximoPago: new Date("invalid") },
  ]) {
    const withInternalCalendar = getCreditDueReminder(credit({ planCapitalVigente, abonos: [payment(100)], ...dateFields }), today);
    assert.equal(withInternalCalendar?.installmentNumber, 2);
    assert.equal(withInternalCalendar?.dueDate, "2026-10-08");
  }
  assert.equal(getCreditDueReminder(credit({ planCapitalVigente: { ...planCapitalVigente, version: "INVALID" },
    fechaPrimerPago: null, fechaProximoPago: null }), today), null);
});

test("invalid contacts are skipped and Prisma Decimal-like values use the same financial calculation", () => {
  for (const changes of [{ clienteTelefono: "123" }, { clienteTelefono: "2000000042" }, { clienteTelefono: "+58 300 000 0042" }, { clienteNombre: " " }, { id: 0 }]) {
    assert.equal(getCreditDueReminder(credit(changes), today), null);
  }
  const decimal = number => ({ toString: () => String(number) });
  assert.ok(getCreditDueReminder(credit({ montoCredito: decimal(300), valorCuota: decimal(100), abonos: [payment(decimal(50))] }), today));
});

test("two credits belonging to one phone have distinct credit and installment identities", () => {
  const first = getCreditDueReminder(credit(), today);
  const second = getCreditDueReminder(credit({ id: 43, fechaPrimerPago: "2026-09-24", abonos: [payment(100)] }), today);
  assert.equal(first?.phone, second?.phone);
  assert.deepEqual([first?.creditId, first?.installmentNumber], [42, 1]);
  assert.deepEqual([second?.creditId, second?.installmentNumber], [43, 2]);
});

test("the sending window is exactly 10:00 to 10:59 Colombia, independent of host timezone", () => {
  const previousTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "Asia/Tokyo", "America/Bogota"]) {
      process.env.TZ = timezone;
      assert.equal(isCreditDueReminderWindow(new Date("2026-10-07T14:59:59.999Z")), false, timezone);
      assert.equal(isCreditDueReminderWindow(new Date("2026-10-07T15:00:00.000Z")), true, timezone);
      assert.equal(isCreditDueReminderWindow(new Date("2026-10-07T15:59:59.999Z")), true, timezone);
      assert.equal(isCreditDueReminderWindow(new Date("2026-10-07T16:00:00.000Z")), false, timezone);
    }
    assert.equal(isCreditDueReminderWindow(new Date("invalid")), false);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
