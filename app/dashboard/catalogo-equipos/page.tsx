import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import EquipmentCatalogConsole from "./equipment-catalog-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Catalogo de equipos | FINSER PAY",
  description: "Administracion de modelos y precios para la fabrica de creditos",
};

export default async function CatalogoEquiposPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/catalogo-equipos"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Administracion"
        current="Catalogo de equipos"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <EquipmentCatalogConsole />
    </AppShell>
  );
}
