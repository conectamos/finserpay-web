const DEFAULT_EQUALITY_BASE_URL = "https://hbm-api.solucionfaas.com/v1/hbm";
const DEFAULT_EQUALITY_VARIANT = "A";

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

function getEqualityConfiguredToken() {
  const rawToken = String(
    process.env.EQUALITY_HBM_ACCESS_TOKEN ||
      process.env.EQUALITY_ZERO_TOUCH_TOKEN ||
      process.env.EQUALITY_API_TOKEN ||
      ""
  ).trim();

  if (!rawToken) {
    throw new Error("EQUALITY_HBM_ACCESS_TOKEN no esta configurado");
  }

  if (rawToken.startsWith("Bearer ")) {
    return rawToken;
  }

  return `Bearer ${rawToken}`;
}

export function isEqualityConfigured() {
  return Boolean(
    String(
      process.env.EQUALITY_HBM_ACCESS_TOKEN ||
        process.env.EQUALITY_ZERO_TOUCH_TOKEN ||
        process.env.EQUALITY_API_TOKEN ||
        ""
    ).trim()
  );
}

export function getEqualityBaseUrl() {
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
  return executeEqualityService("QUERY_DEVICES", {
    deviceList: [
      {
        deviceUid: normalizeEqualityDeviceUid(deviceUid),
      },
    ],
  });
}

export async function uploadEqualityInventoryDevice(deviceUid: string) {
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

export function isEqualityApiError(error: unknown): error is EqualityApiError {
  return error instanceof EqualityApiError;
}
