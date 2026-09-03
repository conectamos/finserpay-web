import "server-only";

import { createHash } from "node:crypto";

import {
  assertPadlockSandboxDeviceAllowed,
  isPadlockIntegrationEnabled,
  type PadlockConfig,
  type PadlockEnvironmentSource,
  resolvePadlockConfig,
} from "./config";
import {
  PADLOCK_DEVICE_STATUSES,
  type PadlockCommandAction,
  type PadlockCommandResult,
  type PadlockDevice,
  type PadlockDeviceList,
  type PadlockDeviceStatus,
  PadlockError,
  type PadlockListDevicesInput,
  type PadlockRequestOptions,
} from "./types";

const LOGIN_PATH = "/api/v1/auth/login";
const DEVICES_PATH = "/api/v1/enterprise/devices";
const LOCK_PATH = "/api/v1/devices/lock";
const UNLOCK_PATH = "/api/v1/devices/unlock";
const MAX_DEVICE_PAGE_SIZE = 100;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_TOKEN_LIFETIME_SECONDS = 31_536_000;

export type PadlockFetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type PadlockClientDependencies = {
  env?: PadlockEnvironmentSource;
  fetchImpl?: PadlockFetchImplementation;
  now?: () => number;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
};

type TokenCache = {
  expiresAt: number;
  key: string;
  token: string;
};

type TokenInFlight = {
  key: string;
  promise: Promise<string>;
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerString(value: unknown, maximumLength = 256) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maximumLength);
}

function joinedUrl(baseUrl: string, path: string) {
  return `${baseUrl}${path}`;
}

function validateCorrelationId(value: unknown) {
  if (value === undefined || value === null || cleanText(value) === "") {
    return null;
  }

  const correlationId = cleanText(value);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(correlationId)) {
    throw new PadlockError({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: "El identificador de correlacion Padlock es invalido.",
    });
  }

  return correlationId;
}

function validateImei(value: unknown, correlationId?: string | null) {
  const imei = cleanText(value);
  if (!/^\d{15}$/.test(imei)) {
    throw new PadlockError({
      code: "VALIDATION_ERROR",
      correlationId,
      httpStatus: 400,
      message: "El IMEI para Padlock debe contener exactamente 15 digitos.",
    });
  }

  return imei;
}

function cacheKey(config: PadlockConfig) {
  return createHash("sha256")
    .update(
      [
        config.baseUrl,
        config.email,
        config.password,
        config.tenant,
      ].join("\u0000")
    )
    .digest("hex");
}

async function cancelResponse(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded; cancellation errors are not actionable.
  }
}

async function responseJsonWithinLimit(
  response: Response,
  maximumBytes: number,
  correlationId?: string | null
) {
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > maximumBytes) {
    await cancelResponse(response);
    throw new PadlockError({
      code: "RESPONSE_TOO_LARGE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego una respuesta demasiado grande.",
      providerHttpStatus: response.status,
    });
  }

  if (!response.body) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego una respuesta vacia.",
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
        throw new PadlockError({
          code: "NETWORK_ERROR",
          correlationId,
          httpStatus: 502,
          message: "La respuesta de Padlock se interrumpio.",
          providerHttpStatus: response.status,
          retryable: true,
        });
      }

      if (chunk.done) {
        break;
      }

      if (!chunk.value) {
        continue;
      }

      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains the relevant failure.
        }

        throw new PadlockError({
          code: "RESPONSE_TOO_LARGE",
          correlationId,
          httpStatus: 502,
          message: "Padlock entrego una respuesta demasiado grande.",
          providerHttpStatus: response.status,
        });
      }

      chunks.push(chunk.value);
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
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego una respuesta JSON invalida.",
      providerHttpStatus: response.status,
    });
  }
}

