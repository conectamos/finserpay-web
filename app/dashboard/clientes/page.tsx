import { redirect } from "next/navigation";
import Link from "next/link";
import { CircleDollarSign, Plus } from "lucide-react";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import CreditFactoryConsole from "@/app/dashboard/creditos/credit-factory-console";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import { PageHeader } from "@/app/_components/finser-ui";

export const metadata = {
  title: "Clientes y expedientes | FINSER PAY",
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
      embeddedLookup={admin}
      initialSearch={initialSearch}
      initialSelectedId={
        Number.isInteger(initialSelectedId) && initialSelectedId > 0
          ? initialSelectedId
          : null
      }
    />
  );

  if (!admin) {
    return lookupConsole;
  }

  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);

  return (
    <div className="fp-client-page min-h-screen bg-[#f4f7f8] text-[#101828] lg:grid lg:grid-cols-[250px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/clientes"
        adminCentral={adminCentral}
        nombreUsuario={session.nombre}
        rolUsuario={session.rolNombre}
      />

      <main className="fp-client-page-content min-w-0 px-4 py-5 sm:px-6 lg:px-7 xl:px-8">
        <PageHeader
          className="fp-client-page-header mb-5"
          eyebrow="Gestion comercial"
          title="Clientes y expedientes"
          description={`${session.sedeNombre} | ${adminCentral ? "Cobertura global" : "Cobertura del aliado"}`}
          actions={
          <>
            <Link
              href="/dashboard/abonos"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#344054] transition hover:border-[#98a2b3] hover:bg-[#f9fafb]"
            >
              <CircleDollarSign className="h-4 w-4" strokeWidth={2} />
              Recaudos
            </Link>
            <Link
              href="/dashboard/creditos"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#151a21] px-4 text-sm font-bold text-white transition hover:bg-[#272e38]"
            >
              <Plus className="h-4 w-4" strokeWidth={2.2} />
              Nuevo credito
            </Link>
          </>
          }
        />

        {lookupConsole}
      </main>
    </div>
  );
}
