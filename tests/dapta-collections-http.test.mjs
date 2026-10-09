import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.FINSERPAY_TEST_DEPENDENCIES || import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { createCollectionsHandlers } = await jiti.import(fileURLToPath(new URL("../lib/dapta-collections-http.ts", import.meta.url)));
const token = "test-only-collections-secret-000000000000";
const agentId = "test-agent-collections";
const valid = () => ({ creditoId: 9, agentId, callId: "call_test_1234", actedAt: "2026-10-09T15:00:00Z",
  result: "ACUERDO_PAGO", comment: "Cliente confirma fecha y monto", nextFollowUpAt: "2026-10-10T15:00:00Z",
  agreementConfirmed: true, agreementDate: "2026-10-10", agreementAmount: 50000 });
const req = (body, auth = token) => new Request("https://finserpay.com/api/integraciones/cobranza/gestiones", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
});
function setup(overrides = {}) {
  const calls = [];
  const handlers = createCollectionsHandlers({ token: () => token, agentId: () => agentId, actorId: () => 7,
    read: async id => ({ credito: { id, diasMora: 129, valorVencido: 971608 } }),
    record: async (id, input, actorId) => { calls.push({ id, input, actorId }); return { item: { id: "saved-event", ...input } }; },
    error: () => Response.json({ ok: false, error: "Registro rechazado" }, { status: 409 }), ...overrides });
  return { ...handlers, calls };
}
test("autenticación falla antes de leer o escribir; configuración ausente falla cerrada", async () => {
  const h = setup();
  assert.equal((await h.gestion(req(valid(), "wrong"))).status, 401);
  assert.equal((await h.consulta(req({ creditoId: 9 }, "wrong"))).status, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await setup({ token: () => undefined }).gestion(req(valid()))).status, 503);
  assert.equal((await setup({ actorId: () => NaN }).gestion(req(valid()))).status, 503);
});
test("consulta entrega los días y valores de la misma fuente, sin fabricarlos", async () => {
  const response = await setup().consulta(req({ creditoId: 9 }));
  assert.deepEqual(await response.json(), { ok: true, credito: { id: 9, diasMora: 129, valorVencido: 971608 } });
  assert.match(response.headers.get("cache-control"), /no-store/);
});
test("acuerdo registra fecha, monto, origen y responsable configurado; mismo callId reutiliza idempotencia", async () => {
  const h = setup();
  assert.equal((await h.gestion(req(valid()))).status, 200);
  await h.gestion(req(valid()));
  assert.equal(h.calls[0].input.idempotencyKey, h.calls[1].input.idempotencyKey);
  assert.equal(h.calls[0].actorId, 7);
  assert.equal(h.calls[0].input.managementStatus, "ACUERDO_PAGO");
  assert.equal(h.calls[0].input.agreementDate, "2026-10-10");
  assert.equal(h.calls[0].input.agreementAmount, 50000);
  assert.match(h.calls[0].input.comment, /Dapta cobranza.*call_test_1234/);
});
test("fallo de persistencia nunca confirma un registro exitoso", async () => {
  const h = setup({ record: async () => { throw new Error("database unavailable"); } });
  const response = await h.gestion(req(valid()));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).registrado, undefined);
});
test("no permite otro agente, suplantar responsable, marcar pago confirmado ni acuerdos sin confirmación", async () => {
  for (const patch of [{ agentId: "Diana" }, { responsibleUserId: 99 }, { result: "SOLUCIONADO" }, { agreementConfirmed: false }]) {
    const h = setup();
    assert.ok((await h.gestion(req({ ...valid(), ...patch }))).status >= 400);
    assert.equal(h.calls.length, 0);
  }
});
test("pago declarado queda en seguimiento, no solucionado ni pago confirmado", async () => {
  const h = setup();
  const { agreementDate, agreementAmount, agreementConfirmed, ...data } = valid();
  const response = await h.gestion(req({ ...data, result: "PAGO_REALIZADO" }));
  assert.equal(response.status, 200);
  assert.equal(h.calls[0].input.managementStatus, "SEGUIMIENTO");
  assert.equal(h.calls[0].input.agreementAmount, undefined);
});
test("rechaza solicitudes grandes y crédito inválido antes de registrar", async () => {
  const h = setup();
  assert.equal((await h.gestion(req({ ...valid(), comment: "x".repeat(13000) }))).status, 413);
  assert.equal((await h.gestion(req({ ...valid(), creditoId: -1 }))).status, 400);
  assert.equal(h.calls.length, 0);
});
