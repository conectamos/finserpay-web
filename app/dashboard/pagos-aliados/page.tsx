import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import AllyPaymentsConsole from "./ally-payments-console";

export const metadata = {
  title: "PAGOS ALIADO | FINSER PAY",
  description: "Liquidaciones, pagos recibidos y pagos pendientes de aliados",
};

export default async function PagosAliadosPage() {
  const { session } = await requireAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const allyId = Number(session.aliadoAccesoId || 0);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/pagos-aliados"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Operacion financiera"
        current="PAGOS ALIADO"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <AllyPaymentsConsole
        initialAdminCentral={adminCentral}
        initialAllyId={Number.isInteger(allyId) && allyId > 0 ? allyId : null}
      />
    </AppShell>
  );
}
