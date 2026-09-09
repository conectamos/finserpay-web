import { redirect } from "next/navigation";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import PendingConsole from "./pending-console";

export const metadata = {
  title: "PENDIENTES | FINSER PAY",
  description: "Novedades de créditos pendientes de revisión del analista",
};

export default async function PendientesPage() {
  const { session } = await requireAdminDashboardAccess();
  const allyId = Number(session.aliadoAccesoId);
  if (isFinserPayCentralAlly(session.aliadoAccesoCodigo) || !Number.isInteger(allyId) || allyId <= 0) {
    redirect("/dashboard");
  }
  return (
    <AppShell sidebar={<AdminSidebar activeHref="/dashboard/pendientes" adminCentral={false}
      nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
      <AdminWorkspaceTopbar parent="Operación" current="PENDIENTES" userName={session.nombre} userRole={session.rolNombre} />
      <PendingConsole />
    </AppShell>
  );
}
