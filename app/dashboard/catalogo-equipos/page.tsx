import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import EquipmentCatalogConsole from "./equipment-catalog-console";

export const dynamic = "force-dynamic";

export default async function CatalogoEquiposPage() {
  await requireCentralAdminDashboardAccess();

  return <EquipmentCatalogConsole />;
}
