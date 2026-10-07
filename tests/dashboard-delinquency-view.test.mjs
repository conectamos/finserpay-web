import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ExcelJS from "exceljs";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const viewModule = await jiti.import("../lib/dashboard-delinquency-view.ts");
const { projectDashboardDelinquency, projectDashboardDelinquencyCredits,
  buildDashboardDelinquencyWorkbook, exportDashboardDelinquencyWorkbook } = viewModule;

function group(key, name, overdueBalance, extra = {}) {
  return { key, name, context: "Aliado 7", unassigned: false, activeCredits: 4,
    overdueCredits: 2, overduePercent: 50, overdueBalance,
    overdueSharePercent: overdueBalance / 600 * 100,
    overduePortfolioPercent: overdueBalance / 10000 * 100,
    ...extra };
}
function detail() {
  return { activeCredits: 10, overdueCredits: 4, overduePercent: 40, totalBalance: 10000,
    overdueBalance: 600, overduePortfolioPercent: 6,
    sites: [group("sede:70", "Centro", 330), group("sede:71", "Centro", 270)],
    sellers: [group("vendedor:2", "Ana", 330), group("usuario:2", "Ana", 270)] };
}
const forbiddenKeys = ["overdueBalance", "totalBalance", "overduePercent", "saldoPendiente", "montoCredito", "valorCuota"];
function assertNoFinancialProperties(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.includes(key), `No debe exponer ${key}`);
    assertNoFinancialProperties(child);
  }
}

test("DTO aliado usa whitelist sin saldos ni tasas auxiliares y conserva cálculos y orden", () => {
  const internal = detail();
  internal.hiddenFinancial = { saldo: 123456789 };
  internal.sites[0].capital = 99887766;
  const original = structuredClone(internal);
  const view = projectDashboardDelinquency(internal, { viewingCentral: false });
  assertNoFinancialProperties(view);
  assert.equal(Object.hasOwn(view, "hiddenFinancial"), false);
  assert.equal(Object.hasOwn(view.sites[0], "capital"), false);
  assert.deepEqual(Object.keys(view).sort(), ["activeCredits", "overdueCredits", "overduePortfolioPercent",
    "leadingSiteKeys", "leadingSellerKeys", "sites", "sellers"].sort());
  assert.equal(view.overduePortfolioPercent, 6);
  assert.equal(view.sites[0].overdueSharePercent, internal.sites[0].overdueSharePercent);
  assert.deepEqual(view.sites.map(item => item.key), ["sede:70", "sede:71"]);
  assert.deepEqual(view.sellers.map(item => item.key), ["vendedor:2", "usuario:2"]);
  assert.deepEqual(internal, original, "La sanitización no debe mutar el cálculo financiero interno");
});

test("central conserva el saldo de mora permitido, sin incorporar montos internos extra", () => {
  const view = projectDashboardDelinquency(detail(), { viewingCentral: true });
  assert.equal(view.overdueBalance, 600);
  assert.equal(view.sites[0].overdueBalance, 330);
  assert.equal(view.sellers[1].overdueBalance, 270);
  assert.equal(Object.hasOwn(view, "totalBalance"), false);
  assert.equal(Object.hasOwn(view, "overduePercent"), false);
  assert.equal(Object.hasOwn(view.sites[0], "overduePercent"), false);
  assertNoFinancialProperties(projectDashboardDelinquency(detail()), "El permiso omitido falla cerrado");
});

test("empates y grupos sin responsable conservan ranking sin revelar los valores", () => {
  const data = detail();
  data.sites = [group("unassigned", "Sin sede", 900, { unassigned: true }),
    group("sede:70", "Centro", 300), group("sede:71", "Norte", 300)];
  data.sellers = [group("unassigned", "Sin vendedor asignado", 900, { unassigned: true }),
    group("vendedor:2", "Ana", 300), group("usuario:2", "Ana", 300),
    group("vendedor:3", "Carlos", 0, { overdueCredits: 0 })];
  const view = projectDashboardDelinquency(data);
  assert.deepEqual(view.leadingSiteKeys, ["sede:70", "sede:71"]);
  assert.deepEqual(view.leadingSellerKeys, ["vendedor:2", "usuario:2"]);
  assert.equal(view.sites[0].unassigned, true);
  assertNoFinancialProperties(view);
  data.sites = [group("sede:70", "Centro", 0, { overdueCredits: 0 })];
  data.sellers = [];
  const empty = projectDashboardDelinquency(data);
  assert.deepEqual(empty.leadingSiteKeys, []);
  assert.deepEqual(empty.leadingSellerKeys, []);
});

function safeCredit() {
  return { id: 7, folio: "FC-0007", clienteNombre: "Nombre cliente", clienteDocumento: "00123456",
    sedeKey: "sede:70", sedeNombre: "Centro", sellerKey: "usuario:2", sellerNombre: "Ana",
    aliadoNombre: "Aliado 7", diasMora: 15 };
}

