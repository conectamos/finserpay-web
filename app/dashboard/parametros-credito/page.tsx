import CreditParametersConsole from "./credit-parameters-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Parametros de credito | FINSER PAY",
  description: "Configuracion administrativa de interes y fianza para creditos",
};

export default function ParametrosCreditoPage() {
  return <CreditParametersConsole />;
}
