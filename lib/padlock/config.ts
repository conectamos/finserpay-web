import "server-only";

import { PadlockError } from "./types";

const DEFAULT_RESPONSE_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 12_000;

export type PadlockEnvironment = "production" | "sandbox";
export type PadlockEnvironmentSource = Readonly<
  Record<string, string | undefined>
>;

export type PadlockConfig = {
  allowProduction: boolean;
  baseUrl: string;
  email: string;
  enabled: boolean;
  environment: PadlockEnvironment;
  password: string;
  responseMaxBytes: number;
  sandboxAllowedCreditIds: ReadonlySet<string>;
  sandboxAllowedDeviceIds: ReadonlySet<string>;
  tenant: string;
  timeoutMs: number;
};

export type PadlockRuntimeConfig = {
  configured: boolean;
  enabled: boolean;
  environment: PadlockEnvironment | "not-configured";
  productionAllowed: boolean;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function booleanValue(value: unknown) {
  return ["1", "on", "true", "yes"].includes(cleanText(value).toLowerCase());
}

function configurationError(message: string, correlationId?: string | null) {
  return new PadlockError({
    code: "CONFIGURATION_ERROR",
    correlationId,
    httpStatus: 503,
    message,
  });
}

function requiredValue(
  env: PadlockEnvironmentSource,
  name: string,
  correlationId?: string | null
) {
  const value = env[name];

  if (typeof value !== "string" || !value.trim()) {
    throw configurationError(
      `Padlock no esta configurado. Falta ${name}.`,
      correlationId
    );
  }

  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  options: {
    correlationId?: string | null;
    maximum: number;
    minimum: number;
    name: string;
  }
) {
  const raw = cleanText(value);

  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw configurationError(
      `${options.name} debe ser un numero entero.`,
      options.correlationId
    );
  }

  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    throw configurationError(
      `${options.name} esta fuera del rango permitido.`,
      options.correlationId
    );
  }

  return parsed;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function secureBaseUrl(
  rawValue: string,
  env: PadlockEnvironmentSource,
  environment: PadlockEnvironment,
  correlationId?: string | null
) {
  let url: URL;

  try {
    url = new URL(rawValue);
  } catch {
    throw configurationError(
      "PADLOCK_BASE_URL no es una URL valida.",
      correlationId
    );
  }

  const loopback = isLoopbackHostname(url.hostname);
  const localHttpTest =
    loopback &&
    url.protocol === "http:" &&
    environment === "sandbox" &&
    cleanText(env.NODE_ENV).toLowerCase() === "test";
  const secureRemote =
    !loopback &&
    url.protocol === "https:" &&
    (!url.port || url.port === "443");

  if (
    (!localHttpTest && !secureRemote) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw configurationError(
      "PADLOCK_BASE_URL debe ser un origen HTTPS sin credenciales, ruta, query ni fragmento. Solo se permite HTTP loopback en tests sandbox.",
      correlationId
    );
  }

  return url.origin;
}

function commaSeparatedValues(
  rawValue: string | undefined,
  options: {
    correlationId?: string | null;
    itemPattern: RegExp;
    name: string;
  }
) {
  const raw = cleanText(rawValue);
  if (!raw) {
    return new Set<string>();
  }

  const values = raw
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.some((value) => !options.itemPattern.test(value))) {
    throw configurationError(
      `${options.name} contiene un identificador invalido.`,
      options.correlationId
    );
  }

  return new Set(values);
}

function publicEnvironment(
  env: PadlockEnvironmentSource
): PadlockEnvironment | "not-configured" {
  const environment = cleanText(env.PADLOCK_ENVIRONMENT).toLowerCase();
  return environment === "sandbox" || environment === "production"
    ? environment
    : "not-configured";
}

export function isPadlockIntegrationEnabled(
  env: PadlockEnvironmentSource = process.env
) {
  return booleanValue(env.PADLOCK_INTEGRATION_ENABLED);
}

