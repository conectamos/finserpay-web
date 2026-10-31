import Link from "next/link";
import { ClipboardList, ChevronDown } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import FinserSupportLink from "@/app/_components/finser-support-link";
import CentralDashboardMenu from "@/app/dashboard/_components/central-dashboard-menu";
import LogoutButton from "@/app/dashboard/_components/logout-button";
import { AttentionNotificationBell } from "@/app/dashboard/_components/attention-notifications";
import styles from "./analyst-navigation.module.css";

export default function AnalystNavigation({ userName, userRole, compact = false, centralAdmin = false, plainBrand = false }: { userName: string; userRole: string; compact?: boolean; centralAdmin?: boolean; plainBrand?: boolean }) {
  const role = centralAdmin ? "Admin Central FINSER" : userRole === "ANALISTA_APROBACION" ? "Analista" : userRole;
  const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  return <header className={`${styles.header}${compact ? ` ${styles.compact}` : ""}${plainBrand ? ` ${styles.plainBrand}` : ""}`}>
    <Link className={styles.brand} href="/dashboard/aprobaciones/centro" aria-label="FINSER PAY, Centro del analista"><FinserBrand wordmarkOnly={plainBrand} mini dark={!plainBrand} plainMark accentPay showTagline={false} /></Link>
    <div className={styles.account}>
      <AttentionNotificationBell />
      <Link href="/dashboard/aprobaciones/solicitudes" className={styles.notifications} aria-label="Consultar solicitudes"><ClipboardList aria-hidden="true" /></Link>
      <CentralDashboardMenu summaryClassName={styles.profile} label={<><span className={styles.avatar}>{initials}</span><span className={styles.identity}><strong>{userName}</strong><span>{role}</span></span><ChevronDown className={styles.chevron} aria-hidden="true" /></>}>
        <div className={styles.menuIdentity}><strong>{userName}</strong><span>{role}</span></div>
        {centralAdmin && <><Link href="/dashboard">Volver al panel central</Link><Link href="/dashboard/contrasena">Cambiar contraseña</Link></>}
        <FinserSupportLink className={styles.help}>Ayuda</FinserSupportLink>
        <LogoutButton className={styles.logout} showIcon />
      </CentralDashboardMenu>
    </div>
  </header>;
}
