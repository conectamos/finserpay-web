import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, Button, Card, DataTable, Select } from "@/app/_components/finser-ui";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { DelinquencyScopeError, delinquencyDetailHref, resolveDelinquencyDetailScope } from "@/lib/delinquency-detail-access";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import prisma from "@/lib/prisma";
import AdminSidebar from "../../_components/admin-sidebar";
import AdminWorkspaceTopbar from "../../_components/admin-workspace-topbar";
import { getDelinquencyDetailData } from "../../_lib/delinquency-detail-data";
import DelinquencyWorkspace from "./delinquency-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Detalle de mora | FINSER PAY" };
type Params = { aliadoId?: string | string[]; tipo?: string | string[]; grupo?: string | string[] };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default async function DelinquencyDetailPage({ searchParams }: { searchParams?: Promise<Params> }) {
  const { session } = await requireAdminDashboardAccess();
  const params = searchParams ? await searchParams : {};
  const allies = isFinserPayCentralAlly(session.aliadoAccesoCodigo)
    ? await prisma.aliado.findMany({ select: { id: true, nombre: true, codigo: true }, orderBy: { nombre: "asc" } })
    : [];
  let scope;
  try { scope = resolveDelinquencyDetailScope(session, first(params.aliadoId), allies); }
  catch (error) {
    if (error instanceof DelinquencyScopeError) {
      if (error.status === 404) notFound();
      redirect("/dashboard");
    }
    throw error;
  }
  await ensureCreditAbonoAuditColumns();
  const { detail, credits, updatedAt } = await getDelinquencyDetailData(scope.aliadoId, scope.adminCentral);
  const requestedGroup = first(params.grupo);
  const requestedType = first(params.tipo);
  const groups = requestedType === "sede" ? detail.sites : requestedType === "vendedor" ? detail.sellers : null;
  const selectedGroup = requestedGroup ? groups?.find(group => group.key === requestedGroup) : null;
  if (requestedGroup && !selectedGroup) notFound();
  const selectedCredits = selectedGroup
    ? credits.filter(credit => (requestedType === "sede" ? credit.sedeKey : credit.sellerKey) === selectedGroup.key)
    : [];
  const displayNumbers = selectedGroup ? await getCreditDisplayNumbers(selectedCredits.map(credit => credit.id)) : new Map<number, string>();
  const creditLinks = Object.fromEntries([
    ...detail.sites.map(group => [group.key, `${delinquencyDetailHref(scope.aliadoId, { type: "sede", key: group.key })}#creditos-en-mora`]),
    ...detail.sellers.map(group => [`seller:${group.key}`, `${delinquencyDetailHref(scope.aliadoId, { type: "vendedor", key: group.key })}#creditos-en-mora`]),
  ]);
  const exportParams = scope.aliadoId ? `?aliadoId=${scope.aliadoId}` : "";

  return <AppShell className="fp-delinquency-shell" sidebar={<AdminSidebar activeHref="/dashboard/cartera/detalle-mora" adminCentral={scope.adminCentral} nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
    <AdminWorkspaceTopbar parent="Cartera" current="Detalle de mora" userName={session.nombre} userRole={session.rolNombre} accentAvatar />
    <main className="min-w-0">
    <DelinquencyWorkspace detail={detail} canViewBalances={scope.adminCentral} scopeLabel={scope.scopeLabel} updatedAt={updatedAt}
      exportHref={`/api/dashboard/cartera/detalle-mora/export${exportParams}`} creditLinks={creditLinks} initialMode={requestedType === "vendedor" ? "vendedores" : "sedes"}
      filters={scope.adminCentral ? <form action="/dashboard/cartera/detalle-mora" method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">Aliado
          <Select name="aliadoId" defaultValue={scope.aliadoId || ""} className="mt-1 min-w-52">
            <option value="">Todos los aliados</option>
            {allies.map(ally => <option key={ally.id} value={ally.id}>{ally.nombre}</option>)}
          </Select>
        </label>
        <Button variant="secondary" type="submit">Consultar</Button>
      </form> : undefined} />
    {selectedGroup ? <Card id="creditos-en-mora" className="scroll-mt-4 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xl font-bold">Créditos en mora · {selectedGroup.name}</h2>
          <p className="mt-1 text-sm text-[var(--fp-muted)]">{selectedCredits.length} créditos · {scope.scopeLabel}</p></div>
        <Link href={delinquencyDetailHref(scope.aliadoId)} className="fp-ui-button is-secondary">Cerrar detalle</Link>
      </div>
      <DataTable><table className="w-full min-w-[720px] text-sm">
        <thead className="bg-[var(--fp-bg)] text-[var(--fp-muted)]"><tr>
          {["Número de crédito", "Cliente", "Cédula", "Sede", "Vendedor", "Días de mora"].map(label => <th key={label} scope="col" className="px-4 py-3 text-left font-medium">{label}</th>)}
        </tr></thead>
        <tbody>{selectedCredits.length ? selectedCredits.map(credit => <tr key={credit.id} className="border-t border-[var(--fp-border)]">
          <td className="px-4 py-3 font-semibold">{displayNumbers.get(credit.id) || credit.folio}</td>
          <td className="px-4 py-3">{credit.clienteNombre}</td><td className="px-4 py-3">{credit.clienteDocumento || "—"}</td>
          <td className="px-4 py-3">{credit.sedeNombre}</td><td className="px-4 py-3">{credit.sellerNombre}</td><td className="px-4 py-3 tabular-nums">{credit.diasMora}</td>
        </tr>) : <tr><td colSpan={6} className="px-4 py-6 text-center text-[var(--fp-muted)]">Este grupo no tiene créditos en mora.</td></tr>}</tbody>
      </table></DataTable>
    </Card> : null}
    </main>
  </AppShell>;
}
