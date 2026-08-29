export const MAX_VERIFF_DECLINED_ATTEMPTS = 1;

export type VeriffRetryPolicy = {
  applicationRejected: boolean;
  declinedAttempts: number;
  maxAttempts: number;
  remainingAttempts: number;
  retryAllowed: boolean;
};

export function veriffDeclineWasCanonicalAtDecision(input: {
  declinedId: number;
  decidedAt: Date;
  newerAttempts: Array<{ createdAt: Date; id: number }>;
}) {
  return !input.newerAttempts.some(
    (attempt) =>
      attempt.id > input.declinedId && attempt.createdAt < input.decidedAt
  );
}

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
