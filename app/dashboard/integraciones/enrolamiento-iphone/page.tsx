import {
  AppShell,
  PageHeader,
} from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import IphoneEnrollmentAccessManager from "./iphone-enrollment-access-manager";

export const metadata = {
  title: "Acceso de enrolamiento iPhone | FINSER PAY",
  description:
    "Acceso compartido para especialistas de enrolamiento iPhone.",
};

export default async function IphoneEnrollmentAccessPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/integraciones/enrolamiento-iphone"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Integraciones"
        current="Enrolamiento iPhone"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <PageHeader
        eyebrow="Operación iPhone"
        title="Acceso de enrolamiento iPhone"
        description="Comparta un único enlace reutilizable con los especialistas. No necesita emitir autorizaciones por cada analista."
      />
      <IphoneEnrollmentAccessManager />
    </AppShell>
  );
}
