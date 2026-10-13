import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { EXPORT_FIXTURE_SQL } from "./helpers/solicitudes-export-fixture.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const origin = "https://finser.example";
const allyUser = { id: 9, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO_UNO", aliadoAccesoId: 1, sedeAccesoId: 10 };
const centralUser = { ...allyUser, id: 8, aliadoAccesoCodigo: "FINSERPAY" };
const ownViewer = { kind: "ALLY_ADMIN", userId: 9, aliadoId: 1, sedeId: 10, vendedorId: null };
const context = { params: Promise.resolve({ id: "7c0e7ad7-00df-41bf-aa18-f2e03d44aa01" }) };
let pg;
before(async () => { pg = new PGlite(); await pg.exec(EXPORT_FIXTURE_SQL); });
after(async () => { await pg.close(); });

// Run the real helper, access checks, data SQL and HTTP handlers. Only session,
// default database and the background-job boundary are replaced; no live DB.
function harness(user = allyUser, store = {}) {
  const cache = new Map();
  const scheduled = [];
  let queryCount = 0;
  const db = { $queryRawUnsafe: async (sql, ...values) => {
    queryCount++;
    return (await pg.query(sql, values)).rows;
  } };
  function load(file) {
    file = file.replaceAll("\\", "/");
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(path.join(root, file), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } });
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    function scopedRequire(name) {
      if (name === "next/server") return { ...require(name), after: callback => { scheduled.push(callback); } };
      let resolved;
      if (name.startsWith("@/")) resolved = name.slice(2);
      else if (name.startsWith(".")) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      else return require(name);
      if (resolved === "lib/auth") return { getSessionUser: async () => user };
      if (resolved === "lib/prisma") return { __esModule: true, default: db };
      if (resolved === "lib/solicitudes-export-jobs") return {
        getSolicitudExportStore: async () => store,
        processSolicitudExports: async () => {},
        serializeExportJob: job => job,
      };
      return load(`${resolved}.ts`);
    }
    new Function("require", "module", "exports", outputText)(scopedRequire, mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  return { load, scheduled, queries: () => queryCount };
}

function post(body, headers = {}, url = `${origin}/api/solicitudes/export/count`) {
  return new Request(url, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("viewer usa rol y aliado de acceso de sesión; rechaza usuarios sin autorización", () => {
  const { load } = harness();
  const { exportViewerFromSession } = load("lib/solicitudes-export-access.ts");
  assert.deepEqual(exportViewerFromSession(allyUser), ownViewer);
  assert.equal(exportViewerFromSession(centralUser).kind, "CENTRAL_ADMIN");
  assert.equal(exportViewerFromSession({ ...allyUser, rolNombre: " admin " }).kind, "ALLY_ADMIN");
  assert.equal(exportViewerFromSession({ ...allyUser, aliadoCodigo: "FINSERPAY", aliadoId: 2 }).kind, "ALLY_ADMIN");
  assert.throws(() => exportViewerFromSession(null), { status: 401 });
  for (const user of [
    { ...centralUser, rolNombre: "VENDEDOR" }, { ...centralUser, rolNombre: "SUPERVISOR" },
    { ...centralUser, rolNombre: "" }, { ...allyUser, aliadoAccesoId: null },
    { ...allyUser, id: 0 }, { ...allyUser, id: "9" },
  ]) assert.throws(() => exportViewerFromSession(user), { status: 403 });
});

test("cuerpo JSON: origen, tipo, sintaxis y límites se validan antes de usar filtros", async () => {
  const { readExportBody } = harness().load("lib/solicitudes-export-http.ts");
  for (const headers of [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }, { origin: "invalid origin" }, { origin: `${origin}/path` }, { origin: "https://user@finser.example" }]) {
    await assert.rejects(readExportBody(post({ filters: {} }, headers)), { status: 403 });
  }
  for (const contentType of ["text/plain", "", "application/jsonp", "text/plain;foo=application/json"]) {
    await assert.rejects(readExportBody(post({}, { "content-type": contentType })), { status: 415 });
  }
  for (const body of ["not json", "{", "null", "[]", "true", "17", '"value"']) {
    await assert.rejects(readExportBody(post(body)), { status: 400 });
  }
  assert.deepEqual(await readExportBody(post({ filters: { period: "all" } }, { "content-type": "application/json; charset=utf-8" })), { filters: { period: "all" } });
  assert.deepEqual(await readExportBody(post({ filters: {} }, { host: "finser.example" }, "http://internal:3000/api/solicitudes/export/count")), { filters: {} });
  await assert.rejects(readExportBody(post({}, { host: "other.example" }, "http://internal:3000/api/solicitudes/export/count")), { status: 403 });
  const maximum = JSON.stringify({ x: "a".repeat(65528) });
  assert.equal(Buffer.byteLength(maximum), 65536);
  assert.equal((await readExportBody(post(maximum))).x.length, 65528);
  await assert.rejects(readExportBody(post(JSON.stringify({ x: "a".repeat(65529) }))), { status: 413 });
  // Measure streamed bytes, never trust a forged Content-Length header.
  await assert.rejects(readExportBody(post(JSON.stringify({ x: "é".repeat(40000) }), { "content-length": "2" })), { status: 413 });
});

test("todas las rutas rechazan sin sesión o con rol vendedor antes de consultar persistencia", async () => {
  for (const [user, expected] of [[null, 401], [{ ...centralUser, rolNombre: "VENDEDOR" }, 403]]) {
    const h = harness(user);
    const handlers = [
      () => h.load("app/api/solicitudes/export/count/route.ts").POST(post({ filters: {} })),
      () => h.load("app/api/solicitudes/export/options/route.ts").GET(),
      () => h.load("app/api/solicitudes/export/route.ts").POST(post({ filters: {} })),
      () => h.load("app/api/solicitudes/export/[id]/route.ts").GET(new Request(origin), context),
      () => h.load("app/api/solicitudes/export/[id]/download/route.ts").GET(new Request(origin), context),
    ];
    for (const handler of handlers) assert.equal((await handler()).status, expected);
    assert.equal(h.queries(), 0);
    assert.equal(h.scheduled.length, 0);
  }
});

test("conteo HTTP general y de aliado coincide con SQL autorizado y nunca se cachea", async () => {
  for (const [user, expected] of [[centralUser, 8], [allyUser, 6]]) {
    const h = harness(user);
    const response = await h.load("app/api/solicitudes/export/count/route.ts").POST(post({ filters: { period: "all" } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: expected });
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("parámetros URL y cuerpos falsificados no amplían alcance de admin aliado", async () => {
  const h = harness(allyUser);
  const route = h.load("app/api/solicitudes/export/count/route.ts");
  for (const filters of [{ aliadoIds: [2] }, { aliadoIds: [1, 2] }, { sedeIds: [20] }, { vendedorIds: [200] }]) {
    const response = await route.POST(post({ filters, viewer: { kind: "CENTRAL_ADMIN" }, userId: 8 }));
    assert.equal(response.status, 403);
  }
  const spoofedUrl = `${origin}/api/solicitudes/export/count?aliadoIds=2&sedeId=20&role=ADMIN&kind=CENTRAL_ADMIN`;
  const response = await route.POST(post({
    filters: { period: "all", viewer: { kind: "CENTRAL_ADMIN" } },
    viewer: { kind: "CENTRAL_ADMIN", aliadoId: 2 },
    session: centralUser, userId: 8, aliadoAccesoCodigo: "FINSERPAY",
  }, {}, spoofedUrl));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 6 });
  assert.equal((await route.POST(post({ filters: { sedeIds: ["20"] } }))).status, 400);
  assert.equal((await route.POST(post({ filters: { period: "month", month: "2026-13" } }))).status, 400);
});

test("opciones HTTP muestran solamente sedes y vendedores del aliado autenticado", async () => {
  const response = await harness(allyUser).load("app/api/solicitudes/export/options/route.ts").GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scope, "ALLY_ADMIN");
  assert.deepEqual(body.options.aliados.map(row => row.id), [1]);
  assert.deepEqual(body.options.sedes.map(row => row.id), [10, 11]);
  assert(!body.options.vendedores.some(row => row.id === 200));
});

test("creación, estado y descarga reciben exclusivamente el viewer de sesión", async () => {
  const calls = [];
  const job = { id: "job", filename: "FINSERPAY_Clientes_Aliado_Historico.xlsx", status: "READY" };
  const store = {
    cleanup: async () => {},
    create: async (...args) => { calls.push(["create", ...args]); return job; },
    get: async (...args) => { calls.push(["get", ...args]); return job; },
    download: async (...args) => {
      calls.push(["download", ...args]);
      return { job, bytes: 2, stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([80, 75])); controller.close(); } }) };
    },
  };
  const h = harness(allyUser, store);
  const response = await h.load("app/api/solicitudes/export/route.ts").POST(post({
    filters: { period: "all" }, expectedCount: 6, viewer: { kind: "CENTRAL_ADMIN" }, userId: 8,
  }));
  assert.equal(response.status, 202);
  assert.equal(h.scheduled.length, 1);
  const request = new Request(`${origin}/api/solicitudes/export/job?viewerKind=CENTRAL_ADMIN&userId=8&aliadoId=2`);
  assert.equal((await h.load("app/api/solicitudes/export/[id]/route.ts").GET(request, context)).status, 200);
  const download = await h.load("app/api/solicitudes/export/[id]/download/route.ts").GET(request, context);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.match(download.headers.get("cache-control"), /no-store/);
  assert.equal(download.headers.get("content-length"), "2");
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), "PK");
  assert.deepEqual(calls.map(call => call[1]), [ownViewer, ownViewer, ownViewer]);
  assert.deepEqual(calls[0].slice(2), [{ period: "all" }, 6]);
  assert.equal(calls[1][2], "7c0e7ad7-00df-41bf-aa18-f2e03d44aa01");
});

test("errores inesperados ocultan parámetros y datos personales", async () => {
  const h = harness(allyUser);
  const { exportFailure } = h.load("lib/solicitudes-export-http.ts");
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.join(" ")); };
  try {
    const response = exportFailure(new Error("SQL query: clienteDocumento=001234567 private token secret"));
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /001234567|token|secret|SQL/);
    assert.doesNotMatch(messages.join(" "), /001234567|token|secret|SQL/);
  } finally { console.error = original; }
});
