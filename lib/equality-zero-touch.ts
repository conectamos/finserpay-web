const DEFAULT_EQUALITY_BASE_URL = "https://hbm-api.solucionfaas.com/v1/hbm";
const DEFAULT_EQUALITY_VARIANT = "A";
const DEFAULT_TRUSTONIC_BASE_URL = "https://api.cloud.trustonic.com";
const TRUSTONIC_TOKEN_TTL_FALLBACK_MS = 50 * 60 * 1000;
const TRUSTONIC_TOKEN_REFRESH_SKEW_MS = 60 * 1000;

export type EqualityServiceCode =
  | "DEVICE_PIN_UNLOCK"
  | "DEVICE_LOCK"
  | "DEVICE_LOCK_MESSAGE"
  | "DEVICE_NOTIFY"
  | "DEVICE_RELEASE"
  | "INVENTORY_UPLOAD"
  | "DEVICE_UNLOCK"
  | "QUERY_DEVICES"
  | "SERVICE_ACTIVATE"
  | "WEBHOOK_CREATE"
  | "WEBHOOK_DELETE"
  | "WEBHOOK_GET_ALL";

export type EqualityServicePayload = {
  service?: {
    code?: string | null;
    parameters?: Record<string, unknown>;
    variant?: string | null;
  };
  statusCode?: number | null;
  message?: string | null;
  dataResponse?: {
    resultCode?: string | null;
    resultMessage?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

class EqualityApiError extends Error {
  payload: unknown;
  status: number;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "EqualityApiError";
    this.status = status;
    this.payload = payload;
  }
}

type TrustonicTokenCache = {
  expiresAt: number;
  token: string;
};

let trustonicTokenCache: TrustonicTokenCache | null = null;

function getLegacyEqualityTokenValue() {
  return String(
    process.env.EQUALITY_HBM_ACCESS_TOKEN ||
      process.env.EQUALITY_ZERO_TOUCH_TOKEN ||
      process.env.EQUALITY_API_TOKEN ||
      ""
  ).trim();
}

function getEqualityConfiguredToken() {
  const rawToken = getLegacyEqualityTokenValue();

  if (!rawToken) {
    throw new Error("EQUALITY_HBM_ACCESS_TOKEN no esta configurado");
  }

  if (rawToken.startsWith("Bearer ")) {
    return rawToken;
  }

  return `Bearer ${rawToken}`;
}

function getTrustonicApiKeyValue() {
  return String(process.env.TRUSTONIC_API_KEY || "").trim();
}

function getTrustonicApiKey() {
  const apiKey = getTrustonicApiKeyValue();

  if (!apiKey) {
    throw new Error("TRUSTONIC_API_KEY no esta configurado");
  }

  return apiKey;
}

function getTrustonicTenantId() {
  return String(
    process.env.TRUSTONIC_TENANT_ID ||
      process.env.TRUSTONIC_TENANT ||
      process.env.TRUSTONIC_TENANTID ||
      ""
  ).trim();
}

function getTrustonicBaseUrl() {
  return String(process.env.TRUSTONIC_BASE_URL || DEFAULT_TRUSTONIC_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
}

export function isTrustonicDirectConfigured() {
  return Boolean(getTrustonicApiKeyValue());
}

export function isEqualityConfigured() {
  return isTrustonicDirectConfigured() || Boolean(getLegacyEqualityTokenValue());
}

export function getEqualityBaseUrl() {
  if (isTrustonicDirectConfigured()) {
    return getTrustonicBaseUrl();
  }

  const value = String(
    process.env.EQUALITY_HBM_BASE_URL || DEFAULT_EQUALITY_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");

  if (value.endsWith("/v1/hbm")) {
    return value;
  }

  return `${value}/v1/hbm`;
}

export function getEqualityDefaultVariant() {
  return String(
    process.env.EQUALITY_HBM_VARIANT || DEFAULT_EQUALITY_VARIANT
  ).trim() || DEFAULT_EQUALITY_VARIANT;
}

export function getEqualityProbeDeviceUid() {
  return String(
    process.env.EQUALITY_HBM_PROBE_DEVICE_UID ||
      process.env.EQUALITY_PROBE_DEVICE_UID ||
      "866000000000000"
  ).trim();
}

export function normalizeEqualityDeviceUid(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function getEqualityMessage(payload: unknown, fallbackStatus: number) {
  if (typeof payload !== "object" || payload === null) {
    return `Equality Zero Touch respondio con estado ${fallbackStatus}`;
  }

  const record = payload as Record<string, unknown>;
  const dataResponse =
    typeof record.dataResponse === "object" && record.dataResponse !== null
      ? (record.dataResponse as Record<string, unknown>)
      : null;

  if (typeof dataResponse?.resultMessage === "string" && dataResponse.resultMessage) {
    return dataResponse.resultMessage;
  }

  if (typeof record.message === "string" && record.message) {
    return record.message;
  }

  return `Equality Zero Touch respondio con estado ${fallbackStatus}`;
}

function getTrustonicResultFromList(record: Record<string, unknown>) {
  const listKeys = [
    "deviceList",
    "lockResponseList",
    "unlockResponseList",
    "releaseResponseList",
    "messageResponseList",
    "lockMessageResponseList",
    "pinUnlockResponseList",
  ];

  for (const key of listKeys) {
    const value = record[key];
    const first =
      Array.isArray(value) && value.length > 0 && typeof value[0] === "object"
        ? (value[0] as Record<string, unknown>)
        : null;

    if (!first) {
      continue;
    }

    if (Array.isArray(first.serviceList) && first.serviceList.length > 0) {
      const service = first.serviceList.find(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      );

      if (service) {
        return service;
      }
    }

    return first;
  }

  return null;
}

function getTrustonicMessage(payload: unknown, fallbackStatus: number) {
  if (typeof payload !== "object" || payload === null) {
    return `Trustonic respondio con estado ${fallbackStatus}`;
  }

  const record = payload as Record<string, unknown>;
  const result = getTrustonicResultFromList(record);

  if (typeof record.resultMessage === "string" && record.resultMessage) {
    return record.resultMessage;
  }

  if (typeof record.message === "string" && record.message) {
    return record.message;
  }

  if (typeof result?.resultMessage === "string" && result.resultMessage) {
    return result.resultMessage;
  }

  return `Trustonic respondio con estado ${fallbackStatus}`;
}

function parseTrustonicExpireTime(expireTime: unknown) {
  if (typeof expireTime === "string" && expireTime.trim()) {
    const parsed = Date.parse(expireTime);

    if (Number.isFinite(parsed)) {
      return Math.max(parsed - TRUSTONIC_TOKEN_REFRESH_SKEW_MS, Date.now());
    }
  }

  return Date.now() + TRUSTONIC_TOKEN_TTL_FALLBACK_MS;
}

async function getTrustonicAccessToken() {
  if (trustonicTokenCache && trustonicTokenCache.expiresAt > Date.now()) {
    return trustonicTokenCache.token;
  }

  const response = await fetch(`${getTrustonicBaseUrl()}/api/v1/authorization/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apiKey: getTrustonicApiKey(),
    },
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new EqualityApiError(
      getTrustonicMessage(parsed, response.status),
      response.status,
      parsed
    );
  }

  const token =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).token === "string"
      ? String((parsed as Record<string, unknown>).token).replace(/^Bearer\s+/i, "")
      : "";

  if (!token) {
    throw new EqualityApiError(
      "Trustonic no devolvio token de acceso",
      response.status,
      parsed
    );
  }

  trustonicTokenCache = {
    expiresAt:
      typeof parsed === "object" && parsed !== null
        ? parseTrustonicExpireTime((parsed as Record<string, unknown>).expireTime)
        : Date.now() + TRUSTONIC_TOKEN_TTL_FALLBACK_MS,
    token,
  };

  return token;
}

async function executeTrustonicRequest(
  path: string,
  options: {
    body?: Record<string, unknown>;
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  } = {}
) {
  const token = await getTrustonicAccessToken();
  const tenantId = getTrustonicTenantId();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  if (tenantId) {
    headers.tenantId = tenantId;
  }

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${getTrustonicBaseUrl()}${path}`, {
    method: options.method || "POST",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new EqualityApiError(
      getTrustonicMessage(parsed, response.status),
      response.status,
      parsed
    );
  }

  return parsed as EqualityServicePayload;
}

export async function executeEqualityService(
  code: EqualityServiceCode,
  data: Record<string, unknown>,
  options?: {
    parameters?: Record<string, unknown>;
    variant?: string;
  }
) {
  const payload = {
    service: {
      code,
      variant: options?.variant || getEqualityDefaultVariant(),
      ...(options?.parameters ? { parameters: options.parameters } : {}),
    },
    data,
  };

  const response = await fetch(getEqualityBaseUrl(), {
    method: "POST",
    headers: {
      Authorization: getEqualityConfiguredToken(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new EqualityApiError(
      getEqualityMessage(parsed, response.status),
      response.status,
      parsed
    );
  }

  return parsed as EqualityServicePayload;
}

export async function queryEqualityDevices(deviceUid: string) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/query/devices", {
      body: {
        deviceList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
          },
        ],
      },
    });
  }

  return executeEqualityService("QUERY_DEVICES", {
    deviceList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
      },
    ],
  });
}

