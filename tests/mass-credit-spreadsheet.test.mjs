import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildMassCreditWorkbook } from "../lib/mass-credit-spreadsheet.ts";
const headers = ["FECHA", "CEDULA", "CLIENTE", "TELEFONO", "REFERENCIA", "IMEI", "ALIADO", "SEDE", "VENDEDOR", "INICIAL", "VALOR DEL CREDITO", "CUOTA", "PLAZO", "FRECUENCIA", "FECHA DE PAGO", "Número de crédito en SADMIN", "DIRECCION", "CORREO", "FECHA DE NACIMIENTO", "SEXO"];
const example = ["2026-09-25", "0012345678", "CLIENTE", "03001234567", "EQUIPO", "001234567890128", "ALIADO", "SEDE", "VENDEDOR", "0", "600000", "50000", "12", "MENSUAL", "2026-10-25", "00012345", "Calle Peña #10-02", "cliente+credito@example.test", "15/1/1990", "PREFIERO_NO_DECIR"];

test("Excel template keeps IMEI and other identifiers as text after saving and reopening", async () => {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await buildMassCreditWorkbook(headers, example));
  const sheet = book.getWorksheet("Creditos");
  assert.equal(book.views[0].activeTab, 0);
  assert.deepEqual(sheet.getRow(1).values.slice(1), headers);
  assert.equal(sheet.columnCount, 20);
  for (const col of [1, 2, 4, 6, 15, 16, 19]) {
    assert.equal(sheet.getCell(2, col).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(2, col).value, example[col - 1]);
    assert.equal(sheet.getCell(251, col).numFmt, "@");
  }
  for (const col of [17, 18, 19, 20]) {
    assert.equal(sheet.getCell(2, col).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(2, col).value, example[col - 1]);
  }
  const instructions = book.getWorksheet("Instrucciones");
  assert.match(instructions.getCell("A5").value, /CSV UTF-8/);
  assert.match(instructions.getCell("A9").value, /DIRECCION, CORREO, FECHA DE NACIMIENTO y SEXO.*obligatorios/);
  assert.match(instructions.getCell("A10").value, /PREFIERO_NO_DECIR/);
});
