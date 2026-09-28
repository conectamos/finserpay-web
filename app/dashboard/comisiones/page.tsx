import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import CommissionAdminConsole from "./commission-admin-console";
import styles from "./commission-admin.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Comisiones de vendedores | FINSER PAY",
  description: "Revisión y pago de comisiones de los vendedores de FINSER PAY",
};

export default async function CommissionsPage() {
  const { session } = await requireCentralAdminDashboardAccess();

  return (
    <div className={styles.shell}>
      <AdminSidebar
        activeHref="/dashboard/comisiones"
        adminCentral
        nombreUsuario={session.nombre}
        rolUsuario={session.rolNombre}
      />
      <div className={styles.workspace}>
        <AdminWorkspaceTopbar
          parent="Administración"
          current="Comisiones"
          userName={session.nombre}
          userRole={session.rolNombre}
        />
        <CommissionAdminConsole />
      </div>
    </div>
  );
}
