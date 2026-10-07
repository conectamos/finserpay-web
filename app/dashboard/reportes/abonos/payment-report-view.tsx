"use client";
import Link from "next/link";
import {useRef,useState,useEffect} from "react";
import {ArrowLeft,Banknote,ChevronLeft,ChevronRight,CreditCard,FileSpreadsheet,Home,Landmark,MoreHorizontal,Search,Smartphone} from "lucide-react";
import {creditReportDocument,creditReportSadmin} from "@/lib/credit-report-identifiers";
import {paymentReportCollector,paymentReportMoney as money,paymentReportDate,type PaymentReportItem,type PaymentReportResponse,type PaymentByDay,type AliadoItem,type SedeItem} from "@/lib/payment-report";
import base from "../creditos/credit-report-view.module.css";
import styles from "./payment-report-view.module.css";

type Props={items:PaymentReportItem[];byDay:PaymentByDay[];summary:PaymentReportResponse["summary"]|null;loading:boolean;error:boolean;exporting:boolean;message:string;isAdmin:boolean;isCentralAdmin:boolean;sedeNombre:string;search:string;from:string;to:string;aliadoId:string;sedeId:string;aliados:AliadoItem[];sedes:SedeItem[];setSearch:(value:string)=>void;setFrom:(value:string)=>void;setTo:(value:string)=>void;setAliado:(value:string)=>void;setSede:(value:string)=>void;apply:()=>void;exportExcel:()=>void;annul:(item:PaymentReportItem)=>void;remove:(item:PaymentReportItem)=>void;annullingId:number|null;deletingId:number|null};
function PaymentActions({item,props}:{item:PaymentReportItem;props:Props}){
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&ref.current&&!ref.current.contains(event.target))ref.current.open=false;};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&ref.current?.open){ref.current.open=false;ref.current.querySelector("summary")?.focus();}};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};},[]);
  const canAnnul=props.isAdmin&&item.estado!=="ANULADO",canDelete=props.isCentralAdmin;
  return <details ref={ref} className={styles.menu} name="payment-report-actions"><summary aria-label={`Acciones del pago ${item.id}`}><MoreHorizontal aria-hidden="true"/></summary><div onClick={event=>{if(event.target instanceof Element&&event.target.closest("button")&&ref.current)ref.current.open=false;}}>
    {canAnnul&&<button type="button" onClick={()=>props.annul(item)} disabled={props.annullingId===item.id||props.deletingId===item.id}>{props.annullingId===item.id?"Anulando…":"Anular"}</button>}
    {canDelete&&<button type="button" className={styles.destructive} onClick={()=>props.remove(item)} disabled={props.deletingId===item.id||props.annullingId===item.id}>{props.deletingId===item.id?"Eliminando…":"Eliminar"}</button>}
    {!canAnnul&&!canDelete&&<span>Sin acciones disponibles</span>}
  </div></details>;
}
function Method({value}:{value:string}){
  const normalized=value.toUpperCase();const digital=/NEQUI|DAVIPLATA|DIGITAL/.test(normalized);const Icon=digital?Smartphone:/TRANSFER|BANCO|PSE/.test(normalized)?Landmark:/TARJETA/.test(normalized)?CreditCard:Banknote;
  return <span className={`${styles.method} ${/NEQUI/.test(normalized)?styles.nequi:""}`}><Icon aria-hidden="true"/>{value.charAt(0).toUpperCase()+value.slice(1).toLowerCase()}</span>;
}
function dateTime(value:string){const date=new Date(value);return [paymentReportDate(value),Number.isNaN(date.getTime())?"":new Intl.DateTimeFormat("es-CO",{hour:"2-digit",minute:"2-digit",timeZone:"America/Bogota"}).format(date)];}
export default function PaymentReportView(props:Props){
  const[tab,setTab]=useState<"payments"|"daily">("payments"),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(25);
  const total=props.items.length,pages=Math.max(1,Math.ceil(total/pageSize)),currentPage=Math.min(page,pages);
  const shown=props.items.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const numbers=[...new Set([1,2,3,currentPage-1,currentPage,currentPage+1,pages])].filter(n=>n>0&&n<=pages).sort((a,b)=>a-b);
  const apply=()=>{setPage(1);props.apply();};
  const metrics=[{label:"Abonos del período",value:(props.summary?.totalAbonos||0).toLocaleString("es-CO"),tone:styles.green},{label:"Recaudado del período",value:money(props.summary?.totalRecaudadoPeriodo||0)},{label:"Pendiente por cobrar",value:money(props.summary?.totalPendientePorCobrar||0),tone:styles.amber},{label:"Recaudado general",value:money(props.summary?.totalRecaudadoGeneral||0)},{label:"Créditos al día",value:(props.summary?.creditosAlDia||0).toLocaleString("es-CO")}];
  return <>
    <nav className={base.breadcrumb} aria-label="Ruta actual"><Link href="/dashboard" aria-label="Inicio"><Home aria-hidden="true"/></Link><ChevronRight aria-hidden="true"/><span>Operación</span><ChevronRight aria-hidden="true"/><Link href="/dashboard/reportes">Reportes</Link><ChevronRight aria-hidden="true"/><strong aria-current="page">Abonos</strong></nav>
    <header className={`${base.heading} ${styles.heading}`}><div><h1>Reporte de recaudos</h1><p>Consulta los pagos registrados y su origen.</p></div><div className={base.headingActions}><Link href="/dashboard/reportes" className={base.secondary}><ArrowLeft aria-hidden="true"/>Volver a reportes</Link><button type="button" className={base.primary} onClick={props.exportExcel} disabled={props.loading||props.exporting||!total}><FileSpreadsheet aria-hidden="true"/>{props.exporting?"Generando Excel…":"Exportar Excel"}</button></div></header>
    <section className={styles.metrics} aria-label="Indicadores de recaudos">{metrics.map(metric=><div key={metric.label}><span>{metric.label}</span><strong className={metric.tone}>{props.loading?"…":metric.value}</strong></div>)}</section>
    <form className={styles.filters} role="search" onSubmit={event=>{event.preventDefault();apply();}}>
      <label className={styles.search}><Search aria-hidden="true"/><input aria-label="Buscar recaudos" placeholder="Cliente, cédula, Sadmin, crédito o folio" value={props.search} onChange={event=>props.setSearch(event.target.value)}/></label>
      <input type="date" aria-label="Fecha desde" value={props.from} onChange={event=>props.setFrom(event.target.value)}/><input type="date" aria-label="Fecha hasta" value={props.to} onChange={event=>props.setTo(event.target.value)}/>
      {props.isAdmin?<><select aria-label="Aliado" value={props.aliadoId} onChange={event=>props.setAliado(event.target.value)}><option value="">Todos los aliados</option>{props.aliados.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select><select aria-label="Sede" value={props.sedeId} onChange={event=>props.setSede(event.target.value)}><option value="">Todas las sedes</option>{props.sedes.map(item=><option key={item.id} value={item.id}>{item.nombre}</option>)}</select></>:<div className={styles.assigned}>{props.sedeNombre||"Sede asignada"}</div>}
      <button type="submit" className={base.primary} disabled={props.loading}><Search aria-hidden="true"/>Aplicar</button>
    </form>
    {props.message&&!props.error&&<div className={styles.message} role="status">{props.message}</div>}
    <div className={styles.tabs} role="tablist" aria-label="Vistas del reporte" onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?"payments":event.key==="End"?"daily":tab==="payments"?"daily":"payments";setTab(next);event.currentTarget.querySelector<HTMLButtonElement>(next==="payments"?"#payments-tab":"#daily-tab")?.focus();}}}><button type="button" role="tab" id="payments-tab" tabIndex={tab==="payments"?0:-1} aria-controls="payments-panel" aria-selected={tab==="payments"} onClick={()=>setTab("payments")}>Pagos registrados</button><button type="button" role="tab" id="daily-tab" tabIndex={tab==="daily"?0:-1} aria-controls="daily-panel" aria-selected={tab==="daily"} onClick={()=>setTab("daily")}>Recaudo día a día</button></div>
    <section id={tab==="payments"?"payments-panel":"daily-panel"} role="tabpanel" aria-labelledby={tab==="payments"?"payments-tab":"daily-tab"} aria-busy={props.loading} className={styles.panel}>
      {props.error?<div className={styles.feedback} role="alert"><h2>No se pudo cargar el reporte</h2><p>{props.message}</p><button type="button" className={base.secondary} onClick={props.apply}>Reintentar</button></div>:props.loading?<div role="status" className={styles.feedback}>Consultando recaudos…</div>:tab==="payments"?<>
        <table className={styles.table}><colgroup>{[10,16,15.5,19,12,12,10,5.5].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup><thead><tr>{["Fecha","Cliente","Crédito Sadmin","Origen","Método","Valor","Estado","Acciones"].map(label=><th key={label} scope="col" className={label==="Valor"?styles.money:undefined}>{label==="Acciones"?<span className={base.srOnly}>Acciones</span>:label}</th>)}</tr></thead><tbody>{shown.length?shown.map(item=>{
          const sadmin=creditReportSadmin(item.credito),[date,time]=dateTime(item.fechaAbono),state=item.estado||"ACTIVO",annulled=state==="ANULADO";
          return <tr key={item.id} className={annulled?styles.annulled:undefined}>
            <td data-label="Fecha"><strong>{date}</strong><small>{time}</small></td>
            <td data-label="Cliente"><strong>{item.credito.clienteNombre}</strong><small>CC {creditReportDocument(item.credito.clienteDocumento)||"Sin documento"}</small></td>
            <td data-label="Crédito Sadmin">{sadmin?<strong>{sadmin}</strong>:<span className={styles.pending}>PENDIENTE</span>}</td>
            <td data-label="Origen"><strong>{item.sede.aliado?.nombre||"Sin aliado"}</strong><small>{item.sede.nombre}</small><small>Responsable: {paymentReportCollector(item)}</small></td>
            <td data-label="Método"><Method value={item.metodoPago}/></td>
            <td data-label="Valor" className={styles.money}><strong>{money(item.valor)}</strong></td>
            <td data-label="Estado"><span className={`${styles.state} ${annulled?styles.danger:state==="ACTIVO"?styles.positive:styles.neutral}`}>{state.charAt(0).toUpperCase()+state.slice(1).toLowerCase()}</span>{annulled&&<small>{item.anulacionMotivo||"Sin motivo"}<br/>{paymentReportDate(item.anuladoAt,true)}</small>}</td>
            <td data-label="Acciones"><PaymentActions item={item} props={props}/></td>
          </tr>;
        }):<tr><td colSpan={8} className={styles.feedback}>No hay pagos para los filtros seleccionados.</td></tr>}</tbody></table>
        <footer className={styles.pagination}><p>Mostrando {total?(currentPage-1)*pageSize+1:0} – {Math.min(currentPage*pageSize,total)} de {total.toLocaleString("es-CO")} resultados</p><select aria-label="Pagos por página" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[25,50,100,500].map(size=><option key={size} value={size}>{size} por página</option>)}</select><nav aria-label="Paginación de pagos"><button type="button" aria-label="Página anterior" disabled={currentPage<=1} onClick={()=>setPage(currentPage-1)}><ChevronLeft aria-hidden="true"/></button>{numbers.map((number,index)=><span key={number}>{index>0&&number-numbers[index-1]>1&&<span className={styles.ellipsis}>…</span>}<button type="button" aria-label={`Página ${number}`} aria-current={number===currentPage?"page":undefined} onClick={()=>setPage(number)}>{number}</button></span>)}<button type="button" aria-label="Página siguiente" disabled={currentPage>=pages} onClick={()=>setPage(currentPage+1)}><ChevronRight aria-hidden="true"/></button></nav></footer>
      </>:<table className={`${styles.table} ${styles.daily}`}><thead><tr><th scope="col">Fecha</th><th scope="col">Abonos</th><th scope="col" className={styles.money}>Total recaudado</th></tr></thead><tbody>{props.byDay.length?props.byDay.map(day=><tr key={day.fecha}><td data-label="Fecha"><strong>{paymentReportDate(day.fecha)}</strong></td><td data-label="Abonos">{day.cantidad.toLocaleString("es-CO")}</td><td data-label="Total recaudado" className={styles.money}><strong>{money(day.total)}</strong></td></tr>):<tr><td colSpan={3} className={styles.feedback}>No hay recaudo para los filtros seleccionados.</td></tr>}</tbody></table>}
    </section>
  </>;
}
