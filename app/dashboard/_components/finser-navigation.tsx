import Link from "next/link";
import { Bell, ChartNoAxesColumnIncreasing, ChevronDown, LayoutGrid, Settings, Timer, UserRound, Wallet, WalletCards, type LucideIcon } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import CentralDashboardMenu from "./central-dashboard-menu";
import LogoutButton from "./logout-button";
import styles from "./finser-navigation.module.css";
type Item = [string, string];

function NavigationMenu({ label, items, active = false, icon: Icon }: { label: string; items: Item[]; active?: boolean; icon?: LucideIcon }) {
  return <div className={active ? styles.active : undefined}>
    <CentralDashboardMenu label={<span className={styles.navLabel}>{Icon && <Icon className={styles.sectionIcon} aria-hidden="true" />}{label}<ChevronDown aria-hidden="true" /></span>}>
      {items.map(([name, href]) => <Link href={href} key={href}>{name}</Link>)}
    </CentralDashboardMenu>
  </div>;
}

export default function FinserNavigation({admin,adminCentral,isSupervisor=false,nombreUsuario,rolUsuario,variant="sale",activeSection="operation"}:{admin:boolean;adminCentral:boolean;isSupervisor?:boolean;nombreUsuario:string;rolUsuario:string;variant?:"sale"|"requests"|"reports"|"settlement";activeSection?:"operation"|"administration"|"reports";}) {
  const operation: Item[] = [
    ...(admin ? [[adminCentral ? "Aprobaciones" : "Pendientes", adminCentral ? "/dashboard/aprobaciones" : "/dashboard/pendientes"]] as Item[] : []),
    ["Nueva venta", "/dashboard/creditos"], ["Solicitudes", "/dashboard/solicitudes"], ["Simulador", "/dashboard/creditos?mode=simulator"],
    ...(admin || isSupervisor ? [["Clientes", "/dashboard/clientes"], ["Recaudos", "/dashboard/abonos"]] as Item[] : []),
    ...(admin ? [["Pagos aliado", "/dashboard/pagos-aliados"], ["Reportes", "/dashboard/reportes"]] as Item[] : []),
    ...(adminCentral ? [["Créditos masivos", "/dashboard/creditos-masivos"], ["Excepciones por mora", "/dashboard/excepciones-mora"]] as Item[] : []),
  ];
  const administration: Item[] = [
    ...(adminCentral ? [["Comisiones", "/dashboard/comisiones"], ["Aliados", "/dashboard/aliados"], ["Lista negra", "/dashboard/lista-negra"]] as Item[] : []),
    ["Sedes", "/dashboard/sedes"], ["Usuarios", "/dashboard/usuarios"],
    ...(adminCentral ? [["Catálogo de equipos", "/dashboard/catalogo-equipos"], ["Parámetros de crédito", "/dashboard/parametros-credito"]] as Item[] : []),
  ];
  const portfolio: Item[] = [["Resumen", "/dashboard/cartera"], ["Detalle de mora", "/dashboard/cartera/detalle-mora"], ["Riesgo por referencia", "/dashboard/riesgo-referencia"]];
  const integrations: Item[] = [["Integraciones", "/dashboard/integraciones"], ["Enrolamiento iPhone", "/dashboard/integraciones/enrolamiento-iphone"], ["Historial DataCrédito", "/dashboard/datacredito"], ["Liberar consultas", "/dashboard/datacredito/liberaciones"], ["Equality Zero Touch", "/dashboard/equality"]];

  if (variant === "settlement") {
    const initials = nombreUsuario.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    return <header className={`${styles.topbar} ${styles.settlement}`}>
      <Link href="/dashboard" aria-label="FINSER PAY, inicio" className={styles.brand}><FinserBrand dark accentPay wordmarkOnly showTagline={false} /></Link>
      <nav className={styles.navigation} aria-label="Navegación principal">
        <Link href="/dashboard"><LayoutGrid aria-hidden="true" />Panel</Link>
        <NavigationMenu label="Operación" icon={Timer} items={operation.filter(([, href]) => href !== "/dashboard/pagos-aliados" && href !== "/dashboard/reportes")} />
        {admin && <NavigationMenu label="Cartera" icon={WalletCards} items={portfolio} />}
        {admin && <Link href="/dashboard/pagos-aliados" className={styles.active} aria-current="page"><Wallet aria-hidden="true" />Pagos</Link>}
        {admin && <Link href="/dashboard/reportes"><ChartNoAxesColumnIncreasing aria-hidden="true" />Reportes</Link>}
      </nav>
      <div className={styles.account}>
        {admin && <CentralDashboardMenu summaryClassName={styles.settings} label={<><Settings aria-hidden="true" /><span className={styles.srOnly}>Administración e integraciones</span></>}>
          <strong className={styles.menuHeading}>Administración</strong>
          {administration.map(([name, href]) => <Link href={href} key={href}>{name}</Link>)}
          {adminCentral && <><strong className={styles.menuHeading}>Integraciones</strong>{integrations.map(([name, href]) => <Link href={href} key={href}>{name}</Link>)}</>}
        </CentralDashboardMenu>}
        <CentralDashboardMenu summaryClassName={styles.settlementProfile} label={<><span className={styles.avatar}>{initials || <UserRound aria-hidden="true" />}</span><span className={styles.profileName}>{nombreUsuario}</span><ChevronDown aria-hidden="true" /><span className={styles.srOnly}>Perfil de {nombreUsuario}</span></>}>
          <div className={styles.identity}><strong>{nombreUsuario}</strong><span>{rolUsuario}</span></div>
          {!admin && <Link href="/dashboard/pin">Cambiar PIN</Link>}
          <LogoutButton className={styles.logout} showIcon />
        </CentralDashboardMenu>
      </div>
    </header>;
  }
return (<header className={`${styles.topbar} ${variant === "requests" ? styles.requests : ""} ${variant === "reports" ? styles.reports : ""}`}>
      <Link href="/dashboard" aria-label="FINSER PAY, inicio" className={styles.brand}><FinserBrand dark accentPay wordmarkOnly={variant === "sale"} mini={variant !== "sale"} plainMark={variant === "reports"} showTagline={false} /></Link>
      <nav className={styles.navigation} aria-label="Navegación principal">
        <Link href="/dashboard">{variant === "reports" ? "Panel central" : "Inicio"}</Link>
        <NavigationMenu label="Operación" items={operation} active={activeSection==="operation"} />
        {admin && <NavigationMenu label="Cartera" items={portfolio} />}
        {variant === "reports" && admin && <Link href="/dashboard/reportes" className={styles.active} aria-current="location">Reportes</Link>}
        {admin && <NavigationMenu label="Administración" items={administration} active={activeSection==="administration"} />}
        {(variant === "requests" || variant === "reports") && adminCentral && <NavigationMenu label="Integraciones" items={integrations} />}
      </nav>
      <div className={styles.account}>
        {variant === "reports" && adminCentral && <Link className={styles.notification} href="/dashboard/aprobaciones" aria-label="Consultar bienvenidas y aprobaciones"><Bell aria-hidden="true" /></Link>}
        {variant === "requests" && <Link className={styles.notification} href="/dashboard/solicitudes?estado=PROCESO" aria-label="Consultar solicitudes en proceso"><Bell aria-hidden="true" /></Link>}
        <CentralDashboardMenu summaryClassName={variant !== "sale" ? styles.requestProfile : styles.profile} label={variant !== "sale" ? <><span className={styles.avatar}>{nombreUsuario.trim().split(/\s+/).slice(0,2).map(part => part[0]).join("").toUpperCase()}</span><span className={styles.profileName}>{nombreUsuario}</span><ChevronDown aria-hidden="true" /></> : <><UserRound aria-hidden="true" /><span className={styles.srOnly}>Perfil de {nombreUsuario}</span></>}>
          <div className={styles.identity}><strong>{nombreUsuario}</strong><span>{rolUsuario}</span></div>
          {!admin && <Link href="/dashboard/pin">Cambiar PIN</Link>}
          <LogoutButton className={styles.logout} showIcon />
        </CentralDashboardMenu>
        <span className={styles.srOnly}>Perfil de {nombreUsuario}</span>
      </div>
    </header>);
}
