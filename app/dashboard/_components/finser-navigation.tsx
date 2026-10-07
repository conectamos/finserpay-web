import Link from "next/link";
import { Bell, ChevronDown, UserRound } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import CentralDashboardMenu from "./central-dashboard-menu";
import LogoutButton from "./logout-button";
import styles from "./finser-navigation.module.css";
type Item = [string, string];

function NavigationMenu({ label, items, active = false }: { label: string; items: Item[]; active?: boolean }) {
  return <div className={active ? styles.active : undefined}>
    <CentralDashboardMenu label={<span className={styles.navLabel}>{label}<ChevronDown aria-hidden="true" /></span>}>
      {items.map(([name, href]) => <Link href={href} key={href}>{name}</Link>)}
    </CentralDashboardMenu>
  </div>;
}

export default function FinserNavigation({admin,adminCentral,isSupervisor=false,nombreUsuario,rolUsuario,variant="sale"}:{admin:boolean;adminCentral:boolean;isSupervisor?:boolean;nombreUsuario:string;rolUsuario:string;variant?:"sale"|"requests";}) {
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
return (<header className={`${styles.topbar} ${variant === "requests" ? styles.requests : ""}`}>
      <Link href="/dashboard" aria-label="FINSER PAY, inicio" className={styles.brand}><FinserBrand dark accentPay wordmarkOnly={variant === "sale"} mini={variant === "requests"} showTagline={false} /></Link>
      <nav className={styles.navigation} aria-label="Navegación principal">
        <Link href="/dashboard">Inicio</Link>
        <NavigationMenu label="Operación" items={operation} active />
        {admin && <NavigationMenu label="Cartera" items={[["Resumen", "/dashboard/cartera"], ["Detalle de mora", "/dashboard/cartera/detalle-mora"], ["Riesgo por referencia", "/dashboard/riesgo-referencia"]]} />}
        {admin && <NavigationMenu label="Administración" items={administration} />}
        {variant === "requests" && adminCentral && <NavigationMenu label="Integraciones" items={[["Integraciones", "/dashboard/integraciones"], ["Enrolamiento iPhone", "/dashboard/integraciones/enrolamiento-iphone"], ["Historial DataCrédito", "/dashboard/datacredito"], ["Liberar consultas", "/dashboard/datacredito/liberaciones"], ["Equality Zero Touch", "/dashboard/equality"]]} />}
      </nav>
      <div className={styles.account}>
        {variant === "requests" && <Link className={styles.notification} href="/dashboard/solicitudes?estado=PROCESO" aria-label="Consultar solicitudes en proceso"><Bell aria-hidden="true" /></Link>}
        <CentralDashboardMenu summaryClassName={variant === "requests" ? styles.requestProfile : styles.profile} label={variant === "requests" ? <><span className={styles.avatar}>{nombreUsuario.trim().split(/\s+/).slice(0,2).map(part => part[0]).join("").toUpperCase()}</span><span className={styles.profileName}>{nombreUsuario}</span><ChevronDown aria-hidden="true" /></> : <><UserRound aria-hidden="true" /><span className={styles.srOnly}>Perfil de {nombreUsuario}</span></>}>
          <div className={styles.identity}><strong>{nombreUsuario}</strong><span>{rolUsuario}</span></div>
          {!admin && <Link href="/dashboard/pin">Cambiar PIN</Link>}
          <LogoutButton className={styles.logout} showIcon />
        </CentralDashboardMenu>
        <span className={styles.srOnly}>Perfil de {nombreUsuario}</span>
      </div>
    </header>);
}
