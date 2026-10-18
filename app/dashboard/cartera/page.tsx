import Link from "next/link";
import { resolveCreditAssignedAdministrator } from "@/lib/credit-assigned-seller";
import { redirect } from "next/navigation";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  CircleCheck,
  Download,
  FileText,
  Filter,
  History,
  Landmark,
  ReceiptText,
  RotateCcw,
  TrendingUp,
  TriangleAlert,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import prisma from "@/lib/prisma";
import { creditDisplayNumber } from "@/lib/credit-display-number";
import { getCreditDisplayNumbers, withCreditDisplayNumber } from "@/lib/credit-display-number-server";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import {
  ALIADO_FINSER_PAY,
  ensureAliadoSchema,
  isFinserPayCentralAlly,
  resolveRedescuentoPercentageByPlatform,
} from "@/lib/aliados";
import { resolveAllyPaymentPlatform } from "@/lib/ally-payments-core";
import { resolveCarteraAliadoId } from "@/lib/cartera-access";
import { normalizeCreditDevicePlatform } from "@/lib/credit-factory";
import { resolveCapitalOriginal } from "@/lib/credit-capital";
import { splitOutstandingBalance } from "@/lib/credit-outstanding-balance";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { calculatePortfolioProfit, resolvePortfolioInvestment } from "@/lib/portfolio-profit";
import PortfolioProfitBreakdown from "./portfolio-profit-breakdown";
import { Button, Card, PageHeader, ProgressBar, Select } from "@/app/_components/finser-ui";
import FinserNavigation from "../_components/finser-navigation";
import PushMassivePanel from "./push-massive-panel";
import CuotavencidaWhatsappButton from "./cuotavencida-whatsapp-button";
import styles from "./cartera.module.css";

export const metadata = {
  title: "Cartera | FINSER PAY",
  description: "Salud de cartera, mora y recuperacion de creditos",
};

type RiskBucket = "alDia" | "temprana" | "mayor" | "avanzada" | "pagado";
type CarteraPageProps = {
  searchParams?: Promise<{
    aliadoId?: string | string[] | undefined;
    plataforma?: string | string[] | undefined;
    platform?: string | string[] | undefined;
  }>;
};

const riskLabels: Record<RiskBucket, string> = {
  alDia: "Al dia",
  temprana: "Mora temprana",
  mayor: "Mora mayor",
  avanzada: "Mora avanzada",
  pagado: "Pagado",
};

