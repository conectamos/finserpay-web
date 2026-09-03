import { AppShell, PageHeader } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import PadlockAdminConsole from "./padlock-admin-console";

export const metadata = {
  title: "Padlock iPhone | FINSER PAY",
  description:
    "Centro administrativo para reglas, vinculaciones y comandos Padlock de créditos iPhone.",
};

export default async function PadlockPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/integraciones/padlock"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Integraciones"
        current="Padlock iPhone"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <PageHeader
        eyebrow="Control de cartera iPhone"
        title="Padlock: bloqueo por mora"
        description="Administre reglas y dispositivos vinculados. Los bloqueos automáticos solo se evalúan los días 5 y 20 a las 8:00 p. m. (Bogotá); el desbloqueo se programa al confirmar que el crédito quedó al día."
      />
      <PadlockAdminConsole />
    </AppShell>
  );
}
