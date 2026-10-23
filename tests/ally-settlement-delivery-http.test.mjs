import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const operationId = "10000000-0000-4000-8000-000000000001";
const deliveryBody = loadReissueModule("lib/ally-settlement-delivery-body.ts");
const { isSameApprovalOrigin } = loadReissueModule("lib/credit-approval-http.ts", {
  "next/server": { NextResponse: Response },
  "@/lib/auth": {},
  "@/lib/roles": {},
  "@/lib/approval-shared-session": {},
  "@/lib/credit-approval-actor": {},
  "@/lib/credit-approval": {},
});
const central = { ok: true, kind: "CENTRAL_ADMIN", allyId: null, user: { id: 91 } };
const ally = { ok: true, kind: "ALLY_ADMIN", allyId: 7, user: { id: 92 } };
class AllyPaymentNotFoundError extends Error {}
class DeliveryConflictError extends Error {}
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ access = central, retry, list, run } = {}) {
  const calls = [], callbacks = [], errors = [];
  const settlement = { id: 123, aliado: { id: 7, nombre: "Aliado sintético" }, saldoNeto: 75000 };
  const deliveries = [
    { channel: "EMAIL", status: "SENT", recipient: "synthetic@example.test", sentAt: "2026-10-21T15:00:00Z" },
    { channel: "WHATSAPP", status: "FAILED", recipient: null, error: "Falta el teléfono del aliado." },
  ];
  const route = loadReissueModule("app/api/pagos-aliados/[id]/envios/route.ts", {
    "next/server": { NextResponse: Response, after: callback => { calls.push(["after"]); callbacks.push(callback); } },
    "@/lib/ally-payment-access": { getAllyPaymentAccess: async () => access },
    "@/lib/ally-payments": {
      AllyPaymentNotFoundError,
      getAllyPaymentDetail: async input => {
        calls.push(["detail", plain(input)]);
        if (input.id !== settlement.id || (input.allyId !== null && input.allyId !== settlement.aliado.id)) {
          throw new AllyPaymentNotFoundError();
        }
        return settlement;
      },
    },
    "@/lib/ally-settlement-delivery-store": { DeliveryConflictError },
    "@/lib/ally-settlement-delivery-body": deliveryBody,
    "@/lib/credit-approval-http": { isSameApprovalOrigin },
    "@/lib/ally-settlement-delivery-service": {
      runSettlementDeliveryQueue: async id => { calls.push(["dispatch", id]); return run?.(id); },
      settlementDeliveryStore: {
        list: async id => { calls.push(["list", id]); return list ? list(id) : { deliveries }; },
        retry: async (...args) => {
          calls.push(["retry-start", ...args]);
          await retry?.(...args);
          calls.push(["retry-saved"]);
        },
      },
    },
  }, {
    fetch: () => assert.fail("No network calls are permitted in these HTTP tests"),
    console: { error: (...args) => errors.push(args) },
  });
  function request(method = "GET", body, headers = {}, raw, url = "https://qa.invalid/api/pagos-aliados/123/envios") {
    return new Request(url, {
      method, headers: method === "POST" ? { "Content-Type": "application/json", ...headers } : headers,
      ...(method === "POST" ? { body: raw ?? JSON.stringify(body ?? { channel: "EMAIL", requestId: operationId }) } : {}),
    });
  }
  const context = (id = "123") => ({ params: Promise.resolve({ id }) });
  return { route, request, context, calls, callbacks, errors, deliveries, settlement };
}

test("consultar estados aplica alcance por aliado y nunca programa ni ejecuta envíos", async () => {
  for (const access of [central, ally]) {
    const f = fixture({ access });
    const response = await f.route.GET(f.request(), f.context());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    assert.deepEqual(await response.json(), { ok: true, deliveries: f.deliveries });
    assert.deepEqual(f.calls, [["detail", { id: 123, allyId: access.allyId }], ["list", 123]]);
    assert.equal(f.callbacks.length, 0);
  }
});

test("un aliado ajeno recibe 404 antes de consultar los destinatarios", async () => {
  const f = fixture({ access: { ...ally, allyId: 8 } });
  const response = await f.route.GET(f.request(), f.context());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
  assert.deepEqual(f.calls, [["detail", { id: 123, allyId: 8 }]]);
});

test("solo central puede reenviar; no autenticados o sin permisos no consultan datos", async () => {
  for (const status of [401, 403]) {
    const f = fixture({ access: { ok: false, status } });
    for (const method of ["GET", "POST"]) {
      assert.equal((await f.route[method](f.request(method), f.context())).status, status);
    }
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ access: ally });
  assert.equal((await f.route.POST(f.request("POST"), f.context())).status, 403);
  assert.deepEqual(f.calls, []);
});

test("reintento usa exclusivamente snapshot y canal seleccionado, ignora destinatarios del cliente", async () => {
  for (const channel of ["EMAIL", "WHATSAPP"]) {
    const f = fixture();
    const response = await f.route.POST(f.request("POST", {
      channel, requestId: operationId, recipient: "attacker@example.test", telefono: "573111111111", aliadoId: 999, settlementId: 999,
    }), f.context());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deliveries: f.deliveries });
    assert.equal(f.calls[1][0], "retry-start");
    assert.equal(f.calls[1][1], f.settlement);
    assert.deepEqual(f.calls[1].slice(2), [channel, operationId, central.user.id]);
    assert.deepEqual(f.calls.map(call => call[0]), ["detail", "retry-start", "retry-saved", "after", "list"]);
    await f.callbacks[0]();
    assert.deepEqual(f.calls.at(-1), ["dispatch", 123]);
  }
});

