import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import AllyEquipmentCatalog from "./ally-equipment-catalog";
import EquipmentCatalogConsole from "./equipment-catalog-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Catálogo de equipos | FINSER PAY",
  description: "Equipos disponibles y precios base de venta de FINSER PAY",
};

export default async function CatalogoEquiposPage() {
  const { session } = await requireAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  if (!adminCentral) {
    return (
      <div className="min-h-screen bg-[var(--fp-bg)]">
        <FinserNavigation
          admin
          adminCentral={false}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
          variant="requests"
          activeSection="administration"
        />
        <AllyEquipmentCatalog />
      </div>
    );
  }

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
