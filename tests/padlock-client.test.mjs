import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": require.resolve("next/dist/compiled/server-only/empty"),
  },
});
const {
  createPadlockClient,
  PadlockError,
} = await jiti.import("../lib/padlock/client.ts");
const {
  getPadlockRuntimeConfig,
  isPadlockConfigured,
  isPadlockIntegrationEnabled,
  isPadlockSandboxCreditAllowed,
  resolvePadlockConfig,
} = await jiti.import("../lib/padlock/config.ts");

const allowedImei = "356938035643809";
const secondAllowedImei = "490154203237518";
const baseEnv = Object.freeze({
  NODE_ENV: "test",
  PADLOCK_ALLOW_PRODUCTION: "false",
  PADLOCK_BASE_URL: "https://padlock-fixture.example",
  PADLOCK_EMAIL: "fixture@example.test",
  PADLOCK_ENVIRONMENT: "sandbox",
  PADLOCK_INTEGRATION_ENABLED: "true",
  PADLOCK_PASSWORD: "fixture-password",
  PADLOCK_RESPONSE_MAX_BYTES: "16384",
  PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS: "credit-fixture-1,credit-fixture-2",
  PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS: `${allowedImei},${secondAllowedImei}`,
  PADLOCK_TENANT: "fixture-tenant",
  PADLOCK_TIMEOUT_MS: "3000",
});

const testSignal = () => new AbortController().signal;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function tokenResponse(token = "fixture-access-token", expiresIn = 3600) {
  return jsonResponse({ expires_in: expiresIn, token });
}

