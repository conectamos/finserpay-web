import { getSessionUser } from "@/lib/auth";
import IntegrationsHub from "./integrations-hub";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Centro operativo para monitorear la sesion local y Equality Zero Touch",
};

export default async function IntegracionesPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  return <IntegrationsHub initialSession={session} />;
}
