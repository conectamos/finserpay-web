import { AppShell } from "@/app/_components/finser-ui";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import IntegrationsHub from "./integrations-hub";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Centro operativo para monitorear la sesion local y Equality Zero Touch",
};

export default async function IntegracionesPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/integraciones"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Integraciones"
        current="Zero Touch"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <IntegrationsHub initialSession={session} />
    </AppShell>
  );
}
