import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ChevronDown, LockKeyhole, UserRound } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import CentralDashboardMenu from "../_components/central-dashboard-menu";
import LogoutButton from "../_components/logout-button";
import styles from "./new-sale-platform-selector.module.css";

type Props = {
  admin: boolean;
  adminCentral: boolean;
  isSupervisor?: boolean;
  androidHref: string;
  iphoneHref: string;
  nombreUsuario: string;
  rolUsuario: string;
};
type Item = [string, string];

function NavigationMenu({ label, items, active = false }: { label: string; items: Item[]; active?: boolean }) {
  return <div className={active ? styles.active : undefined}>
    <CentralDashboardMenu label={<span className={styles.navLabel}>{label}<ChevronDown aria-hidden="true" /></span>}>
      {items.map(([name, href]) => <Link href={href} key={href}>{name}</Link>)}
    </CentralDashboardMenu>
  </div>;
}

export default function NewSalePlatformSelector({ admin, adminCentral, isSupervisor = false, androidHref, iphoneHref, nombreUsuario, rolUsuario }: Props) {
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
  return <div className={styles.screen}>
    <header className={styles.topbar}>
      <Link href="/dashboard" aria-label="FINSER PAY, inicio" className={styles.brand}><FinserBrand dark accentPay wordmarkOnly showTagline={false} /></Link>
      <nav className={styles.navigation} aria-label="Navegación principal">
        <Link href="/dashboard">Inicio</Link>
        <NavigationMenu label="Operación" items={operation} active />
        {admin && <NavigationMenu label="Cartera" items={[["Resumen", "/dashboard/cartera"], ["Detalle de mora", "/dashboard/cartera/detalle-mora"], ["Riesgo por referencia", "/dashboard/riesgo-referencia"]]} />}
        {admin && <NavigationMenu label="Administración" items={administration} />}
      </nav>
      <div className={styles.account}>
        <CentralDashboardMenu summaryClassName={styles.profile} label={<><UserRound aria-hidden="true" /><span className={styles.srOnly}>Perfil de {nombreUsuario}</span></>}>
          <div className={styles.identity}><strong>{nombreUsuario}</strong><span>{rolUsuario}</span></div>
          {!admin && <Link href="/dashboard/pin">Cambiar PIN</Link>}
          <LogoutButton className={styles.logout} showIcon />
        </CentralDashboardMenu>
        <span className={styles.srOnly}>Perfil de {nombreUsuario}</span>
      </div>
    </header>
    <main className={styles.main}>
      <div className={styles.routeRow}>
        <nav aria-label="Ruta actual" className={styles.breadcrumb}><Link href="/dashboard">Ventas</Link><span aria-hidden="true">/</span><span aria-current="page">Nueva venta</span></nav>
        <Link href="/dashboard" className={styles.back}><ArrowLeft aria-hidden="true" />Volver</Link>
      </div>
      <section className={styles.choice} aria-labelledby="new-sale-heading">
        <p className={styles.eyebrow}>Nueva venta</p>
        <h1 id="new-sale-heading">Elige cómo comenzar</h1>
        <p className={styles.question}>¿Qué equipo vas a financiar?</p>
        <div className={styles.cards}>
          {[
            { platform: "Android", href: androidHref, image: "/assets/creditos/android-symbol-3d.png" },
            { platform: "iPhone", href: iphoneHref, image: "/assets/creditos/apple-symbol-3d.png" },
          ].map(({ platform, href, image }) => <Link key={platform} href={href} className={styles.card} aria-label={`Continuar con ${platform}`}>
            <Image src={image} alt="" width={280} height={280} sizes="(max-width: 600px) 220px, 280px" preload className={styles.symbol} />
            <h2>{platform}</h2>
            <span className={styles.continue}>Continuar<ArrowRight aria-hidden="true" /></span>
          </Link>)}
        </div>
        <p className={styles.secure}><LockKeyhole aria-hidden="true" />Proceso seguro</p>
      </section>
    </main>
  </div>;
}
