import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root,
  "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createDianaCreditHandler, readDianaExtensionProtections } = await jiti.import("../lib/diana-credit-api.ts");
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

const verifiedProtection = { verified: true, open: null };
const extensionCredit = { ...base, fechaPrimerPago: "2026-11-02", extensionProtection: verifiedProtection };
const protectionId = "2fd0fd0f-9035-4fe1-a34d-5e6813c62531";
async function extensionAt(iso, credit = extensionCredit) {
  const response = await createDianaCreditHandler({ token: () => token,
    now: () => new Date(iso), lookup: async () => [credit] })(request());
  assert.equal(response.status, 200);
  return (await response.json()).creditos[0];
}

test("extension options before the 02/17 due date use the CRM policy without granting or exposing internal records", async () => {
  for (const [dueDate, expires] of [["2026-11-02", ["03", "04", "05", "06"]], ["2026-11-17", ["18", "19", "20", "21"]]]) {
    const original = { ...extensionCredit, id: 987654321, fechaPrimerPago: dueDate };
    const snapshot = structuredClone(original);
    const result = await extensionAt("2026-11-01T17:00:00Z", original);
    assert.deepEqual(result.prorroga, { verificada: true, disponible: true, motivo: null,
      cuotaNumero: 1, vencimientoCuota: dueDate,
      opciones: expires.map((day, index) => ({ dias: index + 1, fechaLimite: `2026-11-${day}` })),
      compromisoSugerido: { valor: 100, fecha: `2026-11-${expires.at(-1)}` },
      consultadoAt: "2026-11-01T17:00:00.000Z" });
    assert.deepEqual(original, snapshot, "read-only consultation must not mutate the credit");
    assert.equal(JSON.stringify(result).includes("987654321"), false);
    for (const forbidden of ["granted", "aprobada", "extensionId", "actor", "extensionProtection", "extensionAbonos"]) {
      assert.equal(Object.hasOwn(result.prorroga, forbidden), false);
    }
  }
});

test("extension windows exclude elapsed choices and close at midnight in Colombia after the 06/21", async () => {
  for (const [dueDate, cutoff] of [["2026-11-02", "2026-11-06"], ["2026-11-17", "2026-11-21"]]) {
    const credit = { ...extensionCredit, fechaPrimerPago: dueDate };
    const result = await extensionAt(`${cutoff}T17:00:00Z`, credit);
    assert.equal(result.estado, "MORA");
    assert.deepEqual(result.prorroga.opciones, [{ dias: 4, fechaLimite: cutoff }]);
    const nextDate = String(Number(cutoff.slice(-2)) + 1).padStart(2, "0");
    const lastSecond = await extensionAt(`2026-11-${nextDate}T04:59:59Z`, credit);
    assert.equal(lastSecond.prorroga.disponible, true);
    const closed = await extensionAt(`2026-11-${nextDate}T05:00:00Z`, credit);
    assert.equal(closed.prorroga.verificada, true);
    assert.equal(closed.prorroga.disponible, false);
    assert.deepEqual(closed.prorroga.opciones, []);
    assert.match(closed.prorroga.motivo, /06\/21/);
  }
  const middle = await extensionAt("2026-11-04T17:00:00Z");
  assert.deepEqual(middle.prorroga.opciones.map(option => option.dias), [2, 3, 4]);
});

test("pending or current approved protections block all options; an expired approved protection does not", async () => {
  for (const open of [
    { status: "PENDING", expiresOn: "2026-10-31" },
    { status: "APPROVED", expiresOn: null },
    { status: "APPROVED", expiresOn: "2026-11-04" },
    { status: "APPROVED", expiresOn: "2026-11-06" },
    { type: "EXCEPCION", status: "APPROVED", expiresOn: null },
  ]) {
    const result = await extensionAt("2026-11-04T17:00:00Z", { ...extensionCredit,
      extensionProtection: { verified: true, open: { id: protectionId, type: "PRORROGA", ...open } } });
    assert.equal(result.prorroga.verificada, true);
    assert.equal(result.prorroga.disponible, false);
    assert.deepEqual(result.prorroga.opciones, []);
    assert.deepEqual(result.prorroga.compromisoSugerido, { valor: null, fecha: null });
    assert.match(result.prorroga.motivo, /solicitud pendiente o una excepción vigente/);
    assert.equal(JSON.stringify(result).includes(protectionId), false);
  }
  const expired = await extensionAt("2026-11-04T17:00:00Z", { ...extensionCredit,
    extensionProtection: { verified: true, open: { id: protectionId, type: "EXCEPCION", status: "APPROVED", expiresOn: "2026-11-03" } } });
  assert.equal(expired.prorroga.disponible, true);
});

