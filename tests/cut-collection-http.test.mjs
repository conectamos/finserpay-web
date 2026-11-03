import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { CutCollectionError, parseCutFilters, cutAccessFromDashboard } = await jiti.import("../lib/cut-collection-access.ts");
const root = path.resolve(import.meta.dirname, "..");
const url = "https://finser.example/api/reportes/recaudo-por-corte";
const filters = { day: 17, month: 10, year: 2026, aliadoId: 1, sedeId: 10, status: "parcial" };
const query = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
const access = { userId: 8, central: false, aliadoId: 1, sedeId: 10 };
const report = { ok: true, mode: "consulta", cutDate: "2026-10-17", projection: null, history: [],
  historyPage: 0, historyHasMore: false, rows: [], filters, summary: { creditsCount: 0 } };

// Real handlers and filter parsing; only session, report and workbook boundaries
// are substituted. Legacy persistence must never run.
function harness(overrides = {}) {
  const calls = { access: 0, parse: [], read: [], legacyRead: [], save: [], excel: [] };
  const source = readFileSync(path.join(root, "app/api/reportes/recaudo-por-corte/route.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const mod = { exports: {} };
  function scopedRequire(name) {
    if (name === "@/lib/cut-collection-access") return {
      CutCollectionError,
      getCutCollectionAccess: async () => { calls.access++; if (overrides.accessError) throw overrides.accessError; return overrides.access ?? access; },
      parseCutFilters: value => {
        calls.parse.push(Object.fromEntries(value));
        return parseCutFilters(value, new Date("2026-11-02T15:00:00Z"));
      },
    };
    if (name === "@/lib/cut-collection-storage") return {
      getDirectCutCollectionReport: async (...args) => { calls.read.push(args); if (overrides.error) throw overrides.error; return report; },
      getCutCollectionReport: async (...args) => { calls.legacyRead.push(args); throw new Error("No se debe consultar una proyección"); },
      saveCutCollectionProjection: async (...args) => { calls.save.push(args); throw new Error("No se debe guardar una proyección"); },
    };
    if (name === "@/lib/cut-collection-excel") return {
      buildCutCollectionWorkbook: value => { calls.excel.push(value); return { xlsx: { writeBuffer: async () => Buffer.from("PK-test") } }; },
    };
    return require(name);
  }
  new Function("require", "module", "exports", outputText)(scopedRequire, mod, mod.exports);
  return { ...mod.exports, calls };
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("GET y POST exigen sesión y permisos antes de consultar o rechazar la operación retirada", async () => {
  for (const status of [401, 403]) {
    const handler = harness({ accessError: new CutCollectionError("Sin acceso", status) });
    for (const response of [await handler.GET(new Request(url)), await handler.POST()]) {
      assert.equal(response.status, status);
      assertPrivate(response);
    }
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
  }
});

test("consulta directa recibe los filtros y el alcance real de central, aliado y supervisor", async () => {
  for (const dashboard of [
    { admin: true, supervisor: false, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "FINSERPAY" } },
    { admin: true, supervisor: false, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "ALIADO" } },
    { admin: false, supervisor: true, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "ALIADO" } },
  ]) {
    const authorized = cutAccessFromDashboard(dashboard);
    const handler = harness({ access: authorized });
    const response = await handler.GET(new Request(`${url}?${query}&central=true&userId=999`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), report);
    assert.deepEqual(handler.calls.read, [[authorized, filters]]);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    assertPrivate(response);
  }
});

test("enlaces heredados ignoran ID y página de proyección incluso vacíos, inválidos o repetidos", async () => {
  for (const inherited of [
    "projectionId=&historyPage=", "projectionId=../../secret&historyPage=-1",
    "projectionId=old&projectionId=other&historyPage=bad&historyPage=100001",
    "projectionId=d088e4a2-c9d0-4310-aa0d-6023b48b2196&historyPage=4",
  ]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${query}&${inherited}`));
    assert.equal(response.status, 200);
    assert.deepEqual(handler.calls.read, [[access, filters]]);
    assert.equal("projectionId" in handler.calls.parse[0], false);
    assert.equal("historyPage" in handler.calls.parse[0], false);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
  }
});

test("Excel usa exactamente el reporte directo filtrado y nombra el archivo por fecha", async () => {
  const handler = harness();
  const response = await handler.GET(new Request(`${url}?${query}&format=xlsx&projectionId=invalid&historyPage=old`));
  assert.equal(response.status, 200);
  assert.deepEqual(handler.calls.read, [[access, filters]]);
  assert.deepEqual(handler.calls.excel, [report]);
  assert.equal(handler.calls.legacyRead.length, 0);
  assert.equal(handler.calls.save.length, 0);
  assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="FINSERPAY_Recaudo_2026-10-17.xlsx"');
  assert.equal(response.headers.get("content-length"), "7");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PK-test");
  assertPrivate(response);
});

test("POST responde 410 tras autorizar sin leer el cuerpo, consultar ni guardar", async () => {
  for (const body of ["{", JSON.stringify({ ...filters, requestKey: "old", snapshot: { expected: 1 }, userId: 999 })]) {
    const handler = harness();
    const request = new Request(url, { method: "POST", body });
    const response = await handler.POST(request);
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /consulta directamente/);
    assert.equal(request.bodyUsed, false);
    assert.equal(handler.calls.access, 1);
    assert.equal(handler.calls.parse.length, 0);
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    assertPrivate(response);
  }
});

test("filtros y formatos inválidos o repetidos no consultan el reporte", async () => {
  for (const invalid of ["day=2&day=17", "format=xlsx&format=xlsx", "format=csv", "format=", "day=3",
    "month=13", "year=1999", "aliadoId=-1", "sedeId=1.5", "status=invalid", "status=parcial&status=pagado"]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${invalid}`));
    assert.equal(response.status, 400, invalid);
    assert.equal(handler.calls.read.length, 0);
    assertPrivate(response);
  }
});

test("errores de alcance, base de datos y timeout mantienen privacidad", async () => {
  const log = [];
  const original = console.error;
  console.error = (...args) => log.push(args.join(" "));
  try {
    for (const [error, status] of [
      [new Error("SQL clienteDocumento=001234 secret-token"), 500],
      [Object.assign(new Error("SQL private secret-token"), { code: "57014" }), 503],
      [new CutCollectionError("SQL private secret-token", 503), 503],
    ]) {
      const response = await harness({ error }).GET(new Request(url));
      assert.equal(response.status, status);
      assert.doesNotMatch(JSON.stringify(await response.json()), /SQL|001234|secret-token/);
      assertPrivate(response);
    }
    assert.doesNotMatch(log.join(" "), /SQL|001234|secret-token/);
  } finally { console.error = original; }
  const response = await harness({ error: new CutCollectionError("Sede no autorizada.", 403) }).GET(new Request(url));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Sede no autorizada.");
  assertPrivate(response);
});
