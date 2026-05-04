import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import ReporteAbonosPage from "./reporte-abonos-client";

export const metadata = {
  title: "Tabla de abonos | FINSER PAY",
  description: "Vista administrativa y de supervisor para consultar recaudos",
};

export default async function ReporteAbonosRoute() {
  await requireAdminOrSupervisorDashboardAccess();

  return <ReporteAbonosPage />;
}
