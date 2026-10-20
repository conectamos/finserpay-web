import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import FinserSupportLink from "@/app/_components/finser-support-link";
import { CircleHelp } from "lucide-react";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import DataCreditoAdminConsole from "./datacredito-admin-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Historial DataCrédito | FINSER PAY",
  description: "Auditoría central de consultas y expedientes MiDecisor",
};

export default async function DataCreditoAdminPage() {
  const access = await requireCentralAdminDashboardAccess();
  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-graphite)]">
      <FinserNavigation
        admin
        adminCentral
        nombreUsuario={access.session.nombre}
        rolUsuario={access.session.rolNombre}
        variant="administration"
        activeSection="integrations"
        accountActions={<FinserSupportLink className="inline-flex min-h-10 items-center gap-2"><CircleHelp aria-hidden="true" /><span>Ayuda</span></FinserSupportLink>}
      />
      <DataCreditoAdminConsole />
    </div>
  );
}
