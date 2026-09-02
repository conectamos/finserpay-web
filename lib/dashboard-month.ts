const DASHBOARD_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIN_DASHBOARD_YEAR = 2000;

export type DashboardMonthRange = {
  currentKey: string;
  daysInMonth: number;
  end: Date;
  key: string;
  label: string;
  start: Date;
};

function bogotaMonthParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    month: "2-digit",
    timeZone: "America/Bogota",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    month: Number(values.month),
    year: Number(values.year),
  };
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function resolveDashboardMonth(
  requestedMonth?: string | null,
  now = new Date()
): DashboardMonthRange {
  const current = bogotaMonthParts(now);
  const currentKey = monthKey(current.year, current.month);
  const match = String(requestedMonth || "")
    .trim()
    .match(DASHBOARD_MONTH_PATTERN);
  const requestedYear = Number(match?.[1]);
  const requestedMonthNumber = Number(match?.[2]);
  const requestedIndex = requestedYear * 12 + requestedMonthNumber - 1;
  const currentIndex = current.year * 12 + current.month - 1;
  const requestedIsValid =
    Boolean(match) &&
    requestedYear >= MIN_DASHBOARD_YEAR &&
    requestedIndex <= currentIndex;
  const year = requestedIsValid ? requestedYear : current.year;
  const month = requestedIsValid ? requestedMonthNumber : current.month;
  const key = monthKey(year, month);
  const start = new Date(Date.UTC(year, month - 1, 1, 5));
  const end = new Date(Date.UTC(year, month, 1, 5));

  return {
    currentKey,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    end,
    key,
    label: new Intl.DateTimeFormat("es-CO", {
      month: "long",
      timeZone: "America/Bogota",
      year: "numeric",
    }).format(start),
    start,
  };
}
