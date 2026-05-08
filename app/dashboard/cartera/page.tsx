import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";

export const metadata = {
  title: "Cartera | FINSER PAY",
  description: "Salud de cartera, mora y recuperacion de creditos",
};

type RiskBucket = "alDia" | "temprana" | "mayor" | "avanzada" | "pagado";

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

export default async function CarteraPage() {
  await requireAdminDashboardAccess();

  const today = new Date();
  const creditos = await prisma.credito.findMany({
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
  });

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
        clienteNombre: credito.clienteNombre,
        clienteDocumento: credito.clienteDocumento || "",
        referencia:
          credito.referenciaEquipo ||
          [credito.equipoMarca, credito.equipoModelo].filter(Boolean).join(" ") ||
          "Equipo",
        sede: credito.sede.nombre,
        vendedor: credito.vendedor?.nombre || "Sin vendedor",
        cuotaInicial: Number(credito.cuotaInicial || 0),
        creditoAutorizado,
        montoCredito: Number(credito.montoCredito || 0),
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
  const totalCapitalAutorizado = cartera.reduce((sum, item) => sum + item.creditoAutorizado, 0);
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
    .sort((a, b) => b.diasMora - a.diasMora || b.saldoPendiente - a.saldoPendiente)
    .slice(0, 12);

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8 text-[#20242a]">
      <main className="mx-auto max-w-7xl">
        <header className="overflow-hidden rounded-[34px] border border-[#d7dce2] bg-white px-6 py-6 shadow-[0_20px_60px_rgba(17,19,24,0.08)]">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#cce7df] bg-[#eff8f5] px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                Admin cartera
              </div>
              <h1 className="mt-4 text-4xl font-black tracking-tight text-[#20242a] md:text-5xl">
                Salud de cartera
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687080]">
                Lectura global de creditos activos, pagos, mora por edades y recuperacion.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <a
                href="/api/dashboard/cartera/export"
                className="rounded-2xl border border-[#b9e5d3] bg-[#ecfdf5] px-5 py-3 text-sm font-black text-[#0f766e] transition hover:-translate-y-0.5"
              >
                Descargar Excel
              </a>
              <Link
                href="/dashboard/reportes/creditos"
                className="rounded-2xl border border-[#d7dce2] bg-white px-5 py-3 text-sm font-black text-[#20242a] transition hover:-translate-y-0.5"
              >
                Ver creditos
              </Link>
              <Link
                href="/dashboard"
                className="rounded-2xl border border-[#111318] bg-[#111318] px-5 py-3 text-sm font-black text-white transition hover:-translate-y-0.5"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Creditos activos" value={String(activeCredits.length)} detail={`${paidCredits.length} creditos pagos`} />
          <MetricCard label="Clientes en mora" value={String(clientsMora)} detail={`${clientsTemprana} temprana, ${clientsMayor} mayor, ${clientsAvanzada} avanzada`} />
          <MetricCard label="Cartera por cobrar" value={money(totalPendiente)} detail={`${percent(pctSana)} cartera sana`} />
          <MetricCard label="Cartera en mora" value={money(totalMora)} detail={`${percent(pctMora)} del saldo pendiente`} warning={pctMora > 18} />
        </section>

        <section className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className={["rounded-[30px] border p-6 shadow-[0_18px_48px_rgba(17,19,24,0.06)]", health.tone].join(" ")}>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] opacity-75">
              Diagnostico
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-tight">{health.label}</h2>
            <p className="mt-3 text-sm leading-6 opacity-80">{health.detail}</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <MiniMetric label="Recuperado" value={percent(pctRecuperado)} />
              <MiniMetric label="Creditos pagos" value={percent(pctPagados)} />
              <MiniMetric label="Capital autorizado" value={money(totalCapitalAutorizado)} />
              <MiniMetric label="Recaudo total" value={money(totalPagado)} />
            </div>
          </div>

          <div className="rounded-[30px] border border-[#d7dce2] bg-white p-6 shadow-[0_18px_48px_rgba(17,19,24,0.06)]">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
              Mora por edades
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <BucketCard
                title="Temprana"
                subtitle="1 a 15 dias"
                clients={clientsTemprana}
                value={bucketValues.temprana}
                percentValue={ratio(bucketValues.temprana, totalPendiente)}
              />
              <BucketCard
                title="Mayor"
                subtitle="16 a 30 dias"
                clients={clientsMayor}
                value={bucketValues.mayor}
                percentValue={ratio(bucketValues.mayor, totalPendiente)}
              />
              <BucketCard
                title="Avanzada"
                subtitle="Mas de 30 dias"
                clients={clientsAvanzada}
                value={bucketValues.avanzada}
                percentValue={ratio(bucketValues.avanzada, totalPendiente)}
              />
            </div>
          </div>
        </section>

        <section className="mt-5 overflow-hidden rounded-[30px] border border-[#d7dce2] bg-white shadow-[0_18px_48px_rgba(17,19,24,0.06)]">
          <div className="flex flex-col gap-2 border-b border-[#d7dce2] px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#6d5a22]">
                Riesgos prioritarios
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-[#20242a]">
                Clientes que requieren gestion
              </h2>
            </div>
            <p className="text-sm font-semibold text-[#687080]">
              {riskRows.length ? `${riskRows.length} casos visibles` : "Sin mora registrada"}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#111318] text-white">
                <tr>
                  <th className="px-5 py-4 font-black">Cliente</th>
                  <th className="px-5 py-4 font-black">Folio</th>
                  <th className="px-5 py-4 font-black">Referencia</th>
                  <th className="px-5 py-4 font-black">Sede</th>
                  <th className="px-5 py-4 font-black">Mora</th>
                  <th className="px-5 py-4 font-black">Saldo</th>
                  <th className="px-5 py-4 font-black">Proxima cuota</th>
                </tr>
              </thead>
              <tbody>
                {riskRows.length ? (
                  riskRows.map((item) => (
                    <tr key={item.id} className="border-b border-[#e5eaf0] last:border-0">
                      <td className="px-5 py-4">
                        <p className="font-black text-[#20242a]">{item.clienteNombre}</p>
                        <p className="text-xs text-[#687080]">{item.clienteDocumento || "Sin documento"}</p>
                      </td>
                      <td className="px-5 py-4 font-semibold text-[#20242a]">{item.folio}</td>
                      <td className="px-5 py-4 text-[#687080]">{item.referencia}</td>
                      <td className="px-5 py-4 text-[#687080]">{item.sede}</td>
                      <td className="px-5 py-4">
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-black text-amber-800">
                          {riskLabels[item.bucket]} - {item.diasMora} dias
                        </span>
                      </td>
                      <td className="px-5 py-4 font-black text-[#20242a]">{money(item.saldoPendiente)}</td>
                      <td className="px-5 py-4 text-[#687080]">
                        {item.nextDueDate ? `${item.nextDueDate} · ${money(item.nextDueValue)}` : "Sin cuota"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm font-semibold text-[#687080]">
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

function MetricCard({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-[28px] border bg-white p-5 shadow-[0_14px_34px_rgba(17,19,24,0.06)]",
        warning ? "border-red-200" : "border-[#d7dce2]",
      ].join(" ")}
    >
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#687080]">
        {label}
      </p>
      <p className="mt-4 text-3xl font-black tracking-tight text-[#20242a]">{value}</p>
      <p className="mt-2 text-sm font-semibold text-[#687080]">{detail}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] bg-white/70 px-4 py-4">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">{label}</p>
      <p className="mt-2 text-xl font-black">{value}</p>
    </div>
  );
}

function BucketCard({
  title,
  subtitle,
  clients,
  value,
  percentValue,
}: {
  title: string;
  subtitle: string;
  clients: number;
  value: number;
  percentValue: number;
}) {
  return (
    <div className="rounded-[24px] border border-[#d7dce2] bg-[#fbf8ef] p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#6d5a22]">
        {title}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#687080]">{subtitle}</p>
      <p className="mt-4 text-3xl font-black text-[#20242a]">{clients}</p>
      <p className="mt-2 text-sm font-semibold text-[#687080]">{money(value)}</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
        <div
          className="h-full rounded-full bg-[#0f766e]"
          style={{ width: `${Math.min(100, Math.max(0, percentValue))}%` }}
        />
      </div>
      <p className="mt-2 text-xs font-bold text-[#687080]">{percent(percentValue)} del saldo</p>
    </div>
  );
}
