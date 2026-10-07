"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CreditCard, Database, Download, Filter, Home, Info, Phone, ReceiptText, Search, X, XCircle } from "lucide-react";
import { creditReportDocument, creditReportSadmin } from "@/lib/credit-report-identifiers";
import type { AliadoItem, CreditReportItem, CreditReportResponse, SedeItem } from "./reporte-creditos-client";
import styles from "./credit-report-view.module.css";

type Props = {
  items: CreditReportItem[]; summary: CreditReportResponse["summary"] | null; totalAuthorized: number;
  loading: boolean; exporting: boolean; message: string; isAdmin: boolean; sedeNombre: string;
  search: string; from: string; to: string; aliadoId: string; sedeId: string;
  aliados: AliadoItem[]; sedes: SedeItem[];
  setSearch: (value: string) => void; setFrom: (value: string) => void; setTo: (value: string) => void;
  setAliado: (value: string) => void; setSede: (value: string) => void;
  apply: () => void; exportExcel: () => void; actions: (item: CreditReportItem) => ReactNode;
};
const money = (value: number) => `$ ${Number(value || 0).toLocaleString("es-CO")}`;
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Sin fecha" : new Intl.DateTimeFormat("es-CO",{day:"2-digit",month:"short",year:"numeric",timeZone:"America/Bogota"}).format(parsed).replace(/ de /g," ");
}
function reportState(value: string) {
  const state=value.toUpperCase();
  return state.includes("ANUL")?styles.danger:state.includes("APROB")||state.includes("PAG")||state.includes("ENTREG")?styles.positive:styles.warning;
}
export default function CreditReportView(props: Props) {
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(10),[filtersOpen,setFiltersOpen]=useState(false);
  const drawer=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(filtersOpen)drawer.current?.showModal();else drawer.current?.close();},[filtersOpen]);
  const pages=Math.max(1,Math.ceil(props.items.length/pageSize));
  const currentPage=Math.min(page,pages);
  const shown=props.items.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const pageNumbers=[...new Set([1,2,3,currentPage-1,currentPage,currentPage+1,pages])].filter(value=>value>0&&value<=pages).sort((a,b)=>a-b);
  const dates=<><label>Desde<input type="date" value={props.from} onChange={event=>props.setFrom(event.target.value)}/></label><label>Hasta<input type="date" value={props.to} min={props.from||undefined} onChange={event=>props.setTo(event.target.value)}/></label></>;
  const allies=<><label>Aliado<select aria-label="Aliado" value={props.aliadoId} onChange={event=>props.setAliado(event.target.value)}><option value="">Todos los aliados</option>{props.aliados.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label><label>Sede<select aria-label="Sede" value={props.sedeId} onChange={event=>props.setSede(event.target.value)}><option value="">Todas las sedes</option>{props.sedes.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label></>;
  const apply=()=>{setPage(1);props.apply();};
  return <div>
    <nav className={styles.breadcrumb} aria-label="Ruta actual"><Link href="/dashboard" aria-label="Inicio"><Home aria-hidden="true"/></Link><ChevronRight aria-hidden="true"/><Link href="/dashboard/reportes">Reportes</Link><ChevronRight aria-hidden="true"/><strong aria-current="page">Créditos</strong></nav>
    <header className={styles.heading}><div><h1>Reporte de créditos</h1><p>Ventas y financiación del período.</p></div><div className={styles.headingActions}><Link href="/dashboard/reportes" className={styles.secondary}><ArrowLeft aria-hidden="true"/>Centro de reportes</Link><button type="button" className={styles.primary} onClick={props.exportExcel} disabled={props.loading||props.exporting||!props.items.length}><Download aria-hidden="true"/>{props.exporting?"Generando Excel…":"Exportar Excel"}</button></div></header>
    <section className={styles.metrics} aria-label="Indicadores del reporte">{[
      {label:"Créditos",value:props.summary?.totalCreditos||0,icon:CreditCard},
      {label:"Capital autorizado",value:money(props.totalAuthorized),icon:Database},
      {label:"Inicial recibida",value:money(props.summary?.totalInicial||0),icon:ReceiptText},
      {label:"Pagados",value:props.summary?.creditosPagados||0,icon:CheckCircle2},
      {label:"Anulados",value:props.summary?.creditosAnulados||0,icon:XCircle,danger:true},
    ].map(({label,value,icon:Icon,danger})=><div key={label} className={danger?styles.metricDanger:undefined}><Icon aria-hidden="true"/><div><span>{label}</span><strong>{props.loading?"…":value}</strong></div></div>)}</section>
    <form className={styles.filters} role="search" onSubmit={event=>{event.preventDefault();apply();}}>
      <label className={styles.search}><Search aria-hidden="true"/><input aria-label="Buscar créditos" value={props.search} onChange={event=>props.setSearch(event.target.value)} placeholder="Cliente, cédula, Sadmin, folio, IMEI o vendedor"/></label>
      <details className={styles.dateRange}><summary><CalendarDays aria-hidden="true"/><span>{props.from||props.to?`${props.from||"Inicio"} – ${props.to||"Hoy"}`:"Rango de fechas"}</span><ChevronRight aria-hidden="true"/></summary><div>{dates}<button type="button" className={styles.secondary} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');apply();}}>Aplicar fechas</button></div></details>
      <button type="button" className={styles.secondary} onClick={()=>setFiltersOpen(true)}><Filter aria-hidden="true"/>Filtros<ChevronRight aria-hidden="true"/></button>
      {props.isAdmin?<><select className={styles.scope} aria-label="Filtrar por aliado" value={props.aliadoId} onChange={event=>props.setAliado(event.target.value)}><option value="">Todos los aliados</option>{props.aliados.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select><select className={styles.scope} aria-label="Filtrar por sede" value={props.sedeId} onChange={event=>props.setSede(event.target.value)}><option value="">Todas las sedes</option>{props.sedes.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select></>:<div className={styles.assigned}>{props.sedeNombre||"Sede asignada"}</div>}
      <button type="submit" className={styles.primary} disabled={props.loading}><Filter aria-hidden="true"/>{props.loading?"Consultando":"Aplicar"}</button>
    </form>
    {props.message&&<p className={styles.message} role="status">{props.message}</p>}
    <section className={styles.detail} aria-busy={props.loading}><header><h2>Detalle de créditos</h2><span>{props.loading?"Consultando…":`${props.items.length.toLocaleString('es-CO')} resultados`}</span></header>
      <table className={styles.table}><colgroup><col style={{width:'17%'}}/><col style={{width:'18%'}}/><col style={{width:'18%'}}/><col style={{width:'9.5%'}}/><col style={{width:'9.5%'}}/><col style={{width:'11%'}}/><col style={{width:'10%'}}/><col style={{width:'6%'}}/></colgroup><thead><tr>{['Crédito / Cliente','Equipo / IMEI','Aliado / Vendedor','Venta','Inicial','Autorizado','Estado','Acciones'].map(label=><th scope="col" key={label}>{label==='Acciones'?<span className={styles.srOnly}>Acciones</span>:label}</th>)}</tr></thead><tbody>
      {props.loading?<tr><td colSpan={8} className={styles.feedback} role="status">Consultando créditos…</td></tr>:shown.length?shown.map(item=>{
        const sadmin=creditReportSadmin(item);const state=item.estadoReporte||item.estado;
        const brand=[item.equipoMarca,item.equipoModelo,item.referenciaEquipo].join(' ').toUpperCase();const iphone=/APPLE|IPHONE/.test(brand);
        return <tr key={item.id}><td data-label="Crédito / Cliente"><div className={styles.identity}>{sadmin?<strong className={styles.sadmin}>Sadmin: {sadmin}</strong>:<span className={styles.pending}>PENDIENTE SADMIN</span>}<small className={styles.folio}>{item.folio}</small><span className={styles.client}>{item.clienteNombre}</span><small><CreditCard aria-hidden="true"/>CC {creditReportDocument(item.clienteDocumento)||"Sin documento"}</small><small><Phone aria-hidden="true"/>Tel. {item.clienteTelefono||"Sin teléfono registrado"}</small><small><CalendarDays aria-hidden="true"/>{date(item.fechaCredito)}</small></div></td>
          <td data-label="Equipo / IMEI"><div className={styles.equipment}><span className={`${styles.platformIcon} ${iphone?'':styles.android}`} aria-label={iphone?'Apple':'Android'} role="img" style={{maskImage:`url(/assets/dashboard/${iphone?'apple':'android'}.svg)`}}/><div><strong>{item.referenciaEquipo||[item.equipoMarca,item.equipoModelo].filter(Boolean).join(' ')||'Sin referencia'}</strong><small className={styles.imei}>IMEI {item.imei||'Sin registro'}</small></div></div></td>
          <td data-label="Aliado / Vendedor"><strong>{item.sede.aliado?.nombre||'Sin aliado'}</strong><small>{item.sede.nombre}</small><small>Asesor {item.usuario.nombre}</small></td>
          <td data-label="Venta" className={styles.money}>{money(item.valorEquipoTotal)}</td><td data-label="Inicial" className={styles.money}>{money(item.cuotaInicial)}</td><td data-label="Autorizado" className={`${styles.money} ${styles.authorized}`}>{money(item.creditoAutorizado)}</td>
          <td data-label="Estado"><span className={`${styles.state} ${reportState(state)}`}>{state.charAt(0).toUpperCase()+state.slice(1).toLowerCase()}</span>{item.deliverableLabel&&item.deliverableLabel.toLowerCase()!==state.toLowerCase()&&<small>{item.deliverableLabel}</small>}</td><td data-label="Acciones" className={styles.actions}>{props.actions(item)}</td>
        </tr>;
      }):<tr><td colSpan={8} className={styles.feedback}>No hay créditos para los filtros seleccionados.</td></tr>}
      </tbody></table>
      <footer className={styles.pagination}><label>Mostrar<select aria-label="Créditos por página" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[10,25,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select>por página</label><p>{props.items.length?(currentPage-1)*pageSize+1:0} – {Math.min(currentPage*pageSize,props.items.length)} de {props.items.length.toLocaleString('es-CO')}</p><nav aria-label="Paginación de créditos"><button type="button" disabled={currentPage===1} onClick={()=>setPage(currentPage-1)} aria-label="Página anterior"><ChevronLeft aria-hidden="true"/></button>{pageNumbers.map((number,index)=><span key={number}>{index>0&&number-pageNumbers[index-1]>1&&'…'}<button type="button" aria-current={number===currentPage?'page':undefined} onClick={()=>setPage(number)}>{number}</button></span>)}<button type="button" disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)} aria-label="Página siguiente"><ChevronRight aria-hidden="true"/></button></nav></footer>
    </section><p className={styles.help}><Info aria-hidden="true"/>Abre el detalle para consultar toda la información del crédito.</p>
    <dialog ref={drawer} className={styles.drawer} aria-labelledby="report-filters-heading" onCancel={()=>setFiltersOpen(false)}><form onSubmit={event=>{event.preventDefault();setFiltersOpen(false);apply();}}><header><h2 id="report-filters-heading">Filtros del reporte</h2><button type="button" aria-label="Cerrar filtros" onClick={()=>setFiltersOpen(false)}><X aria-hidden="true"/></button></header><div>{dates}{props.isAdmin?allies:<p>{props.sedeNombre}</p>}</div><footer><button type="button" className={styles.secondary} onClick={()=>{props.setSearch('');props.setFrom('');props.setTo('');props.setAliado('');props.setSede('');}}>Limpiar</button><button type="submit" className={styles.primary}>Aplicar</button></footer></form></dialog>
  </div>;
}
