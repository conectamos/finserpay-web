"use client";

import Link from "next/link";
import { ArrowRight, Ban, ChevronLeft, ChevronRight, Home, MoreHorizontal, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SOLICITUD_FILTER_STATES, SOLICITUD_STATE_LABELS } from "@/lib/solicitudes";
import type { FormFilters, ListResponse, SolicitudItem, FilterOption } from "./solicitudes-wall-client";
import styles from "./solicitudes-list-view.module.css";

type Props = {
  list: ListResponse | null; loading: boolean; error: string; notice: string;
  filters: FormFilters; appliedFilters: FormFilters;
  setFilters: (update: (current: FormFilters) => FormFilters) => void;
  quickFilter: (key: "q" | "plataforma" | "estado", value: string) => void;
  applyFilters: (event: FormEvent<HTMLFormElement>) => void;
  clearFilters: () => void; refresh: () => void; dismissNotice: () => void;
  goToPage: (page: number) => void;
  setPageSize: (size: number) => void;
  openDetail: (item: SolicitudItem) => void; desist: (item: SolicitudItem) => void;
  factoryHref: (item: SolicitudItem) => string; replacementHref: (item: SolicitudItem) => string;
  displayNumber: (item: SolicitudItem) => string;
  requestHref?: (item: SolicitudItem) => string;
};
const formatNumber = (value: number) => new Intl.NumberFormat("es-CO").format(value);
function dateParts(value?: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return ["Sin registro", ""];
  return [new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Bogota" }).format(date).replace(/ de /g," "), new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" }).format(date)];
}
function optionValue(option: FilterOption) {
  return typeof option === "object" ? String(option.value ?? option.id ?? "") : String(option);
}
function optionLabel(option: Parameters<typeof optionValue>[0]) {
  return typeof option === "object" ? String(option.label ?? option.nombre ?? option.value ?? option.id ?? "") : String(option);
}
function State({ item }: { item: SolicitudItem }) {
  const tone = ["RECHAZADA", "CANCELADA", "ERROR_TECNICO"].includes(item.estado) ? styles.danger : ["APROBADA"].includes(item.estado) ? styles.positive : styles.warning;
  return <div className={styles.states}>
    <span className={`${styles.state} ${tone}`}>{item.estado === "PROCESO" ? "En proceso" : SOLICITUD_STATE_LABELS[item.estado]}</span>
    {item.processStage && <small>{SOLICITUD_STATE_LABELS[item.processStage]}</small>}
    {item.deliveryStage && <small>{SOLICITUD_STATE_LABELS[item.deliveryStage]}</small>}
  </div>;
}
function RowMenu({ name, children }: { name: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && ref.current && !ref.current.contains(event.target)) ref.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && ref.current?.open) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <details className={styles.rowMenu} name="solicitud-row-actions" ref={ref}>
    <summary aria-label={`Más acciones de ${name}`}><MoreHorizontal aria-hidden="true" /></summary>
    <div onClick={event => { if (event.target instanceof Element && event.target.closest("a,button") && ref.current) ref.current.open = false; }}>{children}</div>
  </details>;
}

