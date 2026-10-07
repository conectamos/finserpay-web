import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import ApprovalOperationRoute from "../approval-operation-route";
import { parseAnalystRequestId } from "@/lib/approval-request-detail-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Gestionar firma | Aprobaciones | FINSER PAY",
  description: "Gestión autorizada de envíos y reenvíos de FirmaSeguro.",
};

export default async function ApprovalSignaturePage({
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
      activeHref="/dashboard/aprobaciones/firma-seguro"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Gestionar firma"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <ApprovalOperationRoute preferredPanel="signature" initialQuery={initialQuery}
        initialCase={selected ? { kind: selected.source, id: selected.entityId } : undefined} />
    </ApprovalDashboardShell>
  );
}
