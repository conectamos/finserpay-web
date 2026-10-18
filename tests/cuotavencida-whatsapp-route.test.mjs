import test from "node:test";
import assert from "node:assert/strict";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
const http = loadReissueModule("lib/cuotavencida-whatsapp-http.ts");
const requestId = "6539fc23-4fe4-442b-8bf9-d8cd88a5abef";
const admin = { id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", sedeAccesoActiva: true, aliadoAccesoActivo: true };
function fixture(user) {
  const calls = [];
  const route = loadReissueModule("app/api/dashboard/cartera/cuotavencida/route.ts", {
    "next/server": { after: callback => { calls.push("after"); assert.equal(typeof callback, "function"); } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/credit-approval-http": { isSameApprovalOrigin: () => true },
    "@/lib/cuotavencida-whatsapp-http": http,
    "@/lib/cuotavencida-whatsapp-store": {
      getCuotaVencidaWhatsAppBatch: async () => { calls.push("read"); return null; },
      createCuotaVencidaWhatsAppBatch: async input => { calls.push(JSON.parse(JSON.stringify(input))); return { created: true, batch: { id: requestId } }; },
    },
    "@/lib/cuotavencida-whatsapp-dispatch": {
      isCuotaVencidaWhatsAppConfigured: () => true,
      runCuotaVencidaWhatsApp: async () => { throw new Error("Must not call a provider in a route test"); },
    },
  });
  return { ...route, calls };
}
function post() {
  return new Request("https://finserpay.com/api/dashboard/cartera/cuotavencida", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }),
  });
}
test("the actual route requires a central admin with an active site and ally", async () => {
  for (const changes of [{ sedeAccesoActiva: false }, { aliadoAccesoActivo: false }, { rolNombre: "VENDEDOR" },
    { rolNombre: "ANALISTA_APROBACION" }, { aliadoAccesoCodigo: "OTHER" }]) {
    const route = fixture({ ...admin, ...changes });
    assert.equal((await route.GET()).status, 403);
    assert.equal((await route.POST(post())).status, 403);
    assert.deepEqual(route.calls, []);
  }
  const anonymous = fixture(null);
  assert.equal((await anonymous.POST(post())).status, 401);
});
test("an authorized route persists the actor before scheduling its background callback", async () => {
  const route = fixture(admin);
  assert.equal((await route.POST(post())).status, 202);
  assert.deepEqual(route.calls, [{ requestId, actorId: 7 }, "after"]);
});
test("reading the real route never schedules an external send", async () => {
  const route = fixture(admin);
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, batch: null });
  assert.deepEqual(route.calls, ["read"]);
});
