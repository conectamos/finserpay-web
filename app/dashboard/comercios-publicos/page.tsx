import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import MerchantsManager from "./merchants-manager";

export const metadata = { title: "¿Dónde comprar? | Administración FINSER PAY" };
export default async function PublicMerchantsPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  return <AppShell sidebar={<AdminSidebar activeHref="/dashboard/comercios-publicos" adminCentral nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
    <AdminWorkspaceTopbar parent="Administración" current="¿Dónde comprar?" userName={session.nombre} userRole={session.rolNombre} />
    <MerchantsManager />
  </AppShell>;
}
