export type AllyPaymentViewFilters = {
  search: string;
  allyId: string;
  start: string;
  end: string;
  platform: "ALL" | "IPHONE" | "ANDROID";
};

export function emptyAllyPaymentViewFilters(): AllyPaymentViewFilters {
  return { search: "", allyId: "", start: "", end: "", platform: "ALL" };
}

/** Bare database dates are Colombia calendar dates; timestamps are converted to Bogotá. */
export function allyPaymentColombiaDate(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Bogota",
  }).formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value || "").join("-");
}

function searchable(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.\s-]/g, "");
}

function matchesSearch(search: string, values: unknown[]) {
  const query = searchable(search);
  return !query || values.some(value => searchable(value).includes(query));
}

function matchesDate(date: string, filters: AllyPaymentViewFilters) {
  if (!filters.start && !filters.end) return true;
  return Boolean(date) && (!filters.start || date >= filters.start) && (!filters.end || date <= filters.end);
}

type Ally = { id: number; nombre?: string | null; codigo?: string | null } | null;
type Settlement = {
  aliadoId?: number | null; aliado?: Ally; aliadoNombre?: string | null;
  periodoInicio?: string | null; periodoFin?: string | null; numeroAprobacionBancaria?: string | null;
};

export function filterReceivedAllyPayments<T extends Settlement>(items: T[], filters: AllyPaymentViewFilters): T[] {
  return items.filter(item => {
    if (filters.allyId && String(item.aliadoId ?? item.aliado?.id ?? "") !== filters.allyId) return false;
    if (!matchesSearch(filters.search, [item.aliado?.nombre, item.aliadoNombre, item.aliado?.codigo, item.numeroAprobacionBancaria])) return false;
    if (!filters.start && !filters.end) return true;
    const start = allyPaymentColombiaDate(item.periodoInicio);
    const end = allyPaymentColombiaDate(item.periodoFin) || start;
    // The selected range overlaps the saved settlement period, rather than its registration date.
    return Boolean(start && end) && (!filters.start || end >= filters.start) && (!filters.end || start <= filters.end);
  });
}

type PendingCredit = {
  aliado?: Ally; fechaLiquidacion?: string | null; fechaCredito?: string | null; fecha?: string | null;
  clienteNombre?: string | null; cliente?: string | null; clienteDocumento?: string | null;
  imei?: string | null; plataforma?: string | null;
};

export function filterPendingAllyCredits<T extends PendingCredit>(items: T[], filters: AllyPaymentViewFilters): T[] {
  return items.filter(item => (!filters.allyId || String(item.aliado?.id ?? "") === filters.allyId)
    && (filters.platform === "ALL" || item.plataforma?.toUpperCase() === filters.platform)
    && matchesSearch(filters.search, [item.clienteNombre, item.cliente, item.clienteDocumento, item.imei])
    && matchesDate(allyPaymentColombiaDate(item.fechaLiquidacion || item.fechaCredito || item.fecha), filters));
}

type PendingCollection = {
  aliado?: Ally; fechaAbono?: string | null; clienteNombre?: string | null;
  clienteDocumento?: string | null; imei?: string | null; plataforma?: string | null;
};

export function filterPendingAllyCollections<T extends PendingCollection>(items: T[], filters: AllyPaymentViewFilters): T[] {
  return items.filter(item => (!filters.allyId || String(item.aliado?.id ?? "") === filters.allyId)
    && (filters.platform === "ALL" || item.plataforma?.toUpperCase() === filters.platform)
    && matchesSearch(filters.search, [item.clienteNombre, item.clienteDocumento, item.imei])
    && matchesDate(allyPaymentColombiaDate(item.fechaAbono), filters));
}
