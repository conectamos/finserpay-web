import { redirect } from "next/navigation";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { canReviewCreditApprovals } from "@/lib/roles";
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
      <ApprovalConsole />
    </AppShell>
  );
}
