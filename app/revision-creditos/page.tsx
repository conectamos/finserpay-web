import { redirect } from "next/navigation";
import { getApprovalSharedSession } from "@/lib/approval-shared-session";
import FinserBrand from "@/app/_components/finser-brand";
import ApprovalConsole from "@/app/dashboard/aprobaciones/approval-console";
import SharedLogout from "./shared-logout";
import styles from "./shared-review.module.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Revisión de créditos | FINSER PAY", robots: { index:false,follow:false,nocache:true,noarchive:true }, referrer:"no-referrer" as const };
export default async function SharedCreditReviewPage(){
  const session=await getApprovalSharedSession();
  if(!session)redirect("/acceso-revision");
  return <div className={`fp-ui-shell ${styles.root}`}>
    <header className={styles.header}>
      <FinserBrand mini dark plainMark showTagline={false}/><div className={styles.access}><span>Acceso por enlace</span><SharedLogout/></div>
    </header><ApprovalConsole shared/>
  </div>;
}
