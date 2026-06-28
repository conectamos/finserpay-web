import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import MassCreditImportConsole from "./mass-credit-import-console";

export const metadata = {
  title: "Creditos masivos | FINSER PAY",
  description: "Carga administrativa de creditos historicos cobrables",
};

export default async function CreditosMasivosPage() {
  await requireCentralAdminDashboardAccess();

  return <MassCreditImportConsole />;
}
