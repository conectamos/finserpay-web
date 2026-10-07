import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowRight } from "lucide-react";
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  PageHeader,
} from "@/app/_components/finser-ui";
import type {
  DashboardDelinquencyGroupView,
  DashboardDelinquencyView,
} from "@/lib/dashboard-delinquency-view";

type DelinquencyWorkspaceProps = {
  detail: DashboardDelinquencyView;
  canViewBalances: boolean;
  scopeLabel: string;
  exportHref: string;
  updatedAt: string;
  filters?: ReactNode;
  creditLinks?: Readonly<Record<string, string>>;
};

const numberFormatter = new Intl.NumberFormat("es-CO");
const percentageFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
});
const updatedAtFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short",
});

function percent(value: number) {
  return `${percentageFormatter.format(value)}%`;
}

function money(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? moneyFormatter.format(value)
    : "No disponible";
}

function GroupName({ group }: { group: DashboardDelinquencyGroupView }) {
  return (
    <span className="block min-w-0 break-words [overflow-wrap:anywhere]">
      <span className="block font-semibold">{group.name}</span>
      {group.context ? (
        <span className="mt-0.5 block text-xs font-normal leading-5 text-[var(--fp-muted)]">
          {group.context}
        </span>
      ) : null}
    </span>
  );
}

function CreditLink({ href, name }: { href: string | undefined; name: string }) {
  return href ? (
    <a
      href={href}
      aria-label={`Ver créditos en mora de ${name}`}
      className="inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-[var(--fp-radius-sm)] text-sm font-semibold text-[var(--fp-graphite)] underline decoration-[var(--fp-lime)] underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
    >
      Ver créditos <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </a>
  ) : null;
}

function LeadingSite({
  sites,
  leadingSiteKeys,
}: {
  sites: DashboardDelinquencyGroupView[];
  leadingSiteKeys: string[];
}) {
  const leaders = sites.filter((site) =>
    !site.unassigned && site.overdueCredits > 0 && leadingSiteKeys.includes(site.key),
  );
  const leader = leaders[0];

  return (
    <MetricCard
      label="Sede con mayor mora"
      value={leader
        ? <span className="block text-base leading-6"><GroupName group={leader} /></span>
        : <span className="text-base">Sin sede con mora</span>}
      detail={leader
        ? `${numberFormatter.format(leader.overdueCredits)} créditos · ${percent(leader.overdueSharePercent)} de la mora`
        : sites.some((site) => site.overdueCredits > 0) ? "La mora no tiene sede asignada." : "Sin créditos en mora."}
    >
      {leaders.length > 1 ? (
        <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">
          Empate con {leaders.length - 1} {leaders.length === 2 ? "otra sede" : "otras sedes"}.
        </p>
      ) : null}
      {leader && sites.some((site) => site.unassigned && site.overdueCredits > 0) ? (
        <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">Entre las sedes identificadas.</p>
      ) : null}
    </MetricCard>
  );
}

