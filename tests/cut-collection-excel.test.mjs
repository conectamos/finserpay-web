import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildCutCollectionWorkbook } = await jiti.import("../lib/cut-collection-excel.ts");
const projectionId = "d088e4a2-c9d0-4310-aa0d-6023b48b2196";
const createdAt = "2026-10-14T02:30:15.000Z";
const fixture = () => ({
  ok: true, filters: { day: 17, month: 10, year: 2026, aliadoId: 1, sedeId: 10, status: "parcial" },
  cutDate: "2026-10-17", asOf: "2026-10-21T01:10:20.000Z", projection: { id: projectionId, createdAt },
  historyPage: 2, historyHasMore: true,
  options: { aliados: [{ id: 1, nombre: "Aliado uno" }], sedes: [{ id: 10, nombre: "Sede centro", aliadoId: 1 }] },
  rows: [{
    key: "1:2", creditId: 1, installment: 2, clientName: "María Pérez", document: "001234567890123456789",
    folio: "000001234567890123456789", aliadoId: 1, aliado: "Aliado uno", sedeId: 10, sede: "Sede centro", dueDate: "2026-10-17",
    installmentAmount: 600.75, priorPayments: 300.25, expected: 300.5, received: 125.25, pending: 175.25, priorReversals: 20,
    lastPaymentAt: "2026-10-21T01:10:20.000Z", status: "parcial", warning: "Anticipo previo ajustado",
    payments: [{ id: 37, paidAt: "2026-10-21T01:10:20.000Z", createdAt: "2026-10-21T01:10:20.000Z", method: "Transferencia",
      state: "ACTIVO", amount: 125.25, appliedBefore: 0, appliedNow: 125.25, received: 125.25, previous: false }],
  }],
  summary: { expected: 300.5, received: 125.25, pending: 175.25, completion: 125.25 / 300.5 * 100,
    pendingClients: 1, priorPayments: 300.25, priorReversals: 20, previousRecovery: 800, futureAdvances: 400 },
  history: [{ id: projectionId, cutDate: "2026-10-17", createdAt, expected: 300.5, received: 125.25,
    pending: 175.25, completion: 125.25 / 300.5 * 100, rowCount: 1 }], warnings: ["Advertencia de conciliación"],
});
async function roundTrip(report) {
  const original = JSON.stringify(report);
  const bytes = await buildCutCollectionWorkbook(report).xlsx.writeBuffer();
  assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), "PK");
  assert.equal(JSON.stringify(report), original, "export must not mutate the report");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}
function summaryValues(workbook) {
  const entries = new Map();
  workbook.getWorksheet("Resumen").eachRow((row, index) => {
    if (index > 1) entries.set(row.getCell(1).value, row.getCell(2));
  });
  return entries;
}

test("Excel exporta todas las columnas, tipos numéricos y mismos totales del reporte filtrado", async () => {
  const report = fixture();
  const workbook = await roundTrip(report);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Resumen", "Cuotas", "Pagos aplicados", "Histórico"]);
  const sheet = workbook.getWorksheet("Cuotas");
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "Cliente", "Cédula", "Número de crédito", "Aliado", "Sede", "Vencimiento", "Valor de cuota", "Anticipos previos",
    "Esperado", "Recibido", "Pendiente", "Último pago (Bogotá)", "Estado", "Ajustes de anticipos previos", "Número de cuota", "Observación",
  ]);
  for (const [address, value] of [["B2", report.rows[0].document], ["C2", report.rows[0].folio]]) {
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(address).numFmt, "@");
    assert.equal(sheet.getCell(address).value, value);
  }
  for (const [address, value] of [["G2", 600.75], ["H2", 300.25], ["I2", 300.5], ["J2", 125.25], ["K2", 175.25], ["N2", 20]]) {
    assert.equal(sheet.getCell(address).value, value);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Number);
    assert.equal(sheet.getCell(address).numFmt, "[$$-es-CO] #,##0.00");
  }
  const summary = summaryValues(workbook);
  for (const [label, column] of [["Recaudo esperado", 9], ["Recaudo recibido", 10], ["Pendiente por recaudar", 11]]) {
    const total = sheet.getColumn(column).values.slice(2).reduce((sum, value) => sum + value, 0);
    assert.equal(summary.get(label).value, total);
  }
  assert.equal(summary.get("Estado de cuota").value, "parcial");
  assert.equal(summary.get("Aliado").value, "Aliado uno");
  assert.equal(summary.get("Sede").value, "Sede centro");
  assert.equal(summary.get("Versión / ID de proyección").value, projectionId);
  assert.equal(summary.get("Porcentaje de cumplimiento").value, report.summary.completion / 100);
  assert.equal(summary.get("Porcentaje de cumplimiento").numFmt, "0.00%");
  assert.equal(summary.get("Recuperación de cuotas anteriores").value, 800);
  assert.equal(summary.get("Anticipos de cuotas futuras").value, 400);
  assert.equal(summary.get("Página de historial exportada").value, 3);
  assert.equal(summary.get("Hay más páginas de historial").value, "Sí");
  assert.equal(sheet.autoFilter, "A1:P2");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF151A21");
});

