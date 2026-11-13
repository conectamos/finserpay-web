import { Badge, Card } from "@/app/_components/finser-ui";
import type { CutRiskMetric } from "@/lib/cut-collection-types";
import { getCutFpdLevel } from "@/lib/cut-risk-presentation";
import type { AllyDashboardFpdData } from "../_lib/ally-dashboard-fpd";
import styles from "./ally-dashboard-fpd-panel.module.css";

const days = [3, 7, 15] as const;
const percentage = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const cutDay = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", timeZone: "America/Bogota" });

function Rate({ metrics, day }: { metrics: CutRiskMetric[]; day: number }) {
  const metric = metrics.find(item => item.label === `DPF ${day}` || item.label === `FPD ${day}`);
  if (!metric || !Number.isFinite(metric.eligible) || metric.eligible <= 0 || !Number.isFinite(metric.cases) || metric.cases < 0) {
    return <span className={styles.pending}>Pendiente</span>;
  }
  const value = metric.cases / metric.eligible * 100;
  const level = getCutFpdLevel(value);
  return <div className={styles.metric}>
    <strong>{percentage.format(value)}<span> %</span></strong>
    <Badge tone={level === "MALO" ? "danger" : level === "REGULAR" ? "warning" : "positive"}>{level.charAt(0) + level.slice(1).toLowerCase()}</Badge>
  </div>;
}

function CutDate({ value }: { value: string }) {
  return <time dateTime={value}><span>{cutDay.format(new Date(`${value}T12:00:00Z`))}</span><small>{value.slice(0, 4)}</small></time>;
}

export default function AllyDashboardFpdPanel({ data }: { data?: AllyDashboardFpdData }) {
  const cuts = data?.status === "ready" ? [...data.cuts].sort((left, right) => right.cutDate.localeCompare(left.cutDate)).slice(0, 3) : [];

  return <Card className={styles.panel} role="region" aria-labelledby="ally-dashboard-fpd-title">
    <header className={styles.header}><div><h2 id="ally-dashboard-fpd-title">FPD por corte</h2><p>Últimos 3 cortes</p></div></header>
    {data?.status !== "ready" ? <p className={styles.empty} role="status">FPD no disponible.</p> : !cuts.length ? <p className={styles.empty} role="status">Sin cortes disponibles.</p> : <>
      <table className={styles.table} aria-label="FPD de los últimos tres cortes">
        <thead><tr><th scope="col">Corte</th>{days.map(day => <th key={day} scope="col">FPD {day}</th>)}</tr></thead>
        <tbody>{cuts.map(cut => <tr key={cut.cutDate}><th scope="row"><CutDate value={cut.cutDate} /></th>{days.map(day => <td key={day}><Rate metrics={cut.earlyRisk} day={day} /></td>)}</tr>)}</tbody>
      </table>
      <div className={styles.mobile} aria-label="FPD de los últimos tres cortes">
        {cuts.map(cut => <section className={styles.mobileCut} key={cut.cutDate} aria-labelledby={`ally-fpd-cut-${cut.cutDate}`}><h3 id={`ally-fpd-cut-${cut.cutDate}`}><CutDate value={cut.cutDate} /></h3><dl>{days.map(day => <div key={day}><dt>FPD {day}</dt><dd><Rate metrics={cut.earlyRisk} day={day} /></dd></div>)}</dl></section>)}
      </div>
    </>}
  </Card>;
}
