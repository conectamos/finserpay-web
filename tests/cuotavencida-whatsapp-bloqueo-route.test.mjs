import test from "node:test";
import assert from "node:assert/strict";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
const http = loadReissueModule("lib/cuotavencida-whatsapp-http.ts");
const requestId = "6539fc23-4fe4-442b-8bf9-d8cd88a5abef";
const admin = { id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", sedeAccesoActiva: true, aliadoAccesoActivo: true };
function fixture(user = admin, { origin = true, configured = true } = {}) {
  const calls = [];
  const route = loadReissueModule("app/api/dashboard/cartera/bloqueo/route.ts", {
    "next/server": { after: callback => { calls.push("after"); assert.equal(typeof callback, "function"); } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/credit-approval-http": { isSameApprovalOrigin: () => origin },
    "@/lib/cuotavencida-whatsapp-http": http,
    "@/lib/bloqueo-whatsapp-store": {
      getBloqueoWhatsAppBatch: async () => { calls.push("read-bloqueo"); return null; },
      createBloqueoWhatsAppBatch: async input => { calls.push(JSON.parse(JSON.stringify(input))); return { created: true, batch: { id: requestId } }; },
    },
    "@/lib/bloqueo-whatsapp-dispatch": {
      isBloqueoWhatsAppConfigured: () => configured,
      runBloqueoWhatsApp: async () => { throw new Error("No live provider allowed in a route test"); },
    },
  });
  return { ...route, calls };
}
const post = (body = { requestId }) => new Request("https://finserpay.com/api/dashboard/cartera/bloqueo", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
test("BLOQUEO rejects inactive sites, allies, non-central admins and anonymous users without queuing", async () => {
  for (const changes of [{ sedeAccesoActiva: false }, { aliadoAccesoActivo: false }, { rolNombre: "VENDEDOR" },
    { rolNombre: "ANALISTA_APROBACION" }, { aliadoAccesoCodigo: "OTHER" }]) {
    const route = fixture({ ...admin, ...changes });
    assert.equal((await route.GET()).status, 403);
    assert.equal((await route.POST(post())).status, 403);
    assert.deepEqual(route.calls, []);
  }
  assert.equal((await fixture(null).GET()).status, 401);
});
test("BLOQUEO GET is read only and the authorized click persists the actor before starting the worker", async () => {
  const route = fixture();
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { ok: true, configured: true, batch: null });
  assert.deepEqual(route.calls, ["read-bloqueo"]);
  route.calls.length = 0;
  assert.equal((await route.POST(post())).status, 202);
  assert.deepEqual(route.calls, [{ requestId, actorId: 7 }, "after"]);
});
test("BLOQUEO cannot bypass origin, recipient/protection filters or a missing configuration", async () => {
  const foreign = fixture(admin, { origin: false });
  assert.equal((await foreign.POST(post())).status, 403);
  assert.deepEqual(foreign.calls, []);
  for (const body of [{ requestId, telefono: "573001234567" }, { requestId, ignoreProrroga: true }, { requestId, campaign: "CUOTAVENCIDA" }]) {
    const route = fixture();
    assert.equal((await route.POST(post(body))).status, 400);
    assert.deepEqual(route.calls, []);
  }
  const disabled = fixture(admin, { configured: false });
  const response = await disabled.POST(post());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /BLOQUEO/);
  assert.deepEqual(disabled.calls, []);
});
