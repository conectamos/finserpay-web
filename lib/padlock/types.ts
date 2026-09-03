export const PADLOCK_DEVICE_STATUSES = [
  "unlocked",
  "locked",
  "locking",
  "unlocking",
  "not_enrolled",
  "error",
] as const;

export type PadlockKnownDeviceStatus =
  (typeof PADLOCK_DEVICE_STATUSES)[number];
export type PadlockDeviceStatus = PadlockKnownDeviceStatus | "unknown";
export type PadlockCommandAction = "LOCK" | "UNLOCK";

export type PadlockErrorCode =
  | "AMBIGUOUS_DEVICE"
  | "AUTHENTICATION_FAILED"
  | "CONFIGURATION_ERROR"
  | "FEATURE_DISABLED"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "PRODUCTION_NOT_ALLOWED"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "RESPONSE_TOO_LARGE"
  | "SANDBOX_DEVICE_NOT_ALLOWED"
  | "TIMEOUT"
  | "VALIDATION_ERROR";

export class PadlockError extends Error {
  readonly code: PadlockErrorCode;
  readonly correlationId: string | null;
  readonly httpStatus: number;
  readonly providerHttpStatus: number | null;
  readonly retryable: boolean;

  constructor(options: {
    code: PadlockErrorCode;
    correlationId?: string | null;
    httpStatus: number;
    message: string;
    providerHttpStatus?: number | null;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "PadlockError";
    this.code = options.code;
    this.correlationId = options.correlationId ?? null;
    this.httpStatus = options.httpStatus;
    this.providerHttpStatus = options.providerHttpStatus ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export type PadlockDevice = {
  brand: string | null;
  createdAt: string | null;
  identifier: string | null;
  key1: string | null;
  key2: string | null;
  model: string | null;
  serial: string | null;
  status: PadlockDeviceStatus;
  transitionStartedAt: string | null;
  updatedAt: string | null;
};

export type PadlockDeviceList = {
  items: PadlockDevice[];
  limit: number;
  page: number;
  total: number;
  totalPages: number;
};

export type PadlockListDevicesInput = {
  correlationId?: string | null;
  limit?: number;
  page?: number;
  search?: string;
};

export type PadlockRequestOptions = {
  correlationId?: string | null;
};

export type PadlockCommandResult = {
  action: PadlockCommandAction;
  brand: string | null;
  message: string | null;
  model: string | null;
  requestedDevice: string;
  status: PadlockDeviceStatus;
  success: boolean;
};
