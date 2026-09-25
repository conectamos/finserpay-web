import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { core, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";
const clearStore = loadBlacklistModule("lib/document-blacklist-clear.ts", { "@/lib/document-blacklist-core": core });
const reader = loadBlacklistModule("lib/document-blacklist-bulk-request.ts", { "@/lib/document-blacklist-core": core });
const nextServer = { NextResponse: { json: (value, init) => Response.json(value, init) } };
const responses = loadBlacklistModule("lib/document-blacklist-response.ts", { "next/server": nextServer, "@/lib/document-blacklist-core": core });
const origin = loadBlacklistModule("lib/credit-approval-http.ts", {
  "next/server": nextServer, "@/lib/auth": {}, "@/lib/roles": {}, "@/lib/approval-shared-session": {}, "@/lib/credit-approval-actor": {}, "@/lib/credit-approval": {},
});
const actor = { id: 32, nombre: "Administrador central" };
const valid = () => ({ confirmed: true, motivo: "Depuración autorizada", mutationId: randomUUID(), fingerprint: "a".repeat(64) });
const request = (body = valid(), headers = {}, url = "https://finserpay.example/api/lista-negra/limpiar") => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function harness(options = {}) {
  const calls = [];
  const db = { $transaction: async (fn, settings) => { calls.push({ type: "transaction", settings }); return fn({ tx: true }); } };
  const route = loadBlacklistModule("app/api/lista-negra/limpiar/route.ts", {
    "next/server": nextServer, "@/lib/prisma": { default: db }, "@/lib/credit-approval-http": origin,
    "@/lib/document-blacklist-core": core, "@/lib/document-blacklist-bulk-request": reader, "@/lib/document-blacklist-response": responses,
    "@/lib/datacredito/admin-access": { getDataCreditoCentralAdmin: async () => options.denied ? { ok: false, status: options.denied } : { ok: true, user: actor } },
    "@/lib/document-blacklist-clear": { ...clearStore,
      previewBlacklistClear: async (database, who) => { calls.push({ type: "preview", database, who }); return { total: 394, active: 390, inactive: 4, fingerprint: "a".repeat(64) }; },
      clearBlacklist: async (database, input, who) => { calls.push({ type: "clear", database, input, who }); if (options.error) throw options.error; return { removed: 394, unblocked: 390 }; },
    },
  });
  return { route, calls, db };
}
for (const status of [401, 403]) test(`acceso ${status} antes de leer cuerpo o datos`, async () => {
  const h = harness({ denied: status });
  assert.equal((await h.route.GET()).status, status);
  assert.equal((await h.route.POST({ get headers() { throw Error("No leer"); } })).status, status);
  assert.equal(h.calls.length, 0);
});
test("la vista previa global sólo lee; la escritura usa transacción y actor de sesión", async () => {
  const h = harness();
  const preview = await h.route.GET();
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal((await preview.json()).total, 394);
  assert.equal(h.calls[0].database, h.db);
  const result = await h.route.POST(request({ ...valid(), actorUserId: 999 }));
  assert.equal(result.status, 200);
  assert.equal(h.calls[1].type, "transaction");
  assert.equal(h.calls[2].database.tx, true);
  assert.equal(h.calls[2].who.id, actor.id);
});
test("rechaza falta de confirmación, motivo, huella o UUID sin escribir", async () => {
  for (const changes of [{ confirmed: false }, { confirmed: "true" }, { motivo: "" }, { fingerprint: "" }, { mutationId: "bad" }]) {
    const h = harness();
    assert.equal((await h.route.POST(request({ ...valid(), ...changes }))).status, 400);
    assert.equal(h.calls.length, 0);
  }
});
test("rechaza origen externo y admite Host público detrás del proxy", async () => {
  const h = harness();
  assert.equal((await h.route.POST(request(valid(), { origin: "https://externo.example" }))).status, 403);
  assert.equal((await h.route.POST(request(valid(), { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.route.POST(request(valid(), { origin: "https://finserpay.example", host: "finserpay.example" }, "http://0.0.0.0:3000/api/lista-negra/limpiar"))).status, 200);
});
test("conflicto muestra error recuperable y fallo interno no filtra detalles", async () => {
  const h = harness({ error: new core.DocumentBlacklistError("CLEAR_PREVIEW_CHANGED", "La lista cambió", 409) });
  const response = await h.route.POST(request());
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "CLEAR_PREVIEW_CHANGED");
  const failed = await harness({ error: Error("postgres secret") }).route.POST(request());
  assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(await failed.json()), /secret/);
});

test("rechaza JSON inválido y cuerpos excesivos sin iniciar transacción", async () => {
  const h = harness();
  const malformed = new Request("https://finserpay.example/api/lista-negra/limpiar", { method: "POST", body: "{" });
  assert.equal((await h.route.POST(malformed)).status, 400);
  assert.equal((await h.route.POST(request({ ...valid(), motivo: "x".repeat(160000) }))).status, 413);
  assert.equal(h.calls.length, 0);
});
