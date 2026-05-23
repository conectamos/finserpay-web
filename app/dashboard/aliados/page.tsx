import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import AliadosClient from "./aliados-client";

export const metadata = {
  title: "Aliados | FINSER PAY",
  description: "Administracion de aliados comerciales y cobertura por sedes",
};

export default async function AliadosPage() {
  await requireAdminDashboardAccess();

  return <AliadosClient />;
}
