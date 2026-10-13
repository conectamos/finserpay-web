import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { writeSolicitudExportWorkbook } = await jiti.import("../lib/solicitudes-export-excel.ts");

const sample = {
  solicitudNumero: "SOL-001", createdAt: "2026-10-13T02:30:00.000Z", estado: "En estudio",
  numeroCredito: "0000000123456789012345", numeroSadmin: "00000098765",
  nombreCompleto: "María Pérez & Hijos", tipoDocumento: "CC", numeroDocumento: "00.123.456",
  celular: "003001234567", correo: "correo@example.test", departamento: "Antioquia", ciudad: "Medellín",
  direccion: "Calle 1 # 2-3", aliado: "Aliado A", sede: "Sede Norte", vendedor: "Vendedora A",
  marcaEquipo: "Marca A", referenciaEquipo: "Equipo 128GB", imei: "001234567890123456789",
  valorEquipo: 2000000.25, inicial: 0, valorFinanciado: 2000000.25,
  numeroCuotas: 12, valorCuota: 180000.5, frecuencia: "Mensual", primerPago: "2026-11-15T00:00:00.000Z",
};

async function* iterable(rows) { yield* rows; }

async function temporaryFile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "finser-solicitudes-excel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "export.xlsx");
}

async function roundTrip(t, rows, options) {
  const filename = await temporaryFile(t);
  const progress = [];
  const result = await writeSolicitudExportWorkbook(iterable(rows), filename, (count) => { progress.push(count); }, options);
  const buffer = await readFile(filename);
  assert.equal(buffer.subarray(0, 2).toString(), "PK", "must be a real XLSX ZIP");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { workbook, result, progress };
}

test("exporta las 26 columnas permitidas, identificadores literales, COP numéricos y fecha de Bogotá", async (t) => {
  const row = { ...sample, password: "excluded-password", accessToken: "excluded-token", documentoUrl: "https://private.test/document" };
  const { workbook, result, progress } = await roundTrip(t, [row]);
  const sheet = workbook.getWorksheet("Solicitudes");
  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(progress, [1]);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.columnCount, 26);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "Número de solicitud", "Fecha de creación (Bogotá)", "Estado", "Número de crédito", "Número de Sadmin",
    "Nombres y apellidos completos", "Tipo de documento", "Número de documento", "Celular", "Correo",
    "Departamento", "Ciudad", "Dirección", "Aliado", "Sede", "Vendedor", "Marca del equipo", "Referencia del equipo",
    "IMEI", "Valor del equipo", "Inicial", "Valor financiado", "Número de cuotas", "Valor de cuota", "Frecuencia", "Primer pago",
  ]);
  for (const [address, value] of [
    ["A2", sample.solicitudNumero], ["D2", sample.numeroCredito], ["E2", sample.numeroSadmin],
    ["H2", "00123456"], ["I2", sample.celular], ["S2", sample.imei],
  ]) {
    const cell = sheet.getCell(address);
    assert.equal(cell.type, ExcelJS.ValueType.String);
    assert.equal(cell.numFmt, "@");
    assert.equal(cell.value, value);
    assert.equal(cell.formula, undefined);
    assert.equal(cell.hyperlink, undefined);
  }
  for (const [address, value] of [["T2", sample.valorEquipo], ["U2", 0], ["V2", sample.valorFinanciado], ["X2", sample.valorCuota]]) {
    const cell = sheet.getCell(address);
    assert.equal(cell.type, ExcelJS.ValueType.Number);
    assert.equal(cell.value, value);
    assert.equal(cell.numFmt, "[$$-es-CO] #,##0.00");
  }
  assert.equal(sheet.getCell("W2").value, 12);
  assert.equal(sheet.getCell("W2").type, ExcelJS.ValueType.Number);
  assert.equal(sheet.getCell("B2").type, ExcelJS.ValueType.Date);
  assert.equal(sheet.getCell("B2").value.toISOString(), "2026-10-12T21:30:00.000Z");
  assert.equal(sheet.getCell("Z2").value.toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(sheet.autoFilter, "A1:Z2");
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.getCell("A1").alignment.wrapText, true);
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF151A21");
  for (const column of sheet.columns) assert.ok(column.width >= 17);
  assert.ok(!JSON.stringify(sheet.getRow(2).values).includes("excluded-"));
  assert.ok(!JSON.stringify(sheet.getRow(2).values).includes("private.test"));
});

test("los textos con prefijos de fórmula y vínculos permanecen literales sin ejecutarse", async (t) => {
  const textKeys = Object.keys(sample).filter((key) => ![
    "createdAt", "primerPago", "valorEquipo", "inicial", "valorFinanciado", "numeroCuotas", "valorCuota",
  ].includes(key));
  const strings = ["=1+1", "+573001234567", "-00123", "@SUM(A1:A2)", "\t=SUM(1,2)", '=HYPERLINK("https://example.test", "Click")'];
  const rows = strings.map((value) => ({ ...sample, ...Object.fromEntries(textKeys.map((key) => [key, value])) }));
  const { workbook } = await roundTrip(t, rows);
  const sheet = workbook.getWorksheet("Solicitudes");
  const textColumns = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 25];
  strings.forEach((value, index) => {
    textColumns.forEach((column) => {
      const cell = sheet.getRow(index + 2).getCell(column);
      assert.equal(cell.value, column === 8 ? value.replace(/\./g, "") : value);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.formula, undefined);
      assert.equal(cell.hyperlink, undefined);
    });
  });
});

