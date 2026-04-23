import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import PinChangeForm from "./pin-change-form";

export const metadata = {
  title: "Cambiar PIN | FINSER PAY",
  description: "Actualiza el PIN del perfil del vendedor",
};

export default async function PinPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const seller = await getSellerSessionUser(session);

  if (!seller) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <PinChangeForm sellerName={seller.nombre} />
      </div>
    </div>
  );
}
