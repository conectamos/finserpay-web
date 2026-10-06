import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { createDianaCreditHandler } = await jiti.import("../lib/diana-credit-api.ts");
const token = "test-only-diana-token";
const base = { folio: "TEST-1", estado: "ACTIVO", montoCredito: 300,
  valorCuota: 100, plazoMeses: 3, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-10-10", abonos: [] };
function request(body = { cedula: "123456789" }, authorization = `Bearer ${token}`, contentType = "application/json") {
  return new Request("http://localhost/api/integraciones/diana/creditos", {
    method: "POST", headers: { authorization, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function handler(credits = [], lookup) {
  return createDianaCreditHandler({ token: () => token,
    now: () => new Date("2026-10-06T15:00:00Z"), lookup: lookup || (async () => credits) });
}
test("authentication fails closed before querying personal data", async () => {
  const api = handler([], async () => { assert.fail("must not query"); });
  for (const auth of ["", "Bearer wrong", "Bearer test-only-diana-tokeX", token]) {
    const response = await api(request(undefined, auth));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  const disabled = createDianaCreditHandler({ token: () => undefined, lookup: async () => { assert.fail(); } });
  assert.equal((await disabled(request())).status, 503);
});
test("invalid documents, content type and JSON never reach lookup", async () => {
  const api = handler([], async () => { assert.fail("must not query"); });
  for (const cedula of [123456, "1234", "1234567890123456", "12345 OR 1=1", null]) {
    assert.equal((await api(request({ cedula }))).status, 400);
  }
  assert.equal((await api(request("{"))).status, 400);
  assert.equal((await api(request(undefined, `Bearer ${token}`, "text/plain"))).status, 415);
});
test("current credit returns next payment; response does not expose identity", async () => {
  const response = await handler([base])(request({ cedula: " 123456789 " }));
  const body = await response.json();
  assert.equal(body.estado, "AL_DIA");
  assert.equal(body.creditos[0].valorAPagar, 100);
  assert.equal(body.creditos[0].fechaVencimiento, "2026-10-10");
  assert.equal(body.creditos[0].saldoPendiente, 300);
  assert.equal(JSON.stringify(body).includes("123456789"), false);
});
test("overdue partial payments and multiple credits use total overdue amount", async () => {
  const body = await (await handler([{ ...base, fechaPrimerPago: "2026-08-10", abonos: [{ valor: 50 }] }, base])(request())).json();
  assert.equal(body.estado, "MORA");
  assert.equal(body.creditos.length, 2);
  assert.equal(body.creditos[0].saldoVencido, 150);
  assert.equal(body.creditos[0].valorAPagar, 150);
  assert.equal(body.creditos[0].cuotasEnMora, 2);
});
test("paid and early settled credits have no next payment or due date", async () => {
  for (const credit of [{ ...base, abonos: [{ valor: 300 }] }, { ...base, estado: "PAZ_Y_SALVO" }, { ...base, pazYSalvoEmitidoAt: new Date() }]) {
    const body = await (await handler([credit])(request())).json();
    assert.equal(body.estado, "PAGADO");
    assert.equal(body.creditos[0].valorAPagar, 0);
    assert.equal(body.creditos[0].saldoPendiente, 0);
    assert.equal(body.creditos[0].fechaVencimiento, null);
  }
});
test("unknown document returns explicit empty result", async () => {
  const body = await (await handler()(request())).json();
  assert.equal(body.encontrado, false);
  assert.equal(body.estado, "SIN_CREDITOS");
  assert.deepEqual(body.creditos, []);
});
test("database failures return generic error without sensitive details", async () => {
  const api = handler([], async () => { throw new Error("secret database credentials"); });
  const response = await api(request());
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("secret"), false);
});

test("production administrative due-date override is honored", async () => {
  const credit = { ...base, fechaPrimerPago: "2026-10-10", fechaProximoPago: new Date("2026-10-02T00:00:00Z") };
  const body = await (await handler([credit])(request())).json();
  assert.equal(body.estado, "MORA");
  assert.equal(body.creditos[0].fechaVencimiento, "2026-10-02");
  assert.equal(body.creditos[0].saldoVencido, 100);
});
