import { redirect } from "next/navigation";
import { Card } from "@/app/_components/finser-ui";
import SharedLogout from "@/app/revision-creditos/shared-logout";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { canManageApprovalAnalysts, canReviewCreditApprovals, isApprovalAnalystRole } from "@/lib/roles";
import ApprovalDashboardShell from "./approval-dashboard-shell";
import ApprovalWorkspace from "./approval-workspace";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Aprobaciones | FINSER PAY",
  description: "Revisión documental y aprobación de créditos para liquidación a aliados",
};

export default async function AprobacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ credito?: string | string[] }>;
}) {
  const user = await getCreditApprovalSessionUser();
  if (!user) redirect("/aliados");
  if (!canReviewCreditApprovals(user)) redirect("/dashboard");
  const sharedContext = await getApprovalSharedRequestActor();
  const centralAdmin = canManageApprovalAnalysts(user);
  const analystDesk = isApprovalAnalystRole(user.rolNombre) && sharedContext === undefined;
  const params = await searchParams;
  const rawCreditId = Array.isArray(params.credito) ? params.credito[0] : params.credito;
  const parsedCreditId = Number(rawCreditId);
  const focusApprovalCreditId = Number.isSafeInteger(parsedCreditId) && parsedCreditId > 0
    ? parsedCreditId
    : null;

  return (
    <ApprovalDashboardShell activeHref="/dashboard/aprobaciones" user={user}>
      {sharedContext !== undefined && <Card className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-4 border-[var(--fp-amber)] p-4 sm:mx-6 lg:mx-8">
        <div role="status">
          <p className="font-semibold">{sharedContext ? "Acceso compartido activo en este navegador" : "El acceso compartido venció o fue revocado"}</p>
          <p className="mt-1 text-sm text-[var(--fp-muted)]">Cierra el acceso compartido para continuar con tu cuenta personal y registrar las acciones con tu nombre.</p>
        </div>
        <SharedLogout returnTo="/dashboard/aprobaciones" />
      </Card>}
      <ApprovalWorkspace redesigned analystDesk={analystDesk} allowOperations={sharedContext === undefined}
        canManageSadmin={centralAdmin && sharedContext === undefined}
        manageLegacySharedAccess={centralAdmin && sharedContext === undefined} userName={user.nombre}
        initialFocusApprovalCreditId={focusApprovalCreditId} />
    </ApprovalDashboardShell>
  );
}