function deviceFixture(overrides = {}) {
  return {
    brand: "Apple",
    created_at: "2026-09-01T10:00:00.000Z",
    identifier: allowedImei,
    key1: allowedImei,
    key2: null,
    model: "iPhone Fixture",
    serial: "SERIAL-FIXTURE",
    status: "unlocked",
    transition_started_at: null,
    updated_at: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function listPayload(items = [deviceFixture()], overrides = {}) {
  return {
    items,
    limit: 100,
    page: 1,
    total: items.length,
    totalPages: items.length ? 1 : 0,
    ...overrides,
  };
}

function commandPayload(overrides = {}) {
  const result = {
    brand: "Apple",
    device: allowedImei,
    message: "Command accepted",
    model: "iPhone Fixture",
    status: "locking",
    success: true,
    ...(overrides.result || {}),
  };

  return {
    errorCount: 0,
    notEnrolledCount: 0,
    results: [result],
    successCount: 1,
    totalDeviceCount: 1,
    ...overrides,
    results: overrides.results || [result],
  };
}

test("resuelve solo la configuracion server-only acordada y expone un resumen publico", () => {
  const config = resolvePadlockConfig(baseEnv);

  assert.equal(config.baseUrl, "https://padlock-fixture.example");
  assert.equal(config.enabled, true);
  assert.equal(config.environment, "sandbox");
  assert.equal(config.timeoutMs, 3000);
  assert.equal(config.responseMaxBytes, 16384);
  assert.deepEqual([...config.sandboxAllowedDeviceIds], [
    allowedImei,
    secondAllowedImei,
  ]);
  assert.equal(isPadlockSandboxCreditAllowed(config, "credit-fixture-1"), true);
  assert.equal(isPadlockSandboxCreditAllowed(config, "credit-not-allowed"), false);
  assert.equal(isPadlockConfigured(baseEnv), true);
  assert.equal(isPadlockIntegrationEnabled(baseEnv), true);

  const runtime = getPadlockRuntimeConfig(baseEnv);
  assert.equal(runtime.configured, true);
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.environment, "sandbox");
  assert.equal(runtime.productionAllowed, false);
  assert.doesNotMatch(
    JSON.stringify(runtime),
    /fixture-password|fixture@example\.test|fixture-tenant/
  );
});

test("el kill switch falla cerrado antes de resolver secretos o usar la red", async () => {
  let calls = 0;
  const client = createPadlockClient({
    env: { PADLOCK_INTEGRATION_ENABLED: "false" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.lockDevice(allowedImei),
    (error) =>
      error instanceof PadlockError && error.code === "FEATURE_DISABLED"
  );
  assert.equal(calls, 0);
});

test("rechaza configuracion incompleta, limites invalidos y allowlists inseguras", () => {
  for (const env of [
    { ...baseEnv, PADLOCK_EMAIL: "" },
    { ...baseEnv, PADLOCK_TIMEOUT_MS: "999" },
    { ...baseEnv, PADLOCK_RESPONSE_MAX_BYTES: "5242881" },
    { ...baseEnv, PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS: "123" },
    { ...baseEnv, PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS: "credit ok" },
    {
      ...baseEnv,
      PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS: "",
      PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS: "",
    },
  ]) {
    assert.throws(
      () => resolvePadlockConfig(env),
      (error) =>
        error instanceof PadlockError && error.code === "CONFIGURATION_ERROR"
    );
  }
});

test("bloquea produccion salvo habilitacion doble explicita", () => {
  const productionEnv = {
    ...baseEnv,
    PADLOCK_ENVIRONMENT: "production",
    PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS: "",
    PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS: "",
  };

  assert.throws(
    () => resolvePadlockConfig(productionEnv),
    (error) =>
      error instanceof PadlockError &&
      error.code === "PRODUCTION_NOT_ALLOWED"
  );

  const config = resolvePadlockConfig({
    ...productionEnv,
    PADLOCK_ALLOW_PRODUCTION: "true",
  });
  assert.equal(config.environment, "production");
  assert.equal(config.allowProduction, true);
});

test("exige HTTPS remoto y solo admite HTTP loopback en tests sandbox", () => {
  for (const baseUrl of [
    "http://padlock-fixture.example",
    "https://user:password@padlock-fixture.example",
    "https://padlock-fixture.example/api",
    "https://padlock-fixture.example?redirect=other",
    "https://padlock-fixture.example:444",
  ]) {
    assert.throws(
      () => resolvePadlockConfig({ ...baseEnv, PADLOCK_BASE_URL: baseUrl }),
      (error) =>
        error instanceof PadlockError && error.code === "CONFIGURATION_ERROR"
    );
  }

  assert.equal(
    resolvePadlockConfig({
      ...baseEnv,
      PADLOCK_BASE_URL: "http://localhost:8000",
    }).baseUrl,
    "http://localhost:8000"
  );
  assert.throws(
    () =>
      resolvePadlockConfig({
        ...baseEnv,
        NODE_ENV: "development",
        PADLOCK_BASE_URL: "http://localhost:8000",
      }),
    (error) =>
      error instanceof PadlockError && error.code === "CONFIGURATION_ERROR"
  );
});

test("autentica con el contrato documentado y lista dispositivos sin cache ni redirects", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      return calls.length === 1
        ? tokenResponse()
        : jsonResponse(listPayload());
    },
    timeoutSignal: (milliseconds) => {
      assert.equal(milliseconds, 3000);
      return signal;
    },
  });

  const result = await client.listDevices({
    correlationId: "padlock-list-0001",
    limit: 25,
    page: 2,
    search: allowedImei,
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://padlock-fixture.example/api/v1/auth/login"
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "fixture@example.test",
    password: "fixture-password",
    tenant: "fixture-tenant",
  });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.signal, signal);

  const listUrl = new URL(calls[1].url);
  assert.equal(listUrl.pathname, "/api/v1/enterprise/devices");
  assert.equal(listUrl.searchParams.get("page"), "2");
  assert.equal(listUrl.searchParams.get("limit"), "25");
  assert.equal(listUrl.searchParams.get("search"), allowedImei);
  assert.equal(
    listUrl.searchParams.get("searchFields"),
    "key1,key2,identifier,serial"
  );
  assert.equal(calls[1].init.cache, "no-store");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(
    new Headers(calls[1].init.headers).get("authorization"),
    "Bearer fixture-access-token"
  );
  assert.deepEqual(result.items[0], {
    brand: "Apple",
    createdAt: "2026-09-01T10:00:00.000Z",
    identifier: allowedImei,
    key1: allowedImei,
    key2: null,
    model: "iPhone Fixture",
    serial: "SERIAL-FIXTURE",
    status: "unlocked",
    transitionStartedAt: null,
    updatedAt: "2026-09-02T10:00:00.000Z",
  });
});

