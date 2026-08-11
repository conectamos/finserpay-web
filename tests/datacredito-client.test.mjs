import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createDataCreditoClient,
  DataCreditoError,
} = await jiti.import("../lib/datacredito/client.ts");
const { resolveDataCreditoConfig } = await jiti.import(
  "../lib/datacredito/config.ts"
);
const { parseDataCreditoQueryResponse } = await jiti.import(
  "../lib/datacredito/response.ts"
);

const baseEnv = Object.freeze({
  DATACREDITO_API_BASE_URL: "https://service-fixture.datacredito.com.co",
  DATACREDITO_AUTH_BASE_URL: "https://auth-fixture.datacredito.com.co",
  DATACREDITO_CLIENT_ID: "fixture-client",
  DATACREDITO_CLIENT_SECRET: "fixture-client-secret",
  DATACREDITO_ENVIRONMENT: "uat",
  DATACREDITO_PASSWORD: "fixture-password",
  DATACREDITO_QUERY_ENABLED: "true",
  DATACREDITO_RESPONSE_MAX_BYTES: "16384",
  DATACREDITO_TIMEOUT_MS: "3000",
  DATACREDITO_USERNAME: "fixture-user",
});

const testSignal = () => new AbortController().signal;

function providerPayload({
  hasInformation = true,
  rootStatus = "ACCEPTED",
  score = "731",
  transactionCode = "03",
} = {}) {
  return {
    status: rootStatus,
    content: {
      infoTransaccion: {
        codigosRespuesta: [
          { clave: "HC", valor: "11" },
          { clave: "TX", valor: transactionCode },
        ],
      },
      respuesta: {
        informacionRiesgo: {
          conInformacion: hasInformation,
          score,
        },
      },
    },
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

test("autentica con headers privados y envia solo los tres datos requeridos", async () => {
  const calls = [];
  let clock = 10_000;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });

      if (calls.length === 1) {
        return jsonResponse({
          access_token: "fixture-access-token",
          expires_in: "1800",
        });
      }

      return jsonResponse(providerPayload());
    },
    now: () => {
      clock += 11;
      return clock;
    },
    timeoutSignal: testSignal,
  });

  const result = await client.queryDataCreditoNaturalPerson({
    correlationId: "dc-test-0001",
    documentNumber: "9001234",
    firstSurname: "Apellido",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(
    calls[0].url,
    "https://auth-fixture.datacredito.com.co/spla/oauth2/v1/token"
  );
  const tokenHeaders = new Headers(calls[0].init.headers);
  assert.equal(tokenHeaders.get("client_id"), "fixture-client");
  assert.equal(tokenHeaders.get("client_secret"), "fixture-client-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    password: "fixture-password",
    username: "fixture-user",
  });
  assert.equal(
    calls[1].url,
    "https://service-fixture.datacredito.com.co/co/cs/midecisor/v1/client"
  );
  const queryHeaders = new Headers(calls[1].init.headers);
  assert.equal(
    queryHeaders.get("authorization"),
    "Bearer fixture-access-token"
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    apellidoRazonSocial: "Apellido",
    numeroIdentificacion: "9001234",
    tipoIdentificacion: "1",
  });
  assert.deepEqual(result, {
    durationMs: 11,
    hasInformation: true,
    providerStatus: "ACCEPTED",
    score: 731,
    transactionCode: "03",
  });
});

test("comparte una sola solicitud de token entre consultas concurrentes", async () => {
  let releaseToken;
  const tokenGate = new Promise((resolve) => {
    releaseToken = resolve;
  });
  let tokenRequests = 0;
  let queryRequests = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).includes("/token")) {
        tokenRequests += 1;
        await tokenGate;
        return jsonResponse({
          access_token: "fixture-shared-token",
          expires_in: "1800",
        });
      }

      queryRequests += 1;
      return jsonResponse(providerPayload({ score: "612" }));
    },
    timeoutSignal: testSignal,
  });

  const first = client.queryDataCreditoNaturalPerson({
    correlationId: "dc-concurrent-01",
    documentNumber: "8001111",
    firstSurname: "Primero",
  });
  const second = client.queryDataCreditoNaturalPerson({
    correlationId: "dc-concurrent-02",
    documentNumber: "8002222",
    firstSurname: "Segundo",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokenRequests, 1);
  releaseToken();
  await Promise.all([first, second]);
  assert.equal(tokenRequests, 1);
  assert.equal(queryRequests, 2);
});

