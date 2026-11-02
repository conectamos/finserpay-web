import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root,
  "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createDianaExtensionHandler } = await jiti.import("../lib/diana-extension-api.ts");
const { AttentionError } = await jiti.import("../lib/atencion-core.ts");
const token = "test-only-extension-api-token-0123456789";
const proposal = { accion: "proponer", cedula: "123456789", folio: "FC-TEST-1", dias: 2,
  valorCompromiso: 100, fechaCompromiso: "2026-11-04", motivo: "Compromiso del cliente" };
const view = { code: "PR-1234567890ABCDEF", status: "PENDING", approved: false,
  offerText: "Oferta canónica", expiresAt: "2026-11-01T18:15:00Z", days: 2,
  installmentNumber: 1, installmentDueDate: "2026-11-02", expiresOn: "2026-11-04",
  promiseAmount: 100, promiseDate: "2026-11-04" };
function request(body = proposal, authorization = `Bearer ${token}`, contentType = "application/json") {
  return new Request("https://finserpay.test/api/integraciones/diana/prorrogas", { method: "POST",
    headers: { authorization, "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function setup(overrides = {}) {
  const calls = [];
  const handler = createDianaExtensionHandler({ enabled: () => true, token: () => token,
    propose: async input => { calls.push(["propose", input]); return view; },
    status: async code => { calls.push(["status", code]); return view; }, ...overrides });
  return { handler, calls };
}
test("financial actions require the dedicated token and enabled integration before any lookup", async () => {
  for (const options of [{ token: () => undefined }, { token: () => "short" }, { enabled: () => false }]) {
    const { handler, calls } = setup(options);
    assert.equal((await handler(request())).status, 503);
    assert.deepEqual(calls, []);
  }
  const { handler, calls } = setup();
  for (const auth of ["", "Bearer wrong", `Bearer ${token} extra`]) assert.equal((await handler(request(proposal, auth))).status, 401);
  assert.deepEqual(calls, []);
});
test("a proposal is not an approval and the HTTP action cannot provide a confirmation witness", async () => {
  const { handler, calls } = setup();
  const response = await handler(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estado, "PENDING"); assert.equal(result.aprobada, false);
  assert.equal(result.oferta, view.offerText);
  assert.deepEqual(calls[0], ["propose", { cedula: proposal.cedula, folio: proposal.folio,
    days: 2, promiseAmount: 100, promiseDate: proposal.fechaCompromiso, reason: proposal.motivo }]);
  for (const extra of [{ confirmed: true }, { conversationId: "fake" }, { actorKey: "ADMIN" }, { messageId: "fake" }]) {
    assert.equal((await handler(request({ ...proposal, ...extra }))).status, 400);
  }
  assert.equal(calls.length, 1);
  assert.equal((await handler(request({ accion: "aprobar", codigo: view.code }))).status, 400);
});
test("state queries expose only the bounded financial projection and committed approval", async () => {
  for (const state of [
    { status: "OFFERED", approved: false }, { status: "GRANTED", approved: false },
    { status: "GRANTED", approved: true }, { status: "REJECTED", approved: true },
  ]) {
    const { handler, calls } = setup({ status: async code => {
      calls.push(["status", code]); return { ...view, ...state, creditId: 987, extensionId: "internal",
        phone: "private", cedula: "private", actorUserId: 3 };
    } });
    const response = await handler(request({ accion: "consultar", codigo: view.code }));
    const result = await response.json();
    assert.equal(result.aprobada, state.status === "GRANTED" && state.approved);
    assert.deepEqual(calls, [["status", view.code]]);
    for (const key of ["creditId", "extensionId", "phone", "cedula", "actorUserId"]) assert.equal(Object.hasOwn(result, key), false);
  }
});
test("malformed or excessive input never prepares a proposal", async () => {
  const { handler, calls } = setup();
  const invalid = [null, [], "{broken", { ...proposal, dias: 5 }, { ...proposal, dias: "2" },
    { ...proposal, cedula: "123" }, { ...proposal, folio: "FC/invalid" },
    { ...proposal, valorCompromiso: 1.001 }, { ...proposal, valorCompromiso: 0 },
    { ...proposal, fechaCompromiso: "2026-02-30" }, { ...proposal, motivo: "x" },
    { accion: "consultar", codigo: "PR-guess" }, { accion: "consultar", codigo: view.code, confirmed: true }];
  for (const body of invalid) assert.equal((await handler(request(body))).status, 400);
  assert.equal((await handler(request(proposal, `Bearer ${token}`, "text/plain"))).status, 415);
  assert.equal((await handler(request({ ...proposal, motivo: "x".repeat(9000) }))).status, 413);
  assert.deepEqual(calls, []);
});
test("provider/database failures do not disclose sensitive details or imply approval", async () => {
  const { handler } = setup({ propose: async () => { throw new Error("private SQL, token and customer data"); } });
  const response = await handler(request());
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.ok, false); assert.equal(Object.hasOwn(result, "aprobada"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("vary"), "Authorization");
  const blocked = setup({ propose: async () => { throw new AttentionError("La cuota cambió.", 409); } });
  assert.equal((await blocked.handler(request())).status, 409);
});