test("busca IMEI por coincidencia exacta y no acepta resultados aproximados", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse(
            listPayload([
              deviceFixture({
                identifier: "111111111111111",
                key1: "111111111111111",
              }),
              deviceFixture({ identifier: allowedImei, key1: null }),
            ])
          ),
    timeoutSignal: testSignal,
  });

  const result = await client.queryDeviceByImei(allowedImei, {
    correlationId: "padlock-query-001",
  });
  assert.equal(result.identifier, allowedImei);
  assert.equal(result.key1, null);
});

test("devuelve null si la busqueda no contiene el IMEI exacto", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse(
            listPayload([
              deviceFixture({
                identifier: "111111111111111",
                key1: "111111111111111",
              }),
            ])
          ),
    timeoutSignal: testSignal,
  });

  assert.equal(await client.queryDeviceByImei(allowedImei), null);
});

test("falla cerrado si Padlock devuelve mas de un dispositivo para el mismo IMEI", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse(
            listPayload([
              deviceFixture(),
              deviceFixture({ key1: null, serial: allowedImei }),
            ])
          ),
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDeviceByImei(allowedImei),
    (error) =>
      error instanceof PadlockError && error.code === "AMBIGUOUS_DEVICE"
  );
});

test("no declara unicidad si la busqueda exacta tiene paginas sin inspeccionar", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse(
            listPayload([deviceFixture()], {
              total: 101,
              totalPages: 2,
            })
          ),
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDeviceByImei(allowedImei),
    (error) =>
      error instanceof PadlockError && error.code === "AMBIGUOUS_DEVICE"
  );
});

test("impide consultar o mutar un IMEI fuera de la allowlist sandbox", async () => {
  let calls = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    },
    timeoutSignal: testSignal,
  });

  for (const operation of [
    () => client.queryDeviceByImei("111111111111111"),
    () => client.lockDevice("111111111111111"),
    () => client.unlockDevice("111111111111111"),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error instanceof PadlockError &&
        error.code === "SANDBOX_DEVICE_NOT_ALLOWED"
    );
  }
  assert.equal(calls, 0);
});

test("envia un solo IMEI por lock y normaliza el resultado exitoso", async () => {
  const calls = [];
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      return calls.length === 1 ? tokenResponse() : jsonResponse(commandPayload());
    },
    timeoutSignal: testSignal,
  });

  const result = await client.lockDevice(allowedImei, {
    correlationId: "padlock-lock-0001",
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    "https://padlock-fixture.example/api/v1/devices/lock"
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    devices: [allowedImei],
  });
  assert.deepEqual(result, {
    action: "LOCK",
    brand: "Apple",
    message: "Command accepted",
    model: "iPhone Fixture",
    requestedDevice: allowedImei,
    status: "locking",
    success: true,
  });
});

test("acepta HTTP 200 parcial sin confundir un item fallido con exito", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse(
            commandPayload({
              errorCount: 1,
              notEnrolledCount: 1,
              result: {
                message: "Device is not enrolled",
                status: "not_enrolled",
                success: false,
              },
              successCount: 0,
            })
          ),
    timeoutSignal: testSignal,
  });

  const result = await client.lockDevice(allowedImei);
  assert.equal(result.success, false);
  assert.equal(result.status, "not_enrolled");
  assert.equal(result.message, "Device is not enrolled");
});

