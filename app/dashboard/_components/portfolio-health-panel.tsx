import { Card } from "@/app/_components/finser-ui";
import type { AdminDashboardOverview } from "../_lib/admin-dashboard-data";
import ProductHealthChart, { HealthDistributionBar, healthMoney, healthPercent, healthRanges } from "./product-health-chart";

export default function HealthPanel({ data }: { data: AdminDashboardOverview }) {
  const iphone = data.productHealth.IPHONE;
  const android = data.productHealth.ANDROID;
  const comparable = iphone.totalBalance > 0 && android.totalBalance > 0;
  // Compare the displayed precision so visually equal rates never show a winner.
  const iphoneRate = Math.round(iphone.overduePercent * 10);
  const androidRate = Math.round(android.overduePercent * 10);
  const empty = data.healthyPercent + data.earlyPercent + data.criticalPercent <= 0;
  return (
    <Card role="region" aria-labelledby="portfolio-health-title" className="@container/health min-w-0 p-4 text-[var(--fp-graphite)] sm:p-5">
      <h2 id="portfolio-health-title" className="text-xl font-black tracking-tight">Salud de cartera</h2>
      <p className="mt-1 text-sm text-[var(--fp-muted)]">Distribución del saldo pendiente</p>
      <div className="mt-5 grid gap-4 @min-[560px]/health:grid-cols-[140px_minmax(0,1fr)] @min-[560px]/health:items-center">
        <div><strong className="text-4xl font-black tracking-tight tabular-nums">{healthPercent(data.healthyPercent)}</strong>
          <p className="mt-1 text-sm font-medium text-[var(--fp-muted)]">Al día</p></div>
        <div className="min-w-0">
          <HealthDistributionBar title="Cartera general" data={data} empty={empty} large />
          <dl className="mt-4 flex flex-wrap justify-between gap-x-6 gap-y-3">
            {healthRanges(data).map(item => <div key={item.label} className="flex items-center gap-3 text-sm">
              <dt className="flex items-center gap-2 text-[var(--fp-muted)]"><span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ background: item.color }} />{item.label}</dt>
              <dd className="font-bold tabular-nums">{healthPercent(item.value)}</dd>
            </div>)}
          </dl>
        </div>
      </div>
      {empty ? <p className="mt-4 text-xs leading-5 text-[var(--fp-muted)]">Sin saldo pendiente en la cartera seleccionada.</p> : null}
      <div className="mt-5 grid gap-3 border-t border-[var(--fp-border)] pt-5 @min-[480px]/health:grid-cols-2">
        <ProductHealthChart id="health-iphone" title="iPhone" data={iphone} highestOverdue={comparable && iphoneRate > androidRate} />
        <ProductHealthChart id="health-android" title="Android" data={android} highestOverdue={comparable && androidRate > iphoneRate} />
      </div>
      {data.unclassifiedPortfolioBalance > 0 ? <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">Saldo sin producto identificado: {healthMoney(data.unclassifiedPortfolioBalance)}. Se conserva en la gráfica general.</p> : null}
    </Card>
  );
}