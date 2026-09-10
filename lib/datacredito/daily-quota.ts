export type DataCreditoDailyQuotaSnapshot = {
  limit: number | null;
  used: number;
  remaining: number | null;
  percentUsed: number | null;
  exhausted: boolean;
  resetsAt: string;
};

/** Derive presentation values from the server's current daily reservation state. */
export function serializeDataCreditoDailyQuota(input: {
  limit: number | null;
  used: number;
  resetsAt: Date;
}): DataCreditoDailyQuotaSnapshot {
  if (
    (input.limit !== null &&
      (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 10_000)) ||
    !Number.isInteger(input.used) ||
    input.used < 0
  ) {
    throw new Error("DATACREDITO_INVALID_DAILY_QUOTA_STATE");
  }

  const exhausted = input.limit !== null && input.used >= input.limit;
  return {
    limit: input.limit,
    used: input.used,
    remaining: input.limit === null ? null : Math.max(0, input.limit - input.used),
    percentUsed:
      input.limit === null
        ? null
        : exhausted
          ? 100
          : Math.floor((input.used / input.limit) * 100),
    exhausted,
    resetsAt: input.resetsAt.toISOString(),
  };
}
