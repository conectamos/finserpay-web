import { Badge, Card, DataTable } from "@/app/_components/finser-ui";
import type {
  AdminDashboardDelinquencyDetail,
  AdminDashboardDelinquencyGroup,
} from "@/lib/dashboard-delinquency";

const numberFormatter = new Intl.NumberFormat("es-CO");
const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 2,
});

function percent(value: number) {
  return `${percentFormatter.format(value)}%`;
}

function credits(value: number) {
  return `${numberFormatter.format(value)} ${value === 1 ? "crédito" : "créditos"} en mora`;
}

function GroupName({ group }: { group: AdminDashboardDelinquencyGroup }) {
  return (
    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
      <span className="block font-semibold">{group.name}</span>
      {group.context ? (
        <span className="mt-0.5 block text-xs font-normal text-[var(--fp-muted)]">
          {group.context}
        </span>
      ) : null}
    </div>
  );
}

function LeadingGroup({
  groups,
  kind,
}: {
  groups: AdminDashboardDelinquencyGroup[];
  kind: "sede" | "vendedor";
}) {
  const assigned = groups.filter((group) => !group.unassigned && group.overdueBalance > 0);
  const maximum = Math.max(0, ...assigned.map((group) => group.overdueBalance));
  const leaders = assigned.filter((group) => group.overdueBalance === maximum);
  const leader = leaders[0];

  return (
    <div className="min-w-0 px-1 py-4 sm:px-4">
      <h3 className="text-sm font-medium text-[var(--fp-muted)]">
        {kind === "sede" ? "Sede con más mora" : "Vendedor con más mora"}
      </h3>
      {leader ? (
        <>
          <div className="mt-2 text-base leading-6"><GroupName group={leader} /></div>
          <p className="mt-2 text-sm font-semibold tabular-nums">
            {credits(leader.overdueCredits)}
          </p>
          <p className="mt-1 text-sm tabular-nums">
            <strong className="font-bold text-[var(--fp-danger)]">
              {percent(leader.overdueSharePercent)}
            </strong>{" "}
            de la mora
          </p>
          {groups.some((group) => group.unassigned && group.overdueBalance > 0) ? (
            <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">
              {kind === "sede" ? "Entre las sedes identificadas." : "Entre los vendedores identificados."}
            </p>
          ) : null}
          {leaders.length > 1 ? (
            <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">
              Empate en saldo con {leaders.length - 1}{" "}
              {kind === "sede"
                ? leaders.length === 2 ? "otra sede" : "otras sedes"
                : leaders.length === 2 ? "otro vendedor" : "otros vendedores"}.
              {" "}Consulta el detalle.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
          {groups.some((group) => group.overdueBalance > 0)
            ? kind === "sede" ? "Mora sin sede asignada." : "Mora sin vendedor asignado."
            : "Sin créditos en mora."}
        </p>
      )}
    </div>
  );
}

function GroupTable({
  groups,
  kind,
}: {
  groups: AdminDashboardDelinquencyGroup[];
  kind: "sede" | "vendedor";
}) {
  const label = kind === "sede" ? "Sede" : "Vendedor";

  return (
    <section className="min-w-0" aria-labelledby={`delinquency-${kind}-title`}>
      <h3 id={`delinquency-${kind}-title`} className="mb-3 text-base font-bold">
        {kind === "sede" ? "Mora por sede" : "Mora por vendedor"}
      </h3>
      <DataTable>
        <table className="w-full min-w-[600px] border-collapse text-sm">
          <caption className="sr-only">
            {label}, créditos en mora, saldo en mora, participación en la mora y aporte a la cartera activa.
          </caption>
          <thead className="bg-[var(--fp-bg)] text-[var(--fp-muted)]">
            <tr>
              <th scope="col" className="w-[30%] px-4 py-3 text-left font-medium">{label}</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Créditos en mora</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Saldo en mora</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">% de la mora</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Aporte a cartera</th>
            </tr>
          </thead>
          <tbody>
            {groups.length ? groups.map((group) => (
              <tr key={group.key} className="border-t border-[var(--fp-border)]">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <GroupName group={group} />
                </th>
                <td className="px-3 py-3 text-right tabular-nums">
                  {numberFormatter.format(group.overdueCredits)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {moneyFormatter.format(group.overdueBalance)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {percent(group.overdueSharePercent)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                  {percentFormatter.format(group.overduePortfolioPercent)} puntos
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={5} className="px-4 py-5 text-center text-[var(--fp-muted)]">
                  {kind === "sede" ? "Sin sedes con cartera activa." : "Sin vendedores con cartera activa."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </DataTable>
    </section>
  );
}

export default function DelinquencyDetailPanel({
  detail,
  scopeLabel,
}: {
  detail?: AdminDashboardDelinquencyDetail;
  scopeLabel: string;
}) {
  return (
    <Card
      role="region"
      aria-labelledby="delinquency-detail-title"
      className="mt-4 min-w-0 p-4 text-[var(--fp-graphite)] sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="delinquency-detail-title" className="text-xl font-black tracking-tight">
            Detalle de mora
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
            {scopeLabel} · Cartera actual, independiente del mes seleccionado.
          </p>
        </div>
        {detail ? (
          <Badge tone={detail.overdueBalance > 0 ? "danger" : "neutral"}>
            {percent(detail.overduePortfolioPercent)} de la cartera activa
          </Badge>
        ) : null}
      </div>
      {detail ? (
        <>
          <div className="mt-4 grid divide-y divide-[var(--fp-border)] border-y border-[var(--fp-border)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="min-w-0 px-1 py-4 sm:pr-4">
              <h3 className="text-sm font-medium text-[var(--fp-muted)]">Créditos en mora</h3>
              <p className="mt-2 text-3xl font-black tabular-nums">
                {numberFormatter.format(detail.overdueCredits)}
              </p>
              <p className="mt-1 text-sm text-[var(--fp-muted)]">
                de {numberFormatter.format(detail.activeCredits)} créditos activos
              </p>
              <p className="mt-2 text-sm font-semibold tabular-nums">
                {moneyFormatter.format(detail.overdueBalance)} de saldo en mora
              </p>
            </div>
            <LeadingGroup groups={detail.sites} kind="sede" />
            <LeadingGroup groups={detail.sellers} kind="vendedor" />
          </div>
          <details className="group mt-1">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-[var(--fp-radius-sm)] py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)] [&::-webkit-details-marker]:hidden">
              Ver detalle por sede y vendedor
              <span aria-hidden="true" className="text-lg transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <p className="mb-4 text-sm leading-6 text-[var(--fp-muted)]">
              Se usa el saldo pendiente de los créditos en mora, igual que en Salud de cartera.{" "}
              El porcentaje de la mora muestra cuánto representa cada grupo del saldo en mora total.
              El aporte a cartera indica cuántos puntos de ese {percent(detail.overduePortfolioPercent)} corresponden al grupo.
              Los grupos se ordenan de mayor a menor saldo en mora.
            </p>
            <div className="grid gap-5 2xl:grid-cols-2">
              <GroupTable groups={detail.sites} kind="sede" />
              <GroupTable groups={detail.sellers} kind="vendedor" />
            </div>
          </details>
        </>
      ) : (
        <p className="mt-4 text-sm text-[var(--fp-muted)]">El detalle de mora aún no está disponible.</p>
      )}
    </Card>
  );
}
