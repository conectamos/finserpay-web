import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import GestionUsuariosPage from "./usuarios-client";

export const metadata = {
  title: "Gestion de usuarios | FINSER PAY",
  description: "Administracion de vendedores, supervisores y administradores",
};

export default async function UsuariosPage() {
  await requireAdminDashboardAccess();

  return <GestionUsuariosPage />;
}
