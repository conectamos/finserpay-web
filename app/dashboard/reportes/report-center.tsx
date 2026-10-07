"use client";
import Link from "next/link";
import {useEffect,useRef,useState} from "react";
import {ArrowLeft,ArrowRight,CalendarDays,CircleDollarSign,CreditCard,FileSearch,FileSpreadsheet,Globe,Layers,MapPin,PieChart,Search,Store,UserRound,X} from "lucide-react";
import styles from "./report-center.module.css";
export type CenterReport={title:string;description:string;formats:string[];href:string;kind:"credits"|"payments"|"portfolio"|"stores"|"sellers"|"datacredito-sales"};
type Props={period:string;selectedSedeId:string;sedes:{id:number;nombre:string}[];admin:boolean;initialQuery:string;reports:CenterReport[];metrics:{activeCredits:string;collected:string;portfolioBalance:string;mora:string}};
const icons={credits:CreditCard,payments:CircleDollarSign,portfolio:PieChart,stores:Store,sellers:UserRound,"datacredito-sales":FileSearch};
const normalize=(value:string)=>value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es-CO");
export default function ReportCenter(props:Props){
  const[search,setSearch]=useState(props.initialQuery),[formatsOpen,setFormatsOpen]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(formatsOpen)dialog.current?.showModal();else dialog.current?.close();},[formatsOpen]);
  const visible=props.reports.filter(report=>normalize(report.title).includes(normalize(search.trim())));
  return <>
    <header className={styles.heading}><div><span className={styles.eyebrow}>ANÁLISIS Y CONTROL</span><h1>Reportes de tu operación</h1><p>Consulta tus créditos, recaudos y cartera.</p></div><Link href="/dashboard" className={styles.back}><ArrowLeft aria-hidden="true"/>Volver al panel</Link></header>
    <form action="/dashboard/reportes" className={styles.filters}>
      <label><CalendarDays aria-hidden="true"/><select name="period" aria-label="Período" defaultValue={props.period}><option value="month">Este mes</option><option value="previous-month">Mes anterior</option><option value="quarter">Este trimestre</option><option value="year">Este año</option><option value="all">Todo el historial</option></select></label>
      <label><MapPin aria-hidden="true"/><select name="sedeId" aria-label="Sede" defaultValue={props.selectedSedeId||(!props.admin?String(props.sedes[0]?.id||""):"")}>{props.admin&&<option value="">Todas las sedes autorizadas</option>}{props.sedes.map(sede=><option key={sede.id} value={sede.id}>{sede.nombre}</option>)}</select></label>
      <label className={styles.unavailable} title="El filtro de plataforma aún no está disponible en este centro de reportes."><Layers aria-hidden="true"/><select aria-label="Plataforma (no disponible)" disabled><option>Todas las plataformas</option></select></label>
      {search&&<input type="hidden" name="q" value={search}/>}
      <button type="submit" className={styles.apply}>Aplicar</button><Link href="/dashboard/reportes" className={styles.clear}>Limpiar</Link>
    </form>
    <section className={styles.metrics} aria-label="Indicadores de la operación">{[
      ["Créditos activos",props.metrics.activeCredits,"Créditos no anulados con saldo pendiente en las sedes autorizadas."],
      ["Recaudado del período",props.metrics.collected,"Abonos activos registrados dentro del período y alcance seleccionados."],
      ["Saldo de cartera",props.metrics.portfolioBalance,"Saldo pendiente actual de los créditos del alcance seleccionado."],
      ["Mora actual",props.metrics.mora,"Porcentaje del saldo pendiente correspondiente a cuotas vencidas."],
    ].map(([label,value,description],index)=><div key={label} title={description}><span>{label}</span><strong className={index===3?styles.mora:undefined}>{value}</strong></div>)}</section>
    <section aria-labelledby="available-reports"><header className={styles.available}><h2 id="available-reports">Reportes disponibles</h2><label className={styles.search}><Search aria-hidden="true"/><input aria-label="Buscar reportes por nombre" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Buscar reporte..."/></label></header>
      {visible.length?<div className={styles.cards}>{visible.map(report=>{const Icon=icons[report.kind];const excel=report.formats.includes("Excel");return <article className={styles.card} key={report.kind}><div className={styles.cardHeading}><span className={styles.icon}><Icon aria-hidden="true"/></span><div><h3>{report.title}</h3><p>{report.description}</p></div></div><footer><span className={`${styles.format} ${excel?styles.excel:""}`}>{excel?<FileSpreadsheet aria-hidden="true"/>:<Globe aria-hidden="true"/>}{report.formats.join(" · ")}</span><Link href={report.href} aria-label={`Abrir ${report.title}`}>Abrir<ArrowRight aria-hidden="true"/></Link></footer></article>;})}</div>:<div className={styles.empty} role="status"><h3>No encontramos reportes</h3><p>Cambia el nombre que estás buscando.</p><button type="button" className={styles.back} onClick={()=>setSearch("")}>Limpiar búsqueda</button></div>}
    </section>
    <footer className={styles.footer}><button type="button" onClick={()=>setFormatsOpen(true)}><FileSpreadsheet aria-hidden="true"/>Consultar formatos disponibles</button></footer>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="report-formats-title" onCancel={()=>setFormatsOpen(false)}><header><h2 id="report-formats-title">Formatos disponibles</h2><button type="button" aria-label="Cerrar formatos" onClick={()=>setFormatsOpen(false)}><X aria-hidden="true"/></button></header><dl>{props.reports.map(report=><div key={report.kind}><dt>{report.title}</dt><dd>{report.formats.join(" · ")}</dd></div>)}</dl><p>Las exportaciones se generan desde cada reporte con sus filtros aplicados.</p></dialog>
  </>;
}
