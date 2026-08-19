import { createHash } from "node:crypto";

import {
  type DataCreditoConfig,
  resolveDataCreditoConfig,
} from "./config";
import { DataCreditoError } from "./errors";
import {
  parseDataCreditoQueryResponse,
  type DataCreditoQueryResult,
} from "./response";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type DataCreditoClientDependencies = {
  env?: EnvironmentSource;
  fetchImpl?: FetchImplementation;
  now?: () => number;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
};

export type DataCreditoNaturalPersonQuery = {
  correlationId: string;
  documentNumber: string;
  firstSurname: string;
};

export type DataCreditoNaturalPersonQueryResult = DataCreditoQueryResult & {
  providerPayload: unknown;
};

type TokenCache = {
  accessToken: string;
  expiresAt: number;
  key: string;
};

type TokenInFlight = {
  key: string;
  promise: Promise<string>;
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function joinedUrl(baseUrl: string, path: string) {
  return `${baseUrl}${path}`;
}

function cacheKey(config: DataCreditoConfig) {
  return createHash("sha256")
    .update(
      [
        config.authBaseUrl,
        config.apiBaseUrl,
        config.clientId,
        config.clientSecret,
        config.username,
        config.password,
        config.tokenPath,
        config.queryPath,
      ].join("\u0000")
    )
    .digest("hex");
}

function validateCorrelationId(value: unknown) {
  const correlationId = cleanText(value);

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(correlationId)) {
    throw new DataCreditoError({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: "El identificador de correlacion es invalido.",
    });
  }

  return correlationId;
}

function validateQueryInput(
  input: DataCreditoNaturalPersonQuery,
  correlationId: string
) {
  const documentNumber = cleanText(input.documentNumber);
  const firstSurname = cleanText(input.firstSurname);

  if (!/^\d{3,13}$/.test(documentNumber)) {
    throw new DataCreditoError({
      code: "VALIDATION_ERROR",
      correlationId,
      httpStatus: 400,
      message: "El numero de cedula es invalido.",
    });
  }

  if (
    firstSurname.length > 120 ||
    !/^[\p{L}\s]+$/u.test(firstSurname)
  ) {
    throw new DataCreditoError({
      code: "VALIDATION_ERROR",
      correlationId,
      httpStatus: 400,
      message: "El primer apellido es invalido.",
    });
  }

  return { documentNumber, firstSurname };
}

async function cancelResponse(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; cancellation failures are safe to ignore.
  }
}

async function responseJsonWithinLimit(
  response: Response,
  maximumBytes: number,
  correlationId: string
) {
  const announcedLength = Number(response.headers.get("content-length"));

  if (
    Number.isFinite(announcedLength) &&
    announcedLength > maximumBytes
  ) {
    await cancelResponse(response);
    throw new DataCreditoError({
      code: "RESPONSE_TOO_LARGE",
      correlationId,
      httpStatus: 502,
      message: "DataCredito entrego una respuesta demasiado grande.",
      providerHttpStatus: response.status,
    });
  }

  if (!response.body) {
    throw new DataCreditoError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "DataCredito entrego una respuesta vacia.",
      providerHttpStatus: response.status,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await reader.read();
      } catch {
        throw new DataCreditoError({
          code: "NETWORK_ERROR",
          correlationId,
          httpStatus: 502,
          message: "La respuesta de DataCredito se interrumpio.",
          providerHttpStatus: response.status,
          retryable: true,
        });
      }

      const { done, value } = chunk;
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is the relevant error even if cancellation fails.
        }
        throw new DataCreditoError({
          code: "RESPONSE_TOO_LARGE",
          correlationId,
          httpStatus: 502,
          message: "DataCredito entrego una respuesta demasiado grande.",
          providerHttpStatus: response.status,
        });
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DataCreditoError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "DataCredito entrego una respuesta JSON invalida.",
      providerHttpStatus: response.status,
    });
  }
}

function providerHttpError(response: Response, correlationId: string) {
  if (response.status === 401 || response.status === 403) {
    return new DataCreditoError({
      code: "AUTHENTICATION_FAILED",
      correlationId,
      httpStatus: 503,
      message: "No fue posible autenticar la integracion con DataCredito.",
      providerHttpStatus: response.status,
    });
  }

  if (response.status === 429) {
    return new DataCreditoError({
      code: "PROVIDER_RATE_LIMITED",
      correlationId,
      httpStatus: 503,
      message: "DataCredito limito temporalmente las consultas.",
      providerHttpStatus: response.status,
      retryable: true,
    });
  }

  if (response.status >= 500) {
    return new DataCreditoError({
      code: "PROVIDER_UNAVAILABLE",
      correlationId,
      httpStatus: 503,
      message: "DataCredito no esta disponible temporalmente.",
      providerHttpStatus: response.status,
      retryable: true,
    });
  }

  return new DataCreditoError({
    code: "PROVIDER_ERROR",
    correlationId,
    httpStatus: 502,
    message: "DataCredito rechazo la solicitud de consulta.",
    providerHttpStatus: response.status,
  });
}

function requestError(error: unknown, correlationId: string) {
  if (error instanceof DataCreditoError) {
    return error;
  }

  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";

  if (name === "AbortError" || name === "TimeoutError") {
    return new DataCreditoError({
      code: "TIMEOUT",
      correlationId,
      httpStatus: 504,
      message: "DataCredito no respondio dentro del tiempo permitido.",
      retryable: true,
    });
  }

  return new DataCreditoError({
    code: "NETWORK_ERROR",
    correlationId,
    httpStatus: 502,
    message: "No fue posible conectar con DataCredito.",
    retryable: true,
  });
}

