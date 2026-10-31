import Link from "next/link";
import { redirect } from "next/navigation";
import { AttentionError } from "@/lib/atencion-core";
import { getAttentionWorkAccess } from "@/lib/atencion-work-access";
import FinserNavigation from "../_components/finser-navigation";
import AttentionWorkQueues from "../atencion/attention-work-queues";
import { isAttentionNotificationWorkId } from "@/lib/atencion-notification-links";
export const metadata={title:"Solicitudes de Atención | FINSER PAY"};
export default async function CommercialAttentionPage({searchParams}:{searchParams:Promise<{tipo?:string;solicitud?:string}>}){
  const access=await getAttentionWorkAccess("seller").catch(error=>{if(error instanceof AttentionError&&[401,403].includes(error.status))redirect("/dashboard");throw error;});
  if(access.type!=="seller")redirect("/dashboard");const params=await searchParams;const kind=params.tipo==="welcome"?"welcome":"enrollment";const initialId=isAttentionNotificationWorkId(params.solicitud)?params.solicitud:null;
  return <div className="min-h-screen bg-[var(--fp-bg)]"><FinserNavigation admin={false} adminCentral={false} isSupervisor={access.supervisor} nombreUsuario={access.name} rolUsuario={access.supervisor?"Supervisor":"Vendedor"} variant="requests"/>
    <main className="p-4 md:p-6"><nav aria-label="Solicitudes del asesor" className="mb-4 flex flex-wrap gap-4"><Link href="/dashboard">Inicio</Link><Link href="/dashboard/gestion-comercial?tipo=welcome" aria-current={kind==="welcome"?"page":undefined}>Solicitar aprobación</Link><Link href="/dashboard/gestion-comercial?tipo=enrollment" aria-current={kind==="enrollment"?"page":undefined}>Solicitar enrolamiento</Link></nav><AttentionWorkQueues key={`${kind}:${access.key}:${initialId}`} kind={kind} mode="seller" sellerId={access.sellerId} initialId={initialId}/></main></div>;
}
