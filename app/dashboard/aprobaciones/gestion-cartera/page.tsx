import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import { requireMoraDashboardAccess } from "../mora-dashboard-access";
import MoraPortfolioClient from "../cartera-mora/mora-portfolio-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Gestión de cartera | Aprobaciones | FINSER PAY",
  description: "Gestiona todos los créditos y conserva su historial de contacto y seguimiento.",
};

export default async function ApprovalCollectionPortfolioPage({ searchParams }: {
  searchParams: Promise<{ creditId?: string | string[] }>;
}) {
  const { user } = await requireMoraDashboardAccess();
  const query = await searchParams;
  const rawCreditId = query.creditId;
  const candidate = typeof rawCreditId === "string" && /^[1-9]\d*$/.test(rawCreditId) ? Number(rawCreditId) : null;
  const initialCreditId = candidate !== null && Number.isSafeInteger(candidate) ? candidate : null;

  return (
    <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/gestion-cartera" user={user}>
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Gestión de cartera"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <MoraPortfolioClient scope="all" initialCreditId={initialCreditId} />
    </ApprovalDashboardShell>
  );
}
