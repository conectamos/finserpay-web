import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovalModule, approvalErrors, approvalActors, roles, plain } from "./credit-approval-test-loader.mjs";

const central = { id: 7, nombre: "Administrador sintético", activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
const nominal = { ...central, id: 17, nombre: "Analista sintético", rolNombre: "ANALISTA_APROBACION" };
const dates = loadApprovalModule("lib/colombia-date.ts");
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x4d, 0x4f, 0x52, 0x41]);
const items = Array.from({ length: 31 }, (_, index) => ({ id: index + 1, folio: `FC-${index + 1}` }));
const request = (query = "q=Cliente&ally=2&responsible=7&minDays=1&maxDays=30&status=PRORROGA&followUp=2026-10-07") =>
  new Request(`https://finser.test/api/aprobaciones/cartera-mora/export?${query}`);

function fixture({ user = central, analyst = null, shared, exportImpl, writeImpl } = {}) {
  const calls = [];
  const auth = {
    getSessionUser: async () => { calls.push({ type: "session" }); return user; },
    getNominalApprovalAnalystSessionUser: async () => { calls.push({ type: "nominal" }); return analyst; },
  };
  const sharedAccess = { getApprovalSharedRequestActor: async () => { calls.push({ type: "shared" }); return shared; } };
  const access = loadApprovalModule("lib/analyst-mora-access.ts", {
    "@/lib/auth": auth, "@/lib/roles": roles, "@/lib/approval-shared-session": sharedAccess,
    "@/lib/credit-approval-errors": approvalErrors,
  });
  const http = loadApprovalModule("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": auth, "@/lib/roles": roles,
    "@/lib/approval-shared-session": sharedAccess, "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval": approvalErrors,
  });
  const route = loadApprovalModule("app/api/aprobaciones/cartera-mora/export/route.ts", {
    "@/lib/analyst-mora-access": access,
    "@/lib/analyst-mora-management": { exportMoraPortfolio: async (search, now) => {
      calls.push({ type: "export", search, now });
      return exportImpl ? exportImpl(search, now) : { items };
    } },
    "@/lib/analyst-mora-excel": { buildMoraPortfolioWorkbook: (rows, options) => {
      calls.push({ type: "workbook", rows, options });
      return { xlsx: { writeBuffer: async () => {
        calls.push({ type: "write" });
        return writeImpl ? writeImpl() : bytes;
      } } };
    } },
    "@/lib/colombia-date": dates,
    "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/credit-approval-http": http,
  });
  return { route, calls };
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("central y analista nominal descargan todos los resultados y usan el mismo reloj para datos, resumen y nombre", async () => {
  for (const auth of [{ user: central }, { user: null, analyst: nominal }]) {
    const f = fixture(auth);
    const response = await f.route.GET(request());
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const exported = f.calls.find(call => call.type === "export");
    const workbook = f.calls.find(call => call.type === "workbook");
    assert.equal(workbook.rows, items);
    assert.equal(workbook.rows.length, 31);
    assert.equal(workbook.options.generatedAt, exported.now);
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="cartera-mora-${dates.colombiaDateKey(exported.now)}.xlsx"`);
    assert.deepEqual(plain(workbook.options.filters), { q: "Cliente", ally: "2", responsible: "7", minDays: "1", maxDays: "30", status: "PRORROGA", followUp: "2026-10-07" });
    assert.equal(f.calls.filter(call => call.type === "export").length, 1);
    assert.equal(f.calls.filter(call => call.type === "write").length, 1);
    assert.ok(f.calls.findIndex(call => call.type === "session") < f.calls.findIndex(call => call.type === "export"));
  }
});

test("permiso idéntico a cartera en mora: no consulta datos ni genera archivos para sesiones ajenas o enlaces", async () => {
  for (const [name, auth] of [
    ["sin sesión", { user: null }],
    ["aliado", { user: { ...central, aliadoAccesoCodigo: "ALIADO" } }],
    ["vendedor", { user: { ...central, rolNombre: "VENDEDOR" } }],
    ["central inactivo", { user: { ...central, activo: false } }],
    ["analista sin cookie nominal", { user: nominal }],
    ["enlace personal", { user: null, analyst: null }],
    ["compartido", { user: null, shared: { kind: "SHARED_LINK", nombre: "Acceso compartido" } }],
    ["compartido incluso con central", { user: central, shared: { kind: "SHARED_LINK" } }],
    ["compartido revocado", { user: central, shared: null }],
  ]) {
    const f = fixture(auth);
    const response = await f.route.GET(request());
    assert.equal(response.status, 403, name);
    assertPrivate(response);
    assert.equal((await response.json()).code, "FORBIDDEN");
    assert.equal(f.calls.some(call => ["export", "workbook", "write"].includes(call.type)), false, name);
  }
});

test("el resumen de filtros solo incluye filtros admitidos y permite exportar una selección vacía", async () => {
  const f = fixture({ exportImpl: async () => ({ items: [] }) });
  const response = await f.route.GET(request("q=%20Cliente%20&status=&page=99&financialStatus=AL_DIA&token=private-token"));
  assert.equal(response.status, 200);
  const call = f.calls.find(call => call.type === "workbook");
  assert.deepEqual(call.rows, []);
  assert.deepEqual(plain(call.options.filters), { q: "Cliente" });
  assert.doesNotMatch(response.headers.get("content-disposition"), /private-token/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("autentica antes del 429 y libera la exportación al terminar", async () => {
  const entered = deferred(), release = deferred();
  let writes = 0;
  const f = fixture({ writeImpl: async () => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    return bytes;
  } });
  const first = f.route.GET(request());
  await entered.promise;
  const busy = await f.route.GET(request());
  assert.equal(busy.status, 429);
  assertPrivate(busy);
  assert.equal((await busy.json()).code, "MORA_EXPORT_BUSY");
  assert.equal(f.calls.filter(call => call.type === "session").length, 2);
  assert.equal(f.calls.filter(call => call.type === "export").length, 1);
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await f.route.GET(request())).status, 200);
});

test("filtros inválidos no generan archivo; fallos privados de consulta o Excel no filtran información ni bloquean reintentos", async () => {
  const invalid = fixture({ exportImpl: async () => { throw new approvalErrors.CreditApprovalError("INVALID_FILTER", "Filtro inválido.", 400); } });
  const invalidResponse = await invalid.route.GET(request("status=BAD"));
  assert.equal(invalidResponse.status, 400);
  assertPrivate(invalidResponse);
  assert.equal(invalid.calls.some(call => call.type === "workbook"), false);
  const tooLarge = fixture({ exportImpl: async () => { throw new approvalErrors.CreditApprovalError("MORA_EXPORT_TOO_LARGE", "Aplica filtros para reducir los resultados.", 413); } });
  const largeResponse = await tooLarge.route.GET(request());
  assert.equal(largeResponse.status, 413);
  assertPrivate(largeResponse);
  assert.equal((await largeResponse.json()).code, "MORA_EXPORT_TOO_LARGE");
  assert.equal(tooLarge.calls.some(call => call.type === "workbook"), false);
  for (const stage of ["exportImpl", "writeImpl"]) {
    let attempts = 0;
    const f = fixture({ [stage]: async () => {
      if (++attempts === 1) throw new Error("password=private-database-secret");
      return stage === "exportImpl" ? { items } : bytes;
    } });
    const failed = await f.route.GET(request());
    assert.equal(failed.status, 503);
    assertPrivate(failed);
    assert.doesNotMatch(await failed.text(), /private-database-secret|password=/);
    assert.equal((await f.route.GET(request())).status, 200);
  }
});
