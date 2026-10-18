import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import { requireMoraDashboardAccess } from "../mora-dashboard-access";
import MoraPortfolioClient from "../cartera-mora/mora-portfolio-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Gestión de cartera | Aprobaciones | FINSER PAY",
  description: "Gestiona todos los créditos y conserva su historial de contacto y seguimiento.",
};

export default async function ApprovalCollectionPortfolioPage() {
  const { user } = await requireMoraDashboardAccess();

  return (
    <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/gestion-cartera" user={user}>
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Gestión de cartera"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <MoraPortfolioClient scope="all" />
    </ApprovalDashboardShell>
  );
}
