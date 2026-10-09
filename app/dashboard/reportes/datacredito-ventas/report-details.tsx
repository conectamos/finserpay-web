"use client";

import { useState } from "react";
import { Button, Card, DataTable, EmptyState, MetricCard } from "@/app/_components/finser-ui";
import type { QueryRankingRow } from "@/lib/datacredito/query-report-details";

export type ReportDetails = {
  summary: { approved: number; rejected: number; notEvaluated: number; originalQueries: number };
  sites: QueryRankingRow[];
  sellers: QueryRankingRow[];
  leaders: { allyId: number | null; allyName: string; sites: QueryRankingRow[]; sellers: QueryRankingRow[] }[];
};
const count = (n: number) => n.toLocaleString("es-CO");
export default function ReportDetailView({ report }: { report: ReportDetails }) {
  const [view, setView] = useState<"sites" | "sellers">("sites");
  const rows = report[view];
  return <>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <MetricCard label="Consultas aprobadas" value={count(report.summary.approved)} detail={report.summary.originalQueries ? `${(100*report.summary.approved/report.summary.originalQueries).toLocaleString("es-CO",{maximumFractionDigits:1})} % de las consultas nuevas` : "Sin consultas nuevas"} />
      <MetricCard label="Consultas rechazadas" value={count(report.summary.rejected)} detail="Decisión comercial de rechazo" />
      <MetricCard label="No evaluadas" value={count(report.summary.notEvaluated)} detail="Incluye errores técnicos; no son rechazos" />
    </div>
    <Card className="mt-4 !p-0 overflow-hidden">
      <h3 className="px-5 py-4 font-bold">Quién realizó más consultas nuevas</h3>
      <DataTable><table className="w-full min-w-[720px] text-sm"><caption className="sr-only">Sedes y vendedores líderes por aliado, incluidos empates</caption>
        <thead><tr>{["Aliado","Sede líder","Vendedor líder"].map(h => <th key={h} className="px-5 py-3 text-left" scope="col">{h}</th>)}</tr></thead>
        <tbody>{report.leaders.map(a => <tr key={a.allyId ?? "none"}>
          <th scope="row" className="px-5 py-4 text-left">{a.allyName}</th>
          {[a.sites,a.sellers].map((winners,i)=><td key={i} className="px-5 py-4">{winners.length ? winners.map(w=><div key={w.key}>{w.name} <strong className="tabular-nums">({count(w.originalQueries)})</strong></div>) : "Sin consultas nuevas"}</td>)}
        </tr>)}</tbody>
      </table></DataTable>
    </Card>
    <Card className="mt-4 !p-0 overflow-hidden">
      <div className="flex flex-wrap gap-3 items-center justify-between px-5 py-4">
        <div><h3 className="font-bold">Detalle de consultas por {view === "sites" ? "sede" : "vendedor"}</h3><p className="text-sm text-[var(--fp-muted)]">Ordenado por consultas nuevas dentro de cada aliado.</p></div>
        <div className="flex gap-2" role="group" aria-label="Detalle de consultas">
          <Button variant={view === "sites" ? "primary" : "secondary"} aria-pressed={view === "sites"} onClick={()=>setView("sites")}>Sedes</Button>
          <Button variant={view === "sellers" ? "primary" : "secondary"} aria-pressed={view === "sellers"} onClick={()=>setView("sellers")}>Vendedores</Button>
        </div>
      </div>
      {rows.length ? <DataTable><table className="w-full min-w-[960px] text-sm"><caption className="sr-only">Detalle completo de consultas por {view === "sites" ? "sede" : "vendedor"}</caption>
        <thead><tr>{["Aliado",view === "sites" ? "Sede" : "Vendedor / consultó","Nuevas","Aprobadas","Rechazadas","No evaluadas","Reutilizadas","% aprobación"].map((h,i)=><th key={h} scope="col" className={`px-4 py-3 ${i<2 ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map(r=><tr key={r.key}><td className="px-4 py-3">{r.allyName}</td><th scope="row" className="px-4 py-3 text-left font-semibold">{r.name}</th>
          {[r.originalQueries,r.approved,r.rejected,r.notEvaluated,r.reusedAssessments].map((n,i)=><td key={i} className="px-4 py-3 text-right tabular-nums">{count(n)}</td>)}
          <td className="px-4 py-3 text-right tabular-nums">{r.originalQueries ? `${(100*r.approved/r.originalQueries).toLocaleString("es-CO",{maximumFractionDigits:1})} %` : "—"}</td>
        </tr>)}</tbody>
      </table></DataTable> : <EmptyState title="Sin actividad" description="No hay consultas para este período y aliado." />}
      <p className="px-5 py-3 text-xs text-[var(--fp-muted)]">Vendedor corresponde a quien consultó. Se agrupa por identificador, incluso cuando hay nombres iguales. Las reutilizadas no se incluyen en el ranking.</p>
    </Card>
  </>;
}
