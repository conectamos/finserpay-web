"use client";

import { useMemo, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Filter, Search, Smartphone } from "lucide-react";
import { Button, Card, DataTable, EmptyState, Input, PageHeader, Select, Tabs } from "@/app/_components/finser-ui";
import { aggregateProductRisk, emptyProductRiskFilters, filterRiskCredits, summarizeProductRisk, type ProductRiskCredit, type ProductRiskFilters } from "@/lib/product-risk";
import styles from "./risk.module.css";

type Row = ReturnType<typeof aggregateProductRisk>[number];
type SortKey = "referencia" | "financiadas" | "mora" | "porcentaje" | "vencido";
const money = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
const percent = (n: number) => `${n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const number = (n: number) => n.toLocaleString("es-CO");
const tabs = [["", "Todas las referencias"], ["IPHONE", "iPhone"], ["ANDROID", "Android"]] as const;

export default function RiskConsole({ credits, cutoff, adminCentral: central = false, scopeLabel }: { credits: ProductRiskCredit[]; cutoff: string; adminCentral?: boolean; scopeLabel?: string }) {
  const [filters, setFilters] = useState<ProductRiskFilters>({ ...emptyProductRiskFilters });
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "porcentaje", desc: true });
  const [selected, setSelected] = useState<string | null>(null);
  const invalid = Boolean(filters.desde && filters.hasta && filters.desde > filters.hasta) || Boolean(filters.minDias && filters.maxDias && Number(filters.minDias) > Number(filters.maxDias));
  // Tabs, search and all filters define the same credit population for totals and detail.
  const filtered = useMemo(() => invalid ? [] : filterRiskCredits(credits, filters).filter(c => (!tab || c.tipo === tab) && c.referencia.toLocaleLowerCase("es").includes(search.trim().toLocaleLowerCase("es"))), [credits, filters, invalid, tab, search]);
  const groups = useMemo(() => aggregateProductRisk(filtered), [filtered]);
  const sorted = [...groups].sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "es");
    return (sort.desc ? -cmp : cmp) || a.key.localeCompare(b.key);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / 7));
  const current = Math.min(page, pages);
  const visible = sorted.slice((current - 1) * 7, current * 7);
  const total = summarizeProductRisk(filtered);
  const detail = groups.find(r => r.key === selected);
  const update = (key: keyof ProductRiskFilters, val: string) => { setFilters(f => ({ ...f, [key]: val, ...(key === "marca" ? { referencia: "" } : {}), ...(key === "aliado" ? { sede: "" } : {}) })); setPage(1); setSelected(null); };
  const options = (key: "marca" | "referencia" | "aliado" | "sede") => [...new Set(credits.filter(c => (key !== "referencia" || !filters.marca || c.marca === filters.marca) && (key !== "sede" || !filters.aliado || c.aliado === filters.aliado)).map(c => c[key]))].sort((a, b) => a.localeCompare(b, "es"));
  const openDetail = (key: string) => { setSelected(key); requestAnimationFrame(() => document.getElementById("reference-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const columns: [SortKey, string][] = [["referencia", "Referencia"], ["financiadas", "Financiados"], ["mora", "En mora"], ["porcentaje", "% mora"], ...(central ? [["vencido", "Saldo vencido"] as [SortKey, string]] : [])];
  const reset = () => { setFilters({ ...emptyProductRiskFilters }); setSearch(""); setTab(""); setPage(1); setSelected(null); };
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const metric = (summary: ReturnType<typeof summarizeProductRisk>) => <>
    <div><strong>{number(summary.financiadas)}</strong><span>financiados</span></div>
    <div><strong className={styles.danger}>{number(summary.mora)}</strong><span>en mora</span></div>
    <div><strong>{percent(summary.porcentaje)}</strong><span>mora por unidades</span></div>
  </>;
  return <main className={styles.main}>
    <PageHeader className={styles.heading} title="Riesgo por referencia" description={central ? `Información de ${filters.aliado || scopeLabel || "todos los aliados"}` : `Información de tu comercio · ${scopeLabel || "Mi aliado"}`} />
    {central && <label className={styles.allyFilter}>Aliado<Select aria-label="Filtrar por aliado" value={filters.aliado} onChange={e => update("aliado", e.target.value)}><option value="">Todos los aliados</option>{options("aliado").map(ally => <option key={ally} value={ally}>{ally}</option>)}</Select></label>}
    <Card className={styles.summary} aria-label="Resumen de unidades">{metric(total)}</Card>
    <section className={styles.platforms} aria-label="Resumen por plataforma">
      {tabs.slice(1).map(([type, label]) => <Card key={type} className={styles.platform}><div className={styles.platformName}><Smartphone size={44} strokeWidth={1.4} aria-hidden="true" /><h2>{label}</h2></div>{metric(summarizeProductRisk(filtered.filter(c => c.tipo === type)))}</Card>)}
    </section>
    <Card className={styles.models}>
      <div className={styles.toolbar}><h2>Mora por modelo</h2><div className={styles.controls}>
        <label className={styles.search}><Search size={20} aria-hidden="true" /><Input aria-label="Buscar referencia" placeholder="Buscar referencia…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); setSelected(null); }} /></label>
        <Button variant="secondary" aria-expanded={expanded} aria-controls="risk-filters" onClick={() => setExpanded(!expanded)}><Filter size={20} aria-hidden="true" />Filtros{activeFilters ? ` (${activeFilters})` : ""}</Button>
      </div></div>
      <Tabs className={styles.tabs} aria-label="Plataforma de las referencias">{tabs.map(([type, label]) => <button key={type} type="button" role="tab" aria-selected={tab === type} aria-controls="risk-models" id={`risk-tab-${type || "all"}`} onClick={() => { setTab(type); setPage(1); setSelected(null); }}>{label}</button>)}</Tabs>
      {expanded && <section id="risk-filters" className={styles.filters} aria-label="Filtros de cartera">
        <div className={styles.filterGrid}>
          <label>Venta desde<Input type="date" value={filters.desde} onChange={e => update("desde", e.target.value)} /></label>
          <label>Venta hasta<Input type="date" value={filters.hasta} onChange={e => update("hasta", e.target.value)} /></label>
          {([["marca", "Marca"], ["referencia", "Referencia / modelo"], ["sede", "Sede"]] as const).map(([key, label]) => <label key={key}>{label}<Select value={filters[key]} onChange={e => update(key, e.target.value)}><option value="">Todos</option>{options(key).map(v => <option key={v}>{v}</option>)}</Select></label>)}
          <label>Tipo de producto<Select value={filters.tipo} onChange={e => update("tipo", e.target.value)}><option value="">Todos</option><option value="IPHONE">iPhone</option><option value="ANDROID">Android</option></Select></label>
          <label>Estado de cartera<Select value={filters.estado} onChange={e => update("estado", e.target.value)}><option value="">Todos</option><option value="activo">Activos</option><option value="alDia">Al día</option><option value="mora">En mora</option><option value="pagado">Pagados</option></Select></label>
          <label>Días de mora desde<Input type="number" min="0" step="1" value={filters.minDias} onChange={e => update("minDias", e.target.value)} /></label>
          <label>Días de mora hasta<Input type="number" min="0" step="1" value={filters.maxDias} onChange={e => update("maxDias", e.target.value)} /></label>
        </div><Button variant="secondary" onClick={reset}>Limpiar filtros</Button>
      </section>}
      {invalid && <p role="alert" className={styles.danger}>El inicio del rango debe ser menor o igual al final.</p>}
      {(filters.estado === "mora" || Number(filters.minDias) > 0) && <p className={styles.note}>Estos filtros limitan el denominador a créditos en mora; el porcentaje puede llegar a 100%. Limpia los filtros para comparar todas las ventas.</p>}
      <div id="risk-models" role="tabpanel" aria-labelledby={`risk-tab-${tab || "all"}`}>
        {groups.length ? <DataTable><table><thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.desc ? "descending" : "ascending" : "none"}><button className={styles.sort} onClick={() => { setSort({ key, desc: sort.key === key ? !sort.desc : false }); setPage(1); }}>{label}<span aria-hidden="true">{sort.key === key ? sort.desc ? " ↓" : " ↑" : " ↕"}</span></button></th>)}<th>Detalle</th></tr></thead><tbody>{visible.map((r: Row) => <tr key={r.key}><td>{r.referencia}</td><td>{number(r.financiadas)}</td><td>{number(r.mora)}</td><td><div className={styles.rate}><div className={styles.track} aria-hidden="true"><span style={{ width: `${r.porcentaje}%` }} /></div>{percent(r.porcentaje)}</div></td>{central && <td>{money(r.vencido)}</td>}<td><button className={styles.reference} aria-label={`Ver créditos de ${r.referencia}`} onClick={() => openDetail(r.key)}>Ver créditos<ArrowRight size={18} aria-hidden="true" /></button></td></tr>)}</tbody></table></DataTable> : <EmptyState title="Sin créditos para esta selección" description="Modifica los filtros para consultar los créditos registrados de tu cartera." />}
      </div>
      <footer className={styles.footer}><span aria-live="polite">{sorted.length ? `${(current - 1) * 7 + 1}–${Math.min(current * 7, sorted.length)}` : "0"} de {sorted.length} referencias</span><p>Mora por unidades = créditos en mora / financiados · Actualizado al {cutoff}</p><nav className={styles.pagination} aria-label="Paginación de referencias"><Button variant="ghost" aria-label="Página anterior" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={18} /></Button><span>{current} / {pages}</span><Button variant="ghost" aria-label="Página siguiente" disabled={current === pages} onClick={() => setPage(current + 1)}><ChevronRight size={18} /></Button></nav></footer>
    </Card>
    <p className={styles.note}>Cada crédito registrado con monto positivo representa una unidad financiada. Se incluyen pagados e importaciones históricas, aunque no tengan firmas o fotos; se excluyen anulados y cancelados. Los filtros se aplican al resumen, las plataformas, la tabla y el detalle. La mora corresponde al corte actual.</p>
    {detail && <Card id="reference-detail" className={styles.detail}><div className={styles.detailHeader}><h2>{detail.referencia}</h2><Button variant="secondary" onClick={() => setSelected(null)}>Cerrar detalle</Button></div><p className={styles.note}>Créditos asociados que cumplen los filtros actuales.</p><DataTable><table><thead><tr>{["Número de crédito", "Cliente", "Aliado", "Sede", "Fecha de venta", ...(central ? ["Valor financiado", "Saldo"] : []), "Días de mora", ...(central ? ["Saldo vencido", "Última gestión de cartera"] : [])].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{detail.credits.map(c => <tr key={c.id}><td>{c.numeroCreditoVisible || c.folio}</td><td>{c.cliente}</td><td>{c.aliado}</td><td>{c.sede}</td><td>{c.fecha}</td>{central && <><td>{money(c.capital ?? 0)}</td><td>{money(c.saldo ?? 0)}</td></>}<td>{c.dias}</td>{central && <><td>{money(c.vencido ?? 0)}</td><td className={styles.observation}>{c.gestion || "Sin gestión registrada"}</td></>}</tr>)}</tbody></table></DataTable></Card>}
  </main>;
}