test("conserva datos faltantes vacíos, cero válido, Sadmin pendiente y solicitudes distintas de la misma cédula", async (t) => {
  const rows = [
    { solicitudNumero: "SOL-A", numeroDocumento: "0001", numeroSadmin: " ", inicial: 0 },
    { solicitudNumero: "SOL-B", numeroDocumento: "0001", createdAt: "invalid", primerPago: "invalid", valorEquipo: Number.NaN },
  ];
  const { workbook, result } = await roundTrip(t, rows);
  const sheet = workbook.getWorksheet("Solicitudes");
  assert.equal(result.count, 2);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell("A2").value, "SOL-A");
  assert.equal(sheet.getCell("A3").value, "SOL-B");
  assert.equal(sheet.getCell("H2").value, sheet.getCell("H3").value);
  assert.equal(sheet.getCell("E2").value, "PENDIENTE SADMIN");
  assert.equal(sheet.getCell("E3").value, "PENDIENTE SADMIN");
  assert.equal(sheet.getCell("U2").value, 0);
  for (const address of ["B2", "B3", "T2", "T3", "Z2", "Z3", "W2"]) assert.equal(sheet.getCell(address).value, null);
  for (const address of ["D2", "F2", "I2", "N2"]) assert.equal(sheet.getCell(address).text, "");
});

test("un periodo sin resultados genera solo los encabezados y conteo cero", async (t) => {
  const { workbook, result, progress } = await roundTrip(t, []);
  assert.equal(result.count, 0);
  assert.deepEqual(progress, [0]);
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(workbook.worksheets[0].rowCount, 1);
  assert.equal(workbook.worksheets[0].autoFilter, "A1:Z1");
});

test("primer pago conserva el día de SQL sin zona y descarta días imposibles", async (t) => {
  const { workbook } = await roundTrip(t, [
    { ...sample, primerPago: "2026-11-15 00:00:00" },
    { ...sample, primerPago: "2026-02-30" },
  ]);
  assert.equal(workbook.worksheets[0].getCell("Z2").value.toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(workbook.worksheets[0].getCell("Z3").value, null);
});

test("transmite miles de filas sin paginarlas ni recortarlas y comunica el progreso", async (t) => {
  const filename = await temporaryFile(t);
  let requested = 0;
  async function* rows() {
    for (let index = 0; index < 5_003; index += 1) {
      requested += 1;
      yield { ...sample, solicitudNumero: `SOL-${index}`, numeroDocumento: "0001" };
    }
  }
  const progress = [];
  const result = await writeSolicitudExportWorkbook(rows(), filename, (count) => { progress.push(count); });
  assert.equal(requested, 5_003);
  assert.equal(result.count, 5_003);
  assert.deepEqual(progress, [1_000, 2_000, 3_000, 4_000, 5_000, 5_003]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filename);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, result.count + 1);
  assert.equal(sheet.getCell("A2").value, "SOL-0");
  assert.equal(sheet.getCell("A5004").value, "SOL-5002");
  assert.equal(sheet.autoFilter, "A1:Z5004");
});

test("al alcanzar la capacidad de la hoja continúa en otra con todos sus encabezados y filtros", async (t) => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ ...sample, solicitudNumero: String(index) }));
  const { workbook, result } = await roundTrip(t, rows, { maxDataRowsPerSheet: 2 });
  assert.equal(result.count, 5);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Solicitudes", "Solicitudes 2", "Solicitudes 3"]);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.rowCount), [3, 3, 2]);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.autoFilter), ["A1:Z3", "A1:Z3", "A1:Z2"]);
  const identifiers = [];
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.views[0].ySplit, 1);
    sheet.eachRow((row, index) => { if (index > 1) identifiers.push(row.getCell(1).value); });
  }
  assert.deepEqual(identifiers, ["0", "1", "2", "3", "4"]);
});

test("un error de lectura elimina el archivo parcial y no entrega un resultado exitoso", async (t) => {
  const filename = await temporaryFile(t);
  async function* rows() {
    yield sample;
    throw new Error("Source unavailable");
  }
  await assert.rejects(writeSolicitudExportWorkbook(rows(), filename), /Source unavailable/);
  await assert.rejects(stat(filename), { code: "ENOENT" });
});

test("el generador nunca sobrescribe ni elimina archivos preexistentes", async (t) => {
  const filename = await temporaryFile(t);
  await writeFile(filename, "existing-file");
  await assert.rejects(writeSolicitudExportWorkbook(iterable([sample]), filename), { code: "EEXIST" });
  assert.equal(await readFile(filename, "utf8"), "existing-file");
});
