import FinancialAccessGate from "./_components/financial-access-gate";
import { getFinancialAccessState } from "@/lib/financial-access";

export default async function FinancieroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getFinancialAccessState();

  if (!access.user) {
    return (
      <div className="min-h-screen bg-slate-100 px-6 py-10">
        <div className="mx-auto max-w-3xl rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-3xl font-black text-slate-950">
            Panel financiero
          </h1>
          <p className="mt-3 text-slate-600">
            Debes iniciar sesi&oacute;n para acceder al panel financiero.
          </p>
        </div>
      </div>
    );
  }

  if (access.esAdmin || access.authorized) {
    return children;
  }

  return (
    <FinancialAccessGate
      sedeNombre={access.sede?.nombre ?? access.user.sedeNombre}
    />
  );
}
