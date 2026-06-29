import Link from "next/link";
import prisma from "@/lib/prisma";
import FinserBrand from "@/app/_components/finser-brand";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import PushMassivePanel from "./push-massive-panel";

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

export default async function CarteraPage() {
  await requireCentralAdminDashboardAccess();

  const today = new Date();
  const [creditos, gastosOperacion] = await Promise.all([
    prisma.credito.findMany({
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
    }),
    prisma.gastoCartera.findMany({
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
  const bolsaRespaldoMora = totalInvertido * 0.1;
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
    .sort((a, b) => b.diasMora - a.diasMora || b.saldoPendiente - a.saldoPendiente)
    .slice(0, 12);
  const lastUpdatedLabel = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(today);

  return (
    <div className="fp-dashboard-app min-h-screen text-[#20242a]">
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <header className="flex flex-col gap-4 rounded-[34px] border border-[#d7dce2] bg-white/92 p-4 shadow-[0_18px_48px_rgba(17,19,24,0.08)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <FinserBrand compact />
            <div className="hidden h-10 w-px bg-[#d7dce2] sm:block" />
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                Panel central
              </p>
              <p className="mt-1 text-sm font-bold text-[#687080]">
                Cartera actualizada {lastUpdatedLabel}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 sm:justify-end">
            <ActionLink href="/api/dashboard/cartera/export" label="Excel" primary />
            <ActionLink href="/dashboard/reportes/creditos" label="Creditos" />
            <ActionLink href="/dashboard" label="Dashboard" dark />
          </div>
        </header>

        <section className="mt-5 rounded-[28px] border border-[#d7dce2] bg-white p-5 shadow-[0_16px_42px_rgba(17,19,24,0.07)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                Control de cartera
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-[#20242a]">
                Cartera
              </h1>
            </div>

            <div className="flex flex-wrap gap-2 lg:justify-end">
              <span className="rounded-full border border-[#d7dce2] bg-[#f8fafc] px-3 py-1 text-xs font-black text-[#687080]">
                {activeCredits.length} activos
              </span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-black text-amber-800">
                {clientsMora} clientes en mora
              </span>
              <span className={["rounded-full border px-3 py-1 text-xs font-black uppercase tracking-[0.12em]", health.tone].join(" ")}>
                {health.label}
              </span>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Inversion activa" value={money(totalInvertido)} detail="Credito autorizado activo" tone="slate" />
            <MetricCard label="Saldo por cobrar" value={money(totalPendiente)} detail={`${percent(pctSana)} cartera sana`} tone="green" />
            <MetricCard
              label="Ganancia estimada"
              value={money(totalGanancias)}
              detail={`${money(totalGastosOperacion)} en gastos`}
              warning={totalGanancias < 0}
              tone="gold"
            />
            <MetricCard
              label="Cartera en mora"
              value={money(totalMora)}
              detail={`${percent(pctMora)} del saldo pendiente`}
              warning={pctMora > 18}
              tone="red"
            />
          </div>

          <div className="mt-4 grid gap-3 border-t border-[#d7dce2] pt-4 sm:grid-cols-2 xl:grid-cols-4">
            <MiniMetric label="Respaldo" value={money(bolsaRespaldoMora)} detail="10% de inversion" />
            <MiniMetric label="Recuperado" value={percent(pctRecuperado)} detail={money(totalPagado)} />
            <MiniMetric label="Creditos pagos" value={percent(pctPagados)} detail={`${paidCredits.length} cerrados`} />
            <MiniMetric label="Sin mora" value={money(totalSano)} detail="Saldo al dia" />
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[28px] border border-[#d7dce2] bg-white p-5 shadow-[0_14px_36px_rgba(17,19,24,0.06)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                  Mora por edades
                </p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-[#20242a]">
                  Riesgo por dias
                </h2>
              </div>
              <span className="rounded-full border border-[#d7dce2] bg-[#f8fafc] px-3 py-1 text-xs font-black text-[#687080]">
                {percent(pctMora)} mora
              </span>
            </div>

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
          </div>

          <PushMassivePanel />
        </section>

        <section className="mt-5 overflow-hidden rounded-[34px] border border-[#d7dce2] bg-white shadow-[0_18px_48px_rgba(17,19,24,0.07)]">
          <div className="flex flex-col gap-3 border-b border-[#d7dce2] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                Riesgos prioritarios
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-[#20242a]">
                Clientes que requieren gestion
              </h2>
            </div>
            <span className="rounded-full border border-[#d7dce2] bg-[#f8fafc] px-4 py-2 text-sm font-black text-[#687080]">
              {riskRows.length ? `${riskRows.length} casos visibles` : "Sin mora registrada"}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1080px] text-left text-sm">
              <thead className="bg-[#20242a] text-white">
                <tr>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Cliente</th>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Equipo</th>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Sede</th>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Mora</th>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Saldo</th>
                  <th className="px-5 py-4 text-[11px] font-black uppercase tracking-[0.16em]">Proxima cuota</th>
                </tr>
              </thead>
              <tbody>
                {riskRows.length ? (
                  riskRows.map((item) => (
                    <tr key={item.id} className="border-b border-[#e5eaf0] last:border-0">
                      <td className="px-5 py-4 align-top">
                        <p className="font-black text-[#20242a]">{item.clienteNombre}</p>
                        <p className="mt-1 text-xs text-[#687080]">{item.clienteDocumento || "Sin documento"}</p>
                        <p className="mt-1 text-xs font-semibold text-[#0f766e]">
                          {item.clienteTelefono || "Sin celular"}
                        </p>
                        <p className="mt-1 text-xs text-[#687080]">
                          Ref. 1: {item.primeraReferenciaTelefono || "Sin referencia"}
                        </p>
                      </td>
                      <td className="px-5 py-4 align-top">
                        <p className="font-semibold text-[#20242a]">{item.imei}</p>
                        <p className="mt-1 max-w-[240px] text-xs leading-5 text-[#687080]">{item.referencia}</p>
                      </td>
                      <td className="px-5 py-4 align-top text-[#687080]">{item.sede}</td>
                      <td className="px-5 py-4 align-top">
                        <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-black text-amber-800">
                          {riskLabels[item.bucket]} - {item.diasMora} dias
                        </span>
                      </td>
                      <td className="px-5 py-4 align-top font-black text-[#20242a]">{money(item.saldoPendiente)}</td>
                      <td className="px-5 py-4 align-top text-[#687080]">
                        {item.nextDueDate ? `${item.nextDueDate} - ${money(item.nextDueValue)}` : "Sin cuota"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-sm font-semibold text-[#687080]">
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

function HeroMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#64717b]">
        {label}
      </p>
      <p
        className={[
          "mt-2 text-2xl font-black tracking-tight",
          danger ? "text-red-700" : "text-[#11161a]",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}

function ActionLink({
  href,
  label,
  primary = false,
  dark = false,
}: {
  href: string;
  label: string;
  primary?: boolean;
  dark?: boolean;
}) {
  const classes = dark
    ? "border-[#20242a] bg-[#20242a] text-white hover:bg-[#111318]"
    : primary
      ? "border-[#0f766e] bg-[#0f766e] text-white hover:bg-[#145a5a]"
      : "border-[#d8e0e3] bg-white text-[#20242a] hover:bg-[#f8fafc]";
  const className = [
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-black transition hover:-translate-y-0.5",
    classes,
  ].join(" ");

  if (href.startsWith("/api/")) {
    return (
      <a href={href} className={className}>
        <span>{label}</span>
        <span aria-hidden="true">{">"}</span>
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      <span>{label}</span>
      <span aria-hidden="true">{">"}</span>
    </Link>
  );
}

function MetricCard({
  label,
  value,
  detail,
  warning = false,
  tone = "slate",
}: {
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
  tone?: "gold" | "green" | "red" | "slate";
}) {
  const toneMap = {
    gold: "border-[#d9c691] bg-[#fbf8ef]",
    green: "border-[#cce7df] bg-[#eff8f5]",
    red: "border-rose-200 bg-rose-50",
    slate: "border-[#d7dce2] bg-white",
  };

  return (
    <div
      className={[
        "relative overflow-hidden rounded-[22px] border p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)]",
        warning ? "border-red-200 bg-red-50" : toneMap[tone],
      ].join(" ")}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#687080]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-tight text-[#20242a]">{value}</p>
      <p className="mt-2 text-sm font-semibold text-[#687080]">{detail}</p>
    </div>
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
    <div className="rounded-[18px] border border-[#d7dce2] bg-[#f8fafc] px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#687080]">{label}</p>
      <div className="text-right">
        <p className="mt-1 text-xl font-black text-[#20242a]">{value}</p>
        <p className="mt-1 text-xs font-semibold text-[#687080]">{detail}</p>
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
    <div className={["rounded-[24px] border p-4", selectedTone.card].join(" ")}>
      <p className={["text-[10px] font-black uppercase tracking-[0.22em]", selectedTone.text].join(" ")}>
        {title}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#687080]">{subtitle}</p>
      <p className="mt-4 text-3xl font-black text-[#20242a]">{clients}</p>
      <p className="mt-2 text-sm font-semibold text-[#687080]">{money(value)}</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
        <div
          className={["h-full rounded-full", selectedTone.bar].join(" ")}
          style={{ width: `${Math.min(100, Math.max(0, percentValue))}%` }}
        />
      </div>
      <p className="mt-2 text-xs font-bold text-[#687080]">{percent(percentValue)} del saldo</p>
    </div>
  );
}