export function createDataCreditoClient(
  dependencies: DataCreditoClientDependencies = {}
) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutSignal =
    dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  let cachedToken: TokenCache | null = null;
  let tokenInFlight: TokenInFlight | null = null;

  async function performFetch(
    url: string,
    init: RequestInit,
    config: DataCreditoConfig,
    correlationId: string
  ) {
    try {
      return await fetchImpl(url, {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: timeoutSignal(config.timeoutMs),
      });
    } catch (error) {
      throw requestError(error, correlationId);
    }
  }

  async function requestToken(
    config: DataCreditoConfig,
    key: string,
    correlationId: string
  ) {
    const response = await performFetch(
      joinedUrl(config.authBaseUrl, config.tokenPath),
      {
        body: JSON.stringify({
          password: config.password,
          username: config.username,
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          client_id: config.clientId,
          client_secret: config.clientSecret,
        },
        method: "POST",
      },
      config,
      correlationId
    );

    if (!response.ok) {
      await cancelResponse(response);
      throw providerHttpError(response, correlationId);
    }

    const payload = await responseJsonWithinLimit(
      response,
      config.responseMaxBytes,
      correlationId
    );
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const accessToken = cleanText(record?.access_token);
    const expiresInRaw = cleanText(record?.expires_in);
    const parsedExpiresIn = /^\d+$/.test(expiresInRaw)
      ? Number(expiresInRaw)
      : 60;
    const expiresInSeconds =
      Number.isSafeInteger(parsedExpiresIn) &&
      parsedExpiresIn > 0 &&
      parsedExpiresIn <= 86_400
        ? parsedExpiresIn
        : 60;

    if (!accessToken || accessToken.length > 16_384) {
      throw new DataCreditoError({
        code: "INVALID_RESPONSE",
        correlationId,
        httpStatus: 502,
        message: "DataCredito no entrego un token valido.",
        providerHttpStatus: response.status,
      });
    }

    const lifetimeMs = expiresInSeconds * 1_000;
    const safetyMarginMs = Math.min(
      60_000,
      Math.max(1_000, Math.floor(lifetimeMs * 0.1))
    );
    cachedToken = {
      accessToken,
      expiresAt: now() + Math.max(0, lifetimeMs - safetyMarginMs),
      key,
    };

    return accessToken;
  }

  async function accessToken(
    config: DataCreditoConfig,
    correlationId: string
  ) {
    const key = cacheKey(config);

    if (
      cachedToken?.key === key &&
      cachedToken.expiresAt > now()
    ) {
      return cachedToken.accessToken;
    }

    if (tokenInFlight?.key === key) {
      return tokenInFlight.promise;
    }

    const promise = requestToken(config, key, correlationId);
    tokenInFlight = { key, promise };

    try {
      return await promise;
    } finally {
      if (tokenInFlight?.promise === promise) {
        tokenInFlight = null;
      }
    }
  }

  function invalidateToken(config: DataCreditoConfig, usedToken: string) {
    const key = cacheKey(config);
    if (
      cachedToken?.key === key &&
      cachedToken.accessToken === usedToken
    ) {
      cachedToken = null;
    }
  }

  async function providerQuery(
    config: DataCreditoConfig,
    token: string,
    input: { documentNumber: string; firstSurname: string },
    correlationId: string
  ) {
    return performFetch(
      joinedUrl(config.apiBaseUrl, config.queryPath),
      {
        body: JSON.stringify({
          apellidoRazonSocial: input.firstSurname,
          numeroIdentificacion: input.documentNumber,
          tipoIdentificacion: "1",
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      config,
      correlationId
    );
  }

  async function queryDataCreditoNaturalPerson(
    rawInput: DataCreditoNaturalPersonQuery
  ): Promise<DataCreditoNaturalPersonQueryResult> {
    const correlationId = validateCorrelationId(rawInput?.correlationId);
    const config = resolveDataCreditoConfig(env, correlationId);

    if (!config.enabled) {
      throw new DataCreditoError({
        code: "FEATURE_DISABLED",
        correlationId,
        httpStatus: 503,
        message: "Las consultas de DataCredito no estan habilitadas.",
      });
    }

    const input = validateQueryInput(rawInput, correlationId);
    let token = await accessToken(config, correlationId);
    const startedAt = now();
    let response = await providerQuery(
      config,
      token,
      input,
      correlationId
    );

    if (response.status === 401) {
      await cancelResponse(response);
      invalidateToken(config, token);
      token = await accessToken(config, correlationId);
      response = await providerQuery(
        config,
        token,
        input,
        correlationId
      );
    }

    if (!response.ok) {
      await cancelResponse(response);
      throw providerHttpError(response, correlationId);
    }

    const payload = await responseJsonWithinLimit(
      response,
      config.responseMaxBytes,
      correlationId
    );
    return {
      ...parseDataCreditoQueryResponse(payload, now() - startedAt),
      providerPayload: payload,
    };
  }

  return { queryDataCreditoNaturalPerson };
}

const defaultClient = createDataCreditoClient();

export async function queryDataCreditoNaturalPerson(
  input: DataCreditoNaturalPersonQuery
) {
  return defaultClient.queryDataCreditoNaturalPerson(input);
}

export { DataCreditoError } from "./errors";
export {
  getDataCreditoPublicConfig,
  isDataCreditoQueryEnabled,
} from "./config";
