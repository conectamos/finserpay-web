import type { PortfolioProfitInput } from "@/lib/portfolio-profit";

const moneyFormatter = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const money = (value: number) => moneyFormatter.format(value);

export default function PortfolioProfitBreakdown({ input, total, estimatedInvestment, estimatedCount, productFiltered }: {
  input: PortfolioProfitInput;
  total: number;
  estimatedInvestment: number;
  estimatedCount: number;
  productFiltered: boolean;
}) {
  const lines = [
    ["Saldo por cobrar", input.outstandingBalance, "+"],
    ["Recaudo acumulado", input.accumulatedCollections, "+"],
    ["Inversión acumulada", input.accumulatedInvestment, "−"],
    ["Gastos", input.operatingExpenses, "−"],
    ["Capital comprometido", input.committedCapital, "−"],
    ["Ganancia reconocida", input.recognizedProfit, "−"],
  ] as const;
  return (
    <details className="mt-3 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-surface)] text-[var(--fp-graphite)]">
      <summary className="min-h-11 cursor-pointer rounded-lg px-4 py-3 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-graphite)]">Ver cálculo de ganancia estimada</summary>
      <div className="px-4 pb-4">
        <dl className="max-w-2xl divide-y divide-[var(--fp-border)] text-sm">
          {lines.map(([label, value, sign]) => (
            <div key={label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
              <dt>{label}</dt><dd className="font-semibold tabular-nums">{sign} {money(value)}</dd>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 py-3 font-bold">
            <dt>Ganancia estimada</dt><dd className="text-lg tabular-nums">{money(total)}</dd>
          </div>
        </dl>
        <div className="mt-2 max-w-3xl space-y-2 text-sm text-[var(--fp-muted)]">
          <p>La inversión incluye créditos activos y pagados, netos de respaldo y antes de compensar recaudos. El recaudo se cuenta completo. El respaldo ya está incluido en la menor inversión; no se suma otra vez.</p>
          {estimatedCount > 0 ? <p>Inversión estimada: {money(estimatedInvestment)} en {estimatedCount} créditos sin liquidación registrada, calculada como capital autorizado menos respaldo según el porcentaje configurado del aliado.</p> : null}
          <p>El capital comprometido descuenta preventivamente el capital pendiente de créditos en mora y deja de descontarse cuando se ponen al día. La reconocida conserva el margen contractual de los créditos finalizados.</p>
          {productFiltered ? <p>Los gastos se registran por sede, sin distribución por producto. Se descuentan los gastos generales del alcance seleccionado; los resultados por producto no deben sumarse entre sí.</p> : null}
        </div>
      </div>
    </details>
  );
}
