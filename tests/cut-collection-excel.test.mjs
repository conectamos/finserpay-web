import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildCutCollectionWorkbook } = await jiti.import("../lib/cut-collection-excel.ts");
const createdAt = "2026-10-14T02:30:15.000Z";
const fixture = () => ({
  ok: true, mode: "consulta", filters: { day: 17, month: 10, year: 2026, aliadoId: 1, sedeId: 10, status: "parcial" },
  cutDate: "2026-10-17", asOf: "2026-10-21T01:10:20.000Z", projection: null,
  historyPage: 0, historyHasMore: false,
  options: { aliados: [{ id: 1, nombre: "Aliado uno" }], sedes: [{ id: 10, nombre: "Sede centro", aliadoId: 1 }] },
  rows: [{
    key: "1:2", creditId: 1, installment: 2, clientName: "María Pérez", document: "001234567890123456789",
    folio: "000001234567890123456789", aliadoId: 1, aliado: "Aliado uno", sedeId: 10, sede: "Sede centro", dueDate: "2026-10-17",
    installmentAmount: 600.75, priorPayments: 300.25, expected: 600.75, received: 425.5, pending: 175.25, priorReversals: 0,
    lastPaymentAt: "2026-10-21T01:10:20.000Z", status: "parcial", warning: null,
    payments: [{ id: 37, paidAt: "2026-10-21T01:10:20.000Z", createdAt: "2026-10-21T01:10:20.000Z", method: "Transferencia",
      state: "ACTIVO", amount: 125.25, appliedBefore: 0, appliedNow: 125.25, received: 125.25, previous: false },
    { id: 36, paidAt: createdAt, createdAt, method: "EFECTIVO", state: "ACTIVO", amount: 300.25,
      appliedBefore: 300.25, appliedNow: 300.25, received: 300.25, previous: true }],
  }],
  summary: { expected: 600.75, received: 425.5, pending: 175.25, completion: 425.5 / 600.75 * 100,
    pendingClients: 1, creditsCount: 1, priorPayments: 300.25, priorReversals: 0, previousRecovery: 800, futureAdvances: 400 },
  history: [], warnings: ["Advertencia de conciliación"],
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
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Resumen", "Cuotas", "Pagos aplicados"]);
  const sheet = workbook.getWorksheet("Cuotas");
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "Cliente", "Cédula", "Número de crédito", "Aliado", "Sede", "Vencimiento", "Valor de cuota", "Anticipos anteriores al corte",
    "Esperado", "Recibido", "Pendiente", "Último pago (Bogotá)", "Estado", "Número de cuota", "Observación",
  ]);
  for (const [address, value] of [["B2", report.rows[0].document], ["C2", report.rows[0].folio]]) {
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(address).numFmt, "@");
    assert.equal(sheet.getCell(address).value, value);
  }
  for (const [address, value] of [["G2", 600.75], ["H2", 300.25], ["I2", 600.75], ["J2", 425.5], ["K2", 175.25]]) {
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
  assert.equal(summary.get("Tipo de reporte").value, "Consulta directa");
  assert.equal(summary.get("Porcentaje de cumplimiento").value, report.summary.completion / 100);
  assert.equal(summary.get("Porcentaje de cumplimiento").numFmt, "0.00%");
  assert.equal(summary.get("Recuperación de cuotas anteriores").value, 800);
  assert.equal(summary.get("Anticipos de cuotas futuras").value, 400);
  assert.equal(summary.get("Créditos del corte filtrado").value, 1);
  assert.equal(summary.get("Anticipos anteriores al corte").value, 300.25);
  assert.match(summary.get("Tratamiento de anticipos").value, /incluidos.*No se suman/);
  assert.equal(sheet.getCell("N2").value, 2);
  assert.equal(sheet.getCell("N2").type, ExcelJS.ValueType.Number);
  assert.equal(sheet.autoFilter, "A1:O2");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF151A21");
});

