import GastoCarteraForm from "@/app/_components/gasto-cartera-form";

export default function CajaCarteraPage() {
  return (
    <GastoCarteraForm
      badgeLabel="Caja"
      description="Registra gastos de cartera desde la operación diaria de tu sede sin entrar al panel financiero."
      detailHref={null}
    />
  );
}
