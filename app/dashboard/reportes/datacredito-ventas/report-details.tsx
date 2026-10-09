"use client";
import { useState } from "react";
import { Info, Search } from "lucide-react";
import { Button, Card, DataTable, EmptyState, Input } from "@/app/_components/finser-ui";
import type { QueryRankingRow } from "@/lib/datacredito/query-report-details";
import styles from "./query-report.module.css";

export type ReportDetails = {
  summary: { approved: number; rejected: number; notEvaluated: number; originalQueries: number };
  sites: QueryRankingRow[];
  sellers: QueryRankingRow[];
  leaders: { allyId: number | null; allyName: string; sites: QueryRankingRow[]; sellers: QueryRankingRow[] }[];
};
const count = (n: number) => n.toLocaleString("es-CO");
export function ReportHelp({text}:{text:string}) {
  return <span className={styles.help}><button type="button" aria-label={text}><Info aria-hidden="true"/></button><span role="tooltip" className={styles.tooltip}>{text}</span></span>;
}
const normalize = (value:string)=>value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es-CO").trim();
export default function ReportDetailView({ report, periodLabel, allyName }: { report: ReportDetails; periodLabel:string; allyName:string }) {
  const [view, setView] = useState<"sites" | "sellers">("sites");
  const [search,setSearch] = useState("");
  const leaders=report.leaders.filter(a=>normalize(a.allyName).includes(normalize(search)));
  const rows = report[view];
  const approval=report.summary.originalQueries?100*report.summary.approved/report.summary.originalQueries:null;
  return <>
    <div className={styles.outcomes}>
      {[
        {label:"Aprobadas",value:count(report.summary.approved),dot:styles.positive,help:"Decisiones de aprobación de consultas nuevas."},
        {label:"Rechazadas",value:count(report.summary.rejected),dot:styles.negative,help:"Decisiones de rechazo de consultas nuevas. No incluye errores técnicos."},
        {label:"No evaluadas",value:count(report.summary.notEvaluated),dot:"",help:"Consultas nuevas sin decisión comercial, incluidos errores técnicos. No son rechazos."},
        {label:"% de aprobación",value:approval===null?"—":`${approval.toLocaleString("es-CO",{maximumFractionDigits:1,minimumFractionDigits:1})} %`,dot:null,help:"Consultas aprobadas / consultas nuevas × 100."},
      ].map(item=><div className={styles.outcome} key={item.label}>{item.dot!==null&&<span aria-hidden="true" className={`${styles.dot} ${item.dot}`}/>}<div><strong>{item.value}</strong><span>{item.label}<ReportHelp text={item.help}/></span></div></div>)}
    </div>
    <Card className={styles.panel}>
      <div className={styles.panelHeading}><div><h2>Mayor actividad por aliado</h2><p>Consultas nuevas<ReportHelp text="Se muestran todos los empates y sus cantidades. Las reutilizadas no cuentan. El buscador solo filtra esta tabla; las exportaciones incluyen todos los resultados del período y aliado consultados."/></p></div><label className={styles.search}><span className="sr-only">Buscar aliado</span><Search aria-hidden="true"/><Input type="search" placeholder="Buscar aliado" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
      {leaders.length ? <DataTable className={styles.tableWrap}><table className={`${styles.table} ${styles.leadersTable}`}><caption className="sr-only">Sedes y vendedores líderes por aliado, incluidos empates</caption><thead><tr>{["Aliado","Sede con más consultas","Vendedores con más consultas"].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{leaders.map(a=><tr key={a.allyId??"none"}><th scope="row">{a.allyName}</th>{[a.sites,a.sellers].map((winners,i)=><td key={i}>{winners.length?<div className={i?styles.ties:undefined}>{winners.map(w=><div key={w.key}>{w.name} <strong>({count(w.originalQueries)})</strong></div>)}</div>:<span className={styles.muted}>Sin consultas nuevas</span>}</td>)}</tr>)}</tbody></table></DataTable>:<EmptyState title={search?"Sin coincidencias":"Sin actividad"} description={search?"No hay aliados con ese nombre en el resultado consultado.":"No hay consultas para los filtros aplicados."}/>}
    </Card>
    <p className={styles.period}>Período: {periodLabel} · {allyName}.<ReportHelp text="Fechas en America/Bogota. Los indicadores, detalles y exportaciones usan el período y aliado del último resultado consultado."/></p>
    <Card className={styles.panel}>
      <div className={styles.panelHeading}><div><h2>Detalle de consultas por {view==="sites"?"sede":"vendedor"}</h2><p>Ordenado por consultas nuevas<ReportHelp text="Vendedor corresponde a quien consultó. Se agrupa por identificador, incluso si hay nombres iguales."/></p></div><div className={styles.detailTabs} role="group" aria-label="Detalle de consultas"><Button variant={view==="sites"?"primary":"secondary"} aria-pressed={view==="sites"} onClick={()=>setView("sites")}>Sedes</Button><Button variant={view==="sellers"?"primary":"secondary"} aria-pressed={view==="sellers"} onClick={()=>setView("sellers")}>Vendedores</Button></div></div>
      {rows.length?<DataTable className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Detalle completo de consultas por {view==="sites"?"sede":"vendedor"}</caption><thead><tr>{["Aliado",view==="sites"?"Sede":"Vendedor / consultó","Nuevas","Aprobadas","Rechazadas","No evaluadas","Reutilizadas","% aprobación"].map((h,i)=><th key={h} scope="col" className={i>1?styles.numeric:undefined}>{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.key}><td>{r.allyName}</td><th scope="row">{r.name}</th>{[r.originalQueries,r.approved,r.rejected,r.notEvaluated,r.reusedAssessments].map((n,i)=><td key={i} className={styles.numeric}>{count(n)}</td>)}<td className={styles.numeric}>{r.originalQueries?`${(100*r.approved/r.originalQueries).toLocaleString("es-CO",{maximumFractionDigits:1})} %`:"—"}</td></tr>)}</tbody></table></DataTable>:<EmptyState title="Sin actividad" description="No hay consultas para el período y aliado consultados."/>}
    </Card>
  </>;
}
