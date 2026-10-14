import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const origin = "https://finser.example";
const url = `${origin}/api/reportes/recaudo-por-corte`;
const id = "d088e4a2-c9d0-4310-aa0d-6023b48b2196";
const filters = { day: 17, month: 10, year: 2026, aliadoId: 1, sedeId: 10, status: "parcial" };
const access = { userId: 8, central: false, aliadoId: 1, sedeId: 10 };
const report = { ok: true, cutDate: "2026-10-17", projection: { id }, rows: [], filters };
class CutCollectionError extends Error { constructor(message, status) { super(message); this.status = status; } }

// Execute the real handlers with access, parsing, persistence and workbook
// boundaries substituted. Their domain contracts have independent tests.
function harness(overrides = {}) {
  const calls = { access: 0, parse: [], read: [], save: [], excel: [] };
  const source = readFileSync(path.join(root, "app/api/reportes/recaudo-por-corte/route.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const mod = { exports: {} };
  function scopedRequire(name) {
    if (name === "@/lib/cut-collection-access") return {
      CutCollectionError,
      getCutCollectionAccess: async () => { calls.access++; if (overrides.accessError) throw overrides.accessError; return access; },
      parseCutFilters: value => { calls.parse.push(value instanceof URLSearchParams ? Object.fromEntries(value) : value); return filters; },
    };
    if (name === "@/lib/cut-collection-storage") return {
      getCutCollectionReport: async (...args) => { calls.read.push(args); if (overrides.error) throw overrides.error; return report; },
      saveCutCollectionProjection: async (...args) => { calls.save.push(args); if (overrides.error) throw overrides.error; return report; },
    };
    if (name === "@/lib/cut-collection-excel") return {
      buildCutCollectionWorkbook: value => { calls.excel.push(value); return { xlsx: { writeBuffer: async () => Buffer.from("PK-test") } }; },
    };
    return require(name);
  }
  new Function("require", "module", "exports", outputText)(scopedRequire, mod, mod.exports);
  return { ...mod.exports, calls };
}

function post(body = { ...filters, requestKey: id }, headers = {}, target = url) {
  const merged = new Headers({ origin, "content-type": "application/json", ...headers });
  for (const [name, value] of Object.entries(headers)) if (value === null) merged.delete(name);
  return new Request(target, { method: "POST", headers: merged, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("GET y POST exigen sesión y permisos antes de consultar o guardar", async () => {
  for (const status of [401, 403]) {
    const handler = harness({ accessError: new CutCollectionError("Sin acceso", status) });
    for (const response of [await handler.GET(new Request(url)), await handler.POST(post())]) {
      assert.equal(response.status, status);
      assertPrivate(response);
    }
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.save.length, 0);
  }
});

test("consulta pasa filtros e ID junto al alcance de sesión, sin confiar en permisos URL", async () => {
  const handler = harness();
  const response = await handler.GET(new Request(`${url}?day=17&month=10&year=2026&status=parcial&projectionId=${id}&central=true&userId=999`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), report);
  assert.deepEqual(handler.calls.read, [[access, filters, id, 0]]);
  assert.equal(handler.calls.save.length, 0);
  assertPrivate(response);
});

test("Excel usa el mismo reporte filtrado, es privado y conserva versión en nombre de archivo", async () => {
  const handler = harness();
  const response = await handler.GET(new Request(`${url}?format=xlsx&projectionId=${id}&status=parcial`));
  assert.equal(response.status, 200);
  assert.deepEqual(handler.calls.read, [[access, filters, id, 0]]);
  assert.deepEqual(handler.calls.excel, [report]);
  assert.equal(handler.calls.save.length, 0);
  assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(response.headers.get("content-disposition"), new RegExp(`attachment;.*2026-10-17_${id}\\.xlsx`));
  assert.equal(response.headers.get("content-length"), "7");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PK-test");
  assertPrivate(response);
});

test("guardar pasa actor desde sesión, filtros y clave idempotente sin aceptar snapshot cliente", async () => {
  const handler = harness();
  const response = await handler.POST(post({ ...filters, requestKey: id, userId: 999, snapshot: { expected: 1 }, central: true }));
  assert.equal(response.status, 201);
  assert.deepEqual(handler.calls.save, [[access, filters, id]]);
  assert.equal(handler.calls.read.length, 0);
  assertPrivate(response);
});

test("parámetros repetidos, identificadores y formato inválidos no consultan storage", async () => {
  for (const query of ["projectionId=", "projectionId=1", "projectionId=../../secret", "projectionId=00000000-0000-0000-0000-000000000000", "day=2&day=17", `projectionId=${id}&projectionId=${id}`, "format=csv", "format=", "historyPage=-1", "historyPage=1.5", "historyPage=100001", "historyPage=", "historyPage=true", "historyPage=1&historyPage=2"]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(handler.calls.read.length, 0);
    assertPrivate(response);
  }
  for (const requestKey of [null, "", 123, true, "wrong", `${id} `]) {
    const handler = harness();
    assert.equal((await handler.POST(post({ ...filters, requestKey }))).status, 400);
    assert.equal(handler.calls.save.length, 0);
  }
});

test("la página del historial se valida y se pasa explícita a consulta y exportación", async () => {
  for (const format of ["", "&format=xlsx"]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?projectionId=${id}&historyPage=4${format}`));
    assert.equal(response.status, 200);
    assert.deepEqual(handler.calls.read, [[access, filters, id, 4]]);
  }
});

test("POST requiere origen explícito válido y rechaza cross-site antes de sesión", async () => {
  for (const headers of [
    { origin: null }, { origin: "null" }, { origin: "invalid" }, { origin: "https://attacker.example" },
    { origin: `${origin}/path` }, { origin: "https://user@finser.example" }, { origin: "http://finser.example" },
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
  ]) {
    const handler = harness();
    const response = await handler.POST(post(undefined, headers));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(handler.calls.access, 0);
    assert.equal(handler.calls.save.length, 0);
  }
  assert.equal((await harness().POST(post(undefined, { host: "finser.example", "x-forwarded-proto": "https" }, "http://internal:3000/api/reportes/recaudo-por-corte"))).status, 201);
  assert.equal((await harness().POST(post(undefined, { host: "finser.example" }, "http://internal:3000/api/reportes/recaudo-por-corte"))).status, 201);
});

test("validación de JSON y límite medido de bytes se ejecutan antes de guardar", async () => {
  for (const contentType of ["text/plain", "application/jsonp", ""]) {
    assert.equal((await harness().POST(post(undefined, { "content-type": contentType }))).status, 415);
  }
  for (const body of ["{", "not json", "[]", "null", "true", "17", '"value"']) {
    const handler = harness();
    assert.equal((await handler.POST(post(body))).status, 400, body);
    assert.equal(handler.calls.save.length, 0);
  }
  const handler = harness();
  assert.equal((await handler.POST(post({ x: "é".repeat(5000) }, { "content-length": "1" }))).status, 413);
  assert.equal(handler.calls.save.length, 0);
  assert.equal((await harness().POST(post(undefined, { "content-type": "application/json; charset=utf-8" }))).status, 201);
});

test("errores de base de datos y timeout no revelan SQL ni datos de cliente", async () => {
  const log = [];
  const original = console.error;
  console.error = (...args) => log.push(args.join(" "));
  try {
    for (const [error, status] of [
      [new Error("SQL clienteDocumento=001234 secret-token"), 500],
      [Object.assign(new Error("SQL private secret-token"), { code: "57014" }), 503],
      [new CutCollectionError("SQL private secret-token", 503), 503],
    ]) {
      const handler = harness({ error });
      const response = await handler.GET(new Request(url));
      assert.equal(response.status, status);
      assert.doesNotMatch(JSON.stringify(await response.json()), /SQL|001234|secret-token/);
      assertPrivate(response);
    }
    assert.doesNotMatch(log.join(" "), /SQL|001234|secret-token/);
  } finally { console.error = original; }
  const response = await harness({ error: new CutCollectionError("Proyección fuera de tu alcance.", 403) }).GET(new Request(url));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Proyección fuera de tu alcance.");
});
