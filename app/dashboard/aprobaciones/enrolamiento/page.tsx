import { redirect } from "next/navigation";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import IphoneEnrollmentPortal from "@/app/enrolamiento-iphone/iphone-enrollment-portal";
import { assertMoraActor, getMoraActor } from "@/lib/analyst-mora-access";
import { normalizeIphoneEnrollmentDocument, normalizeIphoneEnrollmentImei } from "@/lib/iphone-enrollment";
import prisma from "@/lib/prisma";
import ApprovalDashboardShell from "../approval-dashboard-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Enrolamiento iPhone | Aprobaciones | FINSER PAY",
  description: "Consulta y validación del enrolamiento iPhone para analistas autorizados.",
  robots: { index: false, follow: false, nocache: true },
};

async function requireEnrollmentDashboardAccess() {
  const actor = await getMoraActor().then(actor => assertMoraActor(prisma, actor)).catch(() => null);
  if (!actor) redirect("/dashboard/aprobaciones");
  return { nombre: actor.nombre, rolNombre: actor.centralAdmin ? "ADMIN" : "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY" };
}

export default async function ApprovalEnrollmentPage({ searchParams }: {
  searchParams: Promise<{ documento?: string | string[]; imei?: string | string[] }>;
}) {
  const user = await requireEnrollmentDashboardAccess();
  const params = await searchParams;
  const initialDocument = typeof params.documento === "string" && params.documento.length <= 100
    ? normalizeIphoneEnrollmentDocument(params.documento) || "" : "";
  const initialImei = typeof params.imei === "string" && params.imei.length <= 100
    ? normalizeIphoneEnrollmentImei(params.imei) || "" : "";

  return <ApprovalDashboardShell activeHref="/dashboard/aprobaciones/enrolamiento" user={user}>
    <AdminWorkspaceTopbar parent="Aprobaciones" current="Enrolamiento iPhone" userName={user.nombre} userRole={user.rolNombre} />
    <IphoneEnrollmentPortal mode="ANALYST" initialDocument={initialDocument} initialImei={initialImei} />
  </ApprovalDashboardShell>;
}