test("rechaza resultados adicionales cuando se solicito un solo IMEI", async () => {
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse()
        : jsonResponse({
            ...commandPayload(),
            results: [
              commandPayload().results[0],
              {
                ...commandPayload().results[0],
                device: secondAllowedImei,
              },
            ],
          }),
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.lockDevice(allowedImei),
    (error) =>
      error instanceof PadlockError && error.code === "INVALID_RESPONSE"
  );
});

test("unlock usa su endpoint y solo confirma estados compatibles", async () => {
  const calls = [];
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      return calls.length === 1
        ? tokenResponse()
        : jsonResponse(
            commandPayload({
              result: { status: "unlocking", success: true },
            })
          );
    },
    timeoutSignal: testSignal,
  });

  const result = await client.unlockDevice(allowedImei);
  assert.equal(
    calls[1].url,
    "https://padlock-fixture.example/api/v1/devices/unlock"
  );
  assert.equal(result.action, "UNLOCK");
  assert.equal(result.status, "unlocking");
  assert.equal(result.success, true);
});

test("un estado desconocido u opuesto nunca se normaliza como exito", async () => {
  let commandRequests = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/auth/login")) {
        return tokenResponse();
      }

      commandRequests += 1;
      return jsonResponse(
        commandPayload({
          result: {
            status: commandRequests === 1 ? "scheduled_elsewhere" : "unlocked",
            success: true,
          },
        })
      );
    },
    timeoutSignal: testSignal,
  });

  const unknown = await client.lockDevice(allowedImei);
  const opposite = await client.lockDevice(allowedImei);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.success, false);
  assert.equal(opposite.status, "unlocked");
  assert.equal(opposite.success, false);
});

test("redacta IMEI, credenciales, correo y token del mensaje remoto", async () => {
  const token = "fixture-ultra-private-token";
  const providerMessage = [
    allowedImei,
    baseEnv.PADLOCK_EMAIL,
    baseEnv.PADLOCK_PASSWORD,
    baseEnv.PADLOCK_TENANT,
    token,
  ].join(" ");
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) =>
      String(url).endsWith("/auth/login")
        ? tokenResponse(token)
        : jsonResponse(
            commandPayload({ result: { message: providerMessage } })
          ),
    timeoutSignal: testSignal,
  });

  const result = await client.lockDevice(allowedImei);
  assert.doesNotMatch(
    result.message,
    new RegExp(
      `${allowedImei}|fixture@example\\.test|fixture-password|fixture-tenant|${token}`
    )
  );
  assert.match(result.message, /\[redacted/);
});

test("comparte una sola autenticacion entre solicitudes concurrentes", async () => {
  let releaseToken;
  const tokenGate = new Promise((resolve) => {
    releaseToken = resolve;
  });
  let tokenRequests = 0;
  let listRequests = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/auth/login")) {
        tokenRequests += 1;
        await tokenGate;
        return tokenResponse("fixture-shared-token");
      }

      listRequests += 1;
      return jsonResponse(listPayload([]));
    },
    timeoutSignal: testSignal,
  });

  const first = client.listDevices({ correlationId: "padlock-shared-01" });
  const second = client.listDevices({ correlationId: "padlock-shared-02" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokenRequests, 1);
  releaseToken();
  await Promise.all([first, second]);
  assert.equal(tokenRequests, 1);
  assert.equal(listRequests, 2);
});

test("cachea el token solo en memoria y lo renueva antes de expirar", async () => {
  let clock = 0;
  let tokenRequests = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/auth/login")) {
        tokenRequests += 1;
        return tokenResponse(`fixture-token-${tokenRequests}`, 10);
      }
      return jsonResponse(listPayload([]));
    },
    now: () => clock,
    timeoutSignal: testSignal,
  });

  await client.listDevices();
  clock = 8_999;
  await client.listDevices();
  assert.equal(tokenRequests, 1);
  clock = 9_000;
  await client.listDevices();
  assert.equal(tokenRequests, 2);
});

