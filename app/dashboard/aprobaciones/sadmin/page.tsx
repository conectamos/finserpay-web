import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import ApprovalSadminRoute from "../approval-sadmin-route";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creación en SADMIN | Aprobaciones | FINSER PAY",
  description: "Control de creación de créditos en SADMIN.",
};

export default async function ApprovalSadminPage({ searchParams }: {
  searchParams: Promise<{ buscar?: string | string[] }>;
}) {
  const user = await requireNominalApprovalDashboardAccess();
  const params = await searchParams;
  const initialQuery = (Array.isArray(params.buscar) ? params.buscar[0] : params.buscar || "").trim().slice(0, 100);

  return (
    <ApprovalDashboardShell
      activeHref="/dashboard/aprobaciones/sadmin"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Creación en SADMIN"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <ApprovalSadminRoute initialQuery={initialQuery} />
    </ApprovalDashboardShell>
  );
}
