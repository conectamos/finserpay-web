import { redirect } from "next/navigation";
import Link from "next/link";
import { CircleDollarSign, Plus } from "lucide-react";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import CreditFactoryConsole from "@/app/dashboard/creditos/credit-factory-console";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";

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
        <header className="fp-client-page-header mb-5 flex flex-col gap-4 border-b border-[#d8e0e7] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#0d766f]">
              Gestion comercial
            </p>
            <h1 className="mt-1 text-3xl font-black text-[#101828]">
              Clientes y expedientes
            </h1>
            <p className="mt-1 text-sm text-[#667085]">
              {session.sedeNombre} | {adminCentral ? "Cobertura global" : "Cobertura del aliado"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/abonos"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#344054] transition hover:border-[#98a2b3] hover:bg-[#f9fafb]"
            >
              <CircleDollarSign className="h-4 w-4" strokeWidth={2} />
              Recaudos
            </Link>
            <Link
              href="/dashboard/creditos"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#087a73] px-4 text-sm font-bold text-white transition hover:bg-[#06645f]"
            >
              <Plus className="h-4 w-4" strokeWidth={2.2} />
              Nuevo credito
            </Link>
          </div>
        </header>

        {lookupConsole}
      </main>
    </div>
  );
}