test("acepta expires_in documentado como duracion con unidad", async () => {
  let calls = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? tokenResponse("fixture-duration-token", "10d")
        : jsonResponse(listPayload([]));
    },
    timeoutSignal: testSignal,
  });

  await client.listDevices();
  await client.listDevices();
  assert.equal(calls, 3);
});

test("renueva una sola vez despues de 401 y reutiliza el nuevo bearer", async () => {
  let tokenRequests = 0;
  let listRequests = 0;
  const authorizations = [];
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/auth/login")) {
        tokenRequests += 1;
        return tokenResponse(`fixture-token-${tokenRequests}`);
      }

      listRequests += 1;
      authorizations.push(new Headers(init.headers).get("authorization"));
      return listRequests === 1
        ? new Response(null, { status: 401 })
        : jsonResponse(listPayload([]));
    },
    timeoutSignal: testSignal,
  });

  await client.listDevices();
  assert.equal(tokenRequests, 2);
  assert.equal(listRequests, 2);
  assert.deepEqual(authorizations, [
    "Bearer fixture-token-1",
    "Bearer fixture-token-2",
  ]);
});

test("se detiene despues del segundo 401", async () => {
  let tokenRequests = 0;
  let listRequests = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/auth/login")) {
        tokenRequests += 1;
        return tokenResponse(`fixture-denied-token-${tokenRequests}`);
      }
      listRequests += 1;
      return new Response(null, { status: 401 });
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.listDevices(),
    (error) =>
      error instanceof PadlockError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.providerHttpStatus === 401
  );
  assert.equal(tokenRequests, 2);
  assert.equal(listRequests, 2);
});

test("no reintenta 403, 429 ni 5xx y clasifica el error sin cuerpo remoto", async () => {
  for (const [status, code, retryable] of [
    [403, "AUTHENTICATION_FAILED", false],
    [429, "PROVIDER_RATE_LIMITED", true],
    [503, "PROVIDER_UNAVAILABLE", true],
  ]) {
    let providerRequests = 0;
    const client = createPadlockClient({
      env: baseEnv,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/auth/login")) {
          return tokenResponse();
        }
        providerRequests += 1;
        return new Response("remote-secret-detail", { status });
      },
      timeoutSignal: testSignal,
    });

    await assert.rejects(client.listDevices(), (error) => {
      assert.ok(error instanceof PadlockError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.doesNotMatch(error.message, /remote-secret-detail/);
      return true;
    });
    assert.equal(providerRequests, 1);
  }
});

test("normaliza timeout y error de red sin filtrar detalles", async () => {
  for (const thrown of [
    new DOMException(
      `network ${baseEnv.PADLOCK_PASSWORD}`,
      "TimeoutError"
    ),
    new TypeError(`redirect ${baseEnv.PADLOCK_EMAIL}`),
  ]) {
    const client = createPadlockClient({
      env: baseEnv,
      fetchImpl: async () => {
        throw thrown;
      },
      timeoutSignal: testSignal,
    });

    await assert.rejects(client.listDevices(), (error) => {
      assert.ok(error instanceof PadlockError);
      assert.equal(
        error.code,
        thrown.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"
      );
      assert.doesNotMatch(
        error.message,
        /fixture-password|fixture@example\.test|network|redirect/
      );
      return true;
    });
  }
});

test("no reintenta automaticamente un comando con resultado de red ambiguo", async () => {
  let commandRequests = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/auth/login")) {
        return tokenResponse();
      }

      commandRequests += 1;
      throw new DOMException("ambiguous provider outcome", "TimeoutError");
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.lockDevice(allowedImei),
    (error) =>
      error instanceof PadlockError &&
      error.code === "TIMEOUT" &&
      error.retryable === true
  );
  assert.equal(commandRequests, 1);
});

