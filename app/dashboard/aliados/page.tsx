import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import AliadosClient from "./aliados-client";

export const metadata = {
  title: "Aliados | FINSER PAY",
  description: "Administracion de aliados comerciales y cobertura por sedes",
};

export default async function AliadosPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/aliados"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Administracion"
        current="Aliados"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <AliadosClient />
    </AppShell>
  );
}
