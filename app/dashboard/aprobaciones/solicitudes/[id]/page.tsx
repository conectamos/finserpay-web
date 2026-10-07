import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/app/_components/finser-ui";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { getAnalystRequestDetail } from "@/lib/approval-request-detail";
import type { AnalystRequestDetail } from "@/lib/approval-request-detail-types";
import { requireNominalApprovalDashboardAccess } from "../../approval-dashboard-access";
import ApprovalDashboardShell from "../../approval-dashboard-shell";
import AnalystRequestDetailView, { analystRequestReturnHref } from "./analyst-request-detail";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Detalle de solicitud | Aprobaciones | FINSER PAY",
  description: "Consulta autorizada del expediente y avance de la solicitud.",
};

export default async function AnalystRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const user = await requireNominalApprovalDashboardAccess();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const returnHref = analystRequestReturnHref(query.returnTo);
  let detail: AnalystRequestDetail | null = null;
  let failed = false;

  try {
    detail = await getAnalystRequestDetail(id, user.id);
  } catch {
    failed = true;
    console.error("[approval-request-detail] No se pudo consultar la solicitud", { requestId: id });
  }

  if (!failed && !detail) notFound();

  const retryHref = `/dashboard/aprobaciones/solicitudes/${encodeURIComponent(id)}?returnTo=${encodeURIComponent(returnHref)}`;

  return <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/solicitudes" user={user}>
    <AdminWorkspaceTopbar
      parent="Aprobaciones"
      current="Detalle de solicitud"
      userName={user.nombre}
      userRole={user.rolNombre}
    />
    <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      {detail ? <AnalystRequestDetailView detail={detail} returnHref={returnHref} /> : <div className="grid gap-6">
        <PageHeader
          eyebrow="Solicitudes"
          title="Detalle de solicitud"
          actions={<Link href={returnHref} prefetch={false} className="fp-ui-button is-secondary">
            <ArrowLeft size={18} aria-hidden="true" />Volver al muro
          </Link>}
        />
        <Card>
          <EmptyState
            title="No se pudo cargar la solicitud"
            description="Intenta consultar de nuevo en unos momentos."
            action={<a href={retryHref} className="fp-ui-button is-primary">
              <RefreshCw size={18} aria-hidden="true" />Volver a intentar
            </a>}
          />
        </Card>
      </div>}
    </main>
  </ApprovalDashboardShell>;
}