test("aplica el limite de respuesta anunciado y durante streaming", async () => {
  for (const oversizedResponse of [
    () =>
      new Response("{}", {
        headers: { "Content-Length": "16385" },
      }),
    () =>
      new Response("x".repeat(16_385), {
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    let calls = 0;
    const client = createPadlockClient({
      env: baseEnv,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? tokenResponse() : oversizedResponse();
      },
      timeoutSignal: testSignal,
    });

    await assert.rejects(
      client.listDevices(),
      (error) =>
        error instanceof PadlockError && error.code === "RESPONSE_TOO_LARGE"
    );
  }
});

test("rechaza token, JSON, listado y correlacion de comando malformados", async () => {
  const invalidTokenClient = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => jsonResponse({ expires_in: 3600 }),
    timeoutSignal: testSignal,
  });
  await assert.rejects(
    invalidTokenClient.listDevices(),
    (error) =>
      error instanceof PadlockError && error.code === "INVALID_RESPONSE"
  );

  const invalidDurationClient = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => tokenResponse("fixture-token", "10 days"),
    timeoutSignal: testSignal,
  });
  await assert.rejects(
    invalidDurationClient.listDevices(),
    (error) =>
      error instanceof PadlockError && error.code === "INVALID_RESPONSE"
  );

  let invalidJsonCalls = 0;
  const invalidJsonClient = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => {
      invalidJsonCalls += 1;
      return invalidJsonCalls === 1
        ? tokenResponse()
        : new Response("not-json");
    },
    timeoutSignal: testSignal,
  });
  await assert.rejects(
    invalidJsonClient.listDevices(),
    (error) =>
      error instanceof PadlockError && error.code === "INVALID_RESPONSE"
  );

  let malformedCommandCalls = 0;
  const malformedCommandClient = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => {
      malformedCommandCalls += 1;
      return malformedCommandCalls === 1
        ? tokenResponse()
        : jsonResponse(commandPayload({ results: [] }));
    },
    timeoutSignal: testSignal,
  });
  await assert.rejects(
    malformedCommandClient.lockDevice(allowedImei),
    (error) =>
      error instanceof PadlockError && error.code === "INVALID_RESPONSE"
  );
});

test("valida IMEI, correlacion y paginacion antes de usar la red", async () => {
  let calls = 0;
  const client = createPadlockClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    },
    timeoutSignal: testSignal,
  });

  for (const operation of [
    () => client.lockDevice("123"),
    () => client.unlockDevice(`${allowedImei},${secondAllowedImei}`),
    () => client.queryDeviceByImei(allowedImei, { correlationId: "bad" }),
    () => client.listDevices({ limit: 101 }),
    () => client.listDevices({ page: 0 }),
    () => client.listDevices({ search: "\u0000unsafe" }),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error instanceof PadlockError && error.code === "VALIDATION_ERROR"
    );
  }
  assert.equal(calls, 0);
});

test("el codigo no introduce variables publicas, persistencia de token ni logs", async () => {
  const [configSource, clientSource] = await Promise.all([
    readFile(new URL("../lib/padlock/config.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/padlock/client.ts", import.meta.url), "utf8"),
  ]);
  const source = `${configSource}\n${clientSource}`;
  const names = new Set(
    [
      ...source.matchAll(/["'](PADLOCK_[A-Z_]+)["']/g),
      ...source.matchAll(/\.(PADLOCK_[A-Z_]+)/g),
    ].map((match) => match[1])
  );

  assert.deepEqual(
    [...names].sort(),
    [
      "PADLOCK_ALLOW_PRODUCTION",
      "PADLOCK_BASE_URL",
      "PADLOCK_EMAIL",
      "PADLOCK_ENVIRONMENT",
      "PADLOCK_INTEGRATION_ENABLED",
      "PADLOCK_PASSWORD",
      "PADLOCK_RESPONSE_MAX_BYTES",
      "PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS",
      "PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS",
      "PADLOCK_TENANT",
      "PADLOCK_TIMEOUT_MS",
    ].sort()
  );
  assert.match(configSource, /^import "server-only";/);
  assert.match(clientSource, /^import "server-only";/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_|console\.|localStorage|sessionStorage/);
});
