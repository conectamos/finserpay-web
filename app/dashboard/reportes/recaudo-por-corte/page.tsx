import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { parseCutFilters } from "@/lib/cut-collection-access";
import type { CutFilters, CutStatus } from "@/lib/cut-collection-types";
import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import RecaudoPorCorteClient from "./recaudo-por-corte-client";
import styles from "./recaudo-por-corte.module.css";

type Query = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positiveId(value: string | string[] | undefined) {
  const parsed = Number(first(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function initialFilters(query: Query): CutFilters {
  const defaults = parseCutFilters({});
  const month = Number(first(query.month));
  const year = Number(first(query.year));
  const status = first(query.status);

  return {
    day: first(query.day) === "2" || first(query.day) === "02" ? 2 : first(query.day) === "17" ? 17 : defaults.day,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : defaults.month,
    year: Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : defaults.year,
    aliadoId: positiveId(query.aliadoId),
    sedeId: positiveId(query.sedeId),
    status: ["pendiente", "parcial", "pagado"].includes(status || "") ? status as CutStatus : "todos",
  };
}

export const metadata = {
  title: "Recaudo por corte | FINSER PAY",
  description: "Proyecciones de cuotas por vencimiento y seguimiento del recaudo aplicado.",
};

export default async function RecaudoPorCortePage({ searchParams }: { searchParams: Promise<Query> }) {
  const { admin, session, supervisor } = await requireAdminOrSupervisorDashboardAccess();
  const query = await searchParams;
  const projectionId = String(first(query.projectionId) || "");

  return <div className={styles.shell}>
    <FinserNavigation
      variant="requests"
      activeSection="portfolio"
      admin={admin}
      adminCentral={admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo)}
      isSupervisor={supervisor}
      nombreUsuario={session.nombre}
      rolUsuario={session.rolNombre}
    />
    <main className={styles.main}>
      <RecaudoPorCorteClient
        initialFilters={initialFilters(query)}
        initialProjectionId={/^[a-f0-9-]{36}$/i.test(projectionId) ? projectionId : null}
      />
    </main>
  </div>;
}
