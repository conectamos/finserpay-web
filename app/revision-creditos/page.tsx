import { redirect } from "next/navigation";
import { getApprovalSharedSession } from "@/lib/approval-shared-session";
import FinserBrand from "@/app/_components/finser-brand";
import ApprovalConsole from "@/app/dashboard/aprobaciones/approval-console";
import SharedLogout from "./shared-logout";
export const dynamic = "force-dynamic";
export const metadata = { title: "Revisión de créditos | FINSER PAY", robots: { index:false,follow:false,nocache:true,noarchive:true }, referrer:"no-referrer" as const };
export default async function SharedCreditReviewPage(){
  const session=await getApprovalSharedSession();
  if(!session)redirect("/acceso-revision");
  return <div className="fp-ui-shell min-h-screen text-[var(--fp-graphite)]">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--fp-border)] bg-[var(--fp-surface)] px-4 py-4 sm:px-6 lg:px-8">
      <FinserBrand compact/><div><p className="font-semibold">Acceso compartido</p><p className="text-sm text-[var(--fp-muted)]">Las acciones se registran por enlace y sesión.</p></div><SharedLogout/>
    </header><ApprovalConsole/>
  </div>;
}
