import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildMoraPortfolioWorkbook } = await jiti.import("../lib/analyst-mora-excel.ts");
const generatedAt = new Date("2026-10-29T02:30:15.000Z");
const COP = '[$$-es-CO] #,##0.00';
const fixture = (id = 1) => ({
  id, folio: `FC-${id}`, numeroCreditoVisible: `00000${id}`, clienteNombre: "María Muñoz & Hijos",
  clienteDocumento: "0012345678901234567890", clienteTelefono: "+57 03001234567", aliadoId: 7,
  aliadoNombre: "Aliado Bogotá", equipo: "Teléfono Ñ 256 GB", imei: "00123456789012345678",
  diasMora: 21, valorVencido: 1234.56, saldoPendiente: 9876.54,
  ultimoPago: "2026-10-28T04:59:59.000Z", fechaCredito: "2026-10-01T05:00:00.000Z", estadoGestion: "PRORROGA",
  ultimaGestion: { id: "event-1", creditoId: id, action: "LLAMADA", actedAt: "2026-10-28T05:00:00.000Z",
    responsibleUserId: 9, responsibleName: "José García", result: "Acuerdo de pago · 29/10/2026 · $ 1.234,56",
    resultCode: "ACUERDO_PAGO", agreementDate: "2026-10-29", agreementAmount: 1234.56,
    comment: "INTERNAL-COMMENT-NOT-EXPORTED", nextFollowUpAt: "2026-10-29T04:30:00.000Z", managementStatus: "ACUERDO_PAGO",
    actorUserId: 10, actorName: "INTERNAL-ACTOR-NOT-EXPORTED", createdAt: "2026-10-28T16:00:00.000Z", idempotencyKey: "PRIVATE-IDEMPOTENCY" },
  prorrogaActiva: { id: "private-extension-id", expiresOn: "2026-11-01", reason: "PRIVATE-EXTENSION-REASON",
    approvedAt: "2026-10-28T12:00:00.000Z", approvedByName: "PRIVATE-APPROVER", installmentNumber: 2, installmentDueDate: "2026-10-21" },
});
const headers = [
  "Crédito", "Cliente", "Documento", "Teléfono", "Aliado", "Equipo", "IMEI", "Días de mora",
  "Valor vencido (COP)", "Saldo pendiente (COP)", "Último pago (Bogotá)", "Estado de gestión",
  "Última gestión (resultado)", "Responsable", "Fecha última gestión (Bogotá)", "Próxima gestión (Bogotá)",
  "Prórroga activa", "Prórroga hasta", "Fecha crédito",
];
async function roundTrip(items, options = { generatedAt }) {
  const before = structuredClone({ items, options });
  const buffer = await buildMoraPortfolioWorkbook(items, options).xlsx.writeBuffer();
  assert.equal(Buffer.from(buffer).subarray(0, 2).toString(), "PK", "debe ser un XLSX ZIP real");
  assert.deepEqual({ items, options }, before, "exportar no debe mutar la fuente ni los filtros");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}
function summaryValues(workbook) {
  const values = new Map();
  workbook.getWorksheet("Resumen").eachRow((row, index) => {
    if (index > 1) values.set(row.getCell(1).value, row.getCell(2));
  });
  return values;
}