export async function uploadEqualityInventoryDevice(deviceUid: string) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/inventory/upload", {
      body: {
        deviceList: [
          {
            deviceType: "mobile",
            idType: "imei",
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            serviceList: [
              {
                serviceName: "deviceFinancing",
                paymentMethod: "postpaid",
              },
            ],
          },
        ],
      },
    });
  }

  return executeEqualityService("INVENTORY_UPLOAD", {
    deviceList: [
      {
        deviceType: "smartphone",
        idType: "imei",
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
      },
    ],
  });
}

export async function activateEqualityFinancingService(deviceUid: string) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/service/activate", {
      body: {
        deviceList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            serviceList: [
              {
                serviceName: "deviceFinancing",
                paymentMethod: "postpaid",
              },
            ],
          },
        ],
      },
    });
  }

  return executeEqualityService("SERVICE_ACTIVATE", {
    deviceList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
        serviceList: [
          {
            serviceName: "deviceFinancing",
            paymentMethod: "postpaid",
          },
        ],
      },
    ],
  });
}

export async function lockEqualityDevice(
  deviceUid: string,
  options?: {
    lockMsgContent?: string;
    lockMsgTitle?: string;
    lockType?: string;
  }
) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/device/lock", {
      body: {
        lockList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            lockType: options?.lockType || "lock",
            lockMsgTitle: options?.lockMsgTitle || "Telefono bloqueado",
            lockMsgContent:
              options?.lockMsgContent || "Equipo bloqueado por falta de pago.",
          },
        ],
      },
    });
  }

  return executeEqualityService("DEVICE_LOCK", {
    lockList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
        lockType: options?.lockType || "lock",
        lockMsgTitle: options?.lockMsgTitle || "Telefono bloqueado",
        lockMsgContent:
          options?.lockMsgContent || "Equipo bloqueado por falta de pago.",
      },
    ],
  });
}

