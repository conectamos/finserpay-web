export const MAX_VERIFF_DECLINED_ATTEMPTS = 2;

export type VeriffRetryPolicy = {
  applicationRejected: boolean;
  declinedAttempts: number;
  maxAttempts: number;
  remainingAttempts: number;
  retryAllowed: boolean;
};

export function buildVeriffRetryPolicy(
  declinedAttempts: number
): VeriffRetryPolicy {
  const normalizedAttempts = Math.max(
    0,
    Math.trunc(Number(declinedAttempts) || 0)
  );
  const remainingAttempts = Math.max(
    0,
    MAX_VERIFF_DECLINED_ATTEMPTS - normalizedAttempts
  );

  return {
    applicationRejected: normalizedAttempts >= MAX_VERIFF_DECLINED_ATTEMPTS,
    declinedAttempts: normalizedAttempts,
    maxAttempts: MAX_VERIFF_DECLINED_ATTEMPTS,
    remainingAttempts,
    retryAllowed:
      normalizedAttempts > 0 &&
      normalizedAttempts < MAX_VERIFF_DECLINED_ATTEMPTS,
  };
}
