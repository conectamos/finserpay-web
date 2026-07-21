import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import MoraExceptionsClient from "./mora-exceptions-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Excepciones de bloqueo | FINSER PAY",
  description: "Acuerdos que conservan la mora sin bloquear el dispositivo",
};

export default async function MoraExceptionsPage() {
  const access = await requireCentralAdminDashboardAccess();

  return (
    <div className="min-h-screen bg-[#f4f7f8] text-[#101828] lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/excepciones-mora"
        adminCentral
        nombreUsuario={access.session.nombre}
        rolUsuario={access.session.rolNombre}
      />

      <div className="min-w-0">
        <AdminWorkspaceTopbar
          parent="Cartera"
          current="Excepciones por mora"
          userName={access.session.nombre}
          userRole={access.session.rolNombre}
        />
        <MoraExceptionsClient />
      </div>
    </div>
  );
}