test("paid, cancelled, incomplete schedules and non-regular due dates do not offer extensions", async () => {
  for (const credit of [
    { ...extensionCredit, abonos: [{ valor: 300 }] },
    { ...extensionCredit, pazYSalvoEmitidoAt: new Date("2026-11-01T12:00:00Z") },
    { ...extensionCredit, estado: "PAZ_Y_SALVO", pazYSalvoEmitidoAt: null, abonos: [] },
    { ...extensionCredit, estado: "CANCELADO" },
    { ...extensionCredit, fechaPrimerPago: null, fechaProximoPago: new Date("2026-11-02T00:00:00Z") },
    { ...extensionCredit, fechaPrimerPago: "2026-11-10" },
  ]) {
    const result = await extensionAt("2026-11-01T17:00:00Z", credit);
    assert.equal(result.prorroga.disponible, false);
    assert.deepEqual(result.prorroga.opciones, []);
    assert.equal(typeof result.prorroga.motivo, "string");
  }
  const legacyPaid = await extensionAt("2026-11-01T17:00:00Z", { ...extensionCredit,
    estado: "PAZ_Y_SALVO", pazYSalvoEmitidoAt: null, abonos: [] });
  assert.equal(legacyPaid.estado, "PAGADO");
  assert.equal(legacyPaid.prorroga.verificada, true);
  assert.equal(legacyPaid.prorroga.cuotaNumero, null);
  assert.equal(legacyPaid.prorroga.vencimientoCuota, null);
  assert.match(legacyPaid.prorroga.motivo, /pagado/);
});

test("an invalid principal-plan snapshot still fails the financial consultation without advertising extension options", async () => {
  const response = await handler([{ ...extensionCredit, planCapitalVigente: { invalid: true } }])(request());
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(Object.hasOwn(body, "creditos"), false);
  assert.equal(Object.hasOwn(body, "prorroga"), false);
});

test("extension plan uses only the verified active-payment view and never the administrative next-date override", async () => {
  const result = await extensionAt("2026-11-01T17:00:00Z", { ...extensionCredit,
    fechaProximoPago: new Date("2026-11-17T00:00:00Z"),
    abonos: [{ valor: 125 }], extensionAbonos: [{ valor: 25 }] });
  assert.equal(result.saldoPendiente, 175, "the pre-existing balance API keeps its own payment input");
  assert.equal(result.prorroga.vencimientoCuota, "2026-11-02");
  assert.equal(result.prorroga.compromisoSugerido.valor, 75);
});

test("unknown protection evidence fails closed while preserving ordinary financial answers", async () => {
  for (const protection of [undefined, { verified: false }]) {
    const result = await extensionAt("2026-11-01T17:00:00Z", { ...extensionCredit, extensionProtection: protection });
    assert.equal(result.saldoPendiente, 300);
    assert.equal(result.prorroga.verificada, false);
    assert.equal(result.prorroga.disponible, false);
    assert.deepEqual(result.prorroga.opciones, []);
    assert.deepEqual(result.prorroga.compromisoSugerido, { valor: null, fecha: null });
  }
});

