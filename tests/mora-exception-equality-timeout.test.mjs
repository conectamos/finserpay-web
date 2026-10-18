import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../lib/equality-zero-touch.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deviceUid = "001234567890123";
const operations = [
  { name: "consulta", method: "queryEqualityDevices", path: "/api/v2/query/devices", code: "QUERY_DEVICES", body: { deviceList: [{ deviceUid }] } },
  { name: "desbloqueo", method: "unlockEqualityDevice", path: "/api/v2/device/unlock", code: "DEVICE_UNLOCK", body: { unLockList: [{ deviceUid }] } },
  { name: "bloqueo", method: "lockEqualityDevice", path: "/api/v2/device/lock", code: "DEVICE_LOCK", body: { lockList: [{ deviceUid, lockType: "lock", lockMsgTitle: "Pago vencido", lockMsgContent: "Mensaje autorizado" }] }, options: { lockMsgTitle: "Pago vencido", lockMsgContent: "Mensaje autorizado" } },
];
const response = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const tokenResponse = () => response({ token: "test-token", expireTime: "2099-01-01T00:00:00Z" });

function loadClient(provider, implementation) {
  const calls = [], loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Date, JSON, Error, Number, String, Boolean, Promise, AbortSignal,
    process: { env: provider === "Trustonic" ? { TRUSTONIC_API_KEY: "test-key", TRUSTONIC_TENANT_ID: "test-tenant", TRUSTONIC_BASE_URL: "https://trustonic.test" } : { EQUALITY_API_TOKEN: "test-token", EQUALITY_HBM_BASE_URL: "https://equality.test" } },
    fetch: async (url, options) => { const call = { url, options }; calls.push(call); return implementation(call); },
  });
  const invoke = (operation, signal) => loaded.exports[operation.method](" 001234567890123 ", { ...operation.options, ...(signal ? { signal } : {}) });
  return { calls, invoke };
}

function pendingFetch(signal) {
  assert.ok(signal, "el fetch debe recibir la señal de cancelación");
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  });
}
const isToken = call => call.url.endsWith("/api/v1/authorization/token");

for (const provider of ["Equality", "Trustonic"]) {
  for (const operation of operations) {
    for (const withSignal of [false, true]) {
      test(`${provider}: ${operation.name} conserva el payload ${withSignal ? "con señal" : "sin señal"}`, async () => {
        const client = loadClient(provider, call => isToken(call) ? tokenResponse() : response({ ok: true }));
        const controller = new AbortController();
        await client.invoke(operation, withSignal ? controller.signal : undefined);
        assert.equal(client.calls.length, provider === "Trustonic" ? 2 : 1);
        for (const call of client.calls) assert.equal(call.options.signal, withSignal ? controller.signal : undefined);
        const call = client.calls.at(-1), payload = JSON.parse(call.options.body);
        assert.equal(call.url, provider === "Trustonic" ? "https://trustonic.test" + operation.path : "https://equality.test/v1/hbm");
        assert.deepEqual(payload, provider === "Trustonic" ? operation.body : { service: { code: operation.code, variant: "A" }, data: operation.body });
        assert.ok(!JSON.stringify(payload).includes("signal"), "la señal nunca se envía dentro del payload");
        if (provider === "Trustonic") {
          assert.equal(call.options.headers.Authorization, "Bearer test-token");
          assert.equal(call.options.headers.tenantId, "test-tenant");
        }
      });
    }

    test(`${provider}: cancelar ${operation.name} interrumpe el fetch pendiente`, { timeout: 1000 }, async () => {
      const controller = new AbortController(), reason = new Error("Presupuesto agotado");
      const client = loadClient(provider, call => isToken(call) ? tokenResponse() : pendingFetch(call.options.signal));
      const result = client.invoke(operation, controller.signal);
      const rejected = assert.rejects(result, error => error === reason);
      await setImmediate();
      assert.ok(client.calls.some(call => !isToken(call)), "se inició el comando del dispositivo");
      controller.abort(reason); await rejected;
      assert.ok(client.calls.at(-1).options.signal.aborted);
    });

    test(`${provider}: cancelar ${operation.name} interrumpe la lectura del cuerpo`, { timeout: 1000 }, async () => {
      const controller = new AbortController(), reason = new Error("Lectura agotada");
      let reading = false;
      const client = loadClient(provider, call => isToken(call) ? tokenResponse() : { ok: true, status: 200, text: () => { reading = true; return new Promise(() => {}); } });
      const result = client.invoke(operation, controller.signal);
      const rejected = assert.rejects(result, error => error === reason);
      await setImmediate(); assert.ok(reading, "el proveedor ya entregó las cabeceras");
      controller.abort(reason); await rejected;
    });

    test(`${provider}: ${operation.name} no envía nada si la señal ya fue cancelada`, async () => {
      const controller = new AbortController(), reason = new Error("Operación cancelada antes del envío"); controller.abort(reason);
      const client = loadClient(provider, () => { throw new Error("No debe realizarse un fetch"); });
      await assert.rejects(client.invoke(operation, controller.signal), error => error === reason);
      assert.equal(client.calls.length, 0);
    });
  }
}

test("Trustonic: se cancela también la solicitud pendiente del token", { timeout: 1000 }, async () => {
  const controller = new AbortController(), reason = new Error("Token agotado");
  const client = loadClient("Trustonic", call => pendingFetch(call.options.signal));
  const result = client.invoke(operations[0], controller.signal), rejected = assert.rejects(result, error => error === reason);
  await setImmediate(); assert.equal(client.calls.length, 1); assert.ok(isToken(client.calls[0]));
  controller.abort(reason); await rejected;
  assert.equal(client.calls.length, 1, "un token cancelado no inicia el comando del dispositivo");
});

test("Trustonic: cancelar el cuerpo del token no lo guarda en caché ni inicia el comando", { timeout: 1000 }, async () => {
  const controller = new AbortController(), reason = new Error("Cuerpo del token agotado");
  let tokenCalls = 0;
  const client = loadClient("Trustonic", call => {
    if (isToken(call) && ++tokenCalls === 1) return { ok: true, status: 200, text: () => new Promise(() => {}) };
    return isToken(call) ? tokenResponse() : response({ ok: true });
  });
  const result = client.invoke(operations[0], controller.signal), rejected = assert.rejects(result, error => error === reason);
  await setImmediate(); controller.abort(reason); await rejected;
  assert.equal(client.calls.length, 1);
  await client.invoke(operations[0]);
  assert.equal(tokenCalls, 2); assert.equal(client.calls.length, 3);
});

test("Trustonic: una señal cancelada tampoco reutiliza un token vigente para iniciar otra petición", async () => {
  const client = loadClient("Trustonic", call => isToken(call) ? tokenResponse() : response({ ok: true }));
  await client.invoke(operations[0]); assert.equal(client.calls.length, 2);
  const controller = new AbortController(), reason = new Error("Cancelada con token vigente"); controller.abort(reason);
  await assert.rejects(client.invoke(operations[1], controller.signal), error => error === reason);
  assert.equal(client.calls.length, 2);
});