export function resolvePadlockConfig(
  env: PadlockEnvironmentSource = process.env,
  correlationId?: string | null
): PadlockConfig {
  const rawEnvironment = requiredValue(
    env,
    "PADLOCK_ENVIRONMENT",
    correlationId
  )
    .trim()
    .toLowerCase();

  if (rawEnvironment !== "sandbox" && rawEnvironment !== "production") {
    throw configurationError(
      "PADLOCK_ENVIRONMENT debe ser sandbox o production.",
      correlationId
    );
  }

  const environment: PadlockEnvironment = rawEnvironment;
  const enabled = isPadlockIntegrationEnabled(env);
  const allowProduction = booleanValue(env.PADLOCK_ALLOW_PRODUCTION);

  if (environment === "production" && !allowProduction) {
    throw new PadlockError({
      code: "PRODUCTION_NOT_ALLOWED",
      correlationId,
      httpStatus: 503,
      message:
        "La integracion Padlock de produccion requiere habilitacion explicita.",
    });
  }

  const sandboxAllowedDeviceIds = commaSeparatedValues(
    env.PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS,
    {
      correlationId,
      itemPattern: /^\d{15}$/,
      name: "PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS",
    }
  );
  const sandboxAllowedCreditIds = commaSeparatedValues(
    env.PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS,
    {
      correlationId,
      itemPattern: /^[A-Za-z0-9_-]{1,128}$/,
      name: "PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS",
    }
  );

  if (
    enabled &&
    environment === "sandbox" &&
    (sandboxAllowedDeviceIds.size === 0 ||
      sandboxAllowedCreditIds.size === 0)
  ) {
    throw configurationError(
      "Padlock sandbox habilitado requiere allowlists de dispositivos y creditos.",
      correlationId
    );
  }

  const email = requiredValue(env, "PADLOCK_EMAIL", correlationId).trim();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw configurationError("PADLOCK_EMAIL tiene un formato invalido.", correlationId);
  }

  const tenant = requiredValue(env, "PADLOCK_TENANT", correlationId).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(tenant)) {
    throw configurationError(
      "PADLOCK_TENANT tiene un formato invalido.",
      correlationId
    );
  }

  const password = requiredValue(env, "PADLOCK_PASSWORD", correlationId);
  if (password.length > 4_096) {
    throw configurationError(
      "PADLOCK_PASSWORD supera el tamano permitido.",
      correlationId
    );
  }

  return {
    allowProduction,
    baseUrl: secureBaseUrl(
      requiredValue(env, "PADLOCK_BASE_URL", correlationId),
      env,
      environment,
      correlationId
    ),
    email,
    enabled,
    environment,
    password,
    responseMaxBytes: positiveInteger(
      env.PADLOCK_RESPONSE_MAX_BYTES,
      DEFAULT_RESPONSE_MAX_BYTES,
      {
        correlationId,
        maximum: 5_242_880,
        minimum: 1_024,
        name: "PADLOCK_RESPONSE_MAX_BYTES",
      }
    ),
    sandboxAllowedCreditIds,
    sandboxAllowedDeviceIds,
    tenant,
    timeoutMs: positiveInteger(
      env.PADLOCK_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      {
        correlationId,
        maximum: 60_000,
        minimum: 1_000,
        name: "PADLOCK_TIMEOUT_MS",
      }
    ),
  };
}

export function isPadlockConfigured(
  env: PadlockEnvironmentSource = process.env
) {
  try {
    resolvePadlockConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function getPadlockRuntimeConfig(
  env: PadlockEnvironmentSource = process.env
): PadlockRuntimeConfig {
  const enabled = isPadlockIntegrationEnabled(env);
  const environment = publicEnvironment(env);
  const productionAllowed = booleanValue(env.PADLOCK_ALLOW_PRODUCTION);

  return {
    configured: isPadlockConfigured(env),
    enabled,
    environment,
    productionAllowed,
  };
}

export function assertPadlockSandboxDeviceAllowed(
  config: PadlockConfig,
  imei: string,
  correlationId?: string | null
) {
  if (
    config.environment === "sandbox" &&
    !config.sandboxAllowedDeviceIds.has(imei)
  ) {
    throw new PadlockError({
      code: "SANDBOX_DEVICE_NOT_ALLOWED",
      correlationId,
      httpStatus: 403,
      message: "El dispositivo no esta autorizado para pruebas Padlock sandbox.",
    });
  }
}

export function isPadlockSandboxCreditAllowed(
  config: PadlockConfig,
  creditId: string
) {
  return (
    config.environment !== "sandbox" ||
    config.sandboxAllowedCreditIds.has(creditId)
  );
}