test("batched protection reader is read-only, distinguishes verified absence and closes on failure or corrupt data", async () => {
  const calls = [];
  const read = async ids => { calls.push(ids); return [{ id: protectionId, creditoId: 7, type: "EXCEPCION", status: "PENDING", expiresOn: null }]; };
  const result = await readDianaExtensionProtections([7, 8, 7], read);
  assert.deepEqual(calls, [[7, 8]]);
  assert.equal(result.get(7).open.status, "PENDING");
  assert.deepEqual(result.get(8), { verified: true, open: null });
  assert.deepEqual(await readDianaExtensionProtections([], async () => assert.fail("no read for no credits")), new Map());
  const valid = { id: protectionId, creditoId: 7, type: "PRORROGA", status: "APPROVED", expiresOn: "2026-11-06" };
  for (const reader of [
    async () => { throw new Error("missing schema or read denied"); },
    async () => null,
    async () => [valid, valid],
    async () => [{ ...valid, creditoId: 9 }],
    async () => [{ ...valid, expiresOn: "2026-02-30" }],
    async () => [{ ...valid, status: "UNKNOWN" }],
  ]) {
    const protections = await readDianaExtensionProtections([7, 8], reader);
    assert.deepEqual([...protections.values()], [{ verified: false }, { verified: false }]);
    const credit = await extensionAt("2026-11-01T17:00:00Z", { ...extensionCredit, extensionProtection: protections.get(7) });
    assert.equal(credit.prorroga.disponible, false);
    assert.deepEqual(credit.prorroga.opciones, []);
  }
});

test("production lookup batches real protections and filters the extension payment ledger without enabling writes", async () => {
  for (const protectionReadFails of [false, true]) {
    const calls = [], credit = { ...extensionCredit, extensionProtection: undefined, id: 7,
      pazYSalvoEmitidoAt: null, abonos: [
        { valor: 25, estado: "ACTIVO", anuladoAt: null, fechaAbono: new Date("2026-11-01T12:00:00Z") },
        { valor: 100, estado: "PENDIENTE", anuladoAt: null, fechaAbono: null },
        { valor: 50, estado: "ACTIVO", anuladoAt: new Date("2026-11-01T13:00:00Z"), fechaAbono: null },
      ] };
    const prisma = { credito: { findMany: async query => {
      calls.push("credits");
      assert.equal(query.where.clienteDocumento, "123456789");
      assert.equal(query.select.abonos.select.anuladoAt, true);
      return [credit, { ...credit, id: 8, folio: "TEST-2", abonos: [] }];
    } }, $queryRawUnsafe: async (sql, ids) => {
      calls.push("protections");
      assert.match(sql, /^SELECT .*FROM "CreditMoraExceptionRequest"\s+WHERE/);
      assert.match(sql, /status IN \('PENDING','APPROVED'\)/);
      assert.deepEqual(Array.from(ids), [7, 8]);
      if (protectionReadFails) throw new Error("private missing schema details");
      return [{ id: protectionId, creditoId: 8, type: "PRORROGA", status: "PENDING", expiresOn: null }];
    } };
    const route = loadReissueModule("app/api/integraciones/diana/creditos/route.ts", {
      "@/lib/prisma": { default: prisma },
      "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => { calls.push("existing-audit-check"); } },
      "@/lib/diana-credit-api": { readDianaExtensionProtections,
        createDianaCreditHandler: deps => createDianaCreditHandler({ ...deps, now: () => new Date("2026-11-01T17:00:00Z") }) },
    }, { process: { env: { FINSERPAY_DIANA_API_TOKEN: token } } });
    assert.equal((await route.POST(request(undefined, "Bearer wrong"))).status, 401);
    assert.deepEqual(calls, []);
    const response = await route.POST(request());
    assert.equal(response.status, 200);
    const body = await response.json(), [first, second] = body.creditos;
    assert.deepEqual(calls, ["existing-audit-check", "credits", "protections"]);
    assert.equal(first.saldoPendiente, 125, "ordinary balance input is unchanged");
    assert.equal(first.prorroga.verificada, !protectionReadFails);
    assert.equal(first.prorroga.disponible, !protectionReadFails);
    assert.equal(first.prorroga.compromisoSugerido.valor, protectionReadFails ? null : 75);
    assert.equal(second.prorroga.disponible, false);
    assert.deepEqual(second.prorroga.opciones, []);
    assert.equal(JSON.stringify(body).includes("private missing schema details"), false);
    for (const result of body.creditos) {
      for (const key of ["id", "extensionProtection", "extensionAbonos", "abonos"]) assert.equal(Object.hasOwn(result, key), false);
    }
  }
});
