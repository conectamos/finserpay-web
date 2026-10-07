import { getAdminDashboardOverview } from "@/app/dashboard/_lib/admin-dashboard-data";
import { projectDashboardDelinquency, projectDashboardDelinquencyCredits, type DashboardDelinquencyCreditView, type DashboardDelinquencyView } from "@/lib/dashboard-delinquency-view";

export type DelinquencyDetailData = {
  detail: DashboardDelinquencyView;
  credits: DashboardDelinquencyCreditView[];
  updatedAt: string;
};

/** Both scope and balance visibility must come from the authenticated session.
 * An allied account with no valid scope cannot fall back to the global view. */
export async function getDelinquencyDetailData(
  aliadoId: number | null,
  viewingCentral: boolean,
): Promise<DelinquencyDetailData> {
  if (!viewingCentral && (!Number.isSafeInteger(aliadoId) || Number(aliadoId) <= 0)) {
    throw new Error("No se pudo verificar el aliado de esta sesión.");
  }
  const overview = await getAdminDashboardOverview({ aliadoId, includeDelinquencyCredits: true });
  return {
    detail: projectDashboardDelinquency(overview.delinquencyDetail, { viewingCentral }),
    credits: projectDashboardDelinquencyCredits(overview.delinquencyCredits || []),
    updatedAt: new Date().toISOString(),
  };
}