test("invalida el token y reintenta exactamente una vez despues de un 401", async () => {
  let tokenRequests = 0;
  let queryRequests = 0;
  const seenAuthorization = [];
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/token")) {
        tokenRequests += 1;
        return jsonResponse({
          access_token: `fixture-token-${tokenRequests}`,
          expires_in: "1800",
        });
      }

      queryRequests += 1;
      seenAuthorization.push(new Headers(init.headers).get("authorization"));
      return queryRequests === 1
        ? new Response(null, { status: 401 })
        : jsonResponse(providerPayload({ score: "688" }));
    },
    timeoutSignal: testSignal,
  });

  const result = await client.queryDataCreditoNaturalPerson({
    correlationId: "dc-retry-0001",
    documentNumber: "7001234",
    firstSurname: "Prueba",
  });

  assert.equal(result.score, 688);
  assert.equal(tokenRequests, 2);
  assert.equal(queryRequests, 2);
  assert.deepEqual(seenAuthorization, [
    "Bearer fixture-token-1",
    "Bearer fixture-token-2",
  ]);
});

test("no reintenta errores distintos de 401", async () => {
  let queryRequests = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).includes("/token")) {
        return jsonResponse({
          access_token: "fixture-access-token",
          expires_in: "1800",
        });
      }

      queryRequests += 1;
      return new Response(null, { status: 503 });
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-no-retry-01",
      documentNumber: "6001234",
      firstSurname: "Control",
    }),
    (error) => {
      assert.ok(error instanceof DataCreditoError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.providerHttpStatus, 503);
      assert.equal(error.retryable, true);
      return true;
    }
  );
  assert.equal(queryRequests, 1);
});

test("detiene la consulta despues del segundo 401", async () => {
  let tokenRequests = 0;
  let queryRequests = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url) => {
      if (String(url).includes("/token")) {
        tokenRequests += 1;
        return jsonResponse({
          access_token: `fixture-denied-token-${tokenRequests}`,
          expires_in: "1800",
        });
      }

      queryRequests += 1;
      return new Response(null, { status: 401 });
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-two-401-01",
      documentNumber: "6501234",
      firstSurname: "Control",
    }),
    (error) =>
      error instanceof DataCreditoError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.providerHttpStatus === 401
  );
  assert.equal(tokenRequests, 2);
  assert.equal(queryRequests, 2);
});

test("clasifica como no evaluable cualquier respuesta incompleta o inconsistente", () => {
  const cases = [
    providerPayload({ rootStatus: "PRECONDITION_FAILED" }),
    providerPayload({ transactionCode: "17" }),
    providerPayload({ hasInformation: false }),
    providerPayload({ score: "731.5" }),
    providerPayload({ score: "951" }),
    providerPayload({ score: null }),
  ];

  for (const payload of cases) {
    const result = parseDataCreditoQueryResponse(payload, 14.6);
    assert.equal(result.score, null);
    assert.equal(result.durationMs, 15);
  }

  const invalidScoreWithInformation = parseDataCreditoQueryResponse(
    providerPayload({ score: "sin-puntaje" }),
    9
  );
  assert.equal(invalidScoreWithInformation.hasInformation, true);
  assert.equal(invalidScoreWithInformation.score, null);
});