function providerHttpError(
  response: Response,
  correlationId?: string | null
) {
  if (response.status === 401 || response.status === 403) {
    return new PadlockError({
      code: "AUTHENTICATION_FAILED",
      correlationId,
      httpStatus: 503,
      message: "No fue posible autenticar la integracion con Padlock.",
      providerHttpStatus: response.status,
    });
  }

  if (response.status === 429) {
    return new PadlockError({
      code: "PROVIDER_RATE_LIMITED",
      correlationId,
      httpStatus: 503,
      message: "Padlock limito temporalmente las solicitudes.",
      providerHttpStatus: response.status,
      retryable: true,
    });
  }

  if (response.status >= 500) {
    return new PadlockError({
      code: "PROVIDER_UNAVAILABLE",
      correlationId,
      httpStatus: 503,
      message: "Padlock no esta disponible temporalmente.",
      providerHttpStatus: response.status,
      retryable: true,
    });
  }

  return new PadlockError({
    code: "PROVIDER_ERROR",
    correlationId,
    httpStatus: 502,
    message: "Padlock rechazo la solicitud.",
    providerHttpStatus: response.status,
  });
}

function requestError(error: unknown, correlationId?: string | null) {
  if (error instanceof PadlockError) {
    return error;
  }

  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";

  if (name === "AbortError" || name === "TimeoutError") {
    return new PadlockError({
      code: "TIMEOUT",
      correlationId,
      httpStatus: 504,
      message: "Padlock no respondio dentro del tiempo permitido.",
      retryable: true,
    });
  }

  return new PadlockError({
    code: "NETWORK_ERROR",
    correlationId,
    httpStatus: 502,
    message: "No fue posible conectar con Padlock.",
    retryable: true,
  });
}

function knownStatus(value: unknown): PadlockDeviceStatus {
  const status = providerString(value, 64)?.toLowerCase();
  return status &&
    (PADLOCK_DEVICE_STATUSES as readonly string[]).includes(status)
    ? (status as PadlockDeviceStatus)
    : "unknown";
}

function normalizedDevice(
  value: unknown,
  correlationId?: string | null,
  providerHttpStatus?: number
): PadlockDevice {
  const record = recordValue(value);
  if (!record) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego un dispositivo con formato invalido.",
      providerHttpStatus,
    });
  }

  return {
    brand: providerString(record.brand, 160),
    createdAt: providerString(record.created_at, 64),
    identifier: providerString(record.identifier),
    key1: providerString(record.key1),
    key2: providerString(record.key2),
    model: providerString(record.model, 160),
    serial: providerString(record.serial),
    status: knownStatus(record.status),
    transitionStartedAt: providerString(record.transition_started_at, 64),
    updatedAt: providerString(record.updated_at, 64),
  };
}

function responseInteger(
  value: unknown,
  options: {
    correlationId?: string | null;
    maximum?: number;
    minimum: number;
    name: string;
    providerHttpStatus: number;
  }
) {
  const raw =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;

  if (
    !Number.isSafeInteger(raw) ||
    raw < options.minimum ||
    (options.maximum !== undefined && raw > options.maximum)
  ) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId: options.correlationId,
      httpStatus: 502,
      message: `Padlock entrego ${options.name} con formato invalido.`,
      providerHttpStatus: options.providerHttpStatus,
    });
  }

  return raw;
}

function normalizedDeviceList(
  payload: unknown,
  correlationId: string | null,
  providerHttpStatus: number
): PadlockDeviceList {
  const record = recordValue(payload);
  if (!record || !Array.isArray(record.items)) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego un listado de dispositivos invalido.",
      providerHttpStatus,
    });
  }

  if (record.items.length > MAX_DEVICE_PAGE_SIZE) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock excedio el tamano maximo de pagina documentado.",
      providerHttpStatus,
    });
  }

  return {
    items: record.items.map((item) =>
      normalizedDevice(item, correlationId, providerHttpStatus)
    ),
    limit: responseInteger(record.limit, {
      correlationId,
      maximum: MAX_DEVICE_PAGE_SIZE,
      minimum: 1,
      name: "limit",
      providerHttpStatus,
    }),
    page: responseInteger(record.page, {
      correlationId,
      minimum: 1,
      name: "page",
      providerHttpStatus,
    }),
    total: responseInteger(record.total, {
      correlationId,
      minimum: 0,
      name: "total",
      providerHttpStatus,
    }),
    totalPages: responseInteger(record.totalPages, {
      correlationId,
      minimum: 0,
      name: "totalPages",
      providerHttpStatus,
    }),
  };
}

