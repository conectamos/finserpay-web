import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import ApprovalOperationRoute from "../approval-operation-route";
import { parseAnalystRequestId } from "@/lib/approval-request-detail-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cambio de IMEI | Aprobaciones | FINSER PAY",
  description: "Gestión autorizada de cambios de IMEI para créditos.",
};

export default async function ApprovalImeiChangePage({
  searchParams,
}: {
  searchParams: Promise<{ buscar?: string | string[]; caso?: string | string[] }>;
}) {
  const user = await requireNominalApprovalDashboardAccess();
  const params = await searchParams;
  const initialQuery = (Array.isArray(params.buscar) ? params.buscar[0] : params.buscar || "").trim();
  const selected = parseAnalystRequestId(params.caso);

  return (
    <ApprovalDashboardShell
      activeHref="/dashboard/aprobaciones/cambio-imei"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Cambio de IMEI"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <ApprovalOperationRoute preferredPanel="imei" initialQuery={initialQuery}
        initialCase={selected ? { kind: selected.source, id: selected.entityId } : undefined} />
    </ApprovalDashboardShell>
  );
}