function SiteDistribution({
  sites,
  canViewBalances,
}: {
  sites: DashboardDelinquencyGroupView[];
  canViewBalances: boolean;
}) {
  return (
    <Card role="region" aria-labelledby="mora-distribution-title" className="min-w-0 p-4 sm:p-5">
      <h2 id="mora-distribution-title" className="text-lg font-bold">Distribución de la mora</h2>
      <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
        Participación por sede, de mayor a menor mora.
      </p>
      {sites.length ? (
        <ul className="mt-5 max-h-[360px] space-y-4 overflow-y-auto pr-1">
          {sites.map((site) => (
            <li key={site.key} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(90px,0.5fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
              <div className="text-sm"><GroupName group={site} /></div>
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
                  <span className="text-[var(--fp-muted)]">
                    {numberFormatter.format(site.overdueCredits)} {site.overdueCredits === 1 ? "crédito" : "créditos"} en mora
                  </span>
                  <strong className="font-bold">{percent(site.overdueSharePercent)}</strong>
                </div>
                <div
                  role="img"
                  aria-label={`${site.name}: ${percent(site.overdueSharePercent)} de la mora`}
                  className="h-3 overflow-hidden rounded-sm bg-[var(--fp-bg)]"
                >
                  <div
                    className="h-full rounded-sm bg-[var(--fp-danger)]"
                    style={{ width: `${Math.min(100, Math.max(0, site.overdueSharePercent))}%` }}
                  />
                </div>
                {canViewBalances ? (
                  <p className="mt-1.5 text-right text-xs tabular-nums text-[var(--fp-muted)]">
                    {money(site.overdueBalance)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Sin cartera activa" description="No hay sedes con créditos activos en este alcance." className="mt-4" />
      )}
    </Card>
  );
}

function SellersRanking({
  sellers,
  canViewBalances,
  creditLinks,
}: {
  sellers: DashboardDelinquencyGroupView[];
  canViewBalances: boolean;
  creditLinks: Readonly<Record<string, string>>;
}) {
  const hasLinks = sellers.some((seller) => creditLinks[`seller:${seller.key}`]);

  return (
    <Card role="region" aria-labelledby="mora-sellers-title" className="min-w-0 p-4 sm:p-5">
      <h2 id="mora-sellers-title" className="text-lg font-bold">Vendedores con mayor mora</h2>
      <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">Ranking completo por participación en la mora.</p>
      <DataTable className="mt-4 max-h-[360px] overflow-y-auto">
        <table className={`w-full border-collapse text-sm ${canViewBalances || hasLinks ? "min-w-[580px]" : "min-w-[420px]"}`}>
          <caption className="sr-only">Créditos y participación en la mora por vendedor</caption>
          <thead className="sticky top-0 bg-[var(--fp-bg)] text-[var(--fp-muted)]">
            <tr>
              <th scope="col" className="px-3 py-3 text-left font-medium">#</th>
              <th scope="col" className="px-3 py-3 text-left font-medium">Vendedor</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Créditos en mora</th>
              {canViewBalances ? <th scope="col" className="px-3 py-3 text-right font-medium">Saldo en mora</th> : null}
              <th scope="col" className="px-3 py-3 text-right font-medium">% de la mora</th>
              {hasLinks ? <th scope="col" className="px-3 py-3 text-left font-medium">Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {sellers.length ? sellers.map((seller, index) => (
              <tr key={seller.key} className="border-t border-[var(--fp-border)]">
                <td className="px-3 py-2 tabular-nums"><Badge tone="neutral">{index + 1}</Badge></td>
                <th scope="row" className="max-w-52 px-3 py-2 text-left font-normal"><GroupName group={seller} /></th>
                <td className="px-3 py-2 text-right tabular-nums">{numberFormatter.format(seller.overdueCredits)}</td>
                {canViewBalances ? <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(seller.overdueBalance)}</td> : null}
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{percent(seller.overdueSharePercent)}</td>
                {hasLinks ? <td className="px-3 py-2"><CreditLink href={creditLinks[`seller:${seller.key}`]} name={seller.name} /></td> : null}
              </tr>
            )) : (
              <tr><td colSpan={4 + Number(canViewBalances) + Number(hasLinks)} className="px-4 py-8 text-center text-[var(--fp-muted)]">Sin vendedores con cartera activa.</td></tr>
            )}
          </tbody>
        </table>
      </DataTable>
    </Card>
  );
}

function SitesTable({
  sites,
  canViewBalances,
  creditLinks,
  overduePortfolioPercent,
}: {
  sites: DashboardDelinquencyGroupView[];
  canViewBalances: boolean;
  creditLinks: Readonly<Record<string, string>>;
  overduePortfolioPercent: number;
}) {
  const hasLinks = sites.some((site) => creditLinks[site.key]);

  return (
    <Card role="region" aria-labelledby="mora-sites-title" className="min-w-0 p-4 sm:p-5">
      <h2 id="mora-sites-title" className="text-lg font-bold">Detalle por sede</h2>
      <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
        Se usa el saldo pendiente de los créditos en mora, igual que en Salud de cartera.
        El porcentaje muestra cuánto representa cada sede de la mora total.
        Cada aporte compone el {percent(overduePortfolioPercent)} de mora de la cartera activa.
      </p>
      <DataTable className="mt-4">
        <table className="w-full min-w-[650px] border-collapse text-sm">
          <caption className="sr-only">Detalle completo de créditos, participación y aporte a cartera por sede</caption>
          <thead className="bg-[var(--fp-bg)] text-[var(--fp-muted)]">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">Sede</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Créditos en mora</th>
              {canViewBalances ? <th scope="col" className="px-3 py-3 text-right font-medium">Saldo en mora</th> : null}
              <th scope="col" className="px-3 py-3 text-right font-medium">% de la mora</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Aporte a cartera</th>
              {hasLinks ? <th scope="col" className="px-4 py-3 text-left font-medium">Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {sites.length ? sites.map((site) => (
              <tr key={site.key} className="border-t border-[var(--fp-border)]">
                <th scope="row" className="max-w-64 px-4 py-3 text-left font-normal"><GroupName group={site} /></th>
                <td className="px-3 py-3 text-right tabular-nums">{numberFormatter.format(site.overdueCredits)}</td>
                {canViewBalances ? <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(site.overdueBalance)}</td> : null}
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{percent(site.overdueSharePercent)}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{percentageFormatter.format(site.overduePortfolioPercent)} puntos</td>
                {hasLinks ? <td className="px-4 py-3"><CreditLink href={creditLinks[site.key]} name={site.name} /></td> : null}
              </tr>
            )) : (
              <tr><td colSpan={4 + Number(canViewBalances) + Number(hasLinks)} className="px-4 py-8 text-center text-[var(--fp-muted)]">Sin sedes con cartera activa.</td></tr>
            )}
          </tbody>
        </table>
      </DataTable>
    </Card>
  );
}

export default function DelinquencyWorkspace({
  detail,
  canViewBalances,
  scopeLabel,
  exportHref,
  updatedAt,
  filters,
  creditLinks = {},
}: DelinquencyWorkspaceProps) {
  const updatedDate = new Date(updatedAt);
  const validDate = !Number.isNaN(updatedDate.getTime());

  return (
    <div className="space-y-5 text-[var(--fp-graphite)]">
      <PageHeader
        eyebrow="Cartera / Mora actual"
        title="Detalle de mora"
        description={`Identifica qué sedes y vendedores concentran la mora · ${scopeLabel}`}
        actions={
          <a href={exportHref} className="fp-ui-button is-primary">
            <ArrowDownToLine className="h-4 w-4" aria-hidden="true" /> Exportar Excel
          </a>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {filters ? <div className="min-w-0">{filters}</div> : <p className="text-sm font-medium text-[var(--fp-muted)]">Cartera actual</p>}
        <p className="text-xs leading-5 text-[var(--fp-muted)]">
          Actualizado: {validDate ? <time dateTime={updatedAt}>{updatedAtFormatter.format(updatedDate)}</time> : "al consultar"}
        </p>
      </div>
      <section aria-label="Resumen de mora" className={`grid gap-4 sm:grid-cols-2 ${canViewBalances ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
        <MetricCard label="Mora actual" value={<span className="text-[var(--fp-danger)]">{percent(detail.overduePortfolioPercent)}</span>} detail="de la cartera activa" />
        <MetricCard label="Créditos en mora" value={numberFormatter.format(detail.overdueCredits)} detail={`de ${numberFormatter.format(detail.activeCredits)} créditos activos`} />
        {canViewBalances ? <MetricCard label="Saldo en mora" value={money(detail.overdueBalance)} detail="saldo pendiente de los créditos en mora" /> : null}
        <LeadingSite sites={detail.sites} leadingSiteKeys={detail.leadingSiteKeys} />
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <SiteDistribution sites={detail.sites} canViewBalances={canViewBalances} />
        <SellersRanking sellers={detail.sellers} canViewBalances={canViewBalances} creditLinks={creditLinks} />
      </div>
      <SitesTable sites={detail.sites} canViewBalances={canViewBalances} creditLinks={creditLinks} overduePortfolioPercent={detail.overduePortfolioPercent} />
    </div>
  );
}
