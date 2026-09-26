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
      className={`flex overflow-hidden rounded-[var(--fp-radius-md)] bg-[var(--fp-border)] ${large ? "h-7" : "h-5"}`}>
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
    <section aria-labelledby={id} className={`min-w-0 rounded-[var(--fp-radius-lg)] border p-3 text-[var(--fp-graphite)] @min-[600px]/health:p-4 ${highestOverdue ? "border-[color-mix(in_srgb,var(--fp-danger)_20%,white)] bg-[color-mix(in_srgb,var(--fp-danger-soft)_35%,white)]" : "border-[var(--fp-border)] bg-[var(--fp-surface)]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-lg font-bold">{title}</h3>
        {highestOverdue ? <Badge tone="danger"><TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />Mayor nivel de mora</Badge> : null}
      </div>
      <div className="mb-4 mt-4">
        <strong className="text-3xl font-black tracking-tight tabular-nums">{healthPercent(data.overduePercent)}</strong>
        <p className="mt-1 text-sm font-medium text-[var(--fp-muted)]">En mora</p>
      </div>
      <HealthDistributionBar title={`Mora ${title}`} data={data} empty={empty} />
      <dl className="mt-4 space-y-3">
        {healthRanges(data).map(item => (
          <div key={item.label} className="flex items-center justify-between gap-2">
            <dt className="flex min-w-0 items-start gap-2">
              <span aria-hidden="true" className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: item.color }} />
              <span className="text-sm font-medium">{item.label}<small className="mt-0.5 block text-xs font-normal text-[var(--fp-muted)]">{item.range}</small></span>
            </dt>
            <dd className="shrink-0 text-sm font-bold tabular-nums">{healthPercent(item.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}