import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import ReporteAbonosPage from "./reporte-abonos-client";

type SearchParams = Promise<{
  from?: string | string[];
  sedeId?: string | string[];
  to?: string | string[];
}>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function dateValue(value: string | string[] | undefined) {
  const parsed = String(firstValue(value) || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : "";
}

function idValue(value: string | string[] | undefined) {
  const parsed = String(firstValue(value) || "");
  return /^\d+$/.test(parsed) ? parsed : "";
}

export const metadata = {
  title: "Tabla de abonos | FINSER PAY",
  description: "Vista administrativa y de supervisor para consultar recaudos",
};

export default async function ReporteAbonosRoute({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminOrSupervisorDashboardAccess();
  const params = await searchParams;

  return (
    <ReporteAbonosPage
      initialFrom={dateValue(params.from)}
      initialTo={dateValue(params.to)}
      initialSedeId={idValue(params.sedeId)}
    />
  );
}
