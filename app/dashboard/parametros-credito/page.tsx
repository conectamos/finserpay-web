import Link from "next/link";
import { LayoutGrid, Settings2 } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import DatacreditoPolicyConsole from "./datacredito-policy-console";
import styles from "./credit-parameters.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Políticas de crédito | FINSER PAY",
  description:
    "Configuración administrativa de las políticas DataCrédito y sus condiciones financieras",
};

export default async function ParametrosCreditoPage() {
  const { session } = await requireCentralAdminDashboardAccess();

  return (
    <main className={styles.page}>
      <header className={styles.topbar}><div className={styles.topbarInner}>
        <Link href="/dashboard" aria-label="FINSER PAY, ir al Dashboard"><FinserBrand wordmarkOnly accentPay compact showTagline={false} /></Link>
        <nav
          className={styles.topbarActions}
          aria-label="Accesos de administración"
        >
          <Link href="/dashboard" className="fp-ui-button is-secondary">
            <LayoutGrid size={18} aria-hidden="true" />Dashboard
          </Link>
          <Link href="/dashboard/creditos" className="fp-ui-button is-primary">
            <Settings2 size={18} aria-hidden="true" />Fábrica de créditos
          </Link>
          <div className={styles.profile}><span className={styles.avatar} aria-hidden="true">{session.nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("")}</span><span className={styles.profileName}>{session.nombre}</span></div>
        </nav>
      </div></header>
      <div className={styles.content}>
        <DatacreditoPolicyConsole />
      </div>
    </main>
  );
}
