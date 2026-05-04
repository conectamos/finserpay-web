import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import GestionSedesPage from "./sedes-client";

export const metadata = {
  title: "Gestion de sedes | FINSER PAY",
  description: "Administracion de puntos de venta y accesos por sede",
};

export default async function SedesPage() {
  await requireAdminDashboardAccess();

  return <GestionSedesPage />;
}