export async function unlockEqualityDevice(deviceUid: string) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/device/unlock", {
      body: {
        unLockList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
          },
        ],
      },
    });
  }

  return executeEqualityService("DEVICE_UNLOCK", {
    unLockList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
      },
    ],
  });
}

export async function releaseEqualityDevice(
  deviceUid: string,
  reason = "End of contract"
) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/device/release", {
      method: "PUT",
      body: {
        deviceReleaseList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            reason: String(reason || "End of contract").trim(),
          },
        ],
      },
    });
  }

  return executeEqualityService("DEVICE_RELEASE", {
    deviceReleaseList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
        reason: String(reason || "End of contract").trim(),
      },
    ],
  });
}

export async function notifyEqualityDevice(
  deviceUid: string,
  options?: {
    notificationContent?: string;
    notificationTitle?: string;
    notificationType?: string;
  }
) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/device/notify", {
      body: {
        messageList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            notificationTitle: options?.notificationTitle || "Proximo pago",
            notificationType: options?.notificationType || "headsup",
            notificationContent:
              options?.notificationContent || "Se aproxima tu fecha de pago",
          },
        ],
      },
    });
  }

  return executeEqualityService("DEVICE_NOTIFY", {
    messageList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
        notificationTitle: options?.notificationTitle || "Proximo pago",
        notificationType: options?.notificationType || "headsup",
        notificationContent:
          options?.notificationContent || "Se aproxima tu fecha de pago",
      },
    ],
  });
}

export async function sendEqualityLockMessage(
  deviceUid: string,
  options?: {
    messageContent?: string;
    messageTitle?: string;
  }
) {
  if (isTrustonicDirectConfigured()) {
    return executeTrustonicRequest("/api/v2/device/lockMessage", {
      body: {
        lockMessageList: [
          {
            deviceUid: normalizeEqualityDeviceUid(deviceUid),
            messageTitle: options?.messageTitle || "Tienes un pago vencido",
            messageContent:
              options?.messageContent || "Desbloquea tu equipo haz tu pago.",
          },
        ],
      },
    });
  }

  return executeEqualityService("DEVICE_LOCK_MESSAGE", {
    lockMessageList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
        messageTitle: options?.messageTitle || "Tienes un pago vencido",
        messageContent:
          options?.messageContent || "Desbloquea tu equipo haz tu pago.",
      },
    ],
  });
}

export async function addEqualityContract(
  deviceUid: string,
  contractId: string | number,
  assignedContractDate = new Date().toISOString()
) {
  return executeTrustonicRequest("/api/v2/contract/addContract", {
    body: {
      addContractList: [
        {
          deviceUid: normalizeEqualityDeviceUid(deviceUid),
          contractId,
          assignedContractDate,
        },
      ],
    },
  });
}

export async function updateEqualityContractPayment(
  deviceUid: string,
  cycleNumber: string | number
) {
  return executeTrustonicRequest("/api/v2/contract/updatePayment", {
    method: "PUT",
    body: {
      updatePaymentList: [
        {
          deviceUid: normalizeEqualityDeviceUid(deviceUid),
          deviceBillingCycles: [
            {
              cycleNumber,
            },
          ],
        },
      ],
    },
  });
}

export async function exitEqualityContract(
  deviceUid: string,
  exitReason = "End of contract"
) {
  return executeTrustonicRequest("/api/v2/contract/exitContract", {
    method: "PUT",
    body: {
      exitContractList: [
        {
          deviceUid: normalizeEqualityDeviceUid(deviceUid),
          exitReason: String(exitReason || "End of contract").trim(),
        },
      ],
    },
  });
}

export function isEqualityApiError(error: unknown): error is EqualityApiError {
  return error instanceof EqualityApiError;
}
