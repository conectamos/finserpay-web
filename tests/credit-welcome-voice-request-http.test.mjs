import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { createCreditWelcomeVoiceReadHandler } = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": loadReissueModule("lib/roles.ts"),
  "@/lib/aliados": loadReissueModule("lib/aliados.ts"),
  "@/lib/credit-route-lookup": loadReissueModule("lib/credit-route-lookup.ts"),
  "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
});
const requestId = "62e6a6a9-3591-4a7f-a5d6-3d52ef675dfe";
const eventId = "c0b4c3c8-f5f2-4470-9de2-fbeac40da2bb";
const user = { id: 7, activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 2, sedeId: 5, sedeAccesoActiva: true, aliadoAccesoActivo: true };
function fixture(options = {}) {
  const lookups = [];
  const GET = createCreditWelcomeVoiceReadHandler({
    getUser: async () => options.user === undefined ? user : options.user,
    getSeller: async () => ({ activo: true, tipoPerfil: "VENDEDOR", sedeId: 5 }),
    findCredit: async id => options.denied ? null : { id }, listCalls: async () => [], safeUrl: () => null,
    getManualCall: async () => ({ canCall: true, phone: "573000000001" }),
    getManualRequest: async input => { lookups.push(JSON.parse(JSON.stringify(input))); return options.linked ?? null; },
  });
  return { lookups, get: (query = `?requestId=${requestId}`) => GET(new Request(`https://finser.test/api/creditos/72/bienvenida-voz${query}`),
    { params: Promise.resolve({ id: "72" }) }) };
}

test("request reconciliation is a private read scoped to the authenticated actor and credit, with no provider operation", async () => {
  for (const status of ["DISPATCHING", "ACCEPTED", "UNKNOWN", "COMPLETED", "FAILED", "SKIPPED"]) {
    const f = fixture({ linked: { eventId, status, snapshot: "private", destinationPhone: "private", token: "private" } });
    for (let index = 0; index < 2; index++) {
      const response = await f.get(); assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.request, { requestId, found: true, eventId, status });
      assert.equal(JSON.stringify(body).includes("private"), false);
      assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    }
    assert.deepEqual(f.lookups, [0, 1].map(() => ({ creditId: 72, requestId, actorId: 7 })));
  }
});

test("a click blocked before reservation can be reconciled without creating a call or replacing its idempotency key", async () => {
  const f = fixture(), response = await f.get();
  assert.deepEqual((await response.json()).request, { requestId, found: false });
  assert.equal(f.lookups.length, 1);
  assert.equal((await (await f.get("")).json()).request, undefined);
  assert.equal(f.lookups.length, 1);
});

test("invalid keys, unauthorized actors and inaccessible credits never reach request metadata", async () => {
  for (const query of ["?requestId=", "?requestId=wrong", `?requestId=${requestId}&requestId=${requestId}`]) {
    const f = fixture(); assert.equal((await f.get(query)).status, 400); assert.equal(f.lookups.length, 0);
  }
  for (const options of [{ user: null }, { user: { ...user, activo: false } }, { denied: true },
    { user: { ...user, rolNombre: "VENDEDOR" } },
    { user: { ...user, rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "OTHER" } }]) {
    const f = fixture(options); assert.ok([401, 403, 404].includes((await f.get()).status)); assert.equal(f.lookups.length, 0);
  }
  const analyst = fixture({ user: { ...user, rolNombre: "ANALISTA_APROBACION" } });
  assert.equal((await analyst.get()).status, 200); assert.equal(analyst.lookups[0].actorId, 7);
});