test("fechas de vencimiento mantienen el día y timestamps muestran hora Colombia, también histórico y pagos", async () => {
  const workbook = await roundTrip(fixture());
  const summary = summaryValues(workbook);
  assert.equal(summary.get("Proyección guardada (Bogotá)").value.toISOString(), "2026-10-13T21:30:15.000Z");
  assert.equal(summary.get("Consultado al (Bogotá)").value.toISOString(), "2026-10-20T20:10:20.000Z");
  assert.equal(summary.get("Corte").value.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(workbook.getWorksheet("Cuotas").getCell("F2").value.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(workbook.getWorksheet("Cuotas").getCell("L2").value.toISOString(), "2026-10-20T20:10:20.000Z");
  assert.equal(workbook.getWorksheet("Histórico").getCell("C2").value.toISOString(), "2026-10-13T21:30:15.000Z");
  const payments = workbook.getWorksheet("Pagos aplicados");
  assert.equal(payments.getCell("F2").value.toISOString(), "2026-10-20T20:10:20.000Z");
  assert.equal(payments.getCell("E2").value, "37");
  assert.equal(payments.getCell("M2").value, 125.25);
  assert.equal(payments.getCell("N2").value, "No");
});

test("textos con fórmulas permanecen texto literal y el export no filtra datos privados extra", async () => {
  const strings = ["=1+1", "+123", "-00123", "@SUM(A1:A2)", '\t=HYPERLINK("https://example.test","Click")'];
  const report = fixture();
  report.rows = strings.map(value => ({ ...report.rows[0], clientName: value, document: value, folio: value,
    aliado: value, sede: value, warning: value, accessToken: "private-secret", payments: [{ ...report.rows[0].payments[0], method: value }] }));
  const workbook = await roundTrip(report);
  const sheet = workbook.getWorksheet("Cuotas");
  strings.forEach((value, index) => {
    for (const column of [1, 2, 3, 4, 5, 16]) {
      const cell = sheet.getRow(index + 2).getCell(column);
      assert.equal(cell.value, value);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.formula, undefined);
      assert.equal(cell.hyperlink, undefined);
    }
  });
  assert(!JSON.stringify(workbook.model).includes("private-secret"));
});

test("corte vacío y esperado cero conservan reporte exportable sin división inválida", async () => {
  const report = fixture();
  report.projection = null;
  report.rows = [];
  report.summary = { expected: 0, received: 0, pending: 0, completion: null, pendingClients: 0, priorPayments: 0,
    priorReversals: 0, previousRecovery: 0, futureAdvances: 0 };
  report.history[0].completion = null;
  const workbook = await roundTrip(report);
  const summary = summaryValues(workbook);
  assert.equal(summary.get("Porcentaje de cumplimiento").value, "No aplica: esperado cero");
  assert.equal(summary.get("Recaudo esperado").value, 0);
  assert.equal(summary.get("Versión / ID de proyección").value, "Vista previa sin guardar");
  assert.equal(summary.get("Proyección guardada (Bogotá)").value, null);
  assert.equal(workbook.getWorksheet("Cuotas").rowCount, 1);
  assert.equal(workbook.getWorksheet("Cuotas").autoFilter, "A1:P1");
  assert.equal(workbook.getWorksheet("Pagos aplicados").rowCount, 1);
  assert.equal(workbook.getWorksheet("Histórico").getCell("G2").value, "No aplica: esperado cero");
});

test("histórico no conciliable conserva montos desconocidos vacíos y explica la diferencia", async () => {
  const report = fixture();
  report.history[0] = { ...report.history[0], expected: null, received: null, pending: null, completion: null,
    rowCount: null, warning: "El cronograma vigente cambió; requiere conciliación." };
  const workbook = await roundTrip(report);
  const sheet = workbook.getWorksheet("Histórico");
  for (const address of ["D2", "E2", "F2", "H2"]) assert.equal(sheet.getCell(address).value, null);
  assert.equal(sheet.getCell("G2").value, "Requiere conciliación");
  assert.equal(sheet.getCell("I2").value, report.history[0].warning);
});

test("recaudos fuente de conciliación se exportan sin importes aplicados inventados", async () => {
  const report = fixture();
  report.rows[0].sourcePayments = [{ id: 1, amount: 150, paidAt: createdAt, createdAt, method: "EFECTIVO", state: "ACTIVO" }];
  const workbook = await roundTrip(report);
  const payments = workbook.getWorksheet("Pagos aplicados");
  assert.equal(payments.rowCount, 3);
  assert.equal(payments.getCell("E3").value, "1");
  assert.equal(payments.getCell("J3").value, 150);
  for (const address of ["K3", "L3", "M3"]) assert.equal(payments.getCell(address).value, null);
  assert.equal(payments.getCell("O3").value, "Conciliación base; distribución no individualizada");
});
