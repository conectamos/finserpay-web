import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovalModule, approvalErrors } from "./credit-approval-test-loader.mjs";

const json = (body, options = {}) => new Response(JSON.stringify(body), { status: options.status || 200, headers: { "Content-Type": "application/json", ...options.headers } });
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const deny = () => { throw new approvalErrors.CreditApprovalError("FORBIDDEN", "Sin permiso", 403); };
function load(path, actor = deny) {
  let calls = 0;
  const hit = () => { calls++; return {}; };
  const service = loadApprovalModule(path, {
    "next/server": { NextResponse: { json } },
    "@/lib/analyst-mora-access": { getMoraActor: actor },
    "@/lib/analyst-mora-management": { listMoraPortfolio: hit, getMoraManagement: hit, createMoraManagement: hit, parseMoraManagement: hit },
    "@/lib/analyst-mora-support": { listMoraSupports: hit, saveMoraSupport: hit, downloadMoraSupport: hit, parseMoraSupportSubject: hit },
    "@/lib/credit-approval-http": { approvalPrivateHeaders: privateHeaders, readApprovalRequest: hit,
      approvalErrorResponse: error => json({ ok: false, error: error.message }, { status: error.status || 503, headers: privateHeaders }) },
  });
  return { service, calls: () => calls };
}
test("todas las rutas de cartera y soportes deniegan una sesión ajena antes de leer datos o archivos", async () => {
  const cases = [
    ["app/api/aprobaciones/cartera-mora/route.ts", ["GET"]],
    ["app/api/aprobaciones/cartera-mora/[id]/route.ts", ["GET", "POST"]],
    ["app/api/aprobaciones/soportes-mora/route.ts", ["GET", "POST"]],
    ["app/api/aprobaciones/soportes-mora/[id]/route.ts", ["GET"]],
  ];
  for (const [path, methods] of cases) {
    const f = load(path);
    for (const method of methods) {
      const response = await f.service[method](new Request("https://finserpay.com/api/aprobaciones/cartera-mora/81", { method }), { params: Promise.resolve({ id: "81" }) });
      assert.equal(response.status, 403); assert.match(response.headers.get("cache-control"), /private/);
      assert.equal(f.calls(), 0, path + " debe autenticar primero");
    }
    assert.equal(f.service.DELETE, undefined);
  }
});
test("la cartera autenticada mantiene respuestas privadas", async () => {
  const f = load("app/api/aprobaciones/cartera-mora/route.ts", async () => ({ id: 7, nombre: "Analista", centralAdmin: false }));
  const response = await f.service.GET(new Request("https://finserpay.com/api/aprobaciones/cartera-mora"));
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true); assert.equal(f.calls(), 1);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("el detalle identifica al responsable usando la sesión, nunca el último gestor", async () => {
  const actor={id:7,nombre:"Analista autenticado",centralAdmin:false};
  const f=load("app/api/aprobaciones/cartera-mora/[id]/route.ts",async()=>actor);
  const response=await f.service.GET(new Request("https://finserpay.com/api/aprobaciones/cartera-mora/81"),{params:Promise.resolve({id:"81"})});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).currentResponsible,{id:7,nombre:"Analista autenticado"});
});
