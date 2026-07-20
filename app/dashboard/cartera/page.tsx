import Link from "next/link";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  CircleCheck,
  Download,
  FileText,
  Filter,
  Landmark,
  RotateCcw,
  TrendingUp,
  TriangleAlert,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import prisma from "@/lib/prisma";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import {
  ALIADO_FINSER_PAY,
  DEFAULT_REDESCUENTO_PERCENTAGE,
  ensureAliadoSchema,
} from "@/lib/aliados";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import AdminSidebar from "../_components/admin-sidebar";
import PushMassivePanel from "./push-massive-panel";

export const metadata = {
  title: "Cartera | FINSER PAY",
  description: "Salud de cartera, mora y recuperacion de creditos",
};

type RiskBucket = "alDia" | "temprana" | "mayor" | "avanzada" | "pagado";
type CarteraPageProps = {
  searchParams?: Promise<{
    aliadoId?: string | string[] | undefined;
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

function parsePositiveInt(value: unknown) {
  const parsed = Number(String(value ?? "").trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

export default async function CarteraPage({ searchParams }: CarteraPageProps) {
  const { session } = await requireCentralAdminDashboardAccess();
  await ensureAliadoSchema(prisma);

  const params = searchParams ? await searchParams : {};
  const requestedAliadoId = parsePositiveInt(firstSearchParam(params.aliadoId));
  const today = new Date();
  const aliados = await prisma.aliado.findMany({
    where: {
      activo: true,
      NOT: {
        codigo: ALIADO_FINSER_PAY.codigo,
      },
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      redescuentoPorcentaje: true,
    },
    orderBy: {
      nombre: "asc",
    },
  });
  const selectedAliado = requestedAliadoId
    ? aliados.find((aliado) => aliado.id === requestedAliadoId) || null
    : null;
  const selectedAliadoId = selectedAliado?.id || null;
  const selectedAliadoLabel = selectedAliado?.nombre || "Todos los aliados";
  const exportHref = selectedAliadoId
    ? `/api/dashboard/cartera/export?aliadoId=${selectedAliadoId}`
    : "/api/dashboard/cartera/export";
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

  const [creditos, gastosOperacion] = await Promise.all([
    prisma.credito.findMany({
      where: creditWhere,
      include: {
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
      take: 1000,
    }),
    prisma.gastoCartera.findMany({
      where: gastoWhere,
      select: {
        valor: true,
      },
    }),
  ]);

  const cartera = creditos
    .filter((credito) => !isAnnulled(credito.estado))
    .map((credito) => {
      const plan = buildCreditPaymentPlan({
        montoCredito: credito.montoCredito,
        valorCuota: credito.valorCuota,
        plazoMeses: credito.plazoMeses,
        frecuenciaPago: credito.frecuenciaPago,
        fechaPrimerPago: credito.fechaPrimerPago,
        abonos: credito.abonos,
        today,
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

      return {
        id: credito.id,
        folio: credito.folio,
        imei: credito.imei || credito.deviceUid || "Sin IMEI",
        clienteNombre: credito.clienteNombre,
        clienteDocumento: credito.clienteDocumento || "",
        clienteTelefono: credito.clienteTelefono || "",
        primeraReferenciaTelefono: firstFamilyReferencePhone(credito.contratoSnapshot),
        referencia:
          credito.referenciaEquipo ||
          [credito.equipoMarca, credito.equipoModelo].filter(Boolean).join(" ") ||
          "Equipo",
        sede: credito.sede.nombre,
        aliado: credito.sede.aliado?.nombre || "Sin aliado",
        redescuentoPorcentaje: Number(
          credito.sede.aliado?.redescuentoPorcentaje ??
            DEFAULT_REDESCUENTO_PERCENTAGE
        ),
        vendedor: credito.vendedor?.nombre || "Sin vendedor",
        cuotaInicial: Number(credito.cuotaInicial || 0),
        creditoAutorizado,
        montoCredito: Number(credito.montoCredito || 0),
        gananciaProyectada: Math.max(
          0,
          Number(credito.montoCredito || 0) - creditoAutorizado
        ),
        saldoPendiente: plan.saldoPendiente,
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
  const paidCredits = cartera.filter((item) => item.saldoPendiente <= 0);
  const totalPendiente = activeCredits.reduce((sum, item) => sum + item.saldoPendiente, 0);
  const totalMora = activeCredits.reduce((sum, item) => sum + item.saldoMora, 0);
  const totalPagado = cartera.reduce((sum, item) => sum + item.totalPaid, 0);
  const totalCredito = cartera.reduce((sum, item) => sum + item.montoCredito, 0);
  const totalInvertido = activeCredits.reduce((sum, item) => sum + item.creditoAutorizado, 0);
  const bolsaRespaldoMora = activeCredits.reduce(
    (sum, item) =>
      sum + item.creditoAutorizado * Math.max(0, item.redescuentoPorcentaje) / 100,
    0
  );
  const respaldoDetail = selectedAliado
    ? `${percent(selectedAliado.redescuentoPorcentaje)} de inversion`
    : "Segun porcentaje por aliado";
  const totalGananciaBruta = activeCredits.reduce(
    (sum, item) => sum + item.gananciaProyectada,
    0
  );
  const totalGastosOperacion = gastosOperacion.reduce(
    (sum, item) => sum + Number(item.valor || 0),
    0
  );
  const totalGanancias = totalGananciaBruta - totalGastosOperacion - totalMora;
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
              detail: "La mora avanzada ya pesa en el saldo. Prioriza recaudo y bloqueo por mora.",
            };

  const riskRows = activeCredits
    .filter((item) => item.bucket !== "alDia")
    .sort((a, b) => b.diasMora - a.diasMora || b.saldoPendiente - a.saldoPendiente);
  const lastUpdatedLabel = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(today);

  return (
    <div className="min-h-screen bg-[#f4f7f8] text-[#101828] lg:grid lg:grid-cols-[250px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/cartera"
        adminCentral
        nombreUsuario={session.nombre}
        rolUsuario={session.rolNombre}
      />

      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-7 xl:px-8">
        <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#0d766f]">Control de cartera</p>
            <h1 className="mt-1 text-3xl font-black text-[#101828]">Cartera</h1>
            <p className="mt-1 text-sm text-[#667085]">
              {selectedAliadoLabel} · Actualizada {lastUpdatedLabel}
            </p>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
            <form action="/dashboard/cartera" className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="grid gap-1">
                <span className="text-xs font-bold text-[#475467]">Aliado</span>
                <select
                  name="aliadoId"
                  defaultValue={selectedAliadoId ? String(selectedAliadoId) : ""}
                  className="h-11 min-w-[230px] rounded-lg border border-[#d0d7e0] bg-white px-3 text-sm font-semibold text-[#344054] outline-none transition focus:border-[#0d9488] focus:ring-4 focus:ring-[#0d9488]/10"
                >
                  <option value="">Todos los aliados</option>
                  {aliados.map((aliado) => (
                    <option key={aliado.id} value={aliado.id}>
                      {aliado.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#087a73] px-4 text-sm font-bold text-white transition hover:bg-[#06645f]"
                >
                  <Filter className="h-4 w-4" strokeWidth={2} />
                  Aplicar
                </button>
                {selectedAliadoId ? (
                  <Link
                    href="/dashboard/cartera"
                    title="Quitar filtro de aliado"
                    aria-label="Quitar filtro de aliado"
                    className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#d0d7e0] bg-white text-[#475467] transition hover:border-[#0d9488] hover:text-[#0d766f]"
                  >
                    <RotateCcw className="h-4 w-4" strokeWidth={2} />
                  </Link>
                ) : null}
              </div>
            </form>

            <div className="flex gap-2">
              <ActionLink href={exportHref} icon={Download} label="Excel" primary />
              <ActionLink href="/dashboard/reportes/creditos" icon={FileText} label="Creditos" />
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            detail={`${activeCredits.length} creditos con saldo`}
            icon={WalletCards}
            label="Saldo por cobrar"
            tone="teal"
            value={money(totalPendiente)}
          />
          <MetricCard
            detail={`${money(totalSano)} sin mora`}
            icon={CircleCheck}
            label="Cartera al dia"
            tone="green"
            value={percent(pctSana)}
          />
          <MetricCard
            detail={`${percent(pctMora)} del saldo pendiente`}
            icon={TriangleAlert}
            label="Cartera en mora"
            tone="red"
            value={money(totalMora)}
            warning={pctMora > 18}
          />
          <MetricCard
            detail={money(totalPagado)}
            icon={TrendingUp}
            label="Recuperado"
            tone="teal"
            value={percent(pctRecuperado)}
          />
          <MetricCard
            detail={`${money(totalGastosOperacion)} en gastos`}
            icon={Landmark}
            label="Ganancia estimada"
            tone="gold"
            value={money(totalGanancias)}
            warning={totalGanancias < 0}
          />
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MiniMetric label="Inversion activa" value={money(totalInvertido)} detail="Credito autorizado activo" />
          <MiniMetric label="Respaldo" value={money(bolsaRespaldoMora)} detail={respaldoDetail} />
          <MiniMetric label="Creditos pagados" value={percent(pctPagados)} detail={`${paidCredits.length} cerrados`} />
          <MiniMetric label="Clientes en mora" value={String(clientsMora)} detail={health.label} />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <section className="rounded-lg border border-[#d8dee6] bg-white p-5 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase text-[#0d766f]">Mora por edades</p>
                <h2 className="mt-1 text-xl font-black text-[#101828]">Riesgo por dias</h2>
              </div>
              <span className={["inline-flex rounded-full border px-3 py-1 text-xs font-bold", health.tone].join(" ")}>
                {health.label}
              </span>
            </div>
            <p className="mt-3 rounded-lg bg-[#f7f9fb] px-3 py-2.5 text-sm text-[#667085]">
              {health.detail}
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
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
          </section>

          <PushMassivePanel />
        </section>

        <section className="mt-4 overflow-hidden rounded-lg border border-[#d8dee6] bg-white shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-2 border-b border-[#d8dee6] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase text-[#0d766f]">Riesgos prioritarios</p>
              <h2 className="mt-1 text-xl font-black text-[#101828]">Clientes que requieren gestion</h2>
              <p className="mt-1 text-xs text-[#667085]">Ordenados por dias de mora y saldo pendiente.</p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-[#d8dee6] bg-[#f7f9fb] px-3 py-1.5 text-xs font-bold text-[#475467]">
              {riskRows.length ? `${riskRows.length} registros en mora` : "Sin mora registrada"}
            </span>
          </div>

          <div className="overflow-x-auto [scrollbar-color:#98a2b3_transparent] [scrollbar-width:thin]">
            <table className="w-full min-w-[1460px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[#17202b] text-white">
                <tr>
                  <th className="sticky left-0 z-20 w-[190px] bg-[#17202b] px-4 py-3 text-[10px] font-bold uppercase">Cliente</th>
                  <th className="w-[125px] px-4 py-3 text-[10px] font-bold uppercase">Documento</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Celular</th>
                  <th className="w-[130px] px-4 py-3 text-[10px] font-bold uppercase">Ref. familiar</th>
                  <th className="w-[175px] px-4 py-3 text-[10px] font-bold uppercase">Folio</th>
                  <th className="w-[215px] px-4 py-3 text-[10px] font-bold uppercase">Equipo</th>
                  <th className="w-[120px] px-4 py-3 text-[10px] font-bold uppercase">Sede</th>
                  <th className="w-[175px] px-4 py-3 text-[10px] font-bold uppercase">Mora</th>
                  <th className="w-[135px] px-4 py-3 text-[10px] font-bold uppercase">Saldo</th>
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
                      <td className="px-4 py-3 align-top font-semibold text-[#0d766f]">
                        {item.clienteTelefono || "Sin celular"}
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[#475467]">
                        {item.primeraReferenciaTelefono || "Sin referencia"}
                      </td>
                      <td className="px-4 py-3 align-top font-bold leading-5 text-[#101828]">
                        {item.folio || "Sin folio"}
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
                    <td colSpan={11} className="px-5 py-12 text-center text-sm font-semibold text-[#667085]">
                      No hay creditos en mora para mostrar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
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
  const classes = primary
    ? "border-[#087a73] bg-[#087a73] text-white hover:bg-[#06645f]"
    : "border-[#d0d7e0] bg-white text-[#344054] hover:border-[#0d9488] hover:text-[#0d766f]";
  const className = [
    "inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-bold transition",
    classes,
  ].join(" ");

  if (href.startsWith("/api/")) {
    return (
      <a href={href} className={className}>
        <Icon className="h-4 w-4" strokeWidth={2} />
        {label}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      <Icon className="h-4 w-4" strokeWidth={2} />
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
  detail: string;
  icon: LucideIcon;
  label: string;
  tone: "gold" | "green" | "red" | "teal";
  value: string;
  warning?: boolean;
}) {
  const toneMap = {
    gold: {
      icon: "bg-amber-50 text-amber-700",
      value: "text-[#101828]",
    },
    green: {
      icon: "bg-emerald-50 text-emerald-700",
      value: "text-emerald-700",
    },
    red: {
      icon: "bg-red-50 text-red-600",
      value: "text-red-600",
    },
    teal: {
      icon: "bg-teal-50 text-teal-700",
      value: "text-[#101828]",
    },
  }[warning ? "red" : tone];

  return (
    <article className="min-w-0 rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-3">
        <span className={["flex h-10 w-10 shrink-0 items-center justify-center rounded-full", toneMap.icon].join(" ")}>
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <p className="min-w-0 text-sm font-medium text-[#344054]">{label}</p>
      </div>
      <p className={["mt-4 whitespace-nowrap text-[22px] font-black leading-none 2xl:text-2xl", toneMap.value].join(" ")}>
        {value}
      </p>
      <p className="mt-3 text-xs font-medium leading-5 text-[#667085]">{detail}</p>
    </article>
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
    <div className="rounded-lg border border-[#d8dee6] bg-white px-4 py-3">
      <p className="text-[10px] font-bold uppercase text-[#667085]">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="text-lg font-black text-[#101828]">{value}</p>
        <p className="text-right text-xs text-[#667085]">{detail}</p>
      </div>
    </div>
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
  const toneMap = {
    amber: {
      card: "border-amber-200 bg-amber-50",
      text: "text-amber-800",
      bar: "bg-amber-500",
    },
    orange: {
      card: "border-orange-200 bg-orange-50",
      text: "text-orange-800",
      bar: "bg-orange-500",
    },
    red: {
      card: "border-red-200 bg-red-50",
      text: "text-red-800",
      bar: "bg-red-600",
    },
  };
  const selectedTone = toneMap[tone];

  return (
    <div className={["rounded-lg border p-4", selectedTone.card].join(" ")}>
      <p className={["text-[10px] font-bold uppercase", selectedTone.text].join(" ")}>
        {title}
      </p>
      <p className="mt-1 text-xs text-[#667085]">{subtitle}</p>
      <p className="mt-3 text-2xl font-black text-[#101828]">{clients}</p>
      <p className="mt-1 text-sm font-semibold text-[#475467]">{money(value)}</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white">
        <div
          className={["h-full rounded-full", selectedTone.bar].join(" ")}
          style={{ width: `${Math.min(100, Math.max(0, percentValue))}%` }}
        />
      </div>
      <p className="mt-2 text-xs font-semibold text-[#667085]">{percent(percentValue)} del saldo</p>
    </div>
  );
}
