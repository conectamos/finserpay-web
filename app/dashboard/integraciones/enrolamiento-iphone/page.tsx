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
  title: "Accesos de enrolamiento iPhone | FINSER PAY",
  description:
    "Emisión y revocación de accesos temporales para analistas de enrolamiento iPhone.",
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
        eyebrow="Seguridad operativa"
        title="Accesos de enrolamiento iPhone"
        description="Genera enlaces temporales y de un solo uso. La identidad registrada aquí será la que quede en la auditoría de cada aprobación."
      />
      <IphoneEnrollmentAccessManager />
    </AppShell>
  );
}
