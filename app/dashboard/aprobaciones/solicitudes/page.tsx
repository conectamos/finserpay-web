import { Suspense } from "react";
import { LoadingState } from "@/app/_components/finser-ui";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import SolicitudesWallClient from "@/app/dashboard/solicitudes/solicitudes-wall-client";
import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Solicitudes | Aprobaciones | FINSER PAY",
  description: "Consulta global de solicitudes para el equipo de aprobaciones.",
};

export default async function ApprovalRequestsPage() {
  const user = await requireNominalApprovalDashboardAccess();

  return (
    <ApprovalDashboardShell
      activeHref="/dashboard/aprobaciones/solicitudes"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Solicitudes"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
        <Suspense fallback={<LoadingState label="Cargando muro de solicitudes..." />}>
          <SolicitudesWallClient
            baseHref="/dashboard/aprobaciones/solicitudes"
            viewerRole="ANALYST"
          />
        </Suspense>
      </main>
    </ApprovalDashboardShell>
  );
}