function sanitizedProviderMessage(
  value: unknown,
  sensitiveValues: readonly string[]
) {
  if (typeof value !== "string") {
    return null;
  }

  let message = value;
  for (const sensitiveValue of [...sensitiveValues].sort(
    (left, right) => right.length - left.length
  )) {
    if (sensitiveValue) {
      message = message.split(sensitiveValue).join("[redacted]");
    }
  }

  message = message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b\d{12,19}\b/g, "[redacted-device]");

  const normalized = cleanText(message);
  return normalized ? normalized.slice(0, 240) : null;
}

function actionCompatibleStatus(
  action: PadlockCommandAction,
  status: PadlockDeviceStatus
) {
  return action === "LOCK"
    ? status === "locking" || status === "locked"
    : status === "unlocking" || status === "unlocked";
}

function normalizedCommandResult(
  payload: unknown,
  options: {
    action: PadlockCommandAction;
    config: PadlockConfig;
    correlationId: string | null;
    imei: string;
    providerHttpStatus: number;
    token: string | null;
  }
): PadlockCommandResult {
  const record = recordValue(payload);
  if (!record || !Array.isArray(record.results)) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId: options.correlationId,
      httpStatus: 502,
      message: "Padlock entrego un resultado de comando invalido.",
      providerHttpStatus: options.providerHttpStatus,
    });
  }

  const exactResults = record.results.filter((item) => {
    const result = recordValue(item);
    return providerString(result?.device) === options.imei;
  });

  // FINSER PAY deliberately sends one IMEI per request. Extra result rows are
  // therefore a provider-contract contradiction, even if exactly one row
  // happens to match the requested IMEI.
  if (record.results.length !== 1 || exactResults.length !== 1) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId: options.correlationId,
      httpStatus: 502,
      message: "Padlock no correlaciono de forma unica el comando solicitado.",
      providerHttpStatus: options.providerHttpStatus,
    });
  }

  const result = recordValue(exactResults[0])!;
  const status = knownStatus(result.status);
  const providerSuccess = result.success === true;
  const success =
    providerSuccess && actionCompatibleStatus(options.action, status);
  const message = sanitizedProviderMessage(result.message, [
    options.imei,
    options.config.email,
    options.config.password,
    options.config.tenant,
    options.token ?? "",
  ]);

  return {
    action: options.action,
    brand: providerString(result.brand, 160),
    message:
      message ??
      (success
        ? "Padlock acepto la solicitud."
        : "Padlock no confirmo la solicitud para el dispositivo."),
    model: providerString(result.model, 160),
    requestedDevice: options.imei,
    status,
    success,
  };
}

function deviceIdentifiers(device: PadlockDevice) {
  return [device.key1, device.key2, device.identifier, device.serial].filter(
    (value): value is string => Boolean(value)
  );
}

function validateListInput(rawInput: PadlockListDevicesInput | undefined) {
  const input = rawInput ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PadlockError({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: "Los filtros del listado Padlock son invalidos.",
    });
  }

  const correlationId = validateCorrelationId(input.correlationId);
  const page = input.page ?? 1;
  const limit = input.limit ?? MAX_DEVICE_PAGE_SIZE;

  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    throw new PadlockError({
      code: "VALIDATION_ERROR",
      correlationId,
      httpStatus: 400,
      message: "La pagina solicitada a Padlock es invalida.",
    });
  }

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DEVICE_PAGE_SIZE
  ) {
    throw new PadlockError({
      code: "VALIDATION_ERROR",
      correlationId,
      httpStatus: 400,
      message: "El limite solicitado a Padlock debe estar entre 1 y 100.",
    });
  }

  let search: string | null = null;
  if (input.search !== undefined) {
    search = cleanText(input.search);
    if (
      !search ||
      search.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(search)
    ) {
      throw new PadlockError({
        code: "VALIDATION_ERROR",
        correlationId,
        httpStatus: 400,
        message: "La busqueda solicitada a Padlock es invalida.",
      });
    }
  }

  return { correlationId, limit, page, search };
}

