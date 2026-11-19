import { redirect } from "next/navigation";
import { AppShell } from "@/app/_components/finser-ui";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getDataCreditoAllyBranchQuotaAdmin } from "@/lib/datacredito/ally-branch-quota-access";
import CuposConsultasClient from "./cupos-consultas-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cupos de consultas | FINSER PAY",
  description: "Distribución del cupo diario de consultas entre las sedes del aliado",
};

export default async function CuposConsultasPage() {
  const access = await getDataCreditoAllyBranchQuotaAdmin();
  if (!access.ok) redirect(access.status === 401 ? "/aliados" : "/dashboard");
  if (isFinserPayCentralAlly(access.user.aliadoAccesoCodigo)) {
    redirect("/dashboard/parametros-credito");
  }

  return <AppShell>
    <FinserNavigation admin adminCentral={false} variant="administration" activeSection="administration"
      nombreUsuario={access.user.nombre} rolUsuario={access.user.rolNombre} />
    <CuposConsultasClient />
  </AppShell>;
}
