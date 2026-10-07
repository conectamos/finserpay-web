"use client";
import { useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Download, Filter, Search } from "lucide-react";
import { Button, Card, DataTable, EmptyState, Input, PageHeader, Select, Tabs } from "@/app/_components/finser-ui";
import type { ReactNode } from "react";
import type { DashboardDelinquencyView, DashboardDelinquencyGroupView } from "@/lib/dashboard-delinquency-view";
import styles from "./mora.module.css";
const percent = (n: number) => n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
type Group = { id: string; nombre: string; context: string | null; cantidad: number; participacion: number; aporte: number; saldoPendiente?: number; unassigned: boolean };
type SortKey = "nombre" | "cantidad" | "saldoPendiente" | "participacion" | "aporte";
export default function DelinquencyWorkspace({ detail, canViewBalances: central, scopeLabel: ally, updatedAt, exportHref, filters, creditLinks = {}, initialMode = "sedes" }: { detail: DashboardDelinquencyView; canViewBalances: boolean; scopeLabel: string; updatedAt: string; exportHref: string; filters?: ReactNode; creditLinks?: Readonly<Record<string,string>>; initialMode?: "sedes" | "vendedores" }) {
  const mapGroup = (g: DashboardDelinquencyGroupView): Group => ({ id:g.key, nombre:g.name, context:g.context, cantidad:g.overdueCredits, participacion:g.overdueSharePercent, aporte:g.overduePortfolioPercent, saldoPendiente:g.overdueBalance, unassigned:g.unassigned });
  const data = { porcentaje:detail.overduePortfolioPercent, cantidad:detail.overdueCredits, saldoPendiente:detail.overdueBalance, sedes:detail.sites.map(mapGroup), vendedores:detail.sellers.map(mapGroup) };
  const date = new Date(updatedAt);
  const updated = Number.isNaN(date.getTime()) ? "al consultar" : new Intl.DateTimeFormat("es-CO", {timeZone:"America/Bogota",dateStyle:"medium",timeStyle:"short"}).format(date);
  const [mode, setMode] = useState<"sedes" | "vendedores">(initialMode);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{key:SortKey;desc:boolean}>({key:"participacion",desc:true});
  const rows = data[mode].filter(r => r.nombre.toLocaleLowerCase("es").includes(search.trim().toLocaleLowerCase("es")) && (!group || r.id === group) && (!state || (state === "mora" ? r.cantidad > 0 : r.cantidad === 0))).sort((a,b) => {
    const x=a[sort.key] ?? 0, y=b[sort.key] ?? 0;
    const cmp=typeof x === "number" && typeof y === "number" ? x-y : String(x).localeCompare(String(y),"es");
    return (sort.desc ? -cmp : cmp) || a.id.localeCompare(b.id);
  });
  const pages=Math.max(1, Math.ceil(rows.length/6));
  const current=Math.min(page,pages);
  const visible=rows.slice((current-1)*6,current*6);
  const clearSelection=()=>{setPage(1);};
  const columns: [SortKey,string][] = [["nombre",mode === "sedes" ? "Sede" : "Vendedor"],["cantidad","Créditos en mora"],...(central ? [["saldoPendiente","Saldo pendiente en mora"] as [SortKey,string]] : []),["participacion","Participación en la mora"],["aporte","Aporte a cartera"]];
  const concentration=(items:Group[],label:string)=>{
    const keys = label.includes("sede") ? detail.leadingSiteKeys : detail.leadingSellerKeys;
    const leaders=items.filter(r=>r.cantidad>0 && keys.includes(r.id));
    const first=leaders[0];
    return <div><p>{label}</p><strong>{first ? `${first.nombre} · ${first.cantidad} créditos` : "Sin créditos en mora"}</strong>{first && <p><span className={styles.danger}>{percent(first.participacion)}%</span> de participación en el saldo en mora</p>}</div>;
  };
  return <div className={styles.main}>
    <PageHeader className={styles.heading} title="Detalle de mora" description={`${ally} · Cartera actual`} actions={<div className={styles.actions}><span>Actualizado {updated}</span><a className={`fp-ui-button is-primary ${styles.export}`} href={exportHref}><Download size={20} aria-hidden="true"/>Exportar</a></div>} />
    <Card className={styles.summary} aria-label="Resumen de mora de cartera"><div><strong className={styles.danger}>{percent(data.porcentaje)}%</strong><span>Mora de cartera</span></div><div><strong>{data.cantidad}</strong><span>Créditos en mora</span></div>{central && <div><strong>{money(data.saldoPendiente ?? 0)}</strong><span>Saldo pendiente de créditos en mora</span></div>}</Card>
    <Card className={styles.tableCard}><div className={styles.toolbar}><Tabs aria-label="Agrupar mora"><button role="tab" aria-selected={mode==="sedes"} onClick={()=>{setMode("sedes");setGroup("");setSearch("");clearSelection();}}>Por sede</button><button role="tab" aria-selected={mode==="vendedores"} onClick={()=>{setMode("vendedores");setGroup("");setSearch("");clearSelection();}}>Por vendedor</button></Tabs><div className={styles.controls}><label className={styles.search}><Search size={20} aria-hidden="true"/><Input aria-label={mode === "sedes" ? "Buscar sede" : "Buscar vendedor"} placeholder={mode === "sedes" ? "Buscar sede…" : "Buscar vendedor…"} value={search} onChange={e=>{setSearch(e.target.value);clearSelection();}}/></label><Button variant="secondary" aria-expanded={expanded} aria-controls="mora-filters" onClick={()=>setExpanded(!expanded)}><Filter size={18} aria-hidden="true"/>Filtros</Button></div></div>
      {expanded && <section id="mora-filters" className={styles.filters} aria-label="Filtros de detalle">{filters}<label>{mode==="sedes" ? "Sede" : "Vendedor"}<Select value={group} onChange={e=>{setGroup(e.target.value);clearSelection();}}><option value="">Todos</option>{data[mode].map(r=><option key={r.id} value={r.id}>{r.nombre}</option>)}</Select></label><label>Créditos en mora<Select value={state} onChange={e=>{setState(e.target.value);clearSelection();}}><option value="">Todos los grupos</option><option value="mora">Con créditos en mora</option><option value="sinMora">Sin créditos en mora</option></Select></label><Button variant="secondary" onClick={()=>{setGroup("");setState("");setSearch("");clearSelection();}}>Limpiar filtros</Button></section>}
      {rows.length ? <DataTable className={styles.table}><table><thead><tr>{columns.map(([key,label])=><th key={key} aria-sort={sort.key===key ? sort.desc ? "descending" : "ascending" : "none"}><button onClick={()=>{setSort({key,desc:sort.key===key ? !sort.desc : false});setPage(1);}}>{label}<span aria-hidden="true">{sort.key===key ? sort.desc ? " ↓" : " ↑" : " ↕"}</span></button></th>)}<th>Detalle</th></tr></thead><tbody>{visible.map(r=><tr key={r.id}><td><strong>{r.nombre}</strong>{r.context && <small className={styles.context}>{r.context}</small>}</td><td>{r.cantidad}</td>{central && <td>{money(r.saldoPendiente ?? 0)}</td>}<td><div className={styles.rate}><span className={r.cantidad ? styles.danger : undefined}>{percent(r.participacion)}%</span><div className={styles.track} aria-hidden="true"><span style={{width:`${r.participacion}%`}}/></div></div></td><td>{percent(r.aporte)} pp</td><td><a className={styles.detailButton} aria-label={`Ver créditos en mora de ${r.nombre}`} href={creditLinks[mode === "sedes" ? r.id : `seller:${r.id}`]}>Ver créditos<ArrowRight size={18} aria-hidden="true"/></a></td></tr>)}</tbody></table></DataTable> : <EmptyState title="Sin grupos para esta selección" description="Prueba otra búsqueda o limpia los filtros."/>}
      <footer className={styles.footer}><span aria-live="polite">{rows.length ? `${(current-1)*6+1}–${Math.min(current*6,rows.length)}` : "0"} de {rows.length} {mode}</span><nav aria-label="Paginación de mora"><Button variant="ghost" aria-label="Página anterior" disabled={current===1} onClick={()=>setPage(current-1)}><ChevronLeft size={18}/></Button><span>{current} / {pages}</span><Button variant="ghost" aria-label="Página siguiente" disabled={current===pages} onClick={()=>setPage(current+1)}><ChevronRight size={18}/></Button></nav></footer>
    </Card>
    <Card className={styles.concentration}>{concentration(data.sedes,"Mayor concentración por sede")}{concentration(data.vendedores,"Mayor concentración por vendedor")}</Card>
    <p className={styles.note}>El saldo pendiente en mora es el saldo total de los créditos en mora. La participación es su proporción del saldo en mora del comercio, no una tasa individual. El aporte usa el saldo pendiente de créditos en mora del grupo / saldo pendiente de cartera × 100 y se expresa en puntos porcentuales; sus totales coinciden con el porcentaje de Salud de cartera. Búsqueda y filtros de grupos delimitan la tabla; el resumen conserva el total del aliado consultado.</p>
  </div>;
}
