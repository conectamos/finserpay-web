"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import { COMMISSION_TIME_ZONE, type AdminCommissionBalances } from "@/lib/commissions";
import styles from "./commission-balances.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const months = new Intl.DateTimeFormat("es-CO", { timeZone: COMMISSION_TIME_ZONE, month: "long", year: "numeric" });
function monthLabel(period: string) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? months.format(new Date(`${period}-01T12:00:00-05:00`)) : period; }

export default function CommissionBalances({ revision }: { revision: number }) {
  const [period, setPeriod] = useState("all_pending"), [search, setSearch] = useState(""), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; data: AdminCommissionBalances } | null>(null), [periods, setPeriods] = useState<string[]>([]);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [accessStatus, setAccessStatus] = useState<number | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), blocked = useRef(false), previousSearch = useRef("");
  const term = search.trim(), key = JSON.stringify([period, term, page, revision, refresh]);
  const data = result?.key === key && !accessStatus ? result.data : null;

  useEffect(() => {
    if (blocked.current) return;
    const sequence = ++generation.current, read = new AbortController(); controller.current = read;
    const delay = term !== previousSearch.current ? 300 : 0; previousSearch.current = term;
    let deadline: ReturnType<typeof setTimeout> | undefined, timedOut = false, cancelled = false;
    setResult(null); setLoading(true); setError("");
    const load = async () => {
      deadline = setTimeout(() => { timedOut = true; read.abort(); }, 20_000);
      try {
        const query = new URLSearchParams({ period, page: String(page), ...(term ? { search: term } : {}) });
        const response = await fetch(`/api/admin/comisiones/saldos?${query}`, { credentials: "same-origin", cache: "no-store", signal: read.signal });
        const payload = await response.json().catch(() => null);
        if (read.signal.aborted) throw Object.assign(new Error("Consulta cancelada"), { name: "AbortError" });
        if (!response.ok) throw Object.assign(new Error(payload?.error || payload?.message || "No fue posible consultar los saldos."), { status: response.status });
        if (!payload || !Array.isArray(payload.rows) || !Array.isArray(payload.periods) || !payload.totals) throw new Error("La respuesta de saldos no está disponible. Vuelve a consultar.");
        if (cancelled || sequence !== generation.current) return;
        const next = payload as AdminCommissionBalances, lastPage = Math.max(1, Math.ceil(next.total / 40));
        setPeriods(next.periods);
        if (page > lastPage) { setPage(lastPage); return; }
        setResult({ key, data: next }); setLoading(false);
      } catch (failure) {
        if (cancelled || sequence !== generation.current || (read.signal.aborted && !timedOut)) return;
        const status = (failure as { status?: number })?.status;
        if (status === 401 || status === 403) { blocked.current = true; setAccessStatus(status); setPeriods([]); }
        setResult(null); setLoading(false); setError(timedOut ? "La consulta de saldos tardó demasiado. Vuelve a intentarlo." : failure instanceof Error ? failure.message : "No fue posible consultar los saldos.");
      } finally { if (deadline) clearTimeout(deadline); if (controller.current === read) controller.current = null; }
    };
    const debounce = delay ? setTimeout(() => { void load(); }, delay) : undefined;
    if (!delay) void load();
    return () => { cancelled = true; read.abort(); if (debounce) clearTimeout(debounce); if (deadline) clearTimeout(deadline); if (controller.current === read) controller.current = null; };
  }, [key, period, term, page]);

  useEffect(() => {
    const wake = () => { if (!blocked.current && document.visibilityState === "visible") setRefresh(value => value + 1); };
    const timer = setInterval(wake, 60_000); window.addEventListener("focus", wake);
    return () => { clearInterval(timer); window.removeEventListener("focus", wake); };
  }, []);

  function changePeriod(value: string) { if (blocked.current) return; setPeriod(value); setPage(1); }
  function changeSearch(value: string) { if (blocked.current) return; setSearch(value); setPage(1); }
  const lastPage = Math.max(1, Math.ceil((data?.total || 0) / 40)), unavailable = Boolean(accessStatus);
  return <Card className={styles.card}>
    <header className={styles.heading}><div><h2>Saldos por asesor</h2><p>Comisiones generadas, pagos y solicitudes en trámite por mes.</p></div><Button type="button" variant="secondary" disabled={loading || unavailable} onClick={() => setRefresh(value => value + 1)}><RefreshCw aria-hidden="true" size={17}/>Actualizar saldos</Button></header>
    <div className={styles.filters}><label>Mes<Select aria-label="Mes de los saldos" value={period} disabled={unavailable} onChange={event => changePeriod(event.target.value)}><option value="all_pending">Todos los pendientes</option>{periods.map(value => <option key={value} value={value}>{monthLabel(value)}</option>)}</Select></label><label className={styles.search}><span>Buscar asesor o sede</span><div><Search aria-hidden="true" size={18}/><Input aria-label="Buscar asesor o sede" value={search} maxLength={100} disabled={unavailable} placeholder="Nombre del asesor o sede" onChange={event => changeSearch(event.target.value)}/></div></label></div>
    {error && <div className={styles.error} role="alert"><p>{error}</p>{unavailable ? <a href={accessStatus === 401 ? "/aliados" : "/dashboard"}>{accessStatus === 401 ? "Volver a iniciar sesión" : "Volver al inicio"}</a> : <Button type="button" variant="secondary" onClick={() => setRefresh(value => value + 1)}>Volver a consultar saldos</Button>}</div>}
    {!data && !error && <LoadingState label="Consultando saldos reales…"/>}
    {data && <>
      <div className={styles.context}><p>{period === "all_pending" ? "Todos los pendientes" : monthLabel(period)} · {data.totals.sellers} asesores · {data.total} saldos</p><dl><div><dt>Total pendiente</dt><dd>{money.format(data.totals.outstanding)}</dd></div><div><dt>Sin solicitar</dt><dd>{money.format(data.totals.available)}</dd></div><div><dt>En trámite</dt><dd>{money.format(data.totals.reserved)}</dd></div></dl><p className={styles.help}>El total pendiente corresponde a lo generado que aún no se ha pagado. El cobro conserva sus validaciones y pausas.</p>{data.totals.adjustment > 0 && <p className={styles.review}>Los ajustes se muestran aparte y no se suman al total pendiente; requieren revisión del respaldo.</p>}</div>
      {!data.rows.length ? <EmptyState title="No hay saldos para estos filtros" description={term ? "Prueba con otro asesor o sede." : "Elige otro mes para consultar su historial."}/> : <>
        <p className={styles.mobileHelp}>Desliza la tabla para consultar todos los importes.</p>
        <div className={styles.tableRegion} role="region" aria-label="Tabla de saldos por asesor" tabIndex={0}><table className={styles.table}><caption className={styles.srOnly}>Saldos por asesor y mes para los filtros seleccionados</caption><thead><tr><th scope="col">Asesor y sedes</th><th scope="col">Mes</th><th scope="col" className={styles.numeric}>Ventas válidas</th><th scope="col" className={styles.numeric}>Generado</th><th scope="col" className={styles.numeric}>Pagado</th><th scope="col" className={styles.numeric}>En trámite</th><th scope="col" className={styles.numeric}>Sin solicitar</th><th scope="col" className={styles.numeric}>Total pendiente</th></tr></thead><tbody>{data.rows.map(row => <tr key={`${row.sellerId}:${row.period}`}><th scope="row" className={styles.advisor}><strong>{row.sellerName}</strong><small>{row.branches.length ? row.branches.map(branch => branch.name).join(", ") : "Sin sede registrada"}</small><div className={styles.flags}>{!row.sellerActive && <Badge tone="neutral">Inactivo</Badge>}{row.payoutsPaused && <Badge tone="warning">En pausa</Badge>}{row.adjustment > 0 && <Badge tone="warning">Revisión</Badge>}</div>{row.adjustment > 0 && <small>Ajuste en revisión: {money.format(row.adjustment)}</small>}</th><td className={styles.period}>{monthLabel(row.period)}</td><td className={styles.numeric}>{row.validCreditCount}</td><td className={styles.numeric}>{money.format(row.generated)}</td><td className={styles.numeric}>{money.format(row.paid)}</td><td className={styles.numeric}>{money.format(row.reserved)}</td><td className={styles.numeric}>{money.format(row.available)}</td><td className={styles.numeric}><strong>{money.format(row.outstanding)}</strong></td></tr>)}</tbody></table></div>
      </>}
      <footer className={styles.pagination}><span>{data.total ? (page - 1) * 40 + 1 : 0}–{Math.min(page * 40, data.total)} de {data.total} saldos</span><div><Button type="button" variant="ghost" aria-label="Página anterior de saldos" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden="true" size={18}/></Button><span>Página {page} de {lastPage}</span><Button type="button" variant="ghost" aria-label="Página siguiente de saldos" disabled={page >= lastPage || loading} onClick={() => setPage(value => value + 1)}><ChevronRight aria-hidden="true" size={18}/></Button></div></footer>
    </>}
  </Card>;
}
