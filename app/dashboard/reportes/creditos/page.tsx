import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import ReporteCreditosPage from "./reporte-creditos-client";

export const metadata = {
  title: "Tabla de creditos | FINSER PAY",
  description: "Vista administrativa y de supervisor para consultar creditos",
};

export default async function ReporteCreditosRoute() {
  await requireAdminOrSupervisorDashboardAccess();

  return <ReporteCreditosPage />;
}
