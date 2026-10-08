import Link from "next/link";
import { Bell, ChevronDown } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import FinserSupportLink from "@/app/_components/finser-support-link";
import CentralDashboardMenu from "@/app/dashboard/_components/central-dashboard-menu";
import LogoutButton from "@/app/dashboard/_components/logout-button";
import styles from "./analyst-navigation.module.css";

export default function AnalystNavigation({ userName, userRole }: { userName: string; userRole: string }) {
  const role = userRole === "ANALISTA_APROBACION" ? "Analista" : userRole;
  const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  return <header className={styles.header}>
    <Link className={styles.brand} href="/dashboard/aprobaciones/centro" aria-label="FINSER PAY, Centro del analista"><FinserBrand mini dark plainMark accentPay showTagline={false} /></Link>
    <div className={styles.account}>
      <Link href="/dashboard/aprobaciones/solicitudes" className={styles.notifications} aria-label="Consultar solicitudes"><Bell aria-hidden="true" /></Link>
      <CentralDashboardMenu summaryClassName={styles.profile} label={<><span className={styles.avatar}>{initials}</span><span className={styles.identity}><strong>{userName}</strong><span>{role}</span></span><ChevronDown className={styles.chevron} aria-hidden="true" /></>}>
        <div className={styles.menuIdentity}><strong>{userName}</strong><span>{role}</span></div>
        <FinserSupportLink className={styles.help}>Ayuda</FinserSupportLink>
        <LogoutButton className={styles.logout} showIcon />
      </CentralDashboardMenu>
    </div>
  </header>;
}
