import prisma from "@/lib/prisma";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { calendarDateKey, getColombiaDateParts } from "@/lib/colombia-date";
import { isIphoneEquipmentCatalogBrand } from "@/lib/credit-factory";
import { resolveCapitalOriginal } from "@/lib/credit-capital";
import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { riskCreditEligible, type ProductRiskCredit } from "@/lib/product-risk";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "../_components/admin-sidebar";
import AdminWorkspaceTopbar from "../_components/admin-workspace-topbar";
import RiskConsole from "./risk-console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Riesgo por referencia | FINSER PAY" };

export default async function ProductRiskPage() {
  const { session } = await requireCentralAdminDashboardAccess();
  const today = new Date();
  const cutoff = calendarDateKey(getColombiaDateParts(today));
  // Project evidence as booleans: never load the base64 delivery photographs
  // or the full contract snapshots into this reporting page.
  const evidence = await prisma.$queryRaw<Array<{ id: number; fotoEntrega: boolean; fotoRemision: boolean; plataforma: string | null; importOriginType: string | null }>>`
    SELECT id, COALESCE(length("fotoEntregaDataUrl"), 0) > 0 AS "fotoEntrega",
      COALESCE(length("fotoRemisionDataUrl"), 0) > 0 AS "fotoRemision",
      "contratoSnapshot" #>> '{equipo,plataforma}' AS plataforma,
      "contratoSnapshot" #>> '{origen,tipo}' AS "importOriginType"
    FROM "Credito" WHERE "montoCredito" > 0
  `;
  const evidenceById = new Map(evidence.map(e => [e.id, e]));
  const credits = await prisma.credito.findMany({
    where: { montoCredito: { gt: 0 } },
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
    },
    orderBy: { id: "asc" },
  });
  const eligibleCredits = credits.filter(c => riskCreditEligible({ ...c,
    fotoEntregaDataUrl: evidenceById.get(c.id)?.fotoEntrega,
    fotoRemisionDataUrl: evidenceById.get(c.id)?.fotoRemision,
    importOriginType: evidenceById.get(c.id)?.importOriginType,
  }));
  const displayNumbers = await getCreditDisplayNumbers(eligibleCredits.map(c => c.id));
  // Use the same immutable event source and latest-event order as Mora Central.
  await ensureAnalystMoraSchema();
  const latestManagement = await prisma.$queryRaw<Array<{ creditoId: number; actedAt: Date; action: string; result: string; comment: string }>>`
    SELECT DISTINCT ON (event."creditoId") event."creditoId", event."actedAt", event."action", event."result", event."comment"
    FROM "CreditMoraManagementEvent" event
    JOIN "Credito" credit ON credit.id = event."creditoId"
    WHERE credit."montoCredito" > 0
    ORDER BY event."creditoId", event."createdAt" DESC, event.id DESC
  `;
  const managementById = new Map(latestManagement.map(event => [event.creditoId, event]));
  const rows: ProductRiskCredit[] = eligibleCredits.map(c => {
    const plan = buildCreditPaymentPlan({ ...c, today, settled: Boolean(c.pazYSalvoEmitidoAt) });
    const overdue = plan.installments.filter(i => i.estaEnMora && i.saldoPendiente > 0);
    const dias = overdue.reduce((max, i) => Math.max(max, Math.round((Date.parse(cutoff) - Date.parse(i.fechaVencimiento)) / 86400000)), 0);
    const platform = evidenceById.get(c.id)?.plataforma?.toUpperCase();
    const management = managementById.get(c.id);
    return {
      id: c.id, folio: c.folio, numeroCreditoVisible: displayNumbers.get(c.id) || c.folio, cliente: c.clienteNombre,
      marca: c.equipoMarca?.trim() || "Sin marca", referencia: c.equipoModelo?.trim() || c.referenciaEquipo?.trim() || "Sin referencia",
      tipo: platform === "IPHONE" || platform === "ANDROID" ? platform : isIphoneEquipmentCatalogBrand(c.equipoMarca || "") ? "IPHONE" : c.equipoMarca ? "ANDROID" : "SIN_CLASIFICAR",
      aliado: c.sede.aliado?.nombre || "Sin aliado", sede: c.sede.nombre,
      fecha: calendarDateKey(getColombiaDateParts(c.fechaCredito)),
      capital: resolveCapitalOriginal(c),
      saldo: plan.saldoPendiente, vencido: overdue.reduce((sum, i) => sum + i.saldoPendiente, 0),
      dias, gestion: management ? `${management.action} · ${management.result} · ${management.comment}` : null,
      gestionFecha: management?.actedAt.toISOString() || null,
    };
  });
  return <AppShell sidebar={<AdminSidebar activeHref="/dashboard/riesgo-referencia" adminCentral nombreUsuario={session.nombre} rolUsuario={session.rolNombre} />}>
    <AdminWorkspaceTopbar parent="Cartera" current="Riesgo por referencia" userName={session.nombre} userRole={session.rolNombre} />
    <RiskConsole credits={rows} cutoff={cutoff} />
  </AppShell>;
}
