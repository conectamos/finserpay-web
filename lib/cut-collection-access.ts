import { getColombiaDateParts } from "./colombia-date";
import type { CutFilters, CutStatus } from "./cut-collection-types";

export class CutCollectionError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "CutCollectionError"; }
}
export type CutAccess = { userId: number; central: boolean; aliadoId: number | null; sedeId: number | null };

export function cutAccessFromDashboard(access: {
  admin: boolean; supervisor: boolean;
  session: { id: number; sedeId: number; aliadoAccesoId?: number | null; aliadoAccesoCodigo?: string | null };
} | null): CutAccess {
  if (!access) throw new CutCollectionError("No autenticado.", 401);
  if (!access.admin && !access.supervisor) throw new CutCollectionError("Solo administradores y supervisores pueden consultar recaudo por corte.", 403);
  const { session } = access;
  const central = access.admin && session.aliadoAccesoCodigo?.trim().toUpperCase() === "FINSERPAY";
  if (!Number.isSafeInteger(session.id) || session.id <= 0 ||
      (!central && access.admin && (!Number.isSafeInteger(session.aliadoAccesoId) || Number(session.aliadoAccesoId) <= 0)) ||
      (!access.admin && (!Number.isSafeInteger(session.sedeId) || session.sedeId <= 0))) {
    throw new CutCollectionError("Alcance de consulta no autorizado.", 403);
  }
  return { userId: session.id, central, aliadoId: central ? null : session.aliadoAccesoId ?? null, sedeId: access.admin ? null : session.sedeId };
}

export async function getCutCollectionAccess() {
  const { getDashboardAccess } = await import("./dashboard-access");
  return cutAccessFromDashboard(await getDashboardAccess());
}

export function parseCutFilters(input: URLSearchParams | Record<string, unknown>, now = new Date()): CutFilters {
  const read = (key: string) => input instanceof URLSearchParams ? input.get(key) : input[key];
  const parts = getColombiaDateParts(now);
  const next = parts.day <= 2 ? 2 : parts.day <= 17 ? 17 : 2;
  const defaultDate = new Date(Date.UTC(parts.year, parts.month - 1 + (parts.day > 17 ? 1 : 0), next));
  function integer(key: string, fallback: number | null, min: number, max: number) {
    const value = read(key);
    if (value === undefined || value === null || value === "") return fallback;
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) throw new CutCollectionError(`Filtro ${key} inválido.`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new CutCollectionError(`Filtro ${key} inválido.`);
    return number;
  }
  const day = integer("day", next, 2, 17);
  if (day !== 2 && day !== 17) throw new CutCollectionError("El corte debe ser 02 o 17.");
  const status = read("status") ?? "todos";
  if (typeof status !== "string" || !["todos", "pendiente", "parcial", "pagado"].includes(status)) throw new CutCollectionError("Estado de recaudo inválido.");
  return {
    day, month: integer("month", defaultDate.getUTCMonth() + 1, 1, 12)!,
    year: integer("year", defaultDate.getUTCFullYear(), 2000, 2200)!,
    aliadoId: integer("aliadoId", null, 1, 2147483647), sedeId: integer("sedeId", null, 1, 2147483647), status: status as CutStatus,
  };
}

export function cutDateFromFilters(filters: CutFilters) {
  return `${filters.year}-${String(filters.month).padStart(2, "0")}-${String(filters.day).padStart(2, "0")}`;
}

export function assertCutUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CutCollectionError("Identificador de proyección inválido.");
}
