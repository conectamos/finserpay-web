import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { buildSadminWorkbook } = await jiti.import("../lib/credit-sadmin-excel.ts");

const headers = [
  "Fecha crédito", "Creado", "Número crédito", "Folio original", "Estado SADMIN", "Número SADMIN",
  "Codeudor creado", "Crédito creado", "Número confirmado", "Actualizado SADMIN", "Completado SADMIN",
  "Nombre", "Cédula", "Teléfono", "Correo", "Dirección", "Fecha nacimiento", "Género", "Referencia",
  "IMEI", "Aliado", "Sede", "Valor venta", "Inicial", "Crédito autorizado", "N.º cuotas", "Valor cuota",
  "Frecuencia", "Interés mensual efectivo", "Fianza total del crédito", "Seguro por cuota", "Próximo pago",
  "Cuotas pagadas", "Cuotas pendientes", "Días vencidos", "Último pago", "Saldo obligación", "Saldo capital",
  "Saldo fianza", "Saldo intereses",
];

const example = {
  id: 81,
  folio: "FC-20260908123000-00081",
  numeroCreditoVisible: "0000123-A",
  createdAt: "2026-09-08T17:30:00.000Z",
  fechaCredito: "2026-09-08",
  clienteNombre: "María Pérez & Hijos",
  clienteDocumento: "00105616341",
  clienteTelefono: "+57 3001234567",
  clienteDireccion: "Calle 1 # 2-03",
  clienteFechaNacimiento: "1990-01-02",
  clienteCorreo: "maria@example.test",
  clienteGenero: "FEMENINO",
  imei: "001234567890123",
  referenciaEquipo: "IPHONE 16 128GB",
  numeroCuotas: 24,
  frecuenciaPago: "Quincenal",
  valorVenta: 2_640_000,
  cuotaInicial: 1_200_000,
  creditoAutorizado: 1_440_000,
  valorCuota: 89_500,
  interesMensual: 0.021605,
  fianza: 0.75,
  seguro: 0.0003,
  aliadoNombre: "Aliado de prueba",
  sedeNombre: "Sede de prueba",
  fechaProximoPago: "2026-10-02",
  cuotasPagadas: 3,
  cuotasPendientes: 21,
  saldoObligacion: 1_879_500,
  saldoCapital: 1_100_000,
  saldoFianza: 500_000,
  saldoIntereses: 279_500,
  diasVencidos: 0,
  ultimoPago: "2026-09-17 · $ 89.500 · EFECTIVO",
  sadmin: {
    version: 4,
    codeudorCreado: true,
    creditoCreado: true,
    numeroCreditoConfirmado: true,
    numeroCredito: "0000123-A",
    estado: "CREADO_SADMIN",
    updatedAt: "2026-09-18T14:30:00.000Z",
    completedAt: "2026-09-18T14:35:00.000Z",
  },
};

async function roundTrip(items) {
  const buffer = await buildSadminWorkbook(items).xlsx.writeBuffer();
  assert.equal(buffer.subarray(0, 2).toString(), "PK", "debe producir un XLSX ZIP real");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.getWorksheet("Creación SADMIN");
}

