import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import DataCreditoAdminConsole from "./datacredito-admin-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Historial DataCrédito | FINSER PAY",
  description: "Auditoría central de consultas y expedientes MiDecisor",
};

export default async function DataCreditoAdminPage() {
  const access = await requireCentralAdminDashboardAccess();
  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-graphite)] lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/datacredito"
        adminCentral
        nombreUsuario={access.session.nombre}
        rolUsuario={access.session.rolNombre}
      />
      <div className="min-w-0">
        <AdminWorkspaceTopbar
          parent="Integraciones"
          current="Historial DataCrédito"
          userName={access.session.nombre}
          userRole={access.session.rolNombre}
        />
        <DataCreditoAdminConsole />
      </div>
    </div>
  );
}
