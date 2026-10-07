import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { getCreditOverdueDataCandidate, groupCreditOverdueDataCandidates, isCreditOverdueDataWindow } =
  await jiti.import("../lib/credit-overdue-data-policy.ts");
const today = new Date("2026-10-07T15:00:00.000Z");
const credit = changes => ({ id: 42, clienteNombre: "  Ana   Prueba ", clienteTelefono: "300 000 0042", estado: "GENERADO",
  pazYSalvoEmitidoAt: null, montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "CATORCENAL",
  fechaPrimerPago: "2026-09-17", fechaProximoPago: null, abonos: [], ...changes });
const payment = (valor, changes = {}) => ({ valor, fechaAbono: new Date("2026-10-07T13:00:00Z"), estado: "APROBADO", ...changes });

test("20 days is inclusive and 19 days is excluded using the oldest unpaid due date", () => {
  assert.equal(getCreditOverdueDataCandidate(credit({ fechaPrimerPago: "2026-09-18" }), today), null);
  assert.deepEqual(getCreditOverdueDataCandidate(credit(), today), {
    creditId: 42, phone: "573000000042", name: "Ana Prueba", daysPastDue: 20,
    installmentNumber: 1, dueDate: "2026-09-17",
  });
  assert.equal(getCreditOverdueDataCandidate(credit({ fechaPrimerPago: "2026-09-16" }), today)?.daysPastDue, 21);
});

test("payments remove the oldest paid arrears while partial or voided payments do not", () => {
  assert.equal(getCreditOverdueDataCandidate(credit({ abonos: [payment(50)] }), today)?.daysPastDue, 20);
  assert.equal(getCreditOverdueDataCandidate(credit({ abonos: [payment(100)] }), today), null);
  const second = getCreditOverdueDataCandidate(credit({ fechaPrimerPago: "2026-09-01", abonos: [payment(100)] }), today);
  assert.equal(second?.daysPastDue, 22);
  assert.equal(second?.installmentNumber, 2);
  assert.equal(second?.dueDate, "2026-09-15");
  assert.equal(getCreditOverdueDataCandidate(credit({ fechaPrimerPago: "2026-09-01", abonos: [payment(200)] }), today), null);
  assert.equal(getCreditOverdueDataCandidate(credit({ abonos: [payment(300, { estado: "ANULADO" })] }), today)?.daysPastDue, 20);
});

test("paid states, settled credits, cancelled credits and zero balances are excluded", () => {
  for (const estado of ["PAGADO", "PAZ_Y_SALVO", "ANULADO", "ANULADA", "CANCELADO", " cancelada ", "ANULADO POR ERROR"]) {
    assert.equal(getCreditOverdueDataCandidate(credit({ estado }), today), null, estado);
  }
  assert.equal(getCreditOverdueDataCandidate(credit({ pazYSalvoEmitidoAt: today }), today), null);
  assert.equal(getCreditOverdueDataCandidate(credit({ abonos: [payment(300)] }), today), null);
  assert.equal(getCreditOverdueDataCandidate(credit({ montoCredito: 0 }), today), null);
});

test("missing or invalid dates cannot create guessed historical arrears", () => {
  for (const changes of [
    { fechaPrimerPago: null, fechaProximoPago: null },
    { fechaPrimerPago: "", fechaProximoPago: "" },
    { fechaPrimerPago: "2026-02-30", fechaProximoPago: "not-a-date" },
    { fechaPrimerPago: new Date("invalid"), fechaProximoPago: new Date("invalid") },
    { fechaPrimerPago: null, fechaProximoPago: null, planCapitalVigente: {} },
  ]) assert.equal(getCreditOverdueDataCandidate(credit(changes), today), null);
  assert.equal(getCreditOverdueDataCandidate(credit({ fechaPrimerPago: null, fechaProximoPago: "2026-09-17" }), today)?.daysPastDue, 20);
  for (const invalidToday of [undefined, null, "", "2026-02-30", new Date("invalid")]) {
    assert.equal(getCreditOverdueDataCandidate(credit(), invalidToday), null);
  }
});

test("an administrative override applies only to the first unpaid installment and the oldest actual arrear wins", () => {
  const candidate = getCreditOverdueDataCandidate(credit({ fechaPrimerPago: "2026-09-01", fechaProximoPago: "2026-10-20" }), today);
  assert.equal(candidate?.daysPastDue, 22);
  assert.equal(candidate?.installmentNumber, 2);
  assert.equal(candidate?.dueDate, "2026-09-15");
  assert.equal(getCreditOverdueDataCandidate(credit({ fechaProximoPago: "2026-10-20" }), today), null);
});