test("exporta las 40 columnas SADMIN en el orden documentado y con tipos nativos", async () => {
  const sheet = await roundTrip([example]);
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.columnCount, 40);
  assert.deepEqual(sheet.getRow(1).values.slice(1), headers);

  for (const [address, expected] of [
    ["C2", example.numeroCreditoVisible], ["D2", example.folio], ["E2", "CREADO SADMIN"],
    ["F2", example.sadmin.numeroCredito], ["L2", example.clienteNombre], ["M2", example.clienteDocumento],
    ["N2", example.clienteTelefono], ["S2", example.referenciaEquipo], ["T2", example.imei],
  ]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(address).numFmt, "@");
  }
  assert.deepEqual(["G2", "H2", "I2"].map(address => sheet.getCell(address).value), ["Sí", "Sí", "Sí"]);

  for (const [address, expected] of [
    ["W2", example.valorVenta], ["X2", example.cuotaInicial], ["Y2", example.creditoAutorizado],
    ["AA2", example.valorCuota], ["AK2", example.saldoObligacion], ["AL2", example.saldoCapital],
    ["AM2", example.saldoFianza], ["AN2", example.saldoIntereses],
  ]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Number);
    assert.equal(sheet.getCell(address).numFmt, '"$" #,##0');
  }
  for (const [address, expected] of [["Z2", 24], ["AG2", 3], ["AH2", 21], ["AI2", 0]]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Number);
  }
  for (const [address, expected] of [["AC2", 0.021605], ["AD2", 0.75], ["AE2", 0.0003]]) {
    assert.equal(sheet.getCell(address).value, expected);
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Number);
    assert.equal(sheet.getCell(address).numFmt, "0.0000%");
  }
  for (const address of ["A2", "B2", "J2", "K2", "Q2", "AF2"]) {
    assert.equal(sheet.getCell(address).type, ExcelJS.ValueType.Date, `${address} debe ser una fecha real`);
  }
  assert.equal(sheet.getCell("A2").numFmt, "dd/mm/yyyy");
  assert.equal(sheet.getCell("B2").numFmt, "dd/mm/yyyy hh:mm");
  assert.equal(sheet.getCell("J2").numFmt, "dd/mm/yyyy hh:mm");
  assert.equal(sheet.getCell("K2").numFmt, "dd/mm/yyyy hh:mm");
  assert.equal(sheet.getCell("Q2").numFmt, "dd/mm/yyyy");
  assert.equal(sheet.getCell("AF2").numFmt, "dd/mm/yyyy");
});

test("conserva ceros iniciales y textos peligrosos como literales, nunca como fórmulas", async () => {
  const dangerous = ["=1+1", "+573001234567", "-00123", "@SUM(A1:A2)", "00012345678901234567"];
  const items = dangerous.map((value, index) => ({
    ...example,
    id: index + 1,
    folio: value,
    numeroCreditoVisible: value,
    clienteNombre: value,
    clienteDocumento: value,
    clienteTelefono: value,
    referenciaEquipo: value,
    imei: value,
    sadmin: { ...example.sadmin, numeroCredito: value },
  }));
  const before = structuredClone(items);
  const sheet = await roundTrip(items);

  dangerous.forEach((value, index) => {
    for (const column of [3, 4, 6, 12, 13, 14, 19, 20]) {
      const cell = sheet.getRow(index + 2).getCell(column);
      assert.equal(cell.value, value);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.numFmt, "@");
      assert.equal(cell.formula, undefined);
    }
  });
  assert.deepEqual(items, before, "el builder no debe modificar los registros recibidos");
});

test("preserva ceros y representa ausencias sin inventar datos", async () => {
  const pending = {
    ...example,
    numeroCreditoVisible: example.folio,
    clienteFechaNacimiento: null,
    fechaProximoPago: null,
    interesMensual: 0,
    fianza: 0,
    seguro: null,
    cuotasPagadas: 0,
    cuotasPendientes: 0,
    diasVencidos: 0,
    saldoObligacion: 0,
    saldoCapital: 0,
    saldoFianza: 0,
    saldoIntereses: 0,
    ultimoPago: null,
    sadmin: {
      version: 0,
      codeudorCreado: false,
      creditoCreado: false,
      numeroCreditoConfirmado: false,
      numeroCredito: null,
      estado: "PENDIENTE",
      updatedAt: null,
      completedAt: null,
    },
  };
  const sheet = await roundTrip([pending]);
  assert.equal(sheet.getCell("E2").value, "PENDIENTE SADMIN");
  assert.equal(sheet.getCell("F2").text, "");
  assert.deepEqual(["G2", "H2", "I2"].map(address => sheet.getCell(address).value), ["No", "No", "No"]);
  for (const address of ["J2", "K2", "Q2", "AF2"]) assert.equal(sheet.getCell(address).value, null);
  for (const address of ["AC2", "AD2", "AG2", "AH2", "AI2", "AK2", "AL2", "AM2", "AN2"]) {
    assert.equal(sheet.getCell(address).value, 0, `${address} debe conservar cero`);
  }
  assert.equal(sheet.getCell("AE2").value, null);
  assert.equal(sheet.getCell("AJ2").text, "");
});

test("un resultado vacío sigue siendo un Excel utilizable con encabezado, filtro y fila congelada", async () => {
  const sheet = await roundTrip([]);
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 1);
  assert.equal(sheet.columnCount, 40);
  assert.deepEqual(sheet.getRow(1).values.slice(1), headers);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.autoFilter, "A1:AN1");
});
