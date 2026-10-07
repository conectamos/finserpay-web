import Link from "next/link";
import { isAdminRole } from "@/lib/roles";
import { ArrowRight, Bell, CalendarDays, Calculator, ChevronDown, ChevronRight, CircleAlert, CreditCard, FilePlus2, FileText, Layers, TriangleAlert, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/app/_components/finser-ui";
import FinserBrand from "@/app/_components/finser-brand";
import type { AdminDashboardOverview } from "../_lib/admin-dashboard-data";
import LogoutButton from "./logout-button";
import DashboardFilters from "./central-dashboard-filters";
import CentralDashboardMenu from "./central-dashboard-menu";
import styles from "./admin-central-dashboard.module.css";
type Props = {
    adminCentral: boolean;
    aliadoNombre: string;
    data: AdminDashboardOverview;
    nombreUsuario: string;
    rolUsuario: string;
    sedeLabel: string;
    availableSedes: {
        id: number;
        nombre: string;
    }[];
    selectedSede: number | null;
    allies: { id: number; nombre: string; codigo: string | null }[];
    selectedAlly: { id: number; nombre: string; codigo: string | null } | null;
};
const money = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n).replace(/\s/g, "");
const number = (n: number) => new Intl.NumberFormat("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const percent = (n: number) => `${number(n)}%`;
const compact = (n: number) => n >= 1e6 ? `$${number(n / 1e6)} M` : money(n);
function Menu({ label, items }: {
    label: string;
    items: [
        string,
        string
    ][];
}) {
    return <CentralDashboardMenu label={<>{label}<ChevronDown aria-hidden="true"/></>}>{items.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}</CentralDashboardMenu>;
}
function MovementChart({ data }: {
    data: AdminDashboardOverview;
}) {
    const peak = Math.max(1, ...data.daily.flatMap(p => [p.placedCapital, p.recaudo]));
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const max = Math.ceil(peak / magnitude / .5) * magnitude * .5;
    const x = (i: number) => 54 + i * 716 / Math.max(1, data.daily.length - 1);
    const y = (n: number) => 168 - n / max * 142;
    return <svg className={styles.chart} viewBox="0 0 790 205" role="img" aria-label={`Capital y recaudo diario de ${data.monthLabel}`}>
    <defs><linearGradient id="central-capital" x2="0" y2="1"><stop stopColor="#252b2b"/><stop offset="1" stopColor="#424747"/></linearGradient></defs>
    {[0, .2, .4, .6, .8, 1].map(t => <g key={t}><line x1="38" x2="786" y1={y(max * t)} y2={y(max * t)} stroke="#d9dde1" strokeDasharray="3 3"/><text x="29" y={y(max * t) + 4} textAnchor="end">{t === 0 ? "0" : max * t >= 1e6 ? `${Math.round(max * t / 1e6)} M` : compact(max * t)}</text></g>)}
    <line x1="38" x2="38" y1="26" y2="168" stroke="#bec5cc"/>
    {data.daily.map((p, i) => <rect key={p.day} x={x(i) - 7} y={y(p.placedCapital)} width="14" height={168 - y(p.placedCapital)} rx="1" fill="url(#central-capital)"><title>{`${p.day}: ${money(p.placedCapital)} colocados · ${p.creditCount} ventas`}</title></rect>)}
    <polyline points={data.daily.map((p, i) => `${x(i)},${y(p.recaudo)}`).join(" ")} fill="none" stroke="var(--fp-central-lime)" strokeWidth="2.5" strokeLinejoin="round"/>
    {data.daily.map((p, i) => <g key={p.day}><circle cx={x(i)} cy={y(p.recaudo)} r="4.5" fill="var(--fp-central-lime)"><title>{`${p.day}: ${money(p.recaudo)} recaudados`}</title></circle>{(p.day % 2 === 1 || p.day === data.daily.length) && <text x={x(i)} y="190" textAnchor="middle">{p.day}</text>}</g>)}
  </svg>;
}
function Action({ href, icon: Icon, label }: {
    href: string;
    icon: LucideIcon;
    label: string;
}) {
    return <Link href={href} className={styles.action}><Icon aria-hidden="true" strokeWidth={1.7}/>{label}</Link>;
}
export default function AdminCentralDashboard({ adminCentral, aliadoNombre, data, nombreUsuario, rolUsuario, availableSedes, selectedSede, allies, selectedAlly }: Props) {
    const carteraHref = adminCentral ? selectedAlly ? `/dashboard/cartera?aliadoId=${selectedAlly.id}` : "/dashboard/cartera" : "/dashboard/abonos";
    const resumenHref = selectedAlly ? `/dashboard/cartera?aliadoId=${selectedAlly.id}` : "/dashboard/cartera";
    const moraHref = selectedAlly ? `/dashboard/cartera/detalle-mora?aliadoId=${selectedAlly.id}` : "/dashboard/cartera/detalle-mora";
    const platforms = (["IPHONE", "ANDROID"] as const).map(key => ({ name: key === "IPHONE" ? "iPhone" : "Android", total: data.productHealth[key].totalBalance, healthy: data.productHealth[key].healthyPercent, early: data.productHealth[key].earlyPercent, critical: data.productHealth[key].criticalPercent }));
    const operation: [
        string,
        string
    ][] = [...(adminCentral ? [["Aprobaciones", "/dashboard/aprobaciones"]] as [string,string][] : isAdminRole(rolUsuario) ? [["Pendientes", "/dashboard/pendientes"]] as [string,string][] : []), ["Solicitudes", "/dashboard/solicitudes"], ["Créditos", "/dashboard/creditos"], ...(adminCentral ? [["Simulador", "/dashboard/creditos?mode=simulator"], ["Créditos masivos", "/dashboard/creditos-masivos"]] as [
            string,
            string
        ][] : []), ["Recaudos", "/dashboard/abonos"], ["Pagos aliado", "/dashboard/pagos-aliados"], ["Clientes", "/dashboard/clientes"], ...(adminCentral ? [["Excepciones por mora", "/dashboard/excepciones-mora"]] as [
            string,
            string
        ][] : []), ["Reportes", "/dashboard/reportes"]];
    const administration: [
        string,
        string
    ][] = [...(adminCentral && isAdminRole(rolUsuario) ? [["Comisiones", "/dashboard/comisiones"], ["Aliados", "/dashboard/aliados"], ["Lista negra", "/dashboard/lista-negra"]] as [
            string,
            string
        ][] : []), ["Sedes", "/dashboard/sedes"], ["Usuarios", "/dashboard/usuarios"], ...(adminCentral ? [["Catálogo de equipos", "/dashboard/catalogo-equipos"], ["Parámetros de crédito", "/dashboard/parametros-credito"]] as [
            string,
            string
        ][] : [])];
    return <div className={styles.dashboard}>
  <header className={styles.topbar}><Link href="/dashboard" aria-label="FINSER PAY, inicio" className={styles.brand}><FinserBrand dark accentPay wordmarkOnly showTagline={false}/></Link>
   <nav aria-label="Navegación principal" className={styles.navigation}><Link className={styles.active} aria-current="page" href="/dashboard">Inicio</Link><Menu label="Operación" items={operation}/><Menu label="Cartera" items={[...(adminCentral ? [["Salud de cartera", carteraHref]] as [
            string,
            string
        ][] : []), ["Detalle de mora", "/dashboard/cartera/detalle-mora"], ["Riesgo por referencia", "/dashboard/riesgo-referencia"]]}/><Menu label="Administración" items={administration}/>{adminCentral && <Menu label="Integraciones" items={[["Integraciones", "/dashboard/integraciones"], ["Enrolamiento iPhone", "/dashboard/integraciones/enrolamiento-iphone"], ["Liberar consultas", "/dashboard/datacredito/liberaciones"], ["Historial DataCrédito", "/dashboard/datacredito"], ["Equality Zero Touch", "/dashboard/equality"]]}/>}</nav>
   <div className={styles.account}><Link href={carteraHref} className={styles.notification} aria-label={`${data.alertsCount} alertas de cartera`}><Bell aria-hidden="true"/>{data.alertsCount > 0 && <i />}</Link><CentralDashboardMenu summaryClassName={styles.profile} label={<><span className={styles.avatar}><UserRound aria-hidden="true" fill="currentColor"/></span><span>{nombreUsuario}<small>{rolUsuario.toUpperCase().includes("ADMIN") ? "Administrador" : rolUsuario}<ChevronDown aria-hidden="true"/></small></span></>}><LogoutButton /></CentralDashboardMenu></div>
  </header>
  <main className={styles.main}><div className={styles.heading}><h1>{adminCentral ? "Panel central" : "Panel aliado"}</h1><DashboardFilters sedes={availableSedes} sede={selectedSede} month={data.monthKey} scopeLabel={adminCentral ? "Todas las sedes" : aliadoNombre} allies={allies} selectedAlly={selectedAlly}/></div>
   <section className={styles.financial} aria-label="Indicadores financieros"><div className={`${styles.amounts} ${adminCentral ? "" : styles.allyAmounts}`}>{[["Capital colocado", data.investedCapital], ["Cartera activa", data.activePlacedCapital], ...(adminCentral ? [["Recaudo acumulado", data.accumulatedCollection]] : [])].map(([label, value]) => <div key={label}><p>{label}</p><strong>{money(Number(value))}</strong></div>)}</div><div className={styles.counts}><span><b>{data.totalCredits}</b> créditos</span><span><b>{data.activeCredits}</b> activos</span><span><b>{data.closedCredits}</b> finalizados</span></div></section>
   <div className={styles.middle}><Card className={styles.movement}><div className={styles.sectionHeading}><h2>Movimiento del mes</h2><div className={styles.legend}><span><i />Capital</span><span><i />Recaudo</span></div></div><div className={styles.monthCounts}><span><b>{data.monthlyCreditCount}</b> ventas</span><span><b>{data.monthlyPaymentCount}</b> abonos</span></div><div className={styles.chartViewport}><MovementChart data={data}/></div><div className={styles.totals}><div><strong>{money(data.monthlyPlacedCapital)}</strong><span>Colocado</span></div><div><strong>{money(data.monthlyCollection)}</strong><span>Recaudado</span></div></div></Card>
   <Card className={styles.health}><div className={styles.sectionHeading}><h2>Salud de cartera</h2><Link href={moraHref}>Ver detalle <ArrowRight aria-hidden="true"/></Link></div><strong className={styles.healthPercent}>{percent(data.healthyPercent)}</strong><p className={styles.healthCaption}>Al día</p><div className={styles.healthBar} role="img" aria-label={`${percent(data.healthyPercent)} al día, ${percent(data.earlyPercent)} mora temprana y ${percent(data.criticalPercent)} mora crítica`}><span style={{ width: `${data.healthyPercent}%` }}/><span style={{ width: `${data.earlyPercent}%` }}/><span style={{ width: `${data.criticalPercent}%` }}/></div><div className={styles.riskLegend}>{[[data.healthyPercent, "Al día"], [data.earlyPercent, "Mora temprana"], [data.criticalPercent, "Mora crítica"]].map(([value, label]) => <span key={label}><i /><b>{percent(Number(value))}</b> {label}</span>)}</div>
    <div className={styles.platforms}>{platforms.map(p => <div className={styles.platform} key={p.name}><span className={`${styles.platformIcon} ${p.name === "Android" ? styles.android : ""}`}><span style={{ maskImage: `url(/assets/dashboard/${p.name === "iPhone" ? "apple" : "android"}.svg)` }} role="img" aria-label={p.name === "iPhone" ? "Apple" : "Android"}/></span><b>{p.name}</b><div><strong>{p.total > 0 ? `${percent(p.early + p.critical)} en mora` : "Sin cartera activa"}</strong><small>Al día {percent(p.healthy)} · Temprana {percent(p.early)} · Crítica {percent(p.critical)}</small></div></div>)}</div>
   </Card></div>
   <div className={styles.bottom}><section className={styles.attention}><h2>Por atender</h2>{[{ label: "Vencen hoy", count: data.dueToday, icon: CalendarDays, tone: "positive" }, { label: "Mora temprana", count: data.earlyClients, icon: TriangleAlert, tone: "warning" }, { label: "Prioridad", count: data.criticalCredits, icon: CircleAlert, tone: "danger" }].map(({ label, count, icon: Icon, tone }) => <Link key={label} href={resumenHref} className={styles.alert}><span className={`${styles.alertIcon} ${styles[tone]}`}><Icon aria-hidden="true"/></span><b>{count}</b><span>{label}</span><ChevronRight aria-hidden="true"/></Link>)}</section>
   <section className={styles.allies}><div className={styles.sectionHeading}><h2>{selectedAlly || !adminCentral ? "Sedes" : "Aliados"}</h2><span>Colocado · Créditos</span></div>{data.creditPerformance.length ? data.creditPerformance.slice(0, 4).map(a => <div className={styles.ally} key={a.name}><span>{a.name}</span><span>{money(a.value)}<i>·</i>{a.units}</span></div>) : <p className={styles.empty}>Sin colocaciones en este periodo.</p>}</section>
   <section className={styles.actions}><h2>Acciones</h2><div><Action href="/dashboard/creditos" icon={FilePlus2} label="Nuevo crédito"/>{adminCentral && <Action href="/dashboard/creditos?mode=simulator" icon={Calculator} label="Simular"/>}<Action href="/dashboard/abonos" icon={CreditCard} label="Recibir abono"/><Action href="/dashboard/clientes" icon={UserRound} label="Buscar usuario"/>{adminCentral ? <><Action href="/dashboard/creditos-masivos" icon={Layers} label="Créditos masivos"/><Action href="/dashboard/excepciones-mora" icon={FileText} label="Excepciones"/></> : <Action href="/dashboard/reportes" icon={FileText} label="Ver reportes"/>}</div></section></div>
  </main>
 </div>;
}
