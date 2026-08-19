import { DataCreditoError } from "./errors";

const DEFAULT_QUERY_PATH = "/co/cs/midecisor/v1/client";
const DEFAULT_RESPONSE_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TOKEN_PATH = "/spla/oauth2/v1/token";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type DataCreditoConfig = {
  apiBaseUrl: string;
  authBaseUrl: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  environment: string;
  password: string;
  queryPath: string;
  responseMaxBytes: number;
  timeoutMs: number;
  tokenPath: string;
  username: string;
};

export type DataCreditoPublicConfig = {
  configured: boolean;
  enabled: boolean;
  environment: string;
  productionReady: boolean;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function booleanValue(value: unknown) {
  return ["1", "on", "true", "yes"].includes(cleanText(value).toLowerCase());
}

const DATACREDITO_PRODUCTION_HOSTNAME = "api.datacredito.com.co";

function isProductionEnvironment(value: string) {
  return ["prod", "production"].includes(cleanText(value).toLowerCase());
}

function hasExactProductionHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase() === DATACREDITO_PRODUCTION_HOSTNAME;
  } catch {
    return false;
  }
}

function isProductionReady(config: DataCreditoConfig) {
  return (
    isProductionEnvironment(config.environment) &&
    hasExactProductionHost(config.apiBaseUrl) &&
    hasExactProductionHost(config.authBaseUrl)
  );
}

export function allowsDataCreditoNonProductionProvider(
  env: EnvironmentSource = process.env
) {
  return booleanValue(env.DATACREDITO_ALLOW_NON_PRODUCTION_PROVIDER);
}

function publicEnvironment(env: EnvironmentSource) {
  const value = cleanText(env.DATACREDITO_ENVIRONMENT).toLowerCase();
  return /^[a-z0-9_-]{2,32}$/.test(value) ? value : "not-configured";
}

function configurationError(message: string, correlationId?: string | null) {
  return new DataCreditoError({
    code: "CONFIGURATION_ERROR",
    correlationId,
    httpStatus: 503,
    message,
  });
}

function requiredValue(
  env: EnvironmentSource,
  name: keyof EnvironmentSource,
  correlationId?: string | null
) {
  const value = env[name];

  if (typeof value !== "string" || !value.trim()) {
    throw configurationError(
      `DataCredito no esta configurado. Falta ${String(name)}.`,
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

function secureBaseUrl(
  rawValue: string,
  name: string,
  correlationId?: string | null
) {
  let url: URL;

  try {
    url = new URL(rawValue);
  } catch {
    throw configurationError(`${name} no es una URL valida.`, correlationId);
  }

  const hostname = url.hostname.toLowerCase();
  const isDataCreditoSubdomain =
    hostname.endsWith(".datacredito.com.co") &&
    hostname.length > ".datacredito.com.co".length;

  if (
    url.protocol !== "https:" ||
    !isDataCreditoSubdomain ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw configurationError(
      `${name} debe usar HTTPS y un subdominio oficial de datacredito.com.co.`,
      correlationId
    );
  }

  return url.origin;
}

function safePath(
  value: string | undefined,
  fallback: string,
  name: string,
  correlationId?: string | null
) {
  const path = cleanText(value) || fallback;

  if (
    path.length > 256 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(path) ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw configurationError(`${name} no es una ruta valida.`, correlationId);
  }

  return path;
}

export function isDataCreditoQueryEnabled() {
  return booleanValue(process.env.DATACREDITO_QUERY_ENABLED);
}

export function getDataCreditoPublicConfig(
  env: EnvironmentSource = process.env
): DataCreditoPublicConfig {
  const enabled = booleanValue(env.DATACREDITO_QUERY_ENABLED);
  const environment = publicEnvironment(env);

  try {
    const config = resolveDataCreditoConfig(env);
    return {
      configured: true,
      enabled,
      environment,
      productionReady: isProductionReady(config),
    };
  } catch {
    return { configured: false, enabled, environment, productionReady: false };
  }
}

export function resolveDataCreditoConfig(
  env: EnvironmentSource,
  correlationId?: string | null
): DataCreditoConfig {
  const environment = requiredValue(
    env,
    "DATACREDITO_ENVIRONMENT",
    correlationId
  )
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9_-]{2,32}$/.test(environment)) {
    throw configurationError(
      "DATACREDITO_ENVIRONMENT tiene un formato invalido.",
      correlationId
    );
  }

  return {
    apiBaseUrl: secureBaseUrl(
      requiredValue(env, "DATACREDITO_API_BASE_URL", correlationId),
      "DATACREDITO_API_BASE_URL",
      correlationId
    ),
    authBaseUrl: secureBaseUrl(
      requiredValue(env, "DATACREDITO_AUTH_BASE_URL", correlationId),
      "DATACREDITO_AUTH_BASE_URL",
      correlationId
    ),
    clientId: requiredValue(env, "DATACREDITO_CLIENT_ID", correlationId),
    clientSecret: requiredValue(
      env,
      "DATACREDITO_CLIENT_SECRET",
      correlationId
    ),
    enabled: booleanValue(env.DATACREDITO_QUERY_ENABLED),
    environment,
    password: requiredValue(env, "DATACREDITO_PASSWORD", correlationId),
    queryPath: safePath(
      env.DATACREDITO_QUERY_PATH,
      DEFAULT_QUERY_PATH,
      "DATACREDITO_QUERY_PATH",
      correlationId
    ),
    responseMaxBytes: positiveInteger(
      env.DATACREDITO_RESPONSE_MAX_BYTES,
      DEFAULT_RESPONSE_MAX_BYTES,
      {
        correlationId,
        maximum: 5_242_880,
        minimum: 16_384,
        name: "DATACREDITO_RESPONSE_MAX_BYTES",
      }
    ),
    timeoutMs: positiveInteger(
      env.DATACREDITO_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      {
        correlationId,
        maximum: 60_000,
        minimum: 1_000,
        name: "DATACREDITO_TIMEOUT_MS",
      }
    ),
    tokenPath: safePath(
      env.DATACREDITO_TOKEN_PATH,
      DEFAULT_TOKEN_PATH,
      "DATACREDITO_TOKEN_PATH",
      correlationId
    ),
    username: requiredValue(env, "DATACREDITO_USERNAME", correlationId),
  };
}
