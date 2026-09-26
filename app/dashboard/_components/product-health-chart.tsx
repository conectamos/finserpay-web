import type { ProductPortfolioHealth } from "@/lib/product-portfolio-health";

const money = (value: number) => new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
}).format(value);
const percent = (value: number) => new Intl.NumberFormat("es-CO", {
  style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
}).format(value / 100);

export default function ProductHealthChart({ title, id, data }: {
  title: string;
  id: string;
  data: ProductPortfolioHealth;
}) {
  const empty = data.totalBalance <= 0;
  const earlyEnd = Math.min(100, data.healthyPercent + data.earlyPercent);
  const background = empty ? "var(--fp-border)" : `conic-gradient(var(--fp-lime) 0% ${data.healthyPercent}%, var(--fp-amber) ${data.healthyPercent}% ${earlyEnd}%, var(--fp-danger) ${earlyEnd}% 100%)`;
  const ranges = [
    { label: "Al día", range: "Sin días de mora", color: "var(--fp-lime)", value: data.healthyPercent },
    { label: "Mora temprana", range: "1–15 días", color: "var(--fp-amber)", value: data.earlyPercent },
    { label: "Mora crítica", range: "Más de 15 días", color: "var(--fp-danger)", value: data.criticalPercent },
  ];
  return (
    <section aria-labelledby={id} className="min-w-0 text-[var(--fp-graphite)]">
      <h3 id={id} className="text-lg font-bold">{title}</h3>
      <div role="img" aria-label={`${title}: ${empty ? "sin saldo pendiente" : ranges.map((item) => `${item.label} ${percent(item.value)}`).join(", ")}`}
        className="relative mx-auto my-5 h-36 w-36 rounded-full" style={{ background }}>
        <div aria-hidden="true" className="absolute inset-7 flex flex-col items-center justify-center rounded-full bg-[var(--fp-surface)] text-center">
          <strong className="text-xl font-black">{percent(data.overduePercent)}</strong>
          <span className="mt-1 text-xs text-[var(--fp-muted)]">En mora</span>
        </div>
      </div>
      <dl className="space-y-3">
        {ranges.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-2">
            <dt className="flex min-w-0 items-start gap-2">
              <span aria-hidden="true" className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
              <span className="text-sm">{item.label}<small className="block text-xs text-[var(--fp-muted)]">{item.range}</small></span>
            </dt>
            <dd className="shrink-0 text-sm font-bold">{percent(item.value)}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-4 space-y-2 border-t border-[var(--fp-border)] pt-4 text-sm">
        <div><dt className="text-[var(--fp-muted)]">Saldo pendiente</dt><dd className="break-words font-semibold">{money(data.totalBalance)}</dd></div>
        <div><dt className="text-[var(--fp-muted)]">Saldo en mora</dt><dd className="break-words text-lg font-bold">{money(data.overdueBalance)}</dd></div>
      </dl>
      {empty ? <p className="mt-3 text-sm text-[var(--fp-muted)]">Sin saldo pendiente para este producto.</p> : null}
    </section>
  );
}