export default function SolicitudesListView(props: Props) {
  const { list, loading, error, filters, appliedFilters, quickFilter } = props;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (filtersOpen) drawer.current?.showModal(); else drawer.current?.close(); }, [filtersOpen]);
  useEffect(() => {
    if (filters.q === appliedFilters.q || filtersOpen) return;
    const timer = setTimeout(() => quickFilter("q", filters.q.trim()), 350);
    return () => clearTimeout(timer);
  }, [filters.q, appliedFilters.q, filtersOpen, quickFilter]);
  const options = list?.options || {};
  const activeAdvanced = (["desde", "hasta", "aliadoId", "sedeId", "asesorId"] as const).filter(key => appliedFilters[key]).length + (appliedFilters.estado && !["PROCESO", "RECHAZADA"].includes(appliedFilters.estado) ? 1 : 0);
  const page = list?.page || 1, pageSize = list?.pageSize || 25;
  const pages = Math.max(1, Math.ceil((list?.total || 0) / pageSize));
  const pageNumbers = [...new Set([1, 2, 3, page - 1, page, page + 1, pages])].filter(value => value >= 1 && value <= pages).sort((a, b) => a - b);
  const closeFilters = () => { setFiltersOpen(false); props.setFilters(() => appliedFilters); };
  const setField = (key: keyof FormFilters, value: string) => props.setFilters(current => ({ ...current, [key]: value }));
  const actions = (item: SolicitudItem) => {
    const analyst = Boolean(props.requestHref);
    const openingRequest = analyst && item.actions.includes("ABRIR_SOLICITUD");
    const continuing = !analyst && item.source === "DRAFT" && item.actions.includes("ABRIR_FABRICA");
    return <div className={styles.actions}>
      {openingRequest ? <Link href={props.requestHref!(item)} prefetch={false} className={item.estado === "PROCESO" ? styles.primary : styles.secondary}>{item.estado === "PROCESO" ? "Ingresar" : "Ver detalle"}{item.estado === "PROCESO" && <ArrowRight aria-hidden="true" />}</Link> : continuing ? <Link href={props.factoryHref(item)} className={styles.primary}>Continuar<ArrowRight aria-hidden="true" /></Link> : item.actions.includes("VER_DETALLE") ? <button type="button" className={styles.secondary} onClick={() => props.openDetail(item)}>Ver detalle</button> : null}
      <RowMenu name={props.displayNumber(item)}>
        {openingRequest && item.actions.includes("VER_DETALLE") && <button type="button" onClick={() => props.openDetail(item)}>Ver resumen</button>}
        {continuing && item.actions.includes("VER_DETALLE") && <button type="button" onClick={() => props.openDetail(item)}>Ver detalle</button>}
        {!analyst && !continuing && item.actions.includes("ABRIR_FABRICA") && <Link href={props.factoryHref(item)}>Abrir fábrica</Link>}
        {!analyst && item.actions.includes("CAMBIO_GARANTIA") && <Link href={props.replacementHref(item)}>Cambio por garantía</Link>}
        {!analyst && item.actions.includes("DESISTIR") && <button type="button" className={styles.desist} onClick={() => props.desist(item)}><Ban aria-hidden="true" />Desistir</button>}
        {!item.actions.length && <span>Sin acciones disponibles</span>}
        {!continuing && item.actions.includes("VER_DETALLE") && item.actions.length === 1 && <button type="button" onClick={() => props.openDetail(item)}>Ver detalle</button>}
      </RowMenu>
    </div>;
  };
  return <div className={styles.panel}>
    <nav className={styles.breadcrumb} aria-label="Ruta actual"><Link href={props.requestHref ? "/dashboard/aprobaciones/centro" : "/dashboard"} aria-label="Inicio"><Home aria-hidden="true" /></Link><ChevronRight aria-hidden="true" /><span>{props.requestHref ? "Aprobaciones" : "Operación"}</span><ChevronRight aria-hidden="true" /><strong aria-current="page">Solicitudes</strong></nav>
    <header className={styles.heading}><div><h1>Solicitudes</h1><p>{props.requestHref ? "Consulta y gestiona las solicitudes de crédito." : "Consulta y continúa tus ventas."}</p></div><div className={styles.headingActions}><span className={styles.total}>{loading && !list ? "Consultando…" : `${formatNumber(list?.total || 0)} solicitudes`}</span><button type="button" className={styles.secondary} disabled={loading} onClick={props.refresh}><RefreshCw className={loading ? styles.spin : undefined} aria-hidden="true" />Actualizar</button></div></header>
    {props.notice && <div className={styles.notice} role="status"><span>{props.notice}</span><button type="button" onClick={props.dismissNotice} aria-label="Cerrar mensaje"><X aria-hidden="true" /></button></div>}
    <nav className={styles.tabs} aria-label="Filtrar solicitudes por estado">{[["", "Todas"], ["PROCESO", "En proceso"], ["RECHAZADA", "Rechazadas"]].map(([value, label]) => <button key={label} type="button" aria-current={appliedFilters.estado === value ? "page" : undefined} className={appliedFilters.estado === value ? styles.selectedTab : undefined} onClick={() => props.quickFilter("estado", value)}>{label}</button>)}</nav>
    <form className={styles.filters} role="search" onSubmit={event => { event.preventDefault(); props.quickFilter("q", filters.q.trim()); }}>
      <label className={styles.search}><Search aria-hidden="true" /><input aria-label="Buscar solicitudes" value={filters.q} onChange={event => setField("q", event.target.value)} placeholder="Buscar por nombre, cédula, solicitud o IMEI" /></label>
      <select aria-label="Plataforma" value={appliedFilters.plataforma} onChange={event => props.quickFilter("plataforma", event.target.value)}><option value="">Todas las plataformas</option>{(options.plataformas || []).map(option => <option key={optionValue(option)} value={optionValue(option)}>{optionLabel(option)}</option>)}</select>
      <button type="button" className={styles.secondary} onClick={() => setFiltersOpen(true)} aria-haspopup="dialog"><SlidersHorizontal aria-hidden="true" />Más filtros{activeAdvanced > 0 && <span className={styles.filterCount} aria-label={`${activeAdvanced} filtros adicionales activos`}>{activeAdvanced}</span>}</button>
      <button type="button" className={styles.clear} onClick={props.clearFilters}>Limpiar</button>
    </form>
    <section aria-label="Listado de solicitudes" aria-busy={loading}>
      {loading && !list ? <div className={styles.feedback} role="status"><RefreshCw className={styles.spin} aria-hidden="true" />Cargando solicitudes…</div> : error ? <div className={styles.feedback} role="alert"><h2>No se pudieron cargar las solicitudes</h2><p>{error}</p><button className={styles.secondary} type="button" onClick={props.refresh}>Reintentar</button></div> : !list?.items.length ? <div className={styles.feedback}><h2>Sin resultados</h2><p>No hay solicitudes para estos filtros.</p><button type="button" className={styles.secondary} onClick={props.clearFilters}>Limpiar filtros</button></div> : <>
        {loading && <p className={styles.refreshing} role="status">Actualizando solicitudes…</p>}
        <table className={styles.table}><colgroup><col style={{width:"16.5%"}}/><col style={{width:"12%"}}/><col style={{width:"14.8%"}}/><col style={{width:"11.4%"}}/><col style={{width:"19.1%"}}/><col style={{width:"10%"}}/><col style={{width:"16.2%"}}/></colgroup><thead><tr>{["Cliente / Solicitud", "Estado", "Aliado / Sede", "Asesor", "Equipo", "Creación", "Acciones"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{list.items.map(item => {
          const [date, time] = dateParts(item.createdAt || item.fechaCreacion);
          const platform = String(item.plataforma || "").toUpperCase();
          const creatorDistinct = item.creadoPor && item.creadoPor.trim().toLocaleLowerCase() !== item.asesor?.nombre.trim().toLocaleLowerCase();
          return <tr key={item.id}>
            <td data-label="Cliente / Solicitud"><strong>{item.clienteNombre || "Sin nombre"}</strong><small>{item.documento ? `CC ${item.documento}` : "Documento no disponible"}</small><small>{props.displayNumber(item)}</small></td>
            <td data-label="Estado"><State item={item} /></td>
            <td data-label="Aliado / Sede"><strong>{item.aliado?.nombre || "Sin aliado"}</strong><small>{item.sede?.nombre || "Sin sede"}</small></td>
            <td data-label="Asesor"><span>{item.asesor?.nombre || item.creadoPor || "Sin asignar"}</span>{creatorDistinct && <small>Creó: {item.creadoPor}</small>}</td>
            <td data-label="Equipo"><div className={styles.equipment}>{["IPHONE", "ANDROID"].includes(platform) && <span aria-hidden="true" className={`${styles.platformIcon} ${platform === "ANDROID" ? styles.android : ""}`} style={{maskImage:`url(/assets/dashboard/${platform === "IPHONE" ? "apple" : "android"}.svg)`}}/>}<div><strong>{platform === "IPHONE" ? "iPhone" : platform === "ANDROID" ? "Android" : item.plataforma || "Sin plataforma"}</strong><small>{item.imei ? `IMEI ${item.imei}` : "IMEI pendiente"}</small></div></div></td>
            <td data-label="Creación"><span>{date}</span><small>{time}</small></td>
            <td data-label="Acciones">{actions(item)}</td>
          </tr>;
        })}</tbody></table>
      </>}
      {list && !error && <footer className={styles.pagination}><p>Mostrando {list.total ? formatNumber((page-1)*pageSize+1) : "0"} – {formatNumber(Math.min(page*pageSize,list.total))} de {formatNumber(list.total)}</p><nav aria-label="Paginación de solicitudes"><button type="button" className={styles.pageArrow} disabled={page<=1||loading} onClick={() => props.goToPage(page-1)} aria-label="Página anterior"><ChevronLeft aria-hidden="true" /></button>{pageNumbers.map((number,index) => <span key={number}>{index>0&&number-pageNumbers[index-1]>1&&<span className={styles.ellipsis}>…</span>}<button type="button" aria-label={`Página ${number}`} aria-current={number===page?"page":undefined} className={number===page?styles.currentPage:styles.pageNumber} disabled={loading} onClick={() => props.goToPage(number)}>{formatNumber(number)}</button></span>)}<button type="button" className={styles.pageArrow} disabled={page>=pages||loading} onClick={() => props.goToPage(page+1)} aria-label="Página siguiente"><ChevronRight aria-hidden="true" /></button></nav><select aria-label="Solicitudes por página" value={pageSize} disabled={loading} onChange={event => props.setPageSize(Number(event.target.value))}>{[...new Set([pageSize,25,50,100])].sort((a,b)=>a-b).map(size => <option key={size} value={size}>{size} por página</option>)}</select></footer>}
    </section>
    <dialog ref={drawer} className={styles.drawer} aria-labelledby="solicitudes-filters-title" onCancel={closeFilters} onClick={event => {if(event.target === event.currentTarget){const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right)closeFilters();}}}>
      <form onSubmit={event => { props.applyFilters(event); setFiltersOpen(false); }}><header><h2 id="solicitudes-filters-title">Más filtros</h2><button type="button" aria-label="Cerrar filtros" onClick={closeFilters}><X aria-hidden="true" /></button></header><div className={styles.drawerFields}>
        <label>Desde<input type="date" value={filters.desde} onChange={event => setField("desde",event.target.value)} /></label><label>Hasta<input type="date" value={filters.hasta} onChange={event => setField("hasta",event.target.value)} /></label>
        <label>Estado<select aria-label="Estado" value={filters.estado} onChange={event => setField("estado",event.target.value)}><option value="">Todos los estados</option>{SOLICITUD_FILTER_STATES.map(state => <option key={state} value={state}>{state === "PROCESO" ? "En proceso" : SOLICITUD_STATE_LABELS[state]}</option>)}</select></label>
        {([['aliadoId','Aliado','aliados'],['sedeId','Sede','sedes'],['asesorId','Asesor','asesores']] as const).map(([key,label,optionKey]) => <label key={key}>{label}<select aria-label={label} value={filters[key]} onChange={event => setField(key,event.target.value)}><option value="">{label==='Sede'?'Todas las permitidas':'Todos los permitidos'}</option>{(options[optionKey]||[]).map(option => <option key={optionValue(option)} value={optionValue(option)}>{optionLabel(option)}</option>)}</select></label>)}
      </div><footer><button type="button" className={styles.secondary} onClick={() => {props.clearFilters();setFiltersOpen(false);}}>Limpiar</button><button type="submit" className={styles.primary}>Aplicar filtros</button></footer></form>
    </dialog>
  </div>;
}