test("fechas de vencimiento mantienen el día y timestamps muestran hora Colombia en consulta y pagos", async () => {
  const workbook = await roundTrip(fixture());
  const summary = summaryValues(workbook);
  assert.equal(summary.get("Consultado al (Bogotá)").value.toISOString(), "2026-10-20T20:10:20.000Z");
  assert.equal(summary.get("Corte").value.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(workbook.getWorksheet("Cuotas").getCell("F2").value.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(workbook.getWorksheet("Cuotas").getCell("L2").value.toISOString(), "2026-10-20T20:10:20.000Z");
  const payments = workbook.getWorksheet("Pagos aplicados");
  assert.equal(payments.getCell("F2").value.toISOString(), "2026-10-20T20:10:20.000Z");
  assert.equal(payments.getCell("E2").value, "37");
  assert.equal(payments.getCell("M2").value, 125.25);
  assert.equal(payments.getCell("N2").value, "No");
  assert.equal(payments.getCell("F3").value.toISOString(), "2026-10-13T21:30:15.000Z");
  assert.equal(payments.getCell("K3").value, 300.25);
  assert.equal(payments.getCell("L3").value, 300.25);
  assert.equal(payments.getCell("M3").value, 300.25);
  assert.equal(payments.getCell("N3").value, "Sí");
  assert.equal(payments.getCell("M2").value + payments.getCell("M3").value, summary.get("Recaudo recibido").value);
});

test("riesgo exporta FPD PRE MADURO y FPD MADURO con criterios de meses calendario sin alterar importes ni fechas", async () => {
  for (const previousLabel of ["40/60", "FPD PRE MADURO"]) {
    const report = fixture();
    report.earlyRisk = [
      { label: "DPF 3", cases: 1, eligible: 8, pending: 0, unavailable: 1 },
      { label: previousLabel, cases: 2, eligible: 5, pending: 3, unavailable: 1 },
      { label: "FPD MADURO", cases: 1, eligible: 4, pending: 4, unavailable: 1 },
    ];
    const workbook = await roundTrip(report);
    const summary = summaryValues(workbook);
    assert.equal(summary.get("FPD PRE MADURO").value, "2/5 (40.0 %) · 3 por madurar · 1 sin datos comparables");
    assert.equal(summary.get("FPD MADURO").value, "1/4 (25.0 %) · 4 por madurar · 1 sin datos comparables");
    assert.equal(summary.get("DPF 3").value, "1/8 (12.5 %) · 0 por madurar · 1 sin datos comparables");
    assert.match(summary.get("Medición FPD PRE MADURO").value, /6 cuotas completas.*3 meses calendario.*desembolso/);
    assert.match(summary.get("Medición FPD MADURO").value, /10 cuotas completas.*5 meses calendario.*desembolso/);
    assert.doesNotMatch(JSON.stringify(workbook.model), /40\/60/);
    assert.equal(summary.get("Consultado al (Bogotá)").value.toISOString(), "2026-10-20T20:10:20.000Z");
    assert.equal(summary.get("Recaudo recibido").value, report.summary.received);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Resumen", "Cuotas", "Pagos aplicados"]);
  }
});

test("FPD MADURO sin créditos evaluables conserva pendientes y ausencia de datos sin porcentaje inválido", async () => {
  const report = fixture();
  report.earlyRisk = [{ label: "FPD MADURO", cases: 0, eligible: 0, pending: 5, unavailable: 2 }];
  const workbook = await roundTrip(report);
  assert.equal(summaryValues(workbook).get("FPD MADURO").value, "Sin base evaluable · 5 por madurar · 2 sin datos comparables");
  assert.doesNotMatch(JSON.stringify(workbook.model), /NaN|Infinity/);
});

test("textos con fórmulas permanecen texto literal y el export no filtra datos privados extra", async () => {
  const strings = ["=1+1", "+123", "-00123", "@SUM(A1:A2)", '\t=HYPERLINK("https://example.test","Click")'];
  const report = fixture();
  report.rows = strings.map(value => ({ ...report.rows[0], clientName: value, document: value, folio: value,
    aliado: value, sede: value, warning: value, accessToken: "private-secret", payments: [{ ...report.rows[0].payments[0], method: value }] }));
  const workbook = await roundTrip(report);
  const sheet = workbook.getWorksheet("Cuotas");
  strings.forEach((value, index) => {
    for (const column of [1, 2, 3, 4, 5, 15]) {
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
  report.summary = { expected: 0, received: 0, pending: 0, completion: null, pendingClients: 0, creditsCount: 0, priorPayments: 0,
    priorReversals: 0, previousRecovery: 0, futureAdvances: 0 };
  const workbook = await roundTrip(report);
  const summary = summaryValues(workbook);
  assert.equal(summary.get("Porcentaje de cumplimiento").value, "No aplica: esperado cero");
  assert.equal(summary.get("Recaudo esperado").value, 0);
  assert.equal(summary.get("Tipo de reporte").value, "Consulta directa");
  assert.equal(summary.get("Créditos del corte filtrado").value, 0);
  assert.equal(workbook.getWorksheet("Cuotas").rowCount, 1);
  assert.equal(workbook.getWorksheet("Cuotas").autoFilter, "A1:O1");
  assert.equal(workbook.getWorksheet("Pagos aplicados").rowCount, 1);
  assert.equal(workbook.getWorksheet("Histórico"), undefined);
});

test("la consulta directa no exporta proyecciones ni metadatos de guardado heredados", async () => {
  const report = fixture();
  report.projection = { id: "historical-only-secret", createdAt };
  report.history = [{ id: "historical-only-secret", expected: null, received: null, pending: null, completion: null,
    rowCount: null, warning: "Histórico no conciliable" }];
  const workbook = await roundTrip(report);
  assert.equal(workbook.getWorksheet("Histórico"), undefined);
  assert.doesNotMatch(JSON.stringify(workbook.model), /historical-only-secret|proyección|Vista previa|guardada|historial/i);
});

test("recaudos fuente de conciliación se exportan sin importes aplicados inventados", async () => {
  const report = fixture();
  report.rows[0].sourcePayments = [{ id: 1, amount: 150, paidAt: createdAt, createdAt, method: "EFECTIVO", state: "ACTIVO" }];
  const workbook = await roundTrip(report);
  const payments = workbook.getWorksheet("Pagos aplicados");
  assert.equal(payments.rowCount, 4);
  assert.equal(payments.getCell("E4").value, "1");
  assert.equal(payments.getCell("J4").value, 150);
  for (const address of ["K4", "L4", "M4"]) assert.equal(payments.getCell(address).value, null);
  assert.equal(payments.getCell("N4").value, "Sí");
  assert.equal(payments.getCell("O4").value, "Conciliación base; distribución no individualizada");
});

test("efectivo conciliado cuadra con recibido sin inventar distribución por recibo", async () => {
  const report = fixture();
  report.rows[0].payments = [report.rows[0].payments[0]];
  report.rows[0].reconciledReceived = 300.25;
  report.rows[0].sourcePayments = [{ id: 1, amount: 500, paidAt: createdAt, createdAt, method: "EFECTIVO", state: "ACTIVO" }];
  const workbook = await roundTrip(report);
  const payments = workbook.getWorksheet("Pagos aplicados");
  assert.equal(payments.getCell("E3").text, "");
  assert.equal(payments.getCell("F3").value, null);
  assert.equal(payments.getCell("J3").value, null);
  assert.equal(payments.getCell("K3").value, 300.25);
  assert.equal(payments.getCell("M3").value, 300.25);
  assert.match(payments.getCell("O3").text, /conciliado por cuota/);
  assert.equal(payments.getCell("J4").value, 500);
  assert.equal(payments.getCell("M4").value, null);
  assert.equal(payments.getColumn(13).values.slice(2).reduce((sum, value) => sum + (value || 0), 0), report.summary.received);
});
