import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import IntegrationsHub from "./integrations-hub";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Centro operativo para monitorear la sesion local y Equality Zero Touch",
};

export default async function IntegracionesPage() {
  const { session } = await requireAdminDashboardAccess();

  return <IntegrationsHub initialSession={session} />;
}
