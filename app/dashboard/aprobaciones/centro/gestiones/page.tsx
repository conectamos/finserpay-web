import { requireNominalApprovalDashboardAccess } from "../../approval-dashboard-access";
import ApprovalDashboardShell from "../../approval-dashboard-shell";
import AnalystManagements from "./analyst-managements";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mis gestiones | Centro del analista | FINSER PAY" };

export default async function AnalystManagementsPage() {
  const user = await requireNominalApprovalDashboardAccess();
  return <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/centro/gestiones" user={user}><AnalystManagements /></ApprovalDashboardShell>;
}