test("rechaza hosts ajenos, HTTP y rutas que puedan cambiar el destino", () => {
  assert.throws(
    () =>
      resolveDataCreditoConfig({
        ...baseEnv,
        DATACREDITO_API_BASE_URL: "https://api.invalid.example",
      }),
    (error) => error instanceof DataCreditoError && error.code === "CONFIGURATION_ERROR"
  );
  assert.throws(
    () =>
      resolveDataCreditoConfig({
        ...baseEnv,
        DATACREDITO_AUTH_BASE_URL: "http://auth-fixture.datacredito.com.co",
      }),
    (error) => error instanceof DataCreditoError && error.code === "CONFIGURATION_ERROR"
  );
  assert.throws(
    () =>
      resolveDataCreditoConfig({
        ...baseEnv,
        DATACREDITO_QUERY_PATH: "//api.invalid.example/query",
      }),
    (error) => error instanceof DataCreditoError && error.code === "CONFIGURATION_ERROR"
  );
  assert.throws(
    () =>
      resolveDataCreditoConfig({
        ...baseEnv,
        DATACREDITO_QUERY_PATH: "/co/%2e%2e/otra-ruta",
      }),
    (error) => error instanceof DataCreditoError && error.code === "CONFIGURATION_ERROR"
  );
});

test("rechaza redirects sin reenviar credenciales ni datos personales", async () => {
  const calls = [];
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      assert.equal(init.redirect, "error");
      throw new TypeError("fixture redirect target with private values");
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-redirect-01",
      documentNumber: "5101234",
      firstSurname: "Seguro",
    }),
    (error) => {
      assert.ok(error instanceof DataCreditoError);
      assert.equal(error.code, "NETWORK_ERROR");
      assert.doesNotMatch(
        error.message,
        /fixture redirect target|fixture-password|fixture-client-secret|5101234/
      );
      return true;
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://auth-fixture.datacredito.com.co/spla/oauth2/v1/token"
  );
});

test("aplica el maximo de respuesta antes de cargar el contenido", async () => {
  let calls = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          access_token: "fixture-access-token",
          expires_in: "1800",
        });
      }

      return new Response("{}", {
        headers: { "Content-Length": "16385" },
      });
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-size-0001",
      documentNumber: "5001234",
      firstSurname: "Limite",
    }),
    (error) =>
      error instanceof DataCreditoError && error.code === "RESPONSE_TOO_LARGE"
  );
});

test("normaliza timeouts sin incluir detalles de red o credenciales", async () => {
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async () => {
      throw new DOMException("fixture internal detail", "TimeoutError");
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-timeout-01",
      documentNumber: "4001234",
      firstSurname: "Tiempo",
    }),
    (error) => {
      assert.ok(error instanceof DataCreditoError);
      assert.equal(error.code, "TIMEOUT");
      assert.doesNotMatch(error.message, /fixture internal detail|fixture-password/);
      return true;
    }
  );
});

test("normaliza una respuesta interrumpida como error tipado", async () => {
  let calls = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          access_token: "fixture-access-token",
          expires_in: "1800",
        });
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("fixture stream detail"));
          },
        })
      );
    },
    timeoutSignal: testSignal,
  });

  await assert.rejects(
    client.queryDataCreditoNaturalPerson({
      correlationId: "dc-stream-0001",
      documentNumber: "4501234",
      firstSurname: "Flujo",
    }),
    (error) => {
      assert.ok(error instanceof DataCreditoError);
      assert.equal(error.code, "NETWORK_ERROR");
      assert.doesNotMatch(error.message, /fixture stream detail/);
      return true;
    }
  );
});

test("valida cedula, apellido y correlacion antes de llamar al proveedor", async () => {
  let calls = 0;
  const client = createDataCreditoClient({
    env: baseEnv,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
    timeoutSignal: testSignal,
  });

  for (const input of [
    {
      correlationId: "dc-invalid-01",
      documentNumber: "12.34",
      firstSurname: "Apellido",
    },
    {
      correlationId: "dc-invalid-02",
      documentNumber: "3001234",
      firstSurname: "Apellido7",
    },
    {
      correlationId: "bad",
      documentNumber: "3001234",
      firstSurname: "Apellido",
    },
  ]) {
    await assert.rejects(
      client.queryDataCreditoNaturalPerson(input),
      (error) => error instanceof DataCreditoError && error.code === "VALIDATION_ERROR"
    );
  }

  assert.equal(calls, 0);
});
