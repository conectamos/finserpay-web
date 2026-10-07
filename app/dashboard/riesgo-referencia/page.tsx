import prisma from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import { resolveDelinquencyDetailScope } from "@/lib/delinquency-detail-access";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { calendarDateKey, getColombiaDateParts } from "@/lib/colombia-date";
import { resolveCapitalOriginal } from "@/lib/credit-capital";
import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { resolveRiskEquipment, projectProductRiskCredits, riskCreditEligible, type ProductRiskCredit } from "@/lib/product-risk";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "../_components/admin-sidebar";
import AdminWorkspaceTopbar from "../_components/admin-workspace-topbar";
import RiskConsole from "./risk-console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Riesgo por referencia | FINSER PAY" };

export default async function ProductRiskPage() {
  const { session } = await requireAdminDashboardAccess();
  const scope = resolveDelinquencyDetailScope(session, null, []);
  const today = new Date();
  const cutoff = calendarDateKey(getColombiaDateParts(today));
  const credits = await prisma.credito.findMany({
    where: {
      montoCredito: { gt: 0 },
      ...(scope.aliadoId !== null ? { sede: { aliadoId: scope.aliadoId } } : {}),
    },
    select: {
      id: true, folio: true, clienteNombre: true, equipoMarca: true, equipoModelo: true,
      referenciaEquipo: true, estado: true, montoCredito: true,
      saldoBaseFinanciado: true, valorEquipoTotal: true, cuotaInicial: true,
      valorFianza: true, valorInteres: true, planCapitalVigente: true,
      contratoAceptadoAt: true, pagareAceptadoAt: true,
      pazYSalvoEmitidoAt: true, fechaCredito: true,
      valorCuota: true, plazoMeses: true, frecuenciaPago: true, fechaPrimerPago: true,
      fechaProximoPago: true, equalityService: true,
      sede: { select: { nombre: true, aliado: { select: { nombre: true } } } },
      abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true } },
    } satisfies Prisma.CreditoSelect,
    orderBy: { id: "asc" },
  });
  // Use the registered portfolio population, regardless of delivery documentation.
  const eligibleCredits = credits.filter(riskCreditEligible);
  const eligibleCreditIds = eligibleCredits.map(credit => credit.id);
  const displayNumbers = await getCreditDisplayNumbers(eligibleCreditIds);
  // Use the same immutable event source and latest-event order as Mora Central.
  if (eligibleCreditIds.length) await ensureAnalystMoraSchema();
  const latestManagement = eligibleCreditIds.length ? await prisma.$queryRaw<Array<{ creditoId: number; actedAt: Date; action: string; result: string; comment: string }>>`
    SELECT DISTINCT ON (event."creditoId") event."creditoId", event."actedAt", event."action", event."result", event."comment"
    FROM "CreditMoraManagementEvent" event
    WHERE event."creditoId" = ANY(${eligibleCreditIds}::int[])
    ORDER BY event."creditoId", event."createdAt" DESC, event.id DESC
  ` : [];
  const managementById = new Map(latestManagement.map(event => [event.creditoId, event]));
  const rows: ProductRiskCredit[] = eligibleCredits.map(c => {
    const plan = buildCreditPaymentPlan({ ...c, today, settled: Boolean(c.pazYSalvoEmitidoAt) });
    const overdue = plan.installments.filter(i => i.estaEnMora && i.saldoPendiente > 0);
    const dias = overdue.reduce((max, i) => Math.max(max, Math.round((Date.parse(cutoff) - Date.parse(i.fechaVencimiento)) / 86400000)), 0);
    const management = managementById.get(c.id);
    const numeroCreditoVisible = displayNumbers.get(c.id) || c.folio;
    const equipment = resolveRiskEquipment(c, numeroCreditoVisible);
    return {
      id: c.id, folio: c.folio, numeroCreditoVisible, cliente: c.clienteNombre,
      marca: c.equipoMarca?.trim() || "Sin marca", referencia: equipment.referencia,
      tipo: equipment.tipo,
      aliado: c.sede.aliado?.nombre || "Sin aliado", sede: c.sede.nombre,
      fecha: calendarDateKey(getColombiaDateParts(c.fechaCredito)),
      capital: resolveCapitalOriginal(c),
      activo: plan.saldoPendiente > 0,
      saldo: plan.saldoPendiente, vencido: overdue.reduce((sum, i) => sum + i.saldoPendiente, 0),
      dias, gestion: management ? `${management.action} · ${management.result} · ${management.comment}` : null,
      gestionFecha: management?.actedAt.toISOString() || null,
    };
  });
  const publicRows = projectProductRiskCredits(rows, { viewingCentral: scope.adminCentral });
  return <AppShell className="fp-reference-risk-shell" sidebar={<AdminSidebar activeHref="/dashboard/riesgo-referencia" adminCentral={scope.adminCentral} nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
    <AdminWorkspaceTopbar accentAvatar parent="Cartera" current="Riesgo por referencia" userName={session.nombre} userRole={session.rolNombre} />
    <RiskConsole credits={publicRows} cutoff={cutoff} adminCentral={scope.adminCentral} scopeLabel={scope.scopeLabel} />
  </AppShell>;
}
