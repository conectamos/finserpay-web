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

export type DataCreditoErrorPhase = "AUTH_TOKEN" | "QUERY_REQUEST" | "QUERY_RESPONSE";

type DataCreditoErrorOptions = {
  code: DataCreditoErrorCode;
  correlationId?: string | null;
  phase?: DataCreditoErrorPhase;
  httpStatus?: number;
  message: string;
  providerHttpStatus?: number | null;
  retryable?: boolean;
};

export class DataCreditoError extends Error {
  readonly code: DataCreditoErrorCode;
  readonly correlationId: string | null;
  readonly phase: DataCreditoErrorPhase | undefined;
  readonly httpStatus: number;
  readonly providerHttpStatus: number | null;
  readonly retryable: boolean;

  constructor(options: DataCreditoErrorOptions) {
    super(options.message);
    this.name = "DataCreditoError";
    this.code = options.code;
    this.correlationId = options.correlationId ?? null;
    this.phase = options.phase;
    this.httpStatus = options.httpStatus ?? 500;
    this.providerHttpStatus = options.providerHttpStatus ?? null;
    this.retryable = options.retryable ?? false;
  }
}
