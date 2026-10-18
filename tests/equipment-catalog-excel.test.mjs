import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const excel = await jiti.import("../lib/equipment-catalog-excel.ts");
const roles = await jiti.import("../lib/roles.ts");
const aliados = await jiti.import("../lib/aliados.ts");
const central = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
const ally = { id: 2, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" };
const items = [
  ...Array.from({ length: 14 }, (_, index) => ({
    id: index + 1, marca: "SAMSUNG", modelo: `Galaxy A${index}`, precioBaseVenta: 1_000_000 + index * 10_000, activo: true,
  })),
  { id: 20, marca: "IPHONE", modelo: "iPhone 15", precioBaseVenta: 3_000_000, activo: true },
  { id: 21, marca: "APPLE", modelo: "iPhone 14", precioBaseVenta: 2_500_000, activo: true },
  { id: 22, marca: "Apple iPhone", modelo: "iPhone 13", precioBaseVenta: 2_000_000, activo: true },
  { id: 23, marca: "XIAOMI", modelo: "Redmi Nóte 13", precioBaseVenta: 875_900, activo: true },
  { id: 24, marca: "SAMSUNG", modelo: "Retirado A", precioBaseVenta: 600_000, activo: false },
  { id: 25, marca: "APPLE", modelo: "Retirado iPhone", precioBaseVenta: 1_500_000, activo: false },
];
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(user, { rows = items, fail = false } = {}) {
  const calls = [], logged = [], vmModule = { exports: {} };
  const dependencies = {
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": aliados,
    "@/lib/roles": roles,
    "@/lib/equipment-catalog-excel": excel,
    "@/lib/equipment-catalog": {
      async getEquipmentCatalog(options) {
        calls.push(plain(options));
        if (fail) throw new Error("private-database-error");
        // Deliberately return inactive rows even for active-only reads to exercise the final export boundary.
        return structuredClone(rows);
      },
    },
  };
  const source = ts.transpileModule(readFileSync(path.join(projectRoot, "app/api/creditos/catalogo-equipos/exportar/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    module: vmModule, exports: vmModule.exports, Request, Response, URL, Uint8Array,
    console: { error: (...args) => logged.push(args) },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
  });
  return { calls, logged, route: vmModule.exports, request: (search = "") => vmModule.exports.GET(new Request(`https://finser.test/api/creditos/catalogo-equipos/exportar${search}`)) };
}

async function workbookFrom(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Disposition"), /^attachment; filename="catalogo-equipos-[a-z]+-[a-z]+\.xlsx"$/);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0, 2).toString(), "PK", "exports a real XLSX rather than HTML or CSV");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("central y aliado descargan el catálogo completo activo, sin limitarlo a diez filas ni modificar los precios", async () => {
  const expected = items.filter(item => item.activo);
  const original = structuredClone(items);
  for (const user of [central, ally]) {
    const f = fixture(user);
    const workbook = await workbookFrom(await f.request("?page=2&pageSize=10"));
    const sheet = workbook.getWorksheet("Catálogo de equipos");
    assert.equal(workbook.worksheets.length, 1);
    assert.equal(workbook.creator, "FINSER PAY");
    assert.equal(sheet.rowCount, expected.length + 1);
    assert.ok(sheet.rowCount > 11);
    assert.deepEqual(sheet.getRow(1).values.slice(1), ["Producto", "Marca", "Modelo", "Precio base de venta", "Estado"]);
    assert.equal(sheet.columnCount, 5);
    assert.equal(sheet.views[0].state, "frozen");
    assert.equal(sheet.views[0].ySplit, 1);
    assert.equal(sheet.autoFilter, `A1:E${sheet.rowCount}`);
    assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF151A21");
    expected.forEach((item, index) => {
      const row = sheet.getRow(index + 2);
      assert.equal(row.getCell(2).value, item.marca);
      assert.equal(row.getCell(3).value, item.modelo);
      assert.equal(row.getCell(4).type, ExcelJS.ValueType.Number);
      assert.equal(row.getCell(4).value, item.precioBaseVenta);
      assert.equal(row.getCell(4).numFmt, "[$$-es-CO] #,##0");
      assert.equal(row.getCell(5).value, "Activo");
    });
    assert.deepEqual(f.calls, [{ includeInactive: false }]);
    assert.equal(f.route.POST, undefined);
    assert.equal(f.route.PATCH, undefined);
    assert.equal(f.route.DELETE, undefined);
  }
  assert.deepEqual(items, original);
});

test("el servidor protege la exportación sin sesión y ante roles de vendedor, supervisor o analista", async () => {
  for (const [user, status] of [[null, 401], ...["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"].map(rolNombre => [{ ...central, rolNombre }, 403])]) {
    const f = fixture(user);
    const response = await f.request("?status=TODOS&includeInactive=true");
    assert.equal(response.status, status);
    assert.ok((await response.json()).error);
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    assert.deepEqual(f.calls, [], "authorization precedes every catalogue read and XLSX build");
  }
});

test("el aliado no exporta retirados aunque manipule todos los parámetros de estado", async () => {
  for (const status of ["TODOS", "RETIRADOS", "retirados", "INVALIDO"]) {
    const f = fixture(ally);
    const response = await f.request(`?status=${status}&includeInactive=true&product=TODOS`);
    assert.match(response.headers.get("Content-Disposition"), /todos-activos\.xlsx/);
    const workbook = await workbookFrom(response);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, items.filter(item => item.activo).length + 1);
    sheet.eachRow((row, index) => { if (index > 1) assert.equal(row.getCell(5).value, "Activo"); });
    assert.deepEqual(f.calls, [{ includeInactive: false }]);
  }
});

