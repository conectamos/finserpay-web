import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { proxy } = await createJiti(import.meta.url).import("../proxy.ts");
const { createCreditWelcomeVoiceManualHandler } = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": loadReissueModule("lib/roles.ts"),
  "@/lib/aliados": loadReissueModule("lib/aliados.ts"),
  "@/lib/credit-route-lookup": loadReissueModule("lib/credit-route-lookup.ts"),
  "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
  "@/lib/credit-welcome-voice-phone": loadReissueModule("lib/credit-welcome-voice-phone.ts"),
});
const requestId = "2d91ef46-9a50-45d7-aa91-d9dc98ebcf1e";
const actor = { id: 7, activo: true, rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 2, sedeId: 5, sedeAccesoActiva: true, aliadoAccesoActivo: true };
function fixture(user) {
  let sent = 0, reserved = false;
  const handler = createCreditWelcomeVoiceManualHandler({
    getUser: async () => user, sameOrigin: request => request.headers.get("origin") === "https://finser.test",
    configured: () => true, findCredit: async id => ({ id }),
    prepare: async input => { const created = !reserved; reserved = true;
      return { created, eventId: requestId, creditId: input.creditId, snapshot: { phone: "573000000001" } }; },
    dispatch: async () => { sent++; },
    listCalls: async creditId => [{ id: requestId, creditId, status: "ACCEPTED" }],
  });
  return {
    sent: () => sent,
    async post(cookie, origin = "https://finser.test") {
      const request = new NextRequest("https://finser.test/api/creditos/72/bienvenida-voz", {
        method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ requestId }),
      });
      const gate = proxy(request);
      return gate.headers.get("x-middleware-next") === "1" ? handler(request, { params: Promise.resolve({ id: "72" }) }) : gate;
    },
  };
}

test("a nominal analyst's click reaches the call handler through the real proxy, and its replay sends once", async () => {
  const f = fixture(actor), cookie = "approval_analyst_session=nominal-test";
  assert.equal((await f.post(cookie)).status, 202);
  const replay = await f.post(cookie);
  assert.equal(replay.status, 200); assert.equal((await replay.json()).eventId, requestId);
  assert.equal(f.sent(), 1);
});

test("an administrator with a remaining analyst cookie can still send the same authorized attempt once", async () => {
  const f = fixture({ ...actor, rolNombre: "ADMIN" }), cookie = "session=regular-test; approval_analyst_session=remaining-test";
  assert.equal((await f.post(cookie)).status, 202);
  assert.equal((await f.post(cookie)).status, 200); assert.equal(f.sent(), 1);
});

test("proxy passage never replaces server authentication or same-origin validation", async () => {
  for (const cookie of ["", "approval_shared_session=shared-test", "approval_access_session=personal-test",
    "approval_analyst_session=forged-test", "session=forged-test"]) {
    const f = fixture(null);
    assert.equal((await f.post(cookie)).status, 401); assert.equal(f.sent(), 0);
  }
  const f = fixture(actor);
  assert.equal((await f.post("approval_analyst_session=nominal-test", "https://other.test")).status, 403);
  assert.equal(f.sent(), 0);
});