test("XLSX real incluye todos los créditos, 19 columnas, tipos nativos y formato financiero", async () => {
  const items = Array.from({ length: 37 }, (_, index) => fixture(index + 1));
  const workbook = await roundTrip(items);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Resumen", "Cartera en mora"]);
  const detail = workbook.getWorksheet("Cartera en mora");
  assert.equal(detail.rowCount, 38, "no debe truncarse a la página de 25 créditos");
  assert.equal(detail.columnCount, 19);
  assert.deepEqual(detail.getRow(1).values.slice(1), headers);
  assert.deepEqual(Array.from({ length: 37 }, (_, index) => detail.getCell(`A${index + 2}`).value), items.map(item => item.numeroCreditoVisible));
  for (const [address, expected] of [["B2", items[0].clienteNombre], ["C2", items[0].clienteDocumento],
    ["D2", items[0].clienteTelefono], ["F2", items[0].equipo], ["G2", items[0].imei],
    ["L2", "Prórroga"], ["M2", items[0].ultimaGestion.result], ["N2", items[0].ultimaGestion.responsibleName]]) {
    const cell = detail.getCell(address);
    assert.equal(cell.value, expected);
    assert.equal(cell.type, ExcelJS.ValueType.String);
    assert.equal(cell.numFmt, "@");
  }
  for (const [address, expected, format] of [["H2", 21, "0"], ["I2", 1234.56, COP], ["J2", 9876.54, COP]]) {
    const cell = detail.getCell(address);
    assert.equal(cell.value, expected);
    assert.equal(cell.type, ExcelJS.ValueType.Number);
    assert.equal(cell.numFmt, format);
    assert.equal(cell.alignment.horizontal, "right");
  }
  for (const address of ["K2", "O2", "P2"]) {
    assert.equal(detail.getCell(address).type, ExcelJS.ValueType.Date);
    assert.equal(detail.getCell(address).numFmt, "dd/mm/yyyy hh:mm:ss");
  }
  for (const address of ["R2", "S2"]) {
    assert.equal(detail.getCell(address).type, ExcelJS.ValueType.Date);
    assert.equal(detail.getCell(address).numFmt, "dd/mm/yyyy");
  }
  assert.equal(detail.autoFilter, "A1:S38");
  assert.equal(detail.views[0].state, "frozen");
  assert.equal(detail.views[0].ySplit, 1);
  assert.equal(detail.views[0].showGridLines, false);
  assert.equal(detail.getCell("A1").fill.fgColor.argb, "FF151A21");
  assert.equal(detail.getCell("A2").border.bottom.color.argb, "FFD8DEE5");
  assert(detail.getColumn(7).width >= 23);
  const summary = summaryValues(workbook);
  assert.equal(summary.get("Créditos exportados").value, 37);
  assert.equal(summary.get("Total valor vencido (COP)").value, 45678.72);
  assert.equal(summary.get("Total saldo pendiente (COP)").value, 365431.98);
});

test("resumen conserva los filtros aplicados y fecha Bogotá, sin serializar parámetros adicionales", async () => {
  const filters = { q: "María <&> Bogotá", ally: "7", responsible: "9", minDays: "0", maxDays: "30",
    status: "PRORROGA", followUp: "2026-10-29", accessToken: "PRIVATE-FILTER-TOKEN", page: "9" };
  const workbook = await roundTrip([fixture()], { generatedAt, filters });
  const values = summaryValues(workbook);
  assert.equal(values.get("Búsqueda").value, filters.q);
  assert.equal(values.get("Aliado").value, "Aliado Bogotá · ID 7");
  assert.equal(values.get("Responsable").value, "José García · ID 9");
  assert.equal(values.get("Días de mora desde").value, "0");
  assert.equal(values.get("Días de mora hasta").value, "30");
  assert.equal(values.get("Estado de gestión").value, "Prórroga");
  assert.equal(values.get("Fecha próxima gestión").value.toISOString(), "2026-10-29T00:00:00.000Z");
  assert.equal(values.get("Generado el (Bogotá)").value.toISOString(), "2026-10-28T21:30:15.000Z");
  assert.equal(values.get("Zona horaria").value, "America/Bogota (UTC-05:00)");
  assert.equal(workbook.created.toISOString(), generatedAt.toISOString());
  assert(!JSON.stringify(workbook.model).includes("PRIVATE-FILTER-TOKEN"));
  const empty = summaryValues(await roundTrip([], { generatedAt, filters }));
  assert.equal(empty.get("Aliado").value, "ID 7", "sin registros conserva el filtro sin inventar el nombre");
  assert.equal(empty.get("Responsable").value, "ID 9");
});

