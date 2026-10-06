import type { ReactNode } from "react";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isApprovalAnalystRole } from "@/lib/roles";

type ApprovalDashboardUser = {
  nombre: string;
  rolNombre: string;
  aliadoAccesoCodigo: string | null;
};

export default function ApprovalDashboardShell({
  activeHref,
  children,
  user,
}: {
  activeHref: string;
  children: ReactNode;
  user: ApprovalDashboardUser;
}) {
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