test("el administrador central conserva la descarga de retirados o de todo el catálogo", async () => {
  for (const [status, expected] of [["TODOS", items], ["RETIRADOS", items.filter(item => !item.activo)]]) {
    const f = fixture(central);
    const workbook = await workbookFrom(await f.request(`?status=${status}`));
    assert.equal(workbook.worksheets[0].rowCount, expected.length + 1);
    assert.deepEqual(workbook.worksheets[0].getColumn(3).values.slice(2), expected.map(item => item.modelo));
    assert.deepEqual(f.calls, [{ includeInactive: true }]);
  }
});

test("los filtros Android e iPhone reutilizan la clasificación del sistema incluyendo las marcas Apple", async () => {
  for (const user of [central, ally]) {
    const iphone = await workbookFrom(await fixture(user).request("?product=IPHONE"));
    assert.deepEqual(iphone.worksheets[0].getColumn(3).values.slice(2), ["iPhone 15", "iPhone 14", "iPhone 13"]);
    iphone.worksheets[0].eachRow((row, index) => { if (index > 1) assert.equal(row.getCell(1).value, "IPHONE"); });
    const android = await workbookFrom(await fixture(user).request("?product=ANDROID"));
    assert.equal(android.worksheets[0].rowCount, 16);
    android.worksheets[0].eachRow((row, index) => { if (index > 1) assert.equal(row.getCell(1).value, "ANDROID"); });
  }
});

test("la búsqueda ignora tildes, mayúsculas y espacios, y se combina con producto y estado", async () => {
  const f = fixture(central);
  const workbook = await workbookFrom(await f.request("?q=%20Xiaomi%20%20Redmi%20NoTE%20&product=ANDROID&status=TODOS"));
  assert.equal(workbook.worksheets[0].rowCount, 2);
  assert.equal(workbook.worksheets[0].getCell("C2").value, "Redmi Nóte 13");
  const noMatch = await workbookFrom(await f.request("?q=note&product=IPHONE"));
  assert.equal(noMatch.worksheets[0].rowCount, 1);
  assert.equal(noMatch.worksheets[0].autoFilter, "A1:E1");
});

test("los textos con prefijos de fórmula quedan literales y no se exportan campos privados", async () => {
  const values = ["=1+1", "+00123", "-00123", "@SUM(A1:A2)", '=HYPERLINK("https://example.test", "Click")'];
  const rows = values.map((value, index) => ({ ...items[0], id: index, marca: value, modelo: value, privateToken: "excluded-private-token", documentUrl: "https://private.test" }));
  const workbook = await workbookFrom(await fixture(central, { rows }).request());
  const sheet = workbook.worksheets[0];
  values.forEach((value, index) => {
    for (const column of [2, 3]) {
      const cell = sheet.getRow(index + 2).getCell(column);
      assert.equal(cell.value, value);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.formula, undefined);
      assert.equal(cell.hyperlink, undefined);
      assert.equal(cell.numFmt, "@");
    }
  });
  assert.doesNotMatch(JSON.stringify(sheet.model), /excluded-private-token|private\.test/);
});

test("un fallo de consulta no entrega un archivo incompleto ni expone el error interno", async () => {
  const f = fixture(ally, { fail: true });
  const response = await f.request();
  assert.equal(response.status, 500);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.equal(response.headers.get("Content-Disposition"), null);
  assert.match((await response.json()).error, /No se pudo descargar/);
  assert.equal(f.logged.length, 1);
});
