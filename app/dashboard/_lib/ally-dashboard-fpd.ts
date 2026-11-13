import "server-only";

import { calendarDateKey, getColombiaDateParts } from "@/lib/colombia-date";
import type { CutAccess } from "@/lib/cut-collection-access";
import { getDirectCutRiskComparison } from "@/lib/cut-collection-storage";
import type { CutFilters, CutRiskComparisonItem } from "@/lib/cut-collection-types";
import { resolveDashboardMonth } from "@/lib/dashboard-month";

export type AllyDashboardFpdData = {
  status: "ready" | "unavailable";
  cuts: CutRiskComparisonItem[];
};

const validId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

export async function getAllyDashboardFpd({
  access,
  month,
  sedeId,
  now = new Date(),
}: {
  access: CutAccess;
  month: string;
  sedeId?: number | null;
  now?: Date;
}): Promise<AllyDashboardFpdData> {
  try {
    // This panel must never turn a missing ally into a global report. The
    // existing store remains responsible for checking each branch's ownership.
    if (!access || access.central !== false || !validId(access.userId) || !validId(access.aliadoId) ||
        (access.sedeId != null && !validId(access.sedeId)) ||
        (sedeId != null && !validId(sedeId)) ||
        (access.sedeId != null && sedeId != null && access.sedeId !== sedeId) ||
        !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Invalid dashboard scope or date");
    }

    const selectedMonth = resolveDashboardMonth(month, now);
    const cutoff = new Date(Math.min(now.getTime(), selectedMonth.end.getTime() - 1));
    const cutoffParts = getColombiaDateParts(cutoff);
    const cutoffKey = calendarDateKey(cutoffParts);
    const cutDates: string[] = [];
    for (let offset = 0; cutDates.length < 3; offset++) {
      const previousMonth = new Date(Date.UTC(cutoffParts.year, cutoffParts.month - 1 - offset, 1));
      if (previousMonth.getUTCFullYear() < 2000) break;
      for (const day of [17, 2] as const) {
        const date = calendarDateKey({ year: previousMonth.getUTCFullYear(),
          month: previousMonth.getUTCMonth() + 1, day });
        if (date <= cutoffKey) cutDates.push(date);
        if (cutDates.length === 3) break;
      }
    }
    if (cutDates.length === 0) return { status: "ready", cuts: [] };

    const [year, selectedCutMonth, day] = cutDates[0].split("-").map(Number);
    const filters: CutFilters = {
      day: day as 2 | 17, month: selectedCutMonth, year,
      aliadoId: access.aliadoId, sedeId: sedeId ?? access.sedeId ?? null, status: "todos",
    };
    // One shared database snapshot, with the original metric maturity and
    // availability values. Selecting an old month does not backdate payments.
    const cuts = await getDirectCutRiskComparison(access, filters, cutDates);
    return { status: "ready", cuts };
  } catch {
    console.error("[ally-dashboard-fpd] No se pudo consultar el riesgo temprano del panel.");
    return { status: "unavailable", cuts: [] };
  }
}
