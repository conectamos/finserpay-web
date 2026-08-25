import type { Metadata } from "next";
import { CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { Badge, Card } from "@/app/_components/finser-ui";

export const metadata: Metadata = {
  title: "Validación de identidad | FINSER PAY",
  description: "Confirmación del proceso de validación de identidad.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function IdentityValidationCompletedPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--fp-bg)] px-4 py-8 text-[var(--fp-graphite)] sm:px-6">
      <Card
        className="w-full max-w-xl overflow-hidden p-0 shadow-[var(--fp-shadow-md)]"
        role="status"
        aria-labelledby="identity-completed-title"
      >
        <div className="border-b border-[var(--fp-border)] bg-[var(--fp-navy)] px-6 py-5 sm:px-8">
          <FinserBrand compact dark accentPay showTagline={false} />
        </div>

        <div className="px-6 py-8 text-center sm:px-10 sm:py-10">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
            <CheckCircle2 className="h-10 w-10" strokeWidth={1.8} aria-hidden="true" />
          </div>

          <Badge tone="positive" className="mt-6">
            Proceso enviado
          </Badge>
          <h1
            id="identity-completed-title"
            className="mt-4 text-3xl font-black tracking-tight sm:text-4xl"
          >
            Validación de identidad finalizada
          </h1>
          <p className="mx-auto mt-4 max-w-md text-base leading-7 text-[var(--fp-muted)]">
            Ya puedes cerrar esta pestaña y volver con el asesor. El resultado se
            actualizará automáticamente en su pantalla.
          </p>

          <div className="mt-7 flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-4 text-left">
            <Clock3
              className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
              strokeWidth={1.9}
              aria-hidden="true"
            />
            <p className="text-sm leading-6 text-[var(--fp-muted)]">
              No necesitas iniciar sesión en este celular ni repetir la validación.
            </p>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-sm font-bold text-[var(--fp-muted)]">
            <ShieldCheck
              className="h-5 w-5 text-[var(--fp-lime-strong)]"
              strokeWidth={1.9}
              aria-hidden="true"
            />
            Proceso protegido por FINSER PAY
          </div>
        </div>
      </Card>
    </main>
  );
}
