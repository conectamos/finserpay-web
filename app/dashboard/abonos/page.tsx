import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import CreditFactoryConsole from "@/app/dashboard/creditos/credit-factory-console";

export const metadata = {
  title: "Abonos y recaudo | FINSER PAY",
  description:
    "Vista separada para buscar clientes, consultar cartera y registrar pagos de cuotas",
};

type SearchParams = Promise<{ search?: string; selected?: string }>;

export default async function AbonosPage(props: {
  searchParams: SearchParams;
}) {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const sellerSession = isAdminRole(session.rolNombre)
    ? null
    : await getSellerSessionUser(session);

  if (!isAdminRole(session.rolNombre) && !sellerSession) {
    redirect("/dashboard");
  }

  if (
    !isAdminRole(session.rolNombre) &&
    sellerSession?.tipoPerfil !== "SUPERVISOR"
  ) {
    redirect("/dashboard");
  }

  const searchParams = await props.searchParams;
  const initialSearch = String(searchParams?.search || "").trim();
  const initialSelectedId = Number(searchParams?.selected || 0);

  return (
    <CreditFactoryConsole
      initialSession={session}
      initialSeller={sellerSession}
      view="payments"
      initialSearch={initialSearch}
      initialSelectedId={
        Number.isInteger(initialSelectedId) && initialSelectedId > 0
          ? initialSelectedId
          : null
      }
    />
  );
}
