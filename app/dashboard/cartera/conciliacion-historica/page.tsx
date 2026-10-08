import { notFound } from "next/navigation";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import prisma from "@/lib/prisma";
import { AppShell, PageHeader } from "@/app/_components/finser-ui";
import AdminSidebar from "../../_components/admin-sidebar";
import AdminWorkspaceTopbar from "../../_components/admin-workspace-topbar";
import ReconciliationForm from "./reconciliation-form";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{id?:string}>}) {
 const {session}=await requireCentralAdminDashboardAccess();
 const id=Number((await searchParams).id);if(!Number.isSafeInteger(id)||id<=0) notFound();
 const credit=await prisma.credito.findUnique({where:{id},select:{id:true,clienteNombre:true,clienteDocumento:true,folio:true}});if(!credit) notFound();
 return <AppShell sidebar={<AdminSidebar activeHref="/dashboard/cartera" adminCentral nombreUsuario={session.nombre} rolUsuario={session.rolNombre}/> }><AdminWorkspaceTopbar parent="Cartera" current="Conciliación histórica" userName={session.nombre} userRole={session.rolNombre} accentAvatar/><main className="grid min-w-0 gap-6 p-4 sm:p-8"><PageHeader title="Conciliación histórica documentada" description={`${credit.clienteNombre} · ${credit.clienteDocumento}`}/><ReconciliationForm id={credit.id}/></main></AppShell>;
}
