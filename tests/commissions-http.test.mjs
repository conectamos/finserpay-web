import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const seller = { id: 17, tipoPerfil: "VENDEDOR" };
const sellerAccess = { vendedor: true, admin: false, seller, session: { id: 3, aliadoAccesoCodigo: "ALIADO" } };
const centralAccess = { vendedor: false, admin: true, seller: null, session: { id: 8, aliadoAccesoCodigo: "FINSERPAY" } };

// Execute the actual handlers, substituting only the session and persistence boundaries.
function harness(access = sellerAccess, storage = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(path.join(root, file), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } });
    const mod = { exports: {} };
    const scopedRequire = (name) => {
      if (name === "@/lib/dashboard-access") return { getDashboardAccess: async () => access };
      if (name === "@/lib/aliados") return { isFinserPayCentralAlly: (code) => code === "FINSERPAY" };
      if (name === "@/lib/commissions-storage") return storage;
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      return require(name);
    };
    new Function("require", "module", "exports", outputText)(scopedRequire, mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  return load;
}

const context = { params: Promise.resolve({ id: "7c0e7ad7-00df-41bf-aa18-f2e03d44aa01" }) };
const post = (body, extra = {}) => new Request("https://finser.example/api/comisiones/solicitudes", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://finser.example", ...extra },
  body: JSON.stringify(body),
});
const valid = { period: "2026-10", amount: 50000, nequi: "3124085562", idempotencyKey: "b8d8e40f-18b4-473c-ba7b-a542dca6565f" };

test("sesión obligatoria: no se consulta ninguna comisión sin autenticación", async () => {
  const load = harness(null);
  assert.equal((await load("app/api/comisiones/route.ts").GET()).status, 401);
});

test("vendedor consulta exclusivamente su id de sesión y respuesta nunca es cacheable", async () => {
  let received;
  const load = harness(sellerAccess, { getSellerCommissionDashboard: async (id) => { received = id; return { active: false }; } });
  const response = await load("app/api/comisiones/route.ts").GET();
  assert.equal(response.status, 200);
  assert.equal(received, 17);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
});

test("supervisor y administrador aliado no acceden a comisiones personales ni pagos centrales", async () => {
  for (const access of [
    { ...sellerAccess, vendedor: false, supervisor: true },
    { ...centralAccess, session: { id: 9, aliadoAccesoCodigo: "ALIADO" } },
  ]) {
    const load = harness(access);
    assert.equal((await load("app/api/comisiones/route.ts").GET()).status, 403);
    assert.equal((await load("app/api/admin/comisiones/route.ts").GET()).status, 403);
    assert.equal((await load("app/api/admin/comisiones/[id]/pagar/route.ts").POST(post({}), context)).status, 403);
  }
});

test("crear solicitud ignora vendedorId proporcionado por cliente y reserva para su sesión", async () => {
  let received;
  const load = harness(sellerAccess, { createCommissionRequest: async (...args) => { received = args; return { id: "new" }; } });
  const response = await load("app/api/comisiones/solicitudes/route.ts").POST(post({ ...valid, sellerId: 999 }));
  assert.equal(response.status, 201);
  assert.deepEqual(received, [17, valid]);
});

test("monto debe ser entero positivo, nunca booleano, texto, fracción o negativo", async () => {
  const load = harness();
  for (const amount of [true, "50000", 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await load("app/api/comisiones/solicitudes/route.ts").POST(post({ ...valid, amount }))).status, 400);
  }
});

test("rechaza solicitudes de otro origen antes de usar sesión o base de datos", async () => {
  const route = harness()("app/api/comisiones/solicitudes/route.ts");
  assert.equal((await route.POST(post(valid, { origin: "https://attacker.example" }))).status, 403);
  assert.equal((await route.POST(post(valid, { "sec-fetch-site": "cross-site" }))).status, 403);
});