function tokenLifetimeSeconds(
  value: unknown,
  correlationId: string | null,
  providerHttpStatus: number
) {
  let raw = Number.NaN;

  if (typeof value === "number" && Number.isInteger(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
      raw = Number(normalized);
    } else {
      const duration = /^([1-9]\d*)([smhd])$/.exec(normalized);
      if (duration) {
        const amount = Number(duration[1]);
        const multiplier = {
          d: 86_400,
          h: 3_600,
          m: 60,
          s: 1,
        }[duration[2]]!;
        raw = amount * multiplier;
      }
    }
  }

  if (
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new PadlockError({
      code: "INVALID_RESPONSE",
      correlationId,
      httpStatus: 502,
      message: "Padlock entrego una vigencia de token invalida.",
      providerHttpStatus,
    });
  }

  return raw;
}

export function createPadlockClient(
  dependencies: PadlockClientDependencies = {}
) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutSignal =
    dependencies.timeoutSignal ??
    ((milliseconds: number) => AbortSignal.timeout(milliseconds));
  let cachedToken: TokenCache | null = null;
  let tokenInFlight: TokenInFlight | null = null;

  function activeConfig(correlationId: string | null) {
    if (!isPadlockIntegrationEnabled(env)) {
      throw new PadlockError({
        code: "FEATURE_DISABLED",
        correlationId,
        httpStatus: 503,
        message: "La integracion con Padlock no esta habilitada.",
      });
    }

    return resolvePadlockConfig(env, correlationId);
  }

  async function performFetch(
    url: string,
    init: RequestInit,
    config: PadlockConfig,
    correlationId: string | null
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
    config: PadlockConfig,
    key: string,
    correlationId: string | null
  ) {
    const response = await performFetch(
      joinedUrl(config.baseUrl, LOGIN_PATH),
      {
        body: JSON.stringify({
          email: config.email,
          password: config.password,
          tenant: config.tenant,
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
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
    const record = recordValue(payload);
    const token = providerString(record?.token, MAX_TOKEN_LENGTH + 1);
    const expiresInSeconds = tokenLifetimeSeconds(
      record?.expires_in,
      correlationId,
      response.status
    );

    if (!token || token.length > MAX_TOKEN_LENGTH) {
      throw new PadlockError({
        code: "INVALID_RESPONSE",
        correlationId,
        httpStatus: 502,
        message: "Padlock no entrego un token valido.",
        providerHttpStatus: response.status,
      });
    }

    const lifetimeMs = expiresInSeconds * 1_000;
    const safetyMarginMs = Math.min(
      60_000,
      Math.max(1_000, Math.floor(lifetimeMs * 0.1))
    );
    cachedToken = {
      expiresAt: now() + Math.max(0, lifetimeMs - safetyMarginMs),
      key,
      token,
    };

    return token;
  }

  async function accessToken(
    config: PadlockConfig,
    correlationId: string | null
  ) {
    const key = cacheKey(config);
    if (cachedToken?.key === key && cachedToken.expiresAt > now()) {
      return cachedToken.token;
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

  function invalidateToken(config: PadlockConfig, usedToken: string) {
    const key = cacheKey(config);
    if (
      cachedToken?.key === key &&
      cachedToken.token === usedToken
    ) {
      cachedToken = null;
    }
  }

  async function authenticatedFetch(
    config: PadlockConfig,
    correlationId: string | null,
    request: (token: string) => Promise<Response>
  ) {
    let token = await accessToken(config, correlationId);
    let response = await request(token);

    if (response.status === 401) {
      await cancelResponse(response);
      invalidateToken(config, token);
      token = await accessToken(config, correlationId);
      response = await request(token);
    }

    return { response, token };
  }

  async function listDevices(
    rawInput: PadlockListDevicesInput = {}
  ): Promise<PadlockDeviceList> {
    const input = validateListInput(rawInput);
    const config = activeConfig(input.correlationId);
    const url = new URL(DEVICES_PATH, config.baseUrl);
    url.searchParams.set("page", String(input.page));
    url.searchParams.set("limit", String(input.limit));
    if (input.search) {
      url.searchParams.set("search", input.search);
      url.searchParams.set(
        "searchFields",
        "key1,key2,identifier,serial"
      );
    }

    const { response } = await authenticatedFetch(
      config,
      input.correlationId,
      (token) =>
        performFetch(
          url.toString(),
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            method: "GET",
          },
          config,
          input.correlationId
        )
    );

    if (!response.ok) {
      await cancelResponse(response);
      throw providerHttpError(response, input.correlationId);
    }

    return normalizedDeviceList(
      await responseJsonWithinLimit(
        response,
        config.responseMaxBytes,
        input.correlationId
      ),
      input.correlationId,
      response.status
    );
  }

  async function queryDeviceByImei(
    rawImei: string,
    options: PadlockRequestOptions = {}
  ): Promise<PadlockDevice | null> {
    const correlationId = validateCorrelationId(options?.correlationId);
    const imei = validateImei(rawImei, correlationId);
    const config = activeConfig(correlationId);
    assertPadlockSandboxDeviceAllowed(config, imei, correlationId);

    const result = await listDevices({
      correlationId,
      limit: MAX_DEVICE_PAGE_SIZE,
      page: 1,
      search: imei,
    });

    if (result.totalPages > 1 || result.total > result.items.length) {
      throw new PadlockError({
        code: "AMBIGUOUS_DEVICE",
        correlationId,
        httpStatus: 409,
        message:
          "Padlock devolvio una busqueda paginada que no permite probar unicidad del IMEI.",
      });
    }

    const matches = result.items.filter((device) =>
      deviceIdentifiers(device).includes(imei)
    );

    if (matches.length > 1) {
      throw new PadlockError({
        code: "AMBIGUOUS_DEVICE",
        correlationId,
        httpStatus: 409,
        message: "Padlock devolvio mas de un dispositivo para el IMEI.",
      });
    }

    return matches[0] ?? null;
  }

  async function executeDeviceCommand(
    action: PadlockCommandAction,
    rawImei: string,
    options: PadlockRequestOptions = {}
  ): Promise<PadlockCommandResult> {
    const correlationId = validateCorrelationId(options?.correlationId);
    const imei = validateImei(rawImei, correlationId);
    const config = activeConfig(correlationId);
    assertPadlockSandboxDeviceAllowed(config, imei, correlationId);
    const path = action === "LOCK" ? LOCK_PATH : UNLOCK_PATH;
    const { response, token } = await authenticatedFetch(
      config,
      correlationId,
      (accessTokenValue) =>
        performFetch(
          joinedUrl(config.baseUrl, path),
          {
            body: JSON.stringify({ devices: [imei] }),
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessTokenValue}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          },
          config,
          correlationId
        )
    );

    if (!response.ok) {
      await cancelResponse(response);
      throw providerHttpError(response, correlationId);
    }

    return normalizedCommandResult(
      await responseJsonWithinLimit(
        response,
        config.responseMaxBytes,
        correlationId
      ),
      {
        action,
        config,
        correlationId,
        imei,
        providerHttpStatus: response.status,
        token,
      }
    );
  }

  return {
    listDevices,
    lockDevice: (imei: string, options?: PadlockRequestOptions) =>
      executeDeviceCommand("LOCK", imei, options),
    queryDeviceByImei,
    unlockDevice: (imei: string, options?: PadlockRequestOptions) =>
      executeDeviceCommand("UNLOCK", imei, options),
  };
}

const defaultClient = createPadlockClient();

export async function listPadlockDevices(input: PadlockListDevicesInput = {}) {
  return defaultClient.listDevices(input);
}

export async function queryPadlockDeviceByImei(
  imei: string,
  options?: PadlockRequestOptions
) {
  return defaultClient.queryDeviceByImei(imei, options);
}

export async function lockPadlockDevice(
  imei: string,
  options?: PadlockRequestOptions
) {
  return defaultClient.lockDevice(imei, options);
}

export async function unlockPadlockDevice(
  imei: string,
  options?: PadlockRequestOptions
) {
  return defaultClient.unlockDevice(imei, options);
}

export { PadlockError } from "./types";
export {
  getPadlockRuntimeConfig,
  isPadlockConfigured,
  isPadlockIntegrationEnabled,
} from "./config";