test("drilldown whitelist omite finanzas y otros datos del cliente sin perder IDs o cédula", () => {
  const source = { ...safeCredit(), montoCredito: 2000000, saldoPendiente: 700000, valorCuota: 150000,
    clienteTelefono: "3001234567", contratoSnapshot: { financiero: { cuota: 150000 } } };
  const credits = projectDashboardDelinquencyCredits([source]);
  assert.deepEqual(credits, [safeCredit()]);
  assertNoFinancialProperties(credits);
  assert.equal(source.montoCredito, 2000000);
});

async function roundTripWorkbook(workbook) {
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  return loaded;
}

test("Excel aliado sólo contiene agregados y ninguna columna monetaria incluso con input interno", async () => {
  const workbook = await roundTripWorkbook(buildDashboardDelinquencyWorkbook(detail(), { viewingCentral: false }));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Resumen", "Sedes", "Vendedores"]);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.columnCount), [3, 6, 6]);
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.state, "visible");
    const cells = [];
    sheet.eachRow(row => row.eachCell(cell => cells.push(cell.value)));
    assert.ok(!cells.includes("Saldo en mora"));
    assert.ok(!cells.includes(10000));
    assert.ok(!cells.includes(600));
    assert.ok(!cells.includes(330));
    assert.ok(!cells.includes(270));
    assert.ok(!cells.includes("Nombre cliente"));
  }
  const summary = workbook.getWorksheet("Resumen");
  assert.equal(summary.getCell("A2").value, 10);
  assert.equal(summary.getCell("B2").value, 4);
  assert.equal(summary.getCell("C2").value, 0.06);
  assert.equal(summary.getCell("C2").numFmt, "0.0%");
  const sites = workbook.getWorksheet("Sedes");
  assert.equal(sites.getCell("A2").value, "Centro");
  assert.equal(sites.getCell("C2").value, 4);
  assert.equal(sites.getCell("D2").value, 2);
  assert.ok(Math.abs(sites.getCell("E2").value - 0.55) < 1e-10);
});

test("Excel central incluye saldo en mora y porcentajes numéricos sin modificar agregación", async () => {
  const workbook = await roundTripWorkbook(buildDashboardDelinquencyWorkbook(
    projectDashboardDelinquency(detail(), { viewingCentral: true }), { viewingCentral: true }));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.columnCount), [4, 7, 7]);
  assert.equal(workbook.getWorksheet("Resumen").getCell("D2").value, 600);
  assert.equal(workbook.getWorksheet("Sedes").getCell("G2").value, 330);
  assert.equal(workbook.getWorksheet("Vendedores").getCell("G3").value, 270);
  assert.equal(workbook.getWorksheet("Sedes").getCell("G2").numFmt, '"$" #,##0');
  assert.ok(Math.abs(workbook.getWorksheet("Sedes").getCell("F2").value - 0.033) < 1e-10);
});

test("Excel predeterminado redacta y trata nombres como texto literal, no fórmulas", async () => {
  const data = detail();
  data.sites[0].name = '=HYPERLINK("https://example.com","Abrir")';
  const buffer = await exportDashboardDelinquencyWorkbook(data);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet("Resumen").columnCount, 3);
  const cell = workbook.getWorksheet("Sedes").getCell("A2");
  assert.equal(cell.value, data.sites[0].name);
  assert.equal(cell.type, ExcelJS.ValueType.String);
});

const serviceSource = readFileSync(path.join(root, "app/dashboard/_lib/delinquency-detail-data.ts"), "utf8");
const compiledService = ts.transpileModule(serviceSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadService() {
  const calls = [];
  const loaded = { exports: {} };
  runInNewContext(compiledService, { module: loaded, exports: loaded.exports, Date,
    require: name => {
      if (name === "@/lib/dashboard-delinquency-view") return viewModule;
      if (name === "@/app/dashboard/_lib/admin-dashboard-data") return {
        getAdminDashboardOverview: async options => {
          calls.push(options);
          return { delinquencyDetail: detail(), delinquencyCredits: [{ ...safeCredit(), saldoPendiente: 999999 }] };
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { get: loaded.exports.getDelinquencyDetailData, calls };
}

test("servicio aliado consulta su alcance, misma mora vigente y retorna sólo payload seguro", async () => {
  const { get, calls } = loadService();
  const result = await get(7, false);
  assert.equal(calls[0].aliadoId, 7);
  assert.equal(calls[0].includeDelinquencyCredits, true);
  assert.equal(Object.hasOwn(calls[0], "month"), false);
  assertNoFinancialProperties(result);
  assert.deepEqual(result.credits, [safeCredit()]);
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
});

test("servicio falla cerrado sin alcance aliado; central puede consultar alcance global", async () => {
  const { get, calls } = loadService();
  for (const id of [null, undefined, 0, -1, 1.5, NaN]) await assert.rejects(() => get(id, false), /aliado/);
  assert.equal(calls.length, 0);
  const result = await get(null, true);
  assert.equal(calls[0].aliadoId, null);
  assert.equal(result.detail.overdueBalance, 600);
  assert.equal(result.detail.sites[0].overdueBalance, 330);
});
