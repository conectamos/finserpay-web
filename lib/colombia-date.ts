export const COLOMBIA_TIME_ZONE = "America/Bogota";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateValue = Date | string | null | undefined;

export type CalendarDateParts = {
  year: number;
  month: number;
  day: number;
};

const colombiaDatePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: COLOMBIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function exactDateOnlyParts(value: DateValue): CalendarDateParts | null {
  const match = DATE_ONLY_PATTERN.exec(String(value || "").trim());

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function validDate(value: DateValue, fallback = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value || ""));

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const fallbackDate = new Date(fallback);
  return Number.isNaN(fallbackDate.getTime()) ? new Date() : fallbackDate;
}

export function parseColombiaDate(value: DateValue) {
  const dateOnly = exactDateOnlyParts(value);

  if (dateOnly) {
    return new Date(
      `${calendarDateKey(dateOnly)}T12:00:00.000-05:00`
    );
  }

  return value instanceof Date ? new Date(value) : new Date(String(value || ""));
}

export function getColombiaDateParts(
  value: DateValue,
  fallback = new Date()
): CalendarDateParts {
  const dateOnly = exactDateOnlyParts(value);

  if (dateOnly) {
    return dateOnly;
  }

  const parts = colombiaDatePartsFormatter.formatToParts(validDate(value, fallback));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value || 0);

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
  };
}

export function calendarDateKey(parts: CalendarDateParts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export function colombiaDateKey(value: DateValue, fallback = new Date()) {
  return calendarDateKey(getColombiaDateParts(value, fallback));
}

export function isSameColombiaDate(left: DateValue, right: DateValue) {
  return colombiaDateKey(left) === colombiaDateKey(right);
}
