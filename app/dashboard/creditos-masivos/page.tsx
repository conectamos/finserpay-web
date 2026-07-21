import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import MassCreditImportConsole from "./mass-credit-import-console";

export const metadata = {
  title: "Creditos masivos | FINSER PAY",
  description: "Carga administrativa de creditos historicos cobrables",
};

export default async function CreditosMasivosPage() {
  const { session } = await requireCentralAdminDashboardAccess();

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/creditos-masivos"
          adminCentral
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Creditos"
        current="Creditos masivos"
        userName={session.nombre}
        userRole={session.rolNombre}
        accentAvatar
      />
      <MassCreditImportConsole />
    </AppShell>
  );
}
