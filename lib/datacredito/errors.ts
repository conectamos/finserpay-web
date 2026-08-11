export type DataCreditoErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CONFIGURATION_ERROR"
  | "FEATURE_DISABLED"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "VALIDATION_ERROR";

type DataCreditoErrorOptions = {
  code: DataCreditoErrorCode;
  correlationId?: string | null;
  httpStatus?: number;
  message: string;
  providerHttpStatus?: number | null;
  retryable?: boolean;
};

export class DataCreditoError extends Error {
  readonly code: DataCreditoErrorCode;
  readonly correlationId: string | null;
  readonly httpStatus: number;
  readonly providerHttpStatus: number | null;
  readonly retryable: boolean;

  constructor(options: DataCreditoErrorOptions) {
    super(options.message);
    this.name = "DataCreditoError";
    this.code = options.code;
    this.correlationId = options.correlationId ?? null;
    this.httpStatus = options.httpStatus ?? 500;
    this.providerHttpStatus = options.providerHttpStatus ?? null;
    this.retryable = options.retryable ?? false;
  }
}
