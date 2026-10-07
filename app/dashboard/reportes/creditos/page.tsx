import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import ReporteCreditosPage from "./reporte-creditos-client";
import styles from "./credit-report-view.module.css";

type SearchParams = Promise<{from?:string|string[];sedeId?:string|string[];to?:string|string[]}>;
function firstValue(value:string|string[]|undefined){return Array.isArray(value)?value[0]:value;}
function dateValue(value:string|string[]|undefined){const parsed=String(firstValue(value)||"");return /^\d{4}-\d{2}-\d{2}$/.test(parsed)?parsed:"";}
function idValue(value:string|string[]|undefined){const parsed=String(firstValue(value)||"");return /^\d+$/.test(parsed)?parsed:"";}
export const metadata={title:"Reporte de créditos | FINSER PAY",description:"Ventas y financiación del período."};
export default async function ReporteCreditosRoute({searchParams}:{searchParams:SearchParams}){
  const{admin,session}=await requireAdminOrSupervisorDashboardAccess();
  const adminCentral=admin&&isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const params=await searchParams;
  return <div className={styles.shell}>
    <FinserNavigation variant="requests" admin={admin} adminCentral={adminCentral} isSupervisor={!admin} nombreUsuario={session.nombre} rolUsuario={session.rolNombre}/>
    <ReporteCreditosPage initialFrom={dateValue(params.from)} initialTo={dateValue(params.to)} initialSedeId={idValue(params.sedeId)}/>
  </div>;
}
