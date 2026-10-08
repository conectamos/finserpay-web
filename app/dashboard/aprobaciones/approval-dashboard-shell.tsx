import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isApprovalAnalystRole } from "@/lib/roles";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import AnalystNavigation from "./analyst-navigation";
import styles from "./analyst-navigation.module.css";

type ApprovalDashboardUser = {
  nombre: string;
  rolNombre: string;
  aliadoAccesoCodigo: string | null;
};

export default async function ApprovalDashboardShell({
  activeHref,
  children,
  user,
}: {
  activeHref: string;
  children: ReactNode;
  user: ApprovalDashboardUser;
}) {
  const nominalAnalyst = isApprovalAnalystRole(user.rolNombre)
    && Boolean(await getNominalApprovalAnalystSessionUser())
    && (await getApprovalSharedRequestActor()) === undefined;
  const compact = activeHref === "/dashboard/aprobaciones/excepciones-mora";
  if (activeHref === "/dashboard/aprobaciones" && !nominalAnalyst) return <div className={styles.exceptionShell}><FinserNavigation admin adminCentral={isFinserPayCentralAlly(user.aliadoAccesoCodigo)} nombreUsuario={user.nombre} rolUsuario={user.rolNombre} variant="requests" />{children}</div>;
  if (nominalAnalyst) return <div className={styles.shell}>
    <AnalystNavigation userName={user.nombre} userRole={user.rolNombre} compact={compact || activeHref === "/dashboard/aprobaciones"} />
    {activeHref !== "/dashboard/aprobaciones/centro" && <Link className={`${styles.back}${compact ? ` ${styles.compactBack}` : ""}`} href="/dashboard/aprobaciones/centro"><ArrowLeft aria-hidden="true" />Volver al Centro del analista</Link>}
    {children}
  </div>;
  if (compact && isFinserPayCentralAlly(user.aliadoAccesoCodigo) && user.rolNombre === "ADMIN") return <div className={styles.exceptionShell}>
    <FinserNavigation admin adminCentral nombreUsuario={user.nombre} rolUsuario={user.rolNombre} variant="requests" />
    <Link className={`${styles.back} ${styles.compactBack}`} href="/dashboard/aprobaciones"><ArrowLeft aria-hidden="true" />Volver a Aprobaciones</Link>
    {children}
  </div>;
  return (
    <AppShell
      className={isApprovalAnalystRole(user.rolNombre) ? "[--fp-muted:#626660] [--fp-border:#dedfdb]" : undefined}
      sidebar={
        <AdminSidebar
          activeHref={activeHref}
          adminCentral={isFinserPayCentralAlly(user.aliadoAccesoCodigo)}
          nombreUsuario={user.nombre}
          rolUsuario={user.rolNombre}
        />
      }
    >
      {children}
    </AppShell>
  );
}
