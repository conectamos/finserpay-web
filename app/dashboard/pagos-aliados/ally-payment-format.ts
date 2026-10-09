const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 20,
  style: "currency",
});

const numberFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 2,
});

export function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(value: unknown) {
  return moneyFormatter.format(numberValue(value));
}

export function formatNumber(value: unknown) {
  return numberFormatter.format(Math.round(numberValue(value)));
}

export function formatPercent(value: unknown) {
  if (value === undefined || value === "") return "-";
  if (value === null) return "Mixto";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${percentFormatter.format(parsed)}%` : "-";
}

export function formatDate(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);

  if (dateOnly) {
    return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }

  if (!normalized) return "-";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return normalized;

  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Bogota",
    year: "numeric",
  }).format(date);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

export function statusTone(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  if (normalized.includes("ANUL") || normalized.includes("ERROR")) return "danger" as const;
  if (normalized.includes("PAG") || normalized.includes("LIQUID")) return "positive" as const;
  if (normalized.includes("PEND") || normalized.includes("PROCES")) return "warning" as const;
  return "neutral" as const;
}

export function platformLabel(value: string | null | undefined) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "IPHONE" || normalized === "IOS") return "iPhone";
  if (normalized === "ANDROID") return "Android";
  return value || "Sin plataforma";
}
