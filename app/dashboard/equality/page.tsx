import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import EqualityZeroTouchConsole from "./equality-zero-touch-console";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Consola remota para Equality HBM Zero Touch",
};

export default async function EqualityPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/equality"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Integraciones"
        current="Equality Zero Touch"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <EqualityZeroTouchConsole canAdmin roleName={session.rolNombre} />
    </AppShell>
  );
}
