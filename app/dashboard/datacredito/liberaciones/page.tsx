import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import Tx06ReleaseConsole from "./tx06-release-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Liberar consultas DataCrédito | FINSER PAY",
  description:
    "Autorización central de nuevos intentos para consultas TX06 sin puntaje",
};

export default async function DataCreditoReleasePage() {
  const access = await requireCentralAdminDashboardAccess();

  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-graphite)] lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/datacredito/liberaciones"
        adminCentral
        nombreUsuario={access.session.nombre}
        rolUsuario={access.session.rolNombre}
      />
      <div className="min-w-0">
        <AdminWorkspaceTopbar
          parent="Integraciones"
          current="Liberar consultas"
          userName={access.session.nombre}
          userRole={access.session.rolNombre}
        />
        <Tx06ReleaseConsole />
      </div>
    </div>
  );
}
