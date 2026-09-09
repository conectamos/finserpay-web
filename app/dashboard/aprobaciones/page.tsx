import { redirect } from "next/navigation";
import { AppShell, Card } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { canReviewCreditApprovals } from "@/lib/roles";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import SharedLogout from "@/app/revision-creditos/shared-logout";
import SharedAccessControl from "./shared-access-control";
import { canManageApprovalAnalysts } from "@/lib/roles";
import ApprovalConsole from "./approval-console";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Aprobaciones | FINSER PAY",
  description: "Revisión documental y aprobación de créditos para liquidación a aliados",
};

export default async function AprobacionesPage() {
  const user = await getCreditApprovalSessionUser();
  if (!user) redirect("/");
  if (!canReviewCreditApprovals(user)) redirect("/dashboard");
  const sharedContext = await getApprovalSharedRequestActor();

  return (
    <AppShell sidebar={
      <AdminSidebar
        activeHref="/dashboard/aprobaciones"
        adminCentral={isFinserPayCentralAlly(user.aliadoAccesoCodigo)}
        nombreUsuario={user.nombre}
        rolUsuario={user.rolNombre}
      />
    }>
      <AdminWorkspaceTopbar
        parent="Operación financiera"
        current="Aprobaciones"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      {sharedContext !== undefined && <Card className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-4 border-[var(--fp-amber)] p-4 sm:mx-6 lg:mx-8">
        <div role="status"><p className="font-semibold">{sharedContext ? "Acceso compartido activo en este navegador" : "El acceso compartido venció o fue revocado"}</p>
          <p className="mt-1 text-sm text-[var(--fp-muted)]">{sharedContext
            ? "Las revisiones se registrarán con el acceso compartido. Ciérralo para trabajar con tu cuenta personal."
            : "Cierra ese acceso para continuar con tu cuenta personal."}</p></div>
        <SharedLogout returnTo="/dashboard/aprobaciones" />
      </Card>}
      {canManageApprovalAnalysts(user) && <SharedAccessControl />}
      <ApprovalConsole />
    </AppShell>
  );
}
