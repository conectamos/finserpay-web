import { AppShell, PageHeader } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import PasswordChangeForm from "./password-change-form";

export const metadata = {
  title: "Cambiar contraseña | FINSER PAY",
  description: "Actualiza la contraseña de tu cuenta de administrador",
};

export default async function PasswordPage() {
  const { session } = await requireAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const userRole = adminCentral ? "Admin Central FINSER" : "Admin Aliados";

  return (
    <AppShell sidebar={<AdminSidebar activeHref="/dashboard/contrasena" adminCentral={adminCentral} nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
      <AdminWorkspaceTopbar parent="Mi cuenta" current="Cambiar contraseña" userName={session.nombre} userRole={userRole} />
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <PageHeader eyebrow="Seguridad de tu cuenta" title="Cambiar contraseña" description={`Actualiza la contraseña de ingreso de ${session.usuario}.`} />
        <PasswordChangeForm />
      </main>
    </AppShell>
  );
}