test("after se registra únicamente después de persistir el reintento", async () => {
  let release;
  const persisted = new Promise(resolve => { release = resolve; });
  const f = fixture({ retry: () => persisted });
  const responsePromise = f.route.POST(f.request("POST"), f.context());
  for (let i = 0; i < 20 && !f.calls.some(call => call[0] === "retry-start"); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(call => call[0] === "retry-start"));
  assert.equal(f.callbacks.length, 0);
  assert.ok(!f.calls.some(call => call[0] === "list" || call[0] === "dispatch"));
  release();
  assert.equal((await responsePromise).status, 200);
  assert.equal(f.callbacks.length, 1);
  assert.ok(!f.calls.some(call => call[0] === "dispatch"));
});

test("reintentos de ambos canales aceptan el Host público detrás de Railway", async () => {
  for (const channel of ["EMAIL", "WHATSAPP"]) {
    const f = fixture();
    const response = await f.route.POST(f.request("POST", { channel, requestId: operationId }, {
      Origin: "https://finserpay.com", Host: "finserpay.com", "Sec-Fetch-Site": "same-origin",
    }, undefined, "http://0.0.0.0:3000/api/pagos-aliados/123/envios"), f.context());
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.map(call => call[0]), ["detail", "retry-start", "retry-saved", "after", "list"]);
    assert.equal(f.calls[1][2], channel);
    assert.equal(f.callbacks.length, 1);
    await f.callbacks[0]();
    assert.deepEqual(f.calls.at(-1), ["dispatch", 123]);
  }
});

test("orígenes externos, encabezados reenviados y Fetch Metadata no autorizan reintentos", async () => {
  const deniedHeaders = [
    { Origin: "https://attacker.invalid", "X-Forwarded-Host": "attacker.invalid" },
    { Origin: "http://0.0.0.0:3000", "X-Forwarded-Host": "0.0.0.0:3000" },
    { Origin: "https://finserpay.com.attacker.invalid" },
    { Origin: "https://finserpay.com:8443" },
    { Origin: "https://finserpay.com/path" },
    { Origin: "null" },
    { Origin: "https://finserpay.com", "Sec-Fetch-Site": "cross-site" },
    { Origin: "https://finserpay.com", "Sec-Fetch-Site": "same-site" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of deniedHeaders) {
    const f = fixture();
    const response = await f.route.POST(f.request("POST", undefined, {
      Host: "finserpay.com", "Sec-Fetch-Site": "same-origin", ...headers,
    }, undefined, "http://0.0.0.0:3000/api/pagos-aliados/123/envios"), f.context());
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal((await response.json()).error, "Origen no autorizado.");
    assert.deepEqual(f.calls.map(call => call[0]), ["detail"]);
    assert.equal(f.callbacks.length, 0);
  }
});

test("conflicto o fallo al persistir conserva la liquidación sin programar envío", async () => {
  for (const [error, status] of [[new DeliveryConflictError("Envío en curso."), 409], [new Error("database unavailable"), 500]]) {
    const f = fixture({ retry: async () => { throw error; } });
    const response = await f.route.POST(f.request("POST"), f.context());
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.deliveries, undefined);
    assert.equal(f.callbacks.length, 0);
    assert.deepEqual(f.calls.map(call => call[0]), ["detail", "retry-start"]);
  }
});

test("fallo de lectura nunca inventa estado enviado; reintento ya guardado queda recuperable", async () => {
  for (const method of ["GET", "POST"]) {
    const f = fixture({ list: async () => { throw new Error("database unavailable"); } });
    const response = await f.route[method](f.request(method), f.context());
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.deliveries, undefined);
    assert.match(body.error, /liquidación sigue guardada/);
    assert.equal(f.callbacks.length, method === "POST" ? 1 : 0);
  }
});

test("el fallo del worker posterior no altera la respuesta guardada ni simula éxito", async () => {
  const f = fixture({ run: async () => { throw new Error("provider failure"); } });
  const response = await f.route.POST(f.request("POST"), f.context());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deliveries[1].status, "FAILED");
  await assert.doesNotReject(f.callbacks[0]());
  assert.equal(f.errors.length, 1);
});

test("identificadores inválidos y liquidaciones inexistentes no leen envíos", async () => {
  for (const method of ["GET", "POST"]) {
    for (const id of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
      const f = fixture();
      assert.equal((await f.route[method](f.request(method), f.context(id))).status, 400);
      assert.deepEqual(f.calls, []);
    }
    const missing = fixture();
    assert.equal((await missing.route[method](missing.request(method), missing.context("999"))).status, 404);
    assert.deepEqual(missing.calls, [["detail", { id: 999, allyId: null }]]);
  }
});

test("canales, UUID, contenido, tamaño y origen inválidos no persisten ni despachan", async () => {
  const cases = [
    [{ channel: "SMS", requestId: operationId }, {}, undefined, 400],
    [{ channel: "EMAIL", requestId: "invalid" }, {}, undefined, 400],
    [{ channel: "WHATSAPP" }, {}, undefined, 400],
    [[], {}, undefined, 400],
    [undefined, {}, "{invalid", 400],
    [undefined, {}, "null", 400],
    [undefined, { "Content-Type": "text/plain" }, undefined, 415],
    [undefined, {}, " ".repeat(2049), 413],
    [undefined, {}, "é".repeat(1025), 413],
    [undefined, { "Content-Length": "2049" }, undefined, 413],
    [undefined, { Origin: "https://attacker.invalid" }, undefined, 403],
  ];
  for (const [body, headers, raw, expected] of cases) {
    const f = fixture();
    const response = await f.route.POST(f.request("POST", body, headers, raw), f.context());
    assert.equal(response.status, expected);
    assert.equal((await response.json()).ok, false);
    assert.equal(f.callbacks.length, 0);
    assert.deepEqual(f.calls.map(call => call[0]), ["detail"]);
  }
});
