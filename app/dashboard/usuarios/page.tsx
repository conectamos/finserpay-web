import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import GestionUsuariosPage from "./usuarios-client";

export const metadata = {
  title: "Gestion de usuarios | FINSER PAY",
  description: "Administracion de vendedores, supervisores y administradores",
};

export default async function UsuariosPage() {
  const { session } = await requireAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/usuarios"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Administracion"
        current="Usuarios"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <GestionUsuariosPage />
    </AppShell>
  );
}