test("valid revised capital snapshots preserve original installment identity without external dates", () => {
  const planCapitalVigente = {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 2, totalAbonadoAlCorte: 100,
    abonosAlCorte: [{ id: 1, valor: 100 }], saldoCapitalAlCorte: 100, numeroCuotasOriginal: 3,
    parametros: { capitalPendiente: 100, tasaPeriodo: 0, cuotaCredito: 100, fianzaCuota: 0,
      seguroCuota: 0, numeroProximaCuota: 2, fuente: "Plan de capital sintético conciliado" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2026-09-03", valorProgramado: 100, valorAbonadoAlCorte: 100, eliminada: false },
      { numero: 2, fechaVencimiento: "2026-09-17", valorProgramado: 100, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 100, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
      { numero: 3, fechaVencimiento: "2026-10-01", valorProgramado: 0, valorAbonadoAlCorte: 0,
        eliminada: true, capital: 0, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
    ],
  };
  const record = credit({ planCapitalVigente, fechaPrimerPago: null, fechaProximoPago: null, abonos: [payment(100)] });
  const candidate = getCreditOverdueDataCandidate(record, today);
  assert.equal(candidate?.daysPastDue, 20);
  assert.equal(candidate?.installmentNumber, 2);
  assert.equal(candidate?.dueDate, "2026-09-17");
  assert.equal(getCreditOverdueDataCandidate({ ...record, abonos: [payment(200)] }, today), null);
  assert.equal(getCreditOverdueDataCandidate({ ...record, planCapitalVigente: { ...planCapitalVigente, version: "INVALID" } }, today), null);
  assert.equal(getCreditOverdueDataCandidate({ ...record, planCapitalVigente: { ...planCapitalVigente,
    cuotas: planCapitalVigente.cuotas.map(row => row.numero === 2 ? { ...row, fechaVencimiento: "2026-02-30" } : row) } }, today), null);
});

test("only the customer's valid mobile is used, names are normalized and Prisma Decimals are supported", () => {
  for (const changes of [{ clienteTelefono: "123" }, { clienteTelefono: "+58 300 000 0042" }, { clienteTelefono: "2000000042" },
    { clienteNombre: " " }, { id: 0 }]) assert.equal(getCreditOverdueDataCandidate(credit(changes), today), null);
  const decimal = value => ({ toString: () => String(value) });
  const candidate = getCreditOverdueDataCandidate(credit({ clienteTelefono: "+57 300 000 0042", montoCredito: decimal(300),
    valorCuota: decimal(100), plazoMeses: decimal(3), abonos: [payment(decimal(50))] }), today);
  assert.equal(candidate?.phone, "573000000042");
  assert.equal(candidate?.name, "Ana Prueba");
  assert.equal(candidate?.daysPastDue, 20);
});

test("grouping sends once per normalized phone, choosing greatest arrears then lowest credit id", () => {
  const candidates = [
    getCreditOverdueDataCandidate(credit({ id: 9, clienteTelefono: "3000000009" }), today),
    getCreditOverdueDataCandidate(credit({ id: 43 }), today),
    getCreditOverdueDataCandidate(credit({ id: 44, fechaPrimerPago: "2026-09-01" }), today),
    getCreditOverdueDataCandidate(credit({ id: 40, fechaPrimerPago: "2026-09-01", clienteTelefono: "+57 300 000 0042" }), today),
  ];
  assert.ok(candidates.every(Boolean));
  const unchanged = structuredClone(candidates);
  const grouped = groupCreditOverdueDataCandidates(candidates);
  assert.deepEqual(grouped.map(item => [item.phone, item.creditId, item.daysPastDue]), [
    ["573000000009", 9, 20], ["573000000042", 40, 36],
  ]);
  assert.deepEqual(groupCreditOverdueDataCandidates([...candidates].reverse()), grouped);
  assert.deepEqual(candidates, unchanged);
  assert.deepEqual(groupCreditOverdueDataCandidates([]), []);
});

test("20-day threshold and sending window follow Bogotá, independent of server timezone", () => {
  const previousTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "Asia/Tokyo", "America/Bogota"]) {
      process.env.TZ = timezone;
      assert.equal(getCreditOverdueDataCandidate(credit(), new Date("2026-10-07T04:59:59.999Z")), null, timezone);
      assert.equal(getCreditOverdueDataCandidate(credit(), new Date("2026-10-07T05:00:00.000Z"))?.daysPastDue, 20, timezone);
      assert.equal(isCreditOverdueDataWindow(new Date("2026-10-07T14:59:59.999Z")), false, timezone);
      assert.equal(isCreditOverdueDataWindow(new Date("2026-10-07T15:00:00.000Z")), true, timezone);
      assert.equal(isCreditOverdueDataWindow(new Date("2026-10-07T15:59:59.999Z")), true, timezone);
      assert.equal(isCreditOverdueDataWindow(new Date("2026-10-07T16:00:00.000Z")), false, timezone);
    }
    assert.equal(isCreditOverdueDataWindow(new Date("invalid")), false);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