const riskRank: Record<RiskBucket, number> = {
  pagado: 0,
  alDia: 1,
  temprana: 2,
  mayor: 3,
  avanzada: 4,
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 1,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function percent(value: number) {
  return `${percentFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function isAnnulled(value: string | null | undefined) {
  return String(value || "").toUpperCase().includes("ANUL");
}

function dateFromIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function daysLate(dueDateIso: string, today: Date) {
  const due = dateFromIso(dueDateIso);
  const base = new Date(today);
  base.setHours(12, 0, 0, 0);
  return Math.max(0, Math.floor((base.getTime() - due.getTime()) / 86_400_000));
}

function bucketFromDays(days: number, saldoPendiente: number): RiskBucket {
  if (saldoPendiente <= 0) {
    return "pagado";
  }

  if (days > 30) {
    return "avanzada";
  }

  if (days > 15) {
    return "mayor";
  }

  if (days > 0) {
    return "temprana";
  }

  return "alDia";
}

function ratio(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0;
}

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function firstFamilyReferencePhone(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return "";
  }

  const root = snapshot as Record<string, unknown>;
  const cliente =
    typeof root.cliente === "object" && root.cliente !== null
      ? (root.cliente as Record<string, unknown>)
      : null;
  const references = Array.isArray(cliente?.referenciasFamiliares)
    ? cliente.referenciasFamiliares
    : [];
  const first = references[0];

  if (typeof first !== "object" || first === null) {
    return "";
  }

  const record = first as Record<string, unknown>;

  return typeof record.telefono === "string" ? record.telefono : "";
}

function buildCarteraExportHref(input: {
  aliadoId: number | null;
  plataforma: "ANDROID" | "IPHONE" | null;
  scope?: "mora";
}) {
  const params = new URLSearchParams();

  if (input.aliadoId) {
    params.set("aliadoId", String(input.aliadoId));
  }

  if (input.plataforma) {
    params.set("plataforma", input.plataforma);
  }

  if (input.scope) {
    params.set("scope", input.scope);
  }

  const query = params.toString();
  return `/api/dashboard/cartera/export${query ? `?${query}` : ""}`;
}

export default async function CarteraPage({ searchParams }: CarteraPageProps) {
  const { session } = await requireAdminDashboardAccess();
  await ensureAliadoSchema(prisma);

  const params = searchParams ? await searchParams : {};
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const selectedAliadoScopeId = resolveCarteraAliadoId({
    adminCentral,
    ownAliadoId: session.aliadoAccesoId,
    requestedAliadoId: firstSearchParam(params.aliadoId),
  });

  if (!adminCentral && !selectedAliadoScopeId) {
    redirect("/dashboard");
  }

  const selectedPlatform = normalizeCreditDevicePlatform(
    firstSearchParam(params.plataforma) ?? firstSearchParam(params.platform)
  );
  const today = new Date();
  const aliados = await prisma.aliado.findMany({
    where: adminCentral
      ? {
          activo: true,
          NOT: {
            codigo: ALIADO_FINSER_PAY.codigo,
          },
        }
      : {
          activo: true,
          id: selectedAliadoScopeId || -1,
        },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      redescuentoPorcentaje: true,
      redescuentoAndroidPorcentaje: true,
      redescuentoIphonePorcentaje: true,
    },
    orderBy: {
      nombre: "asc",
    },
  });
  const selectedAliado = selectedAliadoScopeId
    ? aliados.find((aliado) => aliado.id === selectedAliadoScopeId) || null
    : null;

  if (!adminCentral && !selectedAliado) {
    redirect("/dashboard");
  }

  const selectedAliadoId = selectedAliado?.id || null;
  const selectedAliadoLabel = selectedAliado?.nombre || "Todos los aliados";
  const selectedPlatformLabel =
    selectedPlatform === "IPHONE"
      ? "Producto iPhone"
      : selectedPlatform === "ANDROID"
        ? "Producto Android"
        : "Todos los productos";
  const hasRemovableFilters = Boolean(selectedPlatform || (adminCentral && selectedAliadoId));
  const exportHref = buildCarteraExportHref({
    aliadoId: selectedAliadoId,
    plataforma: selectedPlatform,
  });
  const overdueExportHref = buildCarteraExportHref({
    aliadoId: selectedAliadoId,
    plataforma: selectedPlatform,
    scope: "mora",
  });
  const creditWhere: Prisma.CreditoWhereInput = selectedAliadoId
    ? {
        sede: {
          aliadoId: selectedAliadoId,
        },
      }
    : {};
  const gastoWhere: Prisma.GastoCarteraWhereInput = selectedAliadoId
    ? {
        sede: {
          aliadoId: selectedAliadoId,
        },
      }
    : {};

  const platformCreditIds = selectedPlatform
    ? (
        await prisma.credito.findMany({
          where: creditWhere,
          select: {
            id: true,
            contratoSnapshot: true,
            equipoMarca: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        })
      )
        .filter(
          (credito) =>
            resolveAllyPaymentPlatform(
              credito.contratoSnapshot,
              credito.equipoMarca
            ) === selectedPlatform
        )
        .map((credito) => credito.id)
    : null;
  const filteredCreditWhere: Prisma.CreditoWhereInput = platformCreditIds
    ? {
        AND: [creditWhere, { id: { in: platformCreditIds } }],
      }
    : creditWhere;

  const [creditos, gastosOperacion] = await Promise.all([
    prisma.credito.findMany({
      where: filteredCreditWhere,
      include: {
        liquidacionAliadoCredito: {
          select: {
            valorPagar: true,
            valorIntermediacion: true,
            estado: true,
            liquidacion: { select: { estado: true } },
          },
        },
        abonos: {
          where: {
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            valor: true,
            fechaAbono: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        },
        sede: {
          select: {
            nombre: true,
            aliado: {
              select: {
                id: true,
                nombre: true,
                codigo: true,
                redescuentoPorcentaje: true,
                redescuentoAndroidPorcentaje: true,
                redescuentoIphonePorcentaje: true,
              },
            },
          },
        },
        vendedor: {
          select: {
            nombre: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.gastoCartera.findMany({
      where: gastoWhere,
      select: {
        valor: true,
      },
    }),
  ]);

  const displayNumbers = await getCreditDisplayNumbers(creditos.map(credito => credito.id));
  const cartera = creditos
    .filter((credito) => !isAnnulled(credito.estado))
    .filter(
      (credito) =>
        !selectedPlatform ||
        resolveAllyPaymentPlatform(
          credito.contratoSnapshot,
          credito.equipoMarca
        ) === selectedPlatform
    )
    .map((credito) => {
      const plan = buildCreditPaymentPlan({
        planCapitalVigente: credito.planCapitalVigente,
        montoCredito: credito.montoCredito,
        valorCuota: credito.valorCuota,
        plazoMeses: credito.plazoMeses,
        frecuenciaPago: credito.frecuenciaPago,
        fechaPrimerPago: credito.fechaPrimerPago,
        fechaProximoPago: credito.fechaProximoPago,
        abonos: credito.abonos,
        today,
        settled: Boolean(credito.pazYSalvoEmitidoAt),
      });
      const overdueInstallments = plan.installments.filter(
        (installment) => installment.estaEnMora && installment.saldoPendiente > 0
      );
      const diasMora = overdueInstallments.reduce(
        (max, installment) => Math.max(max, daysLate(installment.fechaVencimiento, today)),
        0
      );
      const bucket = bucketFromDays(diasMora, plan.saldoPendiente);
      const saldoMora = overdueInstallments.reduce(
        (sum, installment) => sum + installment.saldoPendiente,
        0
      );
      const creditoAutorizado =
        Number(credito.saldoBaseFinanciado || 0) ||
        Math.max(0, Number(credito.valorEquipoTotal || 0) - Number(credito.cuotaInicial || 0));
      const balances = splitOutstandingBalance({
        planCapitalVigente: credito.planCapitalVigente,
        totalAbonado: plan.totalPaid,
        cuotaInicial: Number(credito.cuotaInicial || 0),
        montoCredito: Number(credito.montoCredito || 0),
        saldoBaseFinanciado: Number(credito.saldoBaseFinanciado || 0),
        saldoPendiente: plan.saldoPendiente,
        valorEquipoTotal: Number(credito.valorEquipoTotal || 0),
        valorFianza: Number(credito.valorFianza || 0),
        valorInteres: Number(credito.valorInteres || 0),
        contratoSnapshot: credito.contratoSnapshot,
        valorCuota: Number(credito.valorCuota || 0),
        plazoMeses: credito.plazoMeses,
      });
      const plataforma = resolveAllyPaymentPlatform(
        credito.contratoSnapshot,
        credito.equipoMarca
      );

      const redescuentoPorcentaje = resolveRedescuentoPercentageByPlatform(
        credito.sede.aliado || {}, plataforma
      );
      const registeredSettlement = credito.liquidacionAliadoCredito;
      const paidSettlement = registeredSettlement?.estado === "PAGADO" &&
        registeredSettlement.liquidacion.estado === "PAGADA" ? registeredSettlement : null;
      const investment = resolvePortfolioInvestment({
        authorizedCapital: creditoAutorizado,
        backingPercentage: redescuentoPorcentaje,
        recordedNetInvestment: paidSettlement ? Number(paidSettlement.valorPagar) : null,
      });

      return {
        ...withCreditDisplayNumber({ id: credito.id, folio: credito.folio }, displayNumbers),
        imei: credito.imei || credito.deviceUid || "Sin IMEI",
        clienteNombre: credito.clienteNombre,
        clienteDocumento: credito.clienteDocumento || "",
        estado: credito.estado,
        clienteTelefono: credito.clienteTelefono || "",
        primeraReferenciaTelefono: firstFamilyReferencePhone(credito.contratoSnapshot),
        referencia:
          credito.referenciaEquipo ||
          [credito.equipoMarca, credito.equipoModelo].filter(Boolean).join(" ") ||
          "Equipo",
        sede: credito.sede.nombre,
        aliado: credito.sede.aliado?.nombre || "Sin aliado",
        plataforma,
        capitalOriginal: resolveCapitalOriginal(credito),
        inversionNeta: investment.amount,
        inversionEstimada: investment.estimated,
        respaldo: paidSettlement
          ? Number(paidSettlement.valorIntermediacion)
          : Math.round((creditoAutorizado - investment.amount) * 100) / 100,
        vendedor: resolveCreditAssignedAdministrator(credito)?.nombre || credito.vendedor?.nombre || "Sin vendedor",
        cuotaInicial: Number(credito.cuotaInicial || 0),
        creditoAutorizado,
        montoCredito: Number(credito.montoCredito || 0),
        gananciaProyectada: Math.max(
          0,
          Number(credito.montoCredito || 0) - creditoAutorizado
        ),
        saldoPendiente: plan.saldoPendiente,
        saldoCapital: balances.saldoCapital,
        totalPaid: plan.totalPaid,
        paidCount: plan.paidCount,
        pendingCount: plan.pendingCount,
        overdueCount: plan.overdueCount,
        saldoMora,
        diasMora,
        bucket,
        nextDueDate: plan.nextInstallment?.fechaVencimiento || null,
        nextDueValue: plan.nextInstallment?.saldoPendiente || 0,
      };
    });

  const activeCredits = cartera.filter((item) => item.saldoPendiente > 0);
  const overdueCredits = activeCredits.filter((item) => item.bucket !== "alDia");
  const paidCredits = cartera.filter((item) => item.saldoPendiente <= 0);
  const totalPendiente = activeCredits.reduce((sum, item) => sum + item.saldoPendiente, 0);
  const totalMora = activeCredits.reduce((sum, item) => sum + item.saldoMora, 0);
  const totalPagado = cartera.reduce((sum, item) => sum + item.totalPaid, 0);
  const totalCredito = cartera.reduce((sum, item) => sum + item.montoCredito, 0);
  const totalCapitalInvertido = cartera
    .filter((item) => !["CANCELADO", "CANCELADA"].includes(String(item.estado || "").toUpperCase()))
    .reduce((sum, item) => sum + item.capitalOriginal, 0);
  const totalInvertido = cartera.reduce((sum, item) => sum + item.inversionNeta, 0);
  const estimatedInvestments = cartera.filter((item) => item.inversionEstimada);
  const totalInversionEstimada = estimatedInvestments.reduce((sum, item) => sum + item.inversionNeta, 0);
  const totalCapitalComprometidoMora = overdueCredits.reduce(
    (sum, item) => sum + item.saldoCapital,
    0
  );
  const bolsaRespaldoMora = activeCredits.reduce(
    (sum, item) =>
      sum + item.respaldo,
    0
  );
  const gananciaReconocida = paidCredits.reduce(
    (sum, item) => sum + item.gananciaProyectada,
    0
  );
  const totalGastosOperacion = gastosOperacion.reduce(
    (sum, item) => sum + Number(item.valor || 0),
    0
  );
  const profitInput = {
    outstandingBalance: totalPendiente,
    accumulatedCollections: totalPagado,
    accumulatedInvestment: totalInvertido,
    operatingExpenses: totalGastosOperacion,
    committedCapital: totalCapitalComprometidoMora,
    recognizedProfit: gananciaReconocida,
  };
  const totalGanancias = calculatePortfolioProfit(profitInput);
  const totalSano = activeCredits
    .filter((item) => item.bucket === "alDia")
    .reduce((sum, item) => sum + item.saldoPendiente, 0);

  const bucketValues = {
    temprana: activeCredits
      .filter((item) => item.bucket === "temprana")
      .reduce((sum, item) => sum + item.saldoPendiente, 0),
    mayor: activeCredits
      .filter((item) => item.bucket === "mayor")
      .reduce((sum, item) => sum + item.saldoPendiente, 0),
    avanzada: activeCredits
      .filter((item) => item.bucket === "avanzada")
      .reduce((sum, item) => sum + item.saldoPendiente, 0),
  };

  const clientRisk = new Map<string, RiskBucket>();
  for (const item of activeCredits) {
    const key = item.clienteDocumento || item.clienteNombre || String(item.id);
    const current = clientRisk.get(key);

    if (!current || riskRank[item.bucket] > riskRank[current]) {
      clientRisk.set(key, item.bucket);
    }
  }

  const clientsTemprana = [...clientRisk.values()].filter((value) => value === "temprana").length;
  const clientsMayor = [...clientRisk.values()].filter((value) => value === "mayor").length;
  const clientsAvanzada = [...clientRisk.values()].filter((value) => value === "avanzada").length;
  const clientsMora = clientsTemprana + clientsMayor + clientsAvanzada;
  const pctMora = ratio(totalMora, totalPendiente);
  const pctSana = ratio(totalSano, totalPendiente);
  const pctRecuperado = ratio(totalPagado, totalCredito);
  const pctPagados = ratio(paidCredits.length, cartera.length);

  const health =
    totalPendiente <= 0
      ? {
          label: "Cartera cerrada",
          tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
          detail: "No hay saldo pendiente por cobrar en los creditos activos.",
        }
      : pctMora <= 8 && clientsAvanzada === 0
        ? {
            label: "Vas bien",
            tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
            detail: "La mora esta controlada. Mantener seguimiento antes del vencimiento.",
          }
        : pctMora <= 18 && clientsAvanzada <= 2
          ? {
              label: "Alerta temprana",
              tone: "border-amber-200 bg-amber-50 text-amber-900",
              detail: "La cartera necesita gestion diaria para evitar que la mora avance.",
            }
          : {
              label: "Riesgo alto",
              tone: "border-red-200 bg-red-50 text-red-900",
              detail: "Prioriza el seguimiento de los créditos vencidos y respeta sus autorizaciones vigentes.",
            };

  const riskRows = [...overdueCredits]
    .sort((a, b) => b.diasMora - a.diasMora || b.saldoPendiente - a.saldoPendiente);
  const lastUpdatedLabel = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "America/Bogota",
  }).format(today);

  return (
    <div className={styles.page}>
      <FinserNavigation
        admin
        variant="requests"
        activeSection="portfolio"
        adminCentral={adminCentral}
        nombreUsuario={session.nombre}
        rolUsuario={session.rolNombre}
      />

      <main className={styles.content}>
        <PageHeader className={styles.heading} eyebrow="Control de cartera" title="Cartera"
          description={<>{selectedAliadoLabel} · {selectedPlatformLabel} · Actualizada {lastUpdatedLabel}</>}
          actions={<>
            <ActionLink href={exportHref} icon={Download} label="Excel" primary />
            <ActionLink href="/dashboard/reportes/creditos" icon={FileText} label="Créditos" />
            {adminCentral ? <>
              <ActionLink href="/dashboard/financiero/cartera" icon={ReceiptText} label="Registrar gasto" />
              <ActionLink href="/dashboard/financiero/cartera/detalle" icon={History} label="Historial de gastos" />
            </> : null}
          </>} />
        <Card className={styles.filters}>
            <form action="/dashboard/cartera" className={styles.filterForm}>
              {adminCentral ? (
                <label>
                  <span>Aliado</span>
                  <Select
                    name="aliadoId"
                    defaultValue={selectedAliadoId ? String(selectedAliadoId) : ""}
                    className={styles.allySelect}
                  >
                    <option value="">Todos los aliados</option>
                    {aliados.map((aliado) => (
                      <option key={aliado.id} value={aliado.id}>
                        {aliado.nombre}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label>
                <span>Producto</span>
                <Select
                  name="plataforma"
                  defaultValue={selectedPlatform || ""}
                  className={styles.productSelect}
                >
                  <option value="">Todos los productos</option>
                  <option value="IPHONE">iPhone</option>
                  <option value="ANDROID">Android</option>
                </Select>
              </label>
              <div className="flex gap-2">
                <Button type="submit">
                  <Filter className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  Aplicar
                </Button>
                {hasRemovableFilters ? (
                  <Link
                    href="/dashboard/cartera"
                    title="Quitar filtros"
                    aria-label="Quitar filtros"
                    className="fp-ui-button is-secondary"
                  >
                    <RotateCcw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                    Limpiar
                  </Link>
                ) : null}
              </div>
            </form>

            {adminCentral ? <div className={styles.whatsapp}><CuotavencidaWhatsappButton /></div> : null}
        </Card>

        <section
          className={`${styles.metrics} ${adminCentral ? styles.centralMetrics : styles.allyMetrics}`}
          aria-label="Resumen de cartera"
        >
          {adminCentral ? (
            <MetricCard
              detail={`${activeCredits.length} creditos con saldo`}
              icon={WalletCards}
              label="Saldo por cobrar"
              tone="neutral"
              value={money(totalPendiente)}
            />
          ) : null}
          <MetricCard
            detail={adminCentral ? `${money(totalSano)} sin mora` : undefined}
            icon={CircleCheck}
            label="Cartera al dia"
            tone="green"
            value={percent(pctSana)}
          />
          <MetricCard
            detail={adminCentral ? `${percent(pctMora)} del saldo pendiente` : undefined}
            icon={TriangleAlert}
            label="Cartera en mora"
            tone="red"
            value={money(totalMora)}
            warning={pctMora > 18}
          />
          <MetricCard
            detail={adminCentral ? money(totalPagado) : undefined}
            icon={TrendingUp}
            label="Recuperado"
            tone="neutral"
            value={percent(pctRecuperado)}
          />
          {adminCentral ? (
            <MetricCard
              detail={`${money(gananciaReconocida)} reconocida descontada · ${money(totalGastosOperacion)} en gastos`}
              icon={Landmark}
              label="Ganancia estimada"
              tone="gold"
              value={money(totalGanancias)}
              warning={totalGanancias < 0}
            />
          ) : null}
        </section>

        <section
          className={`${styles.secondaryMetrics} ${adminCentral ? styles.centralSecondary : styles.allySecondary}`}
          aria-label="Indicadores complementarios"
        >
          <MiniMetric
            label="Inversión acumulada"
            value={money(adminCentral ? totalInvertido : totalCapitalInvertido)}
            detail={adminCentral ? "Neto por crédito · activos y pagados" : "Capital original · activos y pagados"}
          />
          <MiniMetric
            label="Capital comprometido"
            value={money(totalCapitalComprometidoMora)}
            detail={`${clientsMora} clientes en mora`}
          />
          {adminCentral ? (
            <MiniMetric label="Respaldo" value={money(bolsaRespaldoMora)} detail="Retención activa · ya descontada de la inversión" />
          ) : null}
          <MiniMetric label="Creditos pagados" value={percent(pctPagados)} detail={`${paidCredits.length} cerrados`} />
          <MiniMetric label="Clientes en mora" value={String(clientsMora)} detail={health.label} />
        </section>

        {adminCentral ? (
          <PortfolioProfitBreakdown input={profitInput} total={totalGanancias}
            estimatedInvestment={totalInversionEstimada} estimatedCount={estimatedInvestments.length}
            productFiltered={Boolean(selectedPlatform)} />
        ) : null}

        <section
          className={`${styles.workspaces} ${adminCentral ? styles.centralWorkspaces : ""}`}
        >
          <Card className={styles.riskPanel}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className={styles.eyebrow}>Mora por edades</p>
                <h2 className={styles.sectionTitle}>Riesgo por días</h2>
              </div>
              <span className={["inline-flex rounded-full border px-3 py-1 text-xs font-bold", health.tone].join(" ")}>
                {health.label}
              </span>
            </div>
            <p className={styles.riskDescription}>
              {health.detail}
            </p>

            <div className={styles.buckets}>
              <BucketCard
                title="Temprana"
                subtitle="1 a 15 dias"
                clients={clientsTemprana}
                value={bucketValues.temprana}
                percentValue={ratio(bucketValues.temprana, totalPendiente)}
                tone="amber"
              />
              <BucketCard
                title="Mayor"
                subtitle="16 a 30 dias"
                clients={clientsMayor}
                value={bucketValues.mayor}
                percentValue={ratio(bucketValues.mayor, totalPendiente)}
                tone="orange"
              />
              <BucketCard
                title="Avanzada"
                subtitle="Mas de 30 dias"
                clients={clientsAvanzada}
                value={bucketValues.avanzada}
                percentValue={ratio(bucketValues.avanzada, totalPendiente)}
                tone="red"
              />
            </div>
          </Card>

          {adminCentral ? <PushMassivePanel /> : null}
        </section>

        <Card className={styles.priorities}>
          <div className={styles.tableHeading}>
            <div>
              <p className={styles.eyebrow}>Riesgos prioritarios</p>
              <h2 className={styles.sectionTitle}>Clientes que requieren gestión</h2>
              <p className="mt-1 text-xs text-[#667085]">Ordenados por dias de mora y saldo pendiente.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex w-fit rounded-full border border-[#d8dee6] bg-[#f7f9fb] px-3 py-1.5 text-xs font-bold text-[#475467]">
                {riskRows.length ? `${riskRows.length} registros en mora` : "Sin mora registrada"}
              </span>
              {riskRows.length ? (
                <ActionLink href={overdueExportHref} icon={Download} label="Excel mora" />
              ) : null}
            </div>
          </div>

          <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="Créditos en mora, desplaza para consultar todas las columnas">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 w-[190px] bg-[#17202b] px-4 py-3 text-[10px] font-bold uppercase">Cliente</th>
                  <th className="w-[125px] px-4 py-3 text-[10px] font-bold uppercase">Documento</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Celular</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Ref. familiar</th>
                  <th className="w-[175px] px-4 py-3 text-[10px] font-bold uppercase">Número crédito</th>
                  <th className="w-[215px] px-4 py-3 text-[10px] font-bold uppercase">Equipo</th>
                  <th className="w-[120px] px-4 py-3 text-[10px] font-bold uppercase">Sede</th>
                  <th className="w-[175px] px-4 py-3 text-[10px] font-bold uppercase">Mora</th>
                  <th className="w-[135px] px-4 py-3 text-[10px] font-bold uppercase">Saldo total</th>
                  <th className="w-[145px] px-4 py-3 text-[10px] font-bold uppercase">Capital pendiente</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Vence</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Cuota</th>
                </tr>
              </thead>
              <tbody>
                {riskRows.length ? (
                  riskRows.map((item) => (
                    <tr key={item.id} className="group border-b border-[#e5eaf0] transition hover:bg-[#f7fbfa] last:border-0">
                      <td className="sticky left-0 z-[1] bg-white px-4 py-3 align-top group-hover:bg-[#f7fbfa]">
                        <p className="font-bold leading-5 text-[#101828]">{item.clienteNombre}</p>
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[#475467]">
                        {item.clienteDocumento || "Sin documento"}
                      </td>
                      <td className="px-4 py-3 align-top font-semibold text-[var(--fp-graphite)]">
                        {item.clienteTelefono || "Sin celular"}
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[#475467]">
                        {item.primeraReferenciaTelefono || "Sin referencia"}
                      </td>
                      <td className="px-4 py-3 align-top font-bold leading-5 text-[#101828]">
                        {creditDisplayNumber(item) || "Sin número"}
                        {creditDisplayNumber(item) !== item.folio ? <p className="mt-1 break-all text-xs font-normal text-[var(--fp-muted)]">Folio original: {item.folio}</p> : null}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <p className="font-semibold leading-5 text-[#101828]">{item.referencia}</p>
                        <p className="mt-1 text-xs text-[#667085]">{item.imei}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <p className="font-semibold text-[#101828]">{item.sede}</p>
                        <p className="mt-1 text-xs text-[#667085]">{item.aliado}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span
                          className={[
                            "inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold",
                            item.bucket === "avanzada"
                              ? "border-red-200 bg-red-50 text-red-700"
                              : item.bucket === "mayor"
                                ? "border-orange-200 bg-orange-50 text-orange-700"
                                : "border-amber-200 bg-amber-50 text-amber-700",
                          ].join(" ")}
                        >
                          {riskLabels[item.bucket]} · {item.diasMora} dias
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top font-black text-[#101828]">
                        {money(item.saldoPendiente)}
                      </td>
                      <td className="px-4 py-3 align-top font-black text-[#101828]">
                        {money(item.saldoCapital)}
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[#475467]">
                        {item.nextDueDate || "Sin cuota"}
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[#475467]">
                        {item.nextDueDate ? money(item.nextDueValue) : "Sin cuota"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={12} className="px-5 py-12 text-center text-sm font-semibold text-[#667085]">
                      No hay creditos en mora para mostrar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </main>
    </div>
  );
}

function ActionLink({
  href,
  icon: Icon,
  label,
  primary = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  primary?: boolean;
}) {
  const className = `fp-ui-button ${primary ? "is-primary" : "is-secondary"}`;

  if (href.startsWith("/api/")) {
    return (
      <a href={href} className={className}>
        <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        {label}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      {label}
    </Link>
  );
}

function MetricCard({
  detail,
  icon: Icon,
  label,
  tone,
  value,
  warning = false,
}: {
  detail?: string;
  icon: LucideIcon;
  label: string;
  tone: "gold" | "green" | "red" | "neutral";
  value: string;
  warning?: boolean;
}) {
  const toneClass = warning || tone === "red" ? styles.dangerMetric : tone === "green" ? styles.positiveMetric : "";

  return (
    <Card className={`${styles.metric} ${toneClass}`}>
      <div className={styles.metricLabel}>
        <span className={styles.metricIcon}>
          <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <p>{label}</p>
      </div>
      <p className={styles.metricValue}>
        {value}
      </p>
      {detail ? (
        <p className={styles.metricDetail}>{detail}</p>
      ) : null}
    </Card>
  );
}

function MiniMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className={styles.miniMetric}>
      <p className={styles.miniLabel}>{label}</p>
      <p className={styles.miniValue}>{value}</p>
      <p className={styles.metricDetail}>{detail}</p>
    </Card>
  );
}

function BucketCard({
  title,
  subtitle,
  clients,
  value,
  percentValue,
  tone,
}: {
  title: string;
  subtitle: string;
  clients: number;
  value: number;
  percentValue: number;
  tone: "amber" | "orange" | "red";
}) {
  return (
    <div className={`${styles.bucket} ${tone === "red" ? styles.dangerBucket : styles.warningBucket}`}>
      <p className={styles.bucketTitle}>{title}</p>
      <p className={styles.bucketDetail}>{subtitle}</p>
      <p className={styles.bucketClients}>{clients}</p>
      <p className={styles.bucketValue}>{money(value)}</p>
      <ProgressBar value={percentValue} label={`${title}: ${percent(percentValue)} del saldo`} className={styles.bucketProgress} />
      <p className={styles.bucketDetail}>{percent(percentValue)} del saldo</p>
    </div>
  );
}
