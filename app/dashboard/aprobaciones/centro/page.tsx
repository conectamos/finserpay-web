import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import AnalystCenter from "./analyst-center";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centro del analista | FINSER PAY", description: "Consulta de créditos y accesos del equipo de analistas." };

export default async function AnalystCenterPage() {
  const user = await requireNominalApprovalDashboardAccess();
  return <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/centro" user={user}><AnalystCenter /></ApprovalDashboardShell>;
}
