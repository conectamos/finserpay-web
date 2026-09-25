import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildMassCreditWorkbook } from "../lib/mass-credit-spreadsheet.ts";
const headers = ["FECHA", "CEDULA", "CLIENTE", "TELEFONO", "REFERENCIA", "IMEI", "ALIADO", "SEDE", "VENDEDOR", "INICIAL", "VALOR DEL CREDITO", "CUOTA", "PLAZO", "FRECUENCIA", "FECHA DE PAGO", "Número de crédito en SADMIN"];
const example = ["2026-09-25", "0012345678", "CLIENTE", "03001234567", "EQUIPO", "001234567890123", "ALIADO", "SEDE", "VENDEDOR", "0", "600000", "50000", "12", "MENSUAL", "2026-10-25", "00012345"];

test("Excel template keeps IMEI and other identifiers as text after saving and reopening", async () => {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await buildMassCreditWorkbook(headers, example));
  const sheet = book.getWorksheet("Creditos");
  assert.equal(book.views[0].activeTab, 0);
  for (const col of [1, 2, 4, 6, 15, 16]) {
    assert.equal(sheet.getCell(2, col).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(2, col).value, example[col - 1]);
    assert.equal(sheet.getCell(251, col).numFmt, "@");
  }
  assert.match(book.getWorksheet("Instrucciones").getCell("A5").value, /CSV UTF-8/);
});
