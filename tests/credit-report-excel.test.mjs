import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildCreditReportWorkbook } from "../lib/credit-report-excel.ts";

const example = {
  fechaCredito: "2026-09-08T17:30:00.000Z",
  folio: "FC-20260908123000-TEST",
  clienteNombre: "María Pérez & Hijos",
  clienteDocumento: "00105616341",
  clienteTelefono: "+57 3001234567",
  referenciaEquipo: "IPHONE 16 128GB",
  equipoMarca: "APPLE",
  equipoModelo: "IPHONE 16",
  imei: "001234567890123",
  sede: { nombre: "Sede de ejemplo", aliado: { nombre: "Aliado de ejemplo" } },
  usuario: { nombre: "Vendedor de ejemplo" },
  valorEquipoTotal: 2640000,
  cuotaInicial: 1200000,
  creditoAutorizado: 1440000,
  estado: "ENTREGABLE",
};

async function roundTrip(items) {
  const buffer = await buildCreditReportWorkbook(items).xlsx.writeBuffer();
  assert.equal(buffer.subarray(0, 2).toString(), "PK", "debe ser un archivo XLSX ZIP real");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.getWorksheet("Créditos");
}

test("exporta las 14 columnas con identificadores completos y valores numéricos", async () => {
  const sheet = await roundTrip([example]);
  assert.equal(sheet.rowCount, 2);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "Fecha", "Folio", "Cliente", "Documento", "Teléfono", "Referencia", "IMEI",
    "Aliado", "Sede", "Vendedor", "Valor venta", "Inicial", "Valor crédito autorizado", "Estado",
  ]);
  for (const [address, expected] of [
    ["B2", example.folio], ["C2", example.clienteNombre],
    ["D2", example.clienteDocumento], ["E2", example.clienteTelefono], ["G2", example.imei],
  ]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(address).numFmt, "@");
  }
  for (const [address, expected] of [["K2", 2640000], ["L2", 1200000], ["M2", 1440000]]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Number);
    assert.equal(sheet.getCell(address).numFmt, '"$" #,##0');
  }
  assert.equal(sheet.getCell("A2").type, ExcelJS.ValueType.Date);
  const sourceDate = new Date(example.fechaCredito);
  assert.equal(sheet.getCell("A2").value.getTime(), Date.UTC(
    sourceDate.getFullYear(), sourceDate.getMonth(), sourceDate.getDate(),
  ));
  assert.equal(sheet.getCell("A2").numFmt, "dd/mm/yyyy");
});

test("conserva literalmente textos que empiezan por fórmulas, signos o ceros", async () => {
  const texts = ["=1+1", "+573001234567", "-00123", "@SUM(A1:A2)", "00012345678901234567"];
  const sheet = await roundTrip(texts.map((text) => ({
    ...example, folio: text, clienteNombre: text, clienteDocumento: text,
    clienteTelefono: text, imei: text, referenciaEquipo: text,
  })));
  texts.forEach((text, index) => {
    for (let column = 2; column <= 7; column += 1) {
      const cell = sheet.getRow(index + 2).getCell(column);
      assert.equal(cell.value, text);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.formula, undefined);
    }
  });
});

test("respeta filas y orden recibidos, vacíos, ceros y referencia alternativa", async () => {
  const sheet = await roundTrip([
    { ...example, folio: "PRIMERO" },
    {
      ...example, folio: "SEGUNDO", fechaCredito: "fecha inválida",
      clienteDocumento: null, clienteTelefono: null, referenciaEquipo: null,
      sede: { nombre: "Sin aliado", aliado: null },
      valorEquipoTotal: 0, cuotaInicial: 0, creditoAutorizado: 0,
    },
  ]);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell("B2").value, "PRIMERO");
  assert.equal(sheet.getCell("B3").value, "SEGUNDO");
  assert.equal(sheet.getCell("A3").value, null);
  assert.equal(sheet.getCell("D3").text, "");
  assert.equal(sheet.getCell("E3").text, "");
  assert.equal(sheet.getCell("F3").value, "APPLE IPHONE 16");
  assert.equal(sheet.getCell("H3").text, "");
  for (const column of ["K", "L", "M"]) assert.equal(sheet.getCell(`${column}3`).value, 0);
  assert.equal(sheet.autoFilter, "A1:N3");
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.getCell("A1").alignment.wrapText, true);
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF151A21");
  assert.equal(sheet.getCell("A2").fill.fgColor.argb, "FFFFFFFF");
  assert.equal(sheet.getCell("A3").fill.fgColor.argb, "FFF5F6F4");
  assert.equal((await roundTrip([])).rowCount, 1);
});

test("la fecha de Excel conserva el día mostrado en Colombia cerca de medianoche UTC", () => {
  const script = `
    import { buildCreditReportWorkbook } from ${JSON.stringify(new URL("../lib/credit-report-excel.ts", import.meta.url).href)};
    const item = ${JSON.stringify({ ...example, fechaCredito: "2026-09-09T00:30:00.000Z" })};
    process.stdout.write(buildCreditReportWorkbook([item]).getWorksheet("Créditos").getCell("A2").value.toISOString());
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "America/Bogota" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2026-09-08T00:00:00.000Z");
});

test("la columna Estado coincide con el reporte aprobado y conserva el fallback historico", async () => {
  const items = [
    { ...example, estado: "INSCRITO", estadoReporte: "APROBADO" },
    { ...example, estado: "ANULADO", estadoReporte: "ANULADO" },
    { ...example, estado: "INSCRITO" },
  ];
  const snapshot = structuredClone(items);
  const sheet = await roundTrip(items);
  assert.deepEqual([2, 3, 4].map(row => sheet.getCell("N" + row).value), ["APROBADO", "ANULADO", "INSCRITO"]);
  for (const row of [2, 3, 4]) {
    assert.equal(sheet.getCell("K" + row).value, example.valorEquipoTotal);
    assert.equal(sheet.getCell("L" + row).value, example.cuotaInicial);
    assert.equal(sheet.getCell("M" + row).value, example.creditoAutorizado);
  }
  assert.equal(sheet.columnCount, 14);
  assert.deepEqual(items, snapshot);
});