test("identidades y resultados con prefijos de fórmula permanecen texto sin enlaces ni pérdida de ceros", async () => {
  const literals = ["=1+1", "+573001234567", "-00123", "@SUM(A1:A2)", '\t=HYPERLINK("https://example.test","x")',
    "000123456789012345678901234567890", "__proto__", "Niña Ñandú — Bogotá 😀"];
  const items = literals.map((value, index) => ({ ...fixture(index + 1), numeroCreditoVisible: value,
    clienteNombre: value, clienteDocumento: value, clienteTelefono: value, aliadoNombre: value, equipo: value,
    imei: value, estadoGestion: value, ultimaGestion: { ...fixture().ultimaGestion, result: value, responsibleName: value } }));
  const workbook = await roundTrip(items, { generatedAt, filters: { q: '=HYPERLINK("https://example.test")' } });
  const detail = workbook.getWorksheet("Cartera en mora");
  literals.forEach((value, index) => {
    for (const column of [1, 2, 3, 4, 5, 6, 7, 12, 13, 14]) {
      const cell = detail.getRow(index + 2).getCell(column);
      assert.equal(cell.value, value);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.formula, undefined);
      assert.equal(cell.hyperlink, undefined);
    }
  });
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    assert.equal(cell.formula, undefined);
    assert.equal(cell.hyperlink, undefined);
  }));
});

test("ceros permanecen números y ausencias no se convierten en saldos o gestiones inventados", async () => {
  const item = { ...fixture(), clienteDocumento: null, clienteTelefono: undefined, imei: null, diasMora: 0,
    valorVencido: 0, saldoPendiente: 0, ultimoPago: null, ultimaGestion: null, prorrogaActiva: null, estadoGestion: "PENDIENTE" };
  const workbook = await roundTrip([item]);
  const detail = workbook.getWorksheet("Cartera en mora");
  for (const address of ["H2", "I2", "J2"]) assert.equal(detail.getCell(address).value, 0);
  for (const address of ["C2", "D2", "G2", "M2", "N2"]) assert.equal(detail.getCell(address).value, "");
  for (const address of ["K2", "O2", "P2", "R2"]) assert.equal(detail.getCell(address).value, null);
  assert.equal(detail.getCell("Q2").value, "No");
  assert.equal(detail.getCell("L2").value, "Pendiente");
  const missing = await roundTrip([{ ...item, valorVencido: null, saldoPendiente: undefined }, { ...item, id: 2, saldoPendiente: Infinity }]);
  const values = summaryValues(missing);
  assert.equal(values.get("Total valor vencido (COP)").value, null);
  assert.equal(values.get("Total saldo pendiente (COP)").value, null);
  assert(values.has("Importes no disponibles"));
  assert.equal(missing.getWorksheet("Cartera en mora").getCell("I2").value, null);
  assert.equal(missing.getWorksheet("Cartera en mora").getCell("J3").value, null);
});

