import Link from "next/link";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import { PageHeader } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import CommissionBalances from "../commission-balances";
import styles from "../commission-admin.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Saldos por asesor | FINSER PAY",
  description: "Consulta de comisiones mensuales y saldos pendientes por asesor",
};

export default async function CommissionBalancesPage() {
  const { session } = await requireCentralAdminDashboardAccess();

  return (
    <div className={styles.shell}>
      <AdminSidebar activeHref="/dashboard/comisiones" adminCentral nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />
      <div className={styles.workspace}>
        <AdminWorkspaceTopbar parent="Administración" current="Comisiones" userName={session.nombre} userRole={session.rolNombre} />
        <main className={styles.main}>
          <PageHeader eyebrow="Administración central" title="Saldos de comisiones"
            description="Consulta cada mes o todos los pendientes. Los saldos anteriores se conservan al cambiar de mes."
            actions={<Link className="fp-ui-button is-secondary" href="/dashboard/comisiones">Solicitudes de cobro</Link>} />
          <CommissionBalances revision={0} />
        </main>
      </div>
    </div>
  );
}
