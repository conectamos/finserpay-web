export type PadlockAdminCounters = {
  pending: number;
  processing: number;
  locked: number;
  unlocked: number;
  error: number;
  reviewRequired: number;
};

export type PadlockAdminStatusCount = {
  status: string;
  count: number | bigint | string;
};

const EMPTY_COUNTERS: PadlockAdminCounters = {
  pending: 0,
  processing: 0,
  locked: 0,
  unlocked: 0,
  error: 0,
  reviewRequired: 0,
};

function normalizedCount(value: number | bigint | string) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function buildPadlockAdminStatusSummary(
  rows: ReadonlyArray<PadlockAdminStatusCount>
) {
  const counters = { ...EMPTY_COUNTERS };
  let total = 0;

  for (const row of rows) {
    const count = normalizedCount(row.count);
    total += count;

    switch (String(row.status || "").trim().toUpperCase()) {
      case "PENDING":
      case "RETRY":
        counters.pending += count;
        break;
      case "PROCESSING":
      case "LOCKING":
      case "UNLOCKING":
        counters.processing += count;
        break;
      case "LOCKED":
        counters.locked += count;
        break;
      case "UNLOCKED":
        counters.unlocked += count;
        break;
      case "ERROR":
        counters.error += count;
        break;
      case "REVIEW_REQUIRED":
      case "NOT_ENROLLED":
        counters.reviewRequired += count;
        break;
    }
  }

  return { counters, total };
}
