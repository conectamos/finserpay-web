"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Input, MetricCard, PageHeader, Select } from "@/app/_components/finser-ui";
import { aggregateProductRisk, emptyProductRiskFilters, filterRiskCredits, riskTone, type ProductRiskCredit, type ProductRiskFilters } from "@/lib/product-risk";
import styles from "./risk.module.css";

type Row = ReturnType<typeof aggregateProductRisk>[number];
const columns = [
  ["marca", "Marca"], ["referencia", "Referencia / modelo"], ["financiadas", "Unidades financiadas"],
  ["activas", "Unidades activas"], ["mora", "Unidades en mora"], ["porcentaje", "% de mora"],
  ["capital", "Capital colocado"], ["saldo", "Saldo pendiente por cobrar"], ["vencido", "Valor vencido"],
  ["dias", "Días promedio de mora"], ["ultima", "Última venta"], ["riesgo", "Indicador de riesgo"],
] as const;
type SortKey = typeof columns[number][0];
const money = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
const percent = (n: number) => `${n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const riskLabel = (n: number) => n >= 8 ? "Alto" : n >= 5 ? "Medio" : "Bajo";
function value(row: Row, key: SortKey) {
  if (key === "riesgo") return row.porcentaje;
  return row[key];
}

export default function RiskConsole({ credits, cutoff }: { credits: ProductRiskCredit[]; cutoff: string }) {
  const [filters, setFilters] = useState<ProductRiskFilters>({ ...emptyProductRiskFilters });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "porcentaje", desc: true });
  const [selected, setSelected] = useState<string | null>(null);
  const invalid = Boolean(filters.desde && filters.hasta && filters.desde > filters.hasta) || Boolean(filters.minDias && filters.maxDias && Number(filters.minDias) > Number(filters.maxDias));
  const filtered = useMemo(() => invalid ? [] : filterRiskCredits(credits, filters), [credits, filters, invalid]);
  const groups = useMemo(() => aggregateProductRisk(filtered), [filtered]);
  const sorted = [...groups].sort((a, b) => {
    const x = value(a, sort.key), y = value(b, sort.key);
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "es");
    return (sort.desc ? -cmp : cmp) || a.key.localeCompare(b.key);
  });
  const ranking = [...groups].sort((a, b) => b.porcentaje - a.porcentaje || b.mora - a.mora).slice(0, 10);
  const maxFinanced = Math.max(...ranking.map(r => r.financiadas), 1);
  const mostUnits = [...groups].sort((a, b) => b.mora - a.mora || b.porcentaje - a.porcentaje)[0];
  const financed = groups.reduce((sum, r) => sum + r.financiadas, 0);
  const overdue = groups.reduce((sum, r) => sum + r.mora, 0);
  const detail = groups.find(r => r.key === selected);
  const update = (key: keyof ProductRiskFilters, val: string) => { setFilters(f => ({ ...f, [key]: val })); setSelected(null); };
  const options = (key: "marca" | "referencia" | "aliado" | "sede") => [...new Set(credits.filter(c => key !== "referencia" || !filters.marca || c.marca === filters.marca).map(c => c[key]))].sort((a, b) => a.localeCompare(b, "es"));
  const openDetail = (key: string) => { setSelected(key); requestAnimationFrame(() => document.getElementById("reference-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  return <main className={styles.main}>
    <PageHeader eyebrow="Admin Central FINSER · Cartera" title="Riesgo por referencia" description={`Mora por producto · Cartera al ${cutoff}`} />
    <details className={styles.method}><summary>Cómo se calcula la mora</summary><p className={styles.note}>Fechas por venta. Mora actual = unidades en mora ÷ unidades financiadas × 100. Incluye créditos pagados en el denominador. Excluye anulados y créditos sin evidencia de financiación. El promedio de días considera solo unidades en mora.</p></details>
    <section className={styles.metrics} aria-label="Resumen de riesgo">
      <MetricCard label="Mayor porcentaje de mora" value={ranking[0]?.mora ? ranking[0].referencia : "Sin mora"} detail={ranking[0]?.mora ? `${ranking[0].marca} · ${percent(ranking[0].porcentaje)}` : "En la selección actual"} />
      <MetricCard label="Más unidades en mora" value={mostUnits?.mora ? mostUnits.referencia : "Sin mora"} detail={mostUnits?.mora ? `${mostUnits.marca} · ${mostUnits.mora} unidades` : "En la selección actual"} />
      <MetricCard label="Total de unidades financiadas" value={financed.toLocaleString("es-CO")} detail="Según los filtros seleccionados" />
      <MetricCard label="Porcentaje general de mora por producto" value={percent(financed ? overdue / financed * 100 : 0)} detail={`${overdue} en mora de ${financed} financiadas`} />
    </section>
    <Card className={`${styles.panel} ${styles.filters}`}>
      <h2>Filtros</h2>
      <div className={styles.filterGrid}>
        <label>Venta desde<Input type="date" value={filters.desde} onChange={e => update("desde", e.target.value)} /></label>
        <label>Venta hasta<Input type="date" value={filters.hasta} onChange={e => update("hasta", e.target.value)} /></label>
        {([ ["marca", "Marca"], ["referencia", "Referencia / modelo"], ["aliado", "Aliado"], ["sede", "Sede"] ] as const).map(([key, label]) => <label key={key}>{label}<Select value={filters[key]} onChange={e => { update(key, e.target.value); if (key === "marca") update("referencia", ""); }}><option value="">Todos</option>{options(key).map(v => <option key={v}>{v}</option>)}</Select></label>)}
        <label>Tipo de producto<Select value={filters.tipo} onChange={e => update("tipo", e.target.value)}><option value="">Todos</option><option value="IPHONE">iPhone</option><option value="ANDROID">Android</option><option value="SIN_CLASIFICAR">Sin clasificar</option></Select></label>
        <label>Estado de cartera<Select value={filters.estado} onChange={e => update("estado", e.target.value)}><option value="">Todos</option><option value="activo">Activos</option><option value="alDia">Al día</option><option value="mora">En mora</option><option value="pagado">Pagados</option></Select></label>
        <label>Días de mora desde<Input type="number" min="0" step="1" value={filters.minDias} onChange={e => update("minDias", e.target.value)} /></label>
        <label>Días de mora hasta<Input type="number" min="0" step="1" value={filters.maxDias} onChange={e => update("maxDias", e.target.value)} /></label>
      </div>
      <div className={styles.filterActions}><Button variant="secondary" onClick={() => { setFilters({ ...emptyProductRiskFilters }); setSelected(null); }}>Limpiar filtros</Button><p className={styles.note}>{financed.toLocaleString("es-CO")} créditos en la selección actual</p></div>
      {invalid && <p role="alert">El inicio del rango debe ser menor o igual al final.</p>}
      {filters.estado === "mora" || Number(filters.minDias) > 0 ? <p className={styles.note}>Esta selección limita el denominador a créditos en mora; el porcentaje puede llegar a 100%. Limpia estos filtros para comparar el riesgo de todas las ventas.</p> : null}
    </Card>
    {groups.length ? <>
      <section className={styles.charts} aria-label="Gráficas por referencia">
        <Card className={styles.panel}>
          <div className={styles.panelHeader}><h2>Ranking por porcentaje de mora</h2><p className={styles.note}>Las 10 referencias con mayor porcentaje</p></div>
          <div className={styles.chartList}>{ranking.map(r => <div className={styles.chartRow} key={r.key}>
            <button className={styles.chartLabel} onClick={() => openDetail(r.key)}>{r.referencia}<span>{r.marca}</span></button>
            <div className={styles.barLine}><div className={styles.track}><span style={{ width: `${r.porcentaje}%`, background: r.porcentaje >= 8 ? "var(--fp-danger)" : r.porcentaje >= 5 ? "var(--fp-amber)" : "var(--fp-lime)" }} /></div><strong>{percent(r.porcentaje)}</strong></div>
          </div>)}</div>
        </Card>
        <Card className={styles.panel}>
          <div className={styles.panelHeader}><h2>Financiadas vs. en mora</h2><div className={styles.legend}><span><i style={{ background: "var(--fp-graphite)" }} aria-hidden="true" />Financiadas</span><span><i style={{ background: "var(--fp-danger)" }} aria-hidden="true" />En mora</span></div></div>
          <div className={styles.chartList}>{ranking.map(r => <div className={styles.comparison} key={r.key}>
            <button className={styles.chartLabel} onClick={() => openDetail(r.key)}>{r.referencia}<span>{r.marca}</span></button>
            <div className={styles.barLine}><span className={styles.seriesLabel}>Financiadas</span><div className={styles.track}><span style={{ width: `${r.financiadas / maxFinanced * 100}%`, background: "var(--fp-graphite)" }} /></div><strong>{r.financiadas}</strong></div>
            <div className={styles.barLine}><span className={styles.seriesLabel}>En mora</span><div className={styles.track}><span style={{ width: `${r.mora / maxFinanced * 100}%`, background: "var(--fp-danger)" }} /></div><strong>{r.mora}</strong></div>
          </div>)}</div>
        </Card>
      </section>
      <Card className={styles.panel}><div className={styles.panelHeader}><h2>Referencias · {groups.length}</h2><p className={styles.note}>Riesgo bajo &lt; 5% · Medio ≥ 5% y &lt; 8% · Alto ≥ 8%. Selecciona una referencia para ver sus créditos.</p></div>
        <DataTable className={styles.tableWrap}><table><thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.desc ? "descending" : "ascending" : "none"}><button className={styles.sort} onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : true })}><span>{label}</span><span aria-hidden="true">{sort.key === key ? sort.desc ? "↓" : "↑" : "↕"}</span></button></th>)}</tr></thead><tbody>{sorted.map(r => <tr key={r.key}>{columns.map(([key]) => <td key={key}>{key === "referencia" ? <button className={styles.reference} onClick={() => openDetail(r.key)}>{r.referencia}</button> : key === "riesgo" ? <Badge tone={riskTone(r.porcentaje)}>{riskLabel(r.porcentaje)}</Badge> : key === "porcentaje" ? percent(r.porcentaje) : ["capital", "saldo", "vencido"].includes(key) ? money(Number(value(r, key))) : key === "dias" ? r.dias.toLocaleString("es-CO", { maximumFractionDigits: 1 }) : String(value(r, key))}</td>)}</tr>)}</tbody></table></DataTable>
      </Card>
    </> : <EmptyState title="Sin créditos para esta selección" description="Modifica los filtros o verifica que las ventas tengan evidencia de financiación." />}
    {detail && <Card id="reference-detail" className={`${styles.panel} ${styles.detail}`}><div className={styles.detailHeader}><h2>{detail.marca} · {detail.referencia}</h2><Button variant="secondary" onClick={() => setSelected(null)}>Cerrar detalle</Button></div><p className={`${styles.note} mt-3 mb-6`}>Todos los créditos de la referencia que cumplen los filtros actuales. Se muestra la última gestión registrada en cartera.</p><DataTable><table><thead><tr>{["Número de crédito", "Cliente", "Aliado", "Sede", "Fecha de venta", "Valor financiado", "Saldo", "Días de mora", "Última gestión de cartera"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{detail.credits.map(c => <tr key={c.id}><td>{c.numeroCreditoVisible || c.folio}</td><td>{c.cliente}</td><td>{c.aliado}</td><td>{c.sede}</td><td>{c.fecha}</td><td>{money(c.capital)}</td><td>{money(c.saldo)}</td><td>{c.dias}</td><td className={styles.observation}>{c.gestion || "Sin gestión registrada"}{c.gestionFecha && <p className={styles.note}>{new Date(c.gestionFecha).toLocaleString("es-CO", { timeZone: "America/Bogota" })}</p>}</td></tr>)}</tbody></table></DataTable></Card>}
  </main>;
}
