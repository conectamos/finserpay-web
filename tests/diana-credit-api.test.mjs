import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { createDianaCreditHandler } = await jiti.import("../lib/diana-credit-api.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote } = await jiti.import("../lib/credit-principal-payment.ts");
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

test("partial payments return the actual remaining installment total and current principal quote", async () => {
  const credit = { ...base, saldoBaseFinanciado: 240, valorInteres: 30, valorFianza: 30,
    abonos: [{ valor: 50, fechaAbono: "2026-10-05" }] };
  const response = await handler([credit])(request());
  const { creditos: [result] } = await response.json();
  assert.equal(result.cuotasTotales, 3);
  assert.equal(result.cuotasPendientes, 3);
  assert.equal(result.totalCuotasPendientes, 250);
  assert.notEqual(result.totalCuotasPendientes, result.cuotasPendientes * credit.valorCuota);
  assert.deepEqual(result.liquidacionAnticipada, { disponible: true, capitalPendiente: 200,
    motivo: null, consultadoAt: "2026-10-06T15:00:00.000Z", proximaCuotaFecha: "2026-10-10" });
});

test("an audited principal plan retains its principal and excludes eliminated installments from the total count", async () => {
  const terms = { ...base, montoCredito: 1200, valorCuota: 120, plazoMeses: 10,
    saldoBaseFinanciado: 1000, valorInteres: 0, valorFianza: 200 };
  const prior = [{ id: 1, valor: 480, fechaAbono: "2026-10-04" }];
  const quote = createPrincipalPaymentQuote({ plan: buildCreditPaymentPlan({ ...terms,
    abonos: prior, today: "2026-10-06" }), abonos: prior, valor: 100,
    capitalOriginal: 1000, cuotaHabitual: 120,
    conciliacion: { capitalPendiente: 600, tasaPeriodo: 0, cuotaCredito: 100,
      fianzaCuota: 20, seguroCuota: 0, numeroProximaCuota: 5, fuente: "Conciliacion artificial de prueba" } });
  const planCapitalVigente = structuredClone(quote.planCapitalVigente);
  planCapitalVigente.abonosAlCorte.push({ id: 2, valor: 100 });
  const credit = { ...terms, montoCredito: quote.montoCreditoActualizado, planCapitalVigente,
    abonos: [...prior, { id: 2, valor: 100, fechaAbono: "2026-10-05" }] };
  const { creditos: [result] } = await (await handler([credit])(request())).json();
  assert.equal(result.cuotasTotales, 9);
  assert.equal(result.cuotasPagadas, 4);
  assert.equal(result.cuotasPendientes, 5);
  assert.equal(result.totalCuotasPendientes, 600);
  assert.equal(result.liquidacionAnticipada.disponible, true);
  assert.equal(result.liquidacionAnticipada.capitalPendiente, 500);
  assert.equal(result.liquidacionAnticipada.proximaCuotaFecha, "2027-02-10");
});

test("overdue and settled credits never offer a principal payoff amount", async () => {
  for (const [credit, state, reason] of [
    [{ ...base, fechaPrimerPago: "2026-08-10" }, "MORA", /al dia/],
    [{ ...base, abonos: [{ valor: 300 }] }, "PAGADO", /pagado/],
    [{ ...base, estado: "PAZ_Y_SALVO" }, "PAGADO", /pagado/],
    [{ ...base, pazYSalvoEmitidoAt: new Date("2026-10-01T12:00:00Z") }, "PAGADO", /pagado/],
  ]) {
    const { creditos: [result] } = await (await handler([credit])(request())).json();
    assert.equal(result.estado, state);
    assert.equal(result.liquidacionAnticipada.disponible, false);
    assert.equal(result.liquidacionAnticipada.capitalPendiente, null);
    assert.match(result.liquidacionAnticipada.motivo, reason);
    if (state === "PAGADO") {
      assert.equal(result.totalCuotasPendientes, 0);
      assert.equal(result.cuotasPendientes, 0);
      assert.equal(result.liquidacionAnticipada.proximaCuotaFecha, null);
    }
  }
});

test("payoff eligibility follows the Colombia calendar without expiring on the due date itself", async () => {
  const apiAt = iso => createDianaCreditHandler({ token: () => token,
    lookup: async () => [{ ...base, fechaPrimerPago: "2026-10-06" }], now: () => new Date(iso) });
  const onDueDate = await (await apiAt("2026-10-07T04:59:59Z")(request())).json();
  assert.equal(onDueDate.creditos[0].estado, "AL_DIA");
  assert.equal(onDueDate.creditos[0].liquidacionAnticipada.disponible, true);
  assert.equal(onDueDate.creditos[0].liquidacionAnticipada.proximaCuotaFecha, "2026-10-06");
  const followingDay = await (await apiAt("2026-10-07T05:00:00Z")(request())).json();
  assert.equal(followingDay.creditos[0].estado, "MORA");
  assert.equal(followingDay.creditos[0].liquidacionAnticipada.capitalPendiente, null);
});

test("new financial fields are an explicit projection without identity, snapshots, payment data or secrets", async () => {
  const response = await handler([{ ...base, clienteDocumento: "123456789", clienteNombre: "PRIVATE_NAME",
    clienteTelefono: "+573001234567", accessToken: "PRIVATE_TOKEN", contratoSnapshot: { private: "PRIVATE_SNAPSHOT" },
    abonos: [{ valor: 50, observacion: "PRIVATE_PAYMENT" }] }])(request());
  const body = await response.json(), serialized = JSON.stringify(body);
  for (const privateValue of ["123456789", "PRIVATE_NAME", "+573001234567", "PRIVATE_TOKEN", "PRIVATE_SNAPSHOT", "PRIVATE_PAYMENT"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.equal(response.headers.get("vary"), "Authorization");
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(Object.keys(body.creditos[0].liquidacionAnticipada).sort(),
    ["disponible", "capitalPendiente", "motivo", "consultadoAt", "proximaCuotaFecha"].sort());
  assert.equal(Object.hasOwn(body.creditos[0].liquidacionAnticipada, "expiresAt"), false);
});
