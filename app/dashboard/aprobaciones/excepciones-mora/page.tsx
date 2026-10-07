import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import { requireMoraDashboardAccess } from "../mora-dashboard-access";
import MoraExceptionRequestsClient from "./mora-exception-requests-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Excepciones de mora | FINSER PAY", description: "Solicitudes, soportes y revisión de excepciones y prórrogas por crédito." };
export default async function MoraExceptionRequestsPage({ searchParams }: { searchParams: Promise<{ credito?: string | string[]; nueva?: string | string[] }> }) {
  const { actor, user } = await requireMoraDashboardAccess();
  const params = await searchParams;
  const value = Number(Array.isArray(params.credito) ? params.credito[0] : params.credito);
  const initialCreditId = Number.isSafeInteger(value) && value > 0 ? value : null;
  const initialCreateOpen = (Array.isArray(params.nueva) ? params.nueva[0] : params.nueva) === "1";
  return <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/excepciones-mora" user={user}>
    <AdminWorkspaceTopbar parent="Aprobaciones" current="Excepciones de mora" userName={user.nombre} userRole={user.rolNombre} />
    <MoraExceptionRequestsClient centralAdmin={actor.centralAdmin} initialCreditId={initialCreditId} initialCreateOpen={initialCreateOpen} />
  </ApprovalDashboardShell>;
}