test("conflicto de saldo real se devuelve al vendedor sin registrar petición exitosa", async () => {
  const load = harness(sellerAccess, { createCommissionRequest: async () => {
    throw Object.assign(new Error("Saldo insuficiente"), { status: 409, code: "INSUFFICIENT_BALANCE" });
  } });
  const response = await load("app/api/comisiones/solicitudes/route.ts").POST(post(valid));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "INSUFFICIENT_BALANCE");
});

test("confirmar pago exige admin central y comprobante no vacío", async () => {
  const route = harness(centralAccess)("app/api/admin/comisiones/[id]/pagar/route.ts");
  assert.equal((await route.POST(post({}), context)).status, 400);
  const request = new Request("https://finser.example/api/admin/comisiones/id/pagar", { method: "POST", body: new FormData() });
  assert.equal((await route.POST(request, context)).status, 400);
});

test("confirmación pasa archivo y actor de sesión al pago transaccional", async () => {
  let received;
  const route = harness(centralAccess, { confirmCommissionPayment: async (...args) => { received = args; return { status: "PAID" }; } })("app/api/admin/comisiones/[id]/pagar/route.ts");
  const data = new FormData();
  data.set("receipt", new File(["%PDF-1.7\nproof"], "pago.pdf", { type: "application/pdf" }));
  data.set("actorId", "999");
  const request = new Request("https://finser.example/api/admin/comisiones/id/pagar", { method: "POST", body: data });
  assert.equal((await route.POST(request, context)).status, 200);
  assert.equal(received[1], 8);
  assert.equal(received[2].fileName, "pago.pdf");
  assert.equal(Buffer.from(received[2].base64, "base64").toString(), "%PDF-1.7\nproof");
});

test("rechazo requiere motivo y registra actor central autenticado", async () => {
  let received;
  const route = harness(centralAccess, { rejectCommissionRequest: async (...args) => { received = args; return { status: "REJECTED" }; } })("app/api/admin/comisiones/[id]/rechazar/route.ts");
  assert.equal((await route.POST(post({ reason: "  " }), context)).status, 400);
  assert.equal((await route.POST(post({ reason: " Revisar Nequi " }), context)).status, 200);
  assert.equal(received[1], 8);
  assert.equal(received[2], "Revisar Nequi");
});

test("descarga privada delimita propiedad al vendedor, con scope central solo para central", async () => {
  for (const [access, expected] of [[sellerAccess, { sellerId: 17 }], [centralAccess, { adminUserId: 8 }]]) {
    let received;
    const route = harness(access, { getCommissionReceipt: async (_id, scope) => {
      received = scope;
      return { fileName: "comprobante.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7") };
    } })("app/api/comisiones/solicitudes/[id]/comprobante/route.ts");
    const response = await route.GET(new Request("https://finser.example"), context);
    assert.equal(response.status, 200);
    assert.deepEqual(received, expected);
    assert.match(response.headers.get("content-disposition"), /^attachment/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});


test("pausa del servidor no revela porcentaje, aliado ni causa interna", async () => {
  const load = harness(sellerAccess, { createCommissionRequest: async () => {
    throw Object.assign(new Error("Aliado interno: mora 8.00%"), { status: 409, code: "COMMISSION_PAUSED" });
  } });
  const response = await load("app/api/comisiones/solicitudes/route.ts").POST(post(valid));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Comisiones temporalmente en pausa", code: "COMMISSION_PAUSED" });
});

test("indicador por aliado es exclusivo del administrador central", async () => {
  const bags = [{ allyId: 3, allyName: "Aliado local", overduePercent: 8, paused: true }];
  let received;
  const storage = { listAdminCommissionRequests: async () => [], listAdminCommissionBags: async id => { received = id; return bags; } };
  const response = await harness(centralAccess, storage)("app/api/admin/comisiones/route.ts").GET();
  assert.equal(response.status, 200);
  assert.equal(received, 8);
  assert.deepEqual(await response.json(), { requests: [], bags });
  for (const access of [sellerAccess, { ...sellerAccess, vendedor: false, approvalAnalyst: true, seller: null }]) {
    assert.equal((await harness(access, storage)("app/api/admin/comisiones/route.ts").GET()).status, 403);
  }
});