test("fechas se interpretan en Bogotá con límites de día y fechas calendario sin desplazamientos", async () => {
  const item = fixture();
  const workbook = await roundTrip([item, { ...fixture(2), fechaCredito: "2024-02-29", ultimoPago: "2026-10-28T00:00:00-05:00" }]);
  const detail = workbook.getWorksheet("Cartera en mora");
  assert.equal(detail.getCell("K2").value.toISOString(), "2026-10-27T23:59:59.000Z");
  assert.equal(detail.getCell("O2").value.toISOString(), "2026-10-28T00:00:00.000Z");
  assert.equal(detail.getCell("P2").value.toISOString(), "2026-10-28T23:30:00.000Z");
  assert.equal(detail.getCell("R2").value.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(detail.getCell("S2").value.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(detail.getCell("S3").value.toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(detail.getCell("K3").value.toISOString(), "2026-10-28T00:00:00.000Z");
  const previousDay = await roundTrip([{ ...item, fechaCredito: "2026-10-01T04:59:59Z" }]);
  assert.equal(previousDay.getWorksheet("Cartera en mora").getCell("S2").value.toISOString(), "2026-09-30T00:00:00.000Z");
});

test("fechas inválidas o sin zona no se normalizan ni usan implícitamente la zona del servidor", async () => {
  const invalid = ["not-a-date", "2026-02-30T12:00:00Z", "2026-10-28T25:00:00Z", "2026-10-28T12:60:00Z",
    "2026-10-28T12:00:60Z", "2026-10-28T12:00:00", "2026-10-28T12:00:00+99:00", "1899-12-31T12:00:00Z"];
  const items = invalid.map((value, index) => ({ ...fixture(index + 1), ultimoPago: value, fechaCredito: value,
    ultimaGestion: { ...fixture().ultimaGestion, actedAt: value, nextFollowUpAt: value },
    prorrogaActiva: { ...fixture().prorrogaActiva, expiresOn: "2026-02-30" } }));
  const detail = (await roundTrip(items)).getWorksheet("Cartera en mora");
  invalid.forEach((_, index) => {
    for (const column of [11, 15, 16, 18, 19]) assert.equal(detail.getRow(index + 2).getCell(column).value, null);
  });
  assert.throws(() => buildMoraPortfolioWorkbook([], { generatedAt: new Date(NaN) }), /fecha de generación/);
});

test("prórroga depende de la autorización actual y el exportador excluye contactos familiares y secretos", async () => {
  const item = { ...fixture(), estadoGestion: "SEGUIMIENTO", prorrogaActiva: null,
    ultimaGestion: { ...fixture().ultimaGestion, result: "Prórroga aprobada 4 días", resultCode: "PRORROGA_APROBADA" },
    contratoSnapshot: { secret: "PRIVATE-SNAPSHOT" }, referenciaFamiliar1Telefono: "PRIVATE-FAMILY-ONE",
    referenciaFamiliar2Telefono: "PRIVATE-FAMILY-TWO", claveHash: "PRIVATE-PASSWORD-HASH", deviceUid: "PRIVATE-DEVICE-TOKEN" };
  const workbook = await roundTrip([item, { ...fixture(2), prorrogaActiva: { ...fixture().prorrogaActiva, expiresOn: null } }]);
  const detail = workbook.getWorksheet("Cartera en mora");
  assert.equal(detail.getCell("Q2").value, "No", "una mención de prórroga no es una autorización activa");
  assert.equal(detail.getCell("R2").value, null);
  assert.equal(detail.getCell("Q3").value, "Sí");
  assert.equal(detail.getCell("R3").value, null, "vigencia abierta no inventa un vencimiento");
  const serialized = JSON.stringify(workbook.model);
  for (const secret of ["PRIVATE-SNAPSHOT", "PRIVATE-FAMILY-ONE", "PRIVATE-FAMILY-TWO", "PRIVATE-PASSWORD-HASH",
    "PRIVATE-DEVICE-TOKEN", "PRIVATE-IDEMPOTENCY", "PRIVATE-EXTENSION-REASON", "PRIVATE-APPROVER", "INTERNAL-COMMENT-NOT-EXPORTED", "INTERNAL-ACTOR-NOT-EXPORTED"]) {
    assert(!serialized.includes(secret), `${secret} no pertenece a las columnas autorizadas`);
  }
});

test("exportación vacía conserva encabezados, filtros y totales cero sin filas ficticias", async () => {
  const workbook = await roundTrip([]);
  const detail = workbook.getWorksheet("Cartera en mora");
  assert.equal(detail.rowCount, 1);
  assert.equal(detail.autoFilter, "A1:S1");
  const values = summaryValues(workbook);
  assert.equal(values.get("Créditos exportados").value, 0);
  assert.equal(values.get("Total valor vencido (COP)").value, 0);
  assert.equal(values.get("Total saldo pendiente (COP)").value, 0);
  assert.equal(values.get("Aliado").value, "Todos");
  assert.equal(values.get("Responsable").value, "Todos");
  assert.equal(values.get("Estado de gestión").value, "Todos");
  assert.equal(values.get("Fecha próxima gestión").value, "Cualquier fecha");
});
