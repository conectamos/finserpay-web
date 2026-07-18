import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import MoraExceptionsClient from "./mora-exceptions-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Excepciones de bloqueo | FINSER PAY",
  description: "Acuerdos que conservan la mora sin bloquear el dispositivo",
};

export default async function MoraExceptionsPage() {
  await requireCentralAdminDashboardAccess();

  return <MoraExceptionsClient />;
}
