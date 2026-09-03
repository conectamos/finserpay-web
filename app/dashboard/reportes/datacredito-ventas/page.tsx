import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import DataCreditoVentasClient from "./datacredito-ventas-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Consultas DataCrédito vs. ventas | FINSER PAY",
  description:
    "Reporte central de consultas DataCrédito y ventas finalizadas por aliado",
};

function bogotaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Bogota",
    year: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

export default async function DataCreditoVentasReportPage() {
  const { session } = await requireCentralAdminDashboardAccess();

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/reportes"
          adminCentral
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Reportes"
        current="DataCrédito vs. ventas"
        userName={session.nombre}
        userRole={session.rolNombre}
      />
      <DataCreditoVentasClient initialDay={bogotaToday()} />
    </AppShell>
  );
}
