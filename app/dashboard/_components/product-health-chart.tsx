import { TriangleAlert } from "lucide-react";
import { Badge } from "@/app/_components/finser-ui";
import type { ProductPortfolioHealth } from "@/lib/product-portfolio-health";

export const healthMoney = (value: number) => new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
}).format(value);
export const healthPercent = (value: number) => new Intl.NumberFormat("es-CO", {
  style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
}).format(value / 100);

type Distribution = Pick<ProductPortfolioHealth, "healthyPercent" | "earlyPercent" | "criticalPercent">;
export const healthRanges = (data: Distribution) => [
  { label: "Al día", range: "Sin días de mora", color: "var(--fp-lime)", value: data.healthyPercent },
  { label: "Mora temprana", range: "1–15 días", color: "var(--fp-amber)", value: data.earlyPercent },
  { label: "Mora crítica", range: "Más de 15 días", color: "var(--fp-danger)", value: data.criticalPercent },
];

export function HealthDistributionBar({ title, data, empty, large = false }: {
  title: string; data: Distribution; empty: boolean; large?: boolean;
}) {
  return (
    <div role="img" aria-label={`${title}: ${empty ? "sin saldo pendiente" : healthRanges(data).map(item => `${item.label} ${healthPercent(item.value)}`).join(", ")}`}
      className={`flex overflow-hidden rounded-[var(--fp-radius-md)] bg-[var(--fp-border)] ${large ? "h-8 sm:h-10" : "h-5 sm:h-6"}`}>
      {!empty && healthRanges(data).map(item => <span key={item.label} aria-hidden="true"
        style={{ width: `${item.value}%`, background: item.color }} />)}
    </div>
  );
}

export default function ProductHealthChart({ title, id, data, highestOverdue = false }: {
  title: string;
  id: string;
  data: ProductPortfolioHealth;
  highestOverdue?: boolean;
}) {
  const empty = data.totalBalance <= 0;
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-[var(--fp-radius-lg)] border p-4 text-[var(--fp-graphite)] sm:p-6 ${highestOverdue ? "border-[color-mix(in_srgb,var(--fp-danger)_20%,white)] bg-[color-mix(in_srgb,var(--fp-danger-soft)_35%,white)]" : "border-[var(--fp-border)] bg-[var(--fp-surface)]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-xl font-bold sm:text-2xl">{title}</h3>
        {highestOverdue ? <Badge tone="danger"><TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />Mayor nivel de mora</Badge> : null}
      </div>
      <div className="mb-5 mt-5">
        <strong className="text-4xl font-black tracking-tight tabular-nums sm:text-5xl">{healthPercent(data.overduePercent)}</strong>
        <p className="mt-1 text-base font-medium text-[var(--fp-muted)]">En mora</p>
      </div>
      <HealthDistributionBar title={`Mora ${title}`} data={data} empty={empty} />
      <dl className="mt-5 space-y-4">
        {healthRanges(data).map(item => (
          <div key={item.label} className="flex items-center justify-between gap-3">
            <dt className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: item.color }} />
              <span className="text-sm font-medium sm:text-base">{item.label}<small className="mt-0.5 block text-xs font-normal text-[var(--fp-muted)] sm:text-sm">{item.range}</small></span>
            </dt>
            <dd className="shrink-0 text-base font-bold tabular-nums">{healthPercent(item.value)}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-6 grid gap-3 border-t border-[var(--fp-border)] pt-4 text-sm sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-[var(--fp-muted)]">Saldo pendiente</dt><dd className="mt-1 break-words font-semibold tabular-nums">{healthMoney(data.totalBalance)}</dd></div>
        <div className="min-w-0"><dt className="text-[var(--fp-muted)]">Saldo en mora</dt><dd className="mt-1 break-words font-bold tabular-nums">{healthMoney(data.overdueBalance)}</dd></div>
      </dl>
      {empty ? <p className="mt-3 text-sm text-[var(--fp-muted)]">Sin saldo pendiente para este producto.</p> : null}
    </section>
  );
}