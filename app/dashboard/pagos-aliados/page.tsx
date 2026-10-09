import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import AllyPaymentsConsole from "./ally-payments-console";

export const metadata = {
  title: "Pagos a aliados | FINSER PAY",
  description: "Liquidaciones, pagos recibidos y pagos pendientes de aliados",
};

export default async function PagosAliadosPage() {
  const { session } = await requireAdminDashboardAccess();
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const allyId = Number(session.aliadoAccesoId || 0);

  return (
    <>
      <FinserNavigation admin adminCentral={adminCentral} nombreUsuario={session.nombre} rolUsuario={session.rolNombre} variant="settlement" />
      <AllyPaymentsConsole
        initialAdminCentral={adminCentral}
        initialAllyId={Number.isInteger(allyId) && allyId > 0 ? allyId : null}
      />
    </>
  );
}
