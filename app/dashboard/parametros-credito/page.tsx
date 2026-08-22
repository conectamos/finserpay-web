import Link from "next/link";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import DatacreditoPolicyConsole from "./datacredito-policy-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Políticas de crédito | FINSER PAY",
  description:
    "Configuración administrativa de las políticas DataCrédito y sus condiciones financieras",
};

export default async function ParametrosCreditoPage() {
  await requireCentralAdminDashboardAccess();

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--fp-bg)] px-4 py-6 text-[var(--fp-graphite)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1480px]">
        <nav
          className="mb-5 flex flex-wrap justify-end gap-2"
          aria-label="Accesos de administración"
        >
          <Link href="/dashboard" className="fp-ui-button is-secondary">
            Dashboard
          </Link>
          <Link href="/dashboard/creditos" className="fp-ui-button is-primary">
            Fábrica de créditos
          </Link>
        </nav>

        <DatacreditoPolicyConsole />
      </div>
    </main>
  );
}
