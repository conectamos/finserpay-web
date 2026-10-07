import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import CreditFactoryConsole from "@/app/dashboard/creditos/credit-factory-console";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import "./client-dossier.css";

export const metadata = {
  title: "Expediente del cliente | FINSER PAY",
  description:
    "Busca clientes, abre expedientes y consulta documentos firmados sin mezclar la fabrica de creditos",
};

type SearchParams = Promise<{ search?: string; selected?: string }>;

export default async function ClientesPage(props: {
  searchParams: SearchParams;
}) {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const admin = isAdminRole(session.rolNombre);
  const sellerSession = admin ? null : await getSellerSessionUser(session);

  if (!admin && !sellerSession) {
    redirect("/dashboard");
  }

  if (
    !admin &&
    sellerSession?.tipoPerfil !== "SUPERVISOR"
  ) {
    redirect("/dashboard");
  }

  const searchParams = await props.searchParams;
  const initialSearch = String(searchParams?.search || "").trim();
  const initialSelectedId = Number(searchParams?.selected || 0);

  const lookupConsole = (
    <CreditFactoryConsole
      initialSession={session}
      initialSeller={sellerSession}
      view="lookup"
      embeddedLookup
      initialSearch={initialSearch}
      initialSelectedId={
        Number.isInteger(initialSelectedId) && initialSelectedId > 0
          ? initialSelectedId
          : null
      }
    />
  );

  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  return <div className="fp-client-page fp-client-dossier-page">
    <FinserNavigation variant="requests" admin={admin} adminCentral={adminCentral} isSupervisor={!admin} nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />
    <main className="fp-client-page-content">{lookupConsole}</main>
  </div>;
}
