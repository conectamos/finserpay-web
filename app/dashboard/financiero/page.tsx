"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import FinancialPasswordSettings from "./_components/financial-password-settings";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Resumen = {
  cajaGeneralVentas: number;
  saldoCaja: number;
  cajaDisponible: number;
  transferenciasVentas: number;
  abonosTransferencia: number;
  saldoTransferencias: number;
  prestamosPorCobrar: number;
  deudaEquipos: number;
  financieras: Record<string, number>;
  valorPendiente: number;
  valorGarantia: number;
  valorBodega: number;
  totalGastosCartera: number;
};

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type Sede = {
  id: number;
  nombre: string;
};

type Tone = "neutral" | "positive" | "negative" | "accent";

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function formatTimeLabel(date: Date) {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function toneClasses(tone: Tone) {
  switch (tone) {
    case "positive":
      return {
        card: "border-emerald-200 bg-emerald-50/80",
        value: "text-emerald-700",
        detail: "text-emerald-600",
      };
    case "negative":
      return {
        card: "border-red-200 bg-red-50/80",
        value: "text-red-700",
        detail: "text-red-600",
      };
    case "accent":
      return {
        card: "border-[#d7c3a0] bg-[#fff9ef]",
        value: "text-[#8f5b24]",
        detail: "text-[#8f5b24]",
      };
    default:
      return {
        card: "border-slate-200 bg-white",
        value: "text-slate-950",
        detail: "text-slate-500",
      };
  }
}

function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: Tone;
}) {
  const styles = toneClasses(tone);

  return (
    <div
      className={[
        "min-w-0 rounded-[26px] border px-5 py-5 shadow-sm transition",
        styles.card,
      ].join(" ")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p
        className={[
          "mt-4 overflow-hidden text-[clamp(1.75rem,1.6vw,2.5rem)] font-black leading-[1.05] tracking-tight tabular-nums",
          styles.value,
        ].join(" ")}
      >
        {formatoPesos(value)}
      </p>
      <p className={["mt-3 text-sm leading-6", styles.detail].join(" ")}>
        {detail}
      </p>
    </div>
  );
}

function SectionHeader({
  badge,
  title,
  description,
}: {
  badge: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
        {badge}
      </div>
      <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
    </div>
  );
}

function ActionLink({
  href,
  label,
  primary = false,
}: {
  href: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        "inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold transition",
        primary
          ? "bg-slate-950 text-white hover:bg-slate-800"
          : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

export default function PanelFinancieroPage() {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [error, setError] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeFiltroId, setSedeFiltroId] = useState("TODAS");
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date | null>(
    null
  );

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const cargarContexto = async () => {
    try {
      const sessionRes = await fetch("/api/session", { cache: "no-store" });
      const sessionData = await sessionRes.json();

      if (!sessionRes.ok) {
        return;
      }

      setUser(sessionData);

      if (String(sessionData?.rolNombre || "").toUpperCase() === "ADMIN") {
        const sedesRes = await fetch("/api/sedes", { cache: "no-store" });
        const sedesData = await sedesRes.json();

        if (sedesRes.ok) {
          setSedes(Array.isArray(sedesData) ? sedesData : []);
        }
      } else {
        setSedes([]);
        setSedeFiltroId("TODAS");
      }
    } catch {}
  };

  const cargarResumen = async () => {
    try {
      setError("");

      const params = new URLSearchParams();

      if (esAdmin && sedeFiltroId !== "TODAS") {
        params.set("sedeId", sedeFiltroId);
      }

      const endpoint = params.size
        ? `/api/financiero?${params.toString()}`
        : "/api/financiero";

      const res = await fetch(endpoint, {
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Error cargando panel financiero");
        return;
      }

      setResumen(data.resumen);
      setUltimaActualizacion(new Date());
    } catch {
      setError("Error interno cargando panel financiero");
    }
  };

  useEffect(() => {
    const init = async () => {
      await cargarContexto();
    };

    void init();
  }, []);

  useLiveRefresh(
    async () => {
      if (!user) {
        return;
      }

      await cargarResumen();
    },
    {
      enabled: Boolean(user),
      intervalMs: 10000,
      runOnMount: true,
    }
  );

  const totalFinancieras = Object.values(resumen?.financieras || {}).reduce(
    (acc, value) => acc + Number(value || 0),
    0
  );

  const activos =
    Number(resumen?.cajaDisponible || 0) +
    Number(resumen?.saldoTransferencias || 0) +
    Number(resumen?.prestamosPorCobrar || 0) +
    Number(resumen?.valorBodega || 0) +
    Number(totalFinancieras || 0);

  const pasivos =
    Number(resumen?.deudaEquipos || 0) +
    Number(resumen?.valorPendiente || 0) +
    Number(resumen?.valorGarantia || 0) +
    Number(resumen?.totalGastosCartera || 0);

  const resumenGeneral = activos - pasivos;

  const coberturaActual =
    !esAdmin || sedeFiltroId === "TODAS"
      ? esAdmin
        ? "Todas las sedes"
        : user?.sedeNombre || "Tu sede"
      : sedes.find((sede) => String(sede.id) === sedeFiltroId)?.nombre ||
        "Sede filtrada";

  const financierasOrdenadas = useMemo(() => {
    return Object.entries(resumen?.financieras || {})
      .map(([nombre, valor]) => ({
        nombre,
        valor: Number(valor || 0),
      }))
      .sort((a, b) => b.valor - a.valor);
  }, [resumen?.financieras]);

  const valorMaximoFinanciera =
    financierasOrdenadas.length > 0 ? financierasOrdenadas[0].valor : 0;

  const alertas = useMemo(() => {
    const items: Array<{
      title: string;
      detail: string;
      tone: Tone;
    }> = [];

    if (resumenGeneral < 0) {
      items.push({
        title: "Resultado neto en rojo",
        detail: `Los pasivos superan a los activos por ${formatoPesos(
          Math.abs(resumenGeneral)
        )}.`,
        tone: "negative",
      });
    }

    if (Number(resumen?.cajaDisponible || 0) < 0) {
      items.push({
        title: "Caja disponible negativa",
        detail: `La caja disponible esta en ${formatoPesos(
          Number(resumen?.cajaDisponible || 0)
        )}.`,
        tone: "negative",
      });
    }

    if (Number(resumen?.valorPendiente || 0) > 0) {
      items.push({
        title: "Equipos pendientes",
        detail: `Tienes ${formatoPesos(
          Number(resumen?.valorPendiente || 0)
        )} comprometidos en estado pendiente.`,
        tone: "accent",
      });
    }

    if (Number(resumen?.valorGarantia || 0) > 0) {
      items.push({
        title: "Garantias abiertas",
        detail: `Hay ${formatoPesos(
          Number(resumen?.valorGarantia || 0)
        )} inmovilizados por garantia.`,
        tone: "accent",
      });
    }

    if (
      Number(resumen?.totalGastosCartera || 0) > 0 &&
      Number(resumen?.totalGastosCartera || 0) >=
        Number(resumen?.deudaEquipos || 0)
    ) {
      items.push({
        title: "Cartera con peso alto",
        detail: `El gasto de cartera alcanza ${formatoPesos(
          Number(resumen?.totalGastosCartera || 0)
        )}.`,
        tone: "negative",
      });
    }

    if (items.length === 0) {
      items.push({
        title: "Operacion estable",
        detail:
          "No hay alertas financieras criticas con los datos visibles en este corte.",
        tone: "positive",
      });
    }

    return items.slice(0, 4);
  }, [resumen, resumenGeneral]);

  const estadoResumen =
    resumenGeneral >= 0 ? "Balance saludable" : "Balance bajo presion";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#eef2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <section className="relative overflow-hidden rounded-[36px] border border-[#2b2f36] bg-[linear-gradient(135deg,#0d0f13_0%,#171a21_52%,#3b1118_100%)] px-6 py-7 text-white shadow-[0_28px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(199,154,87,0.24),transparent_28%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.08),transparent_20%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#f1d19c]">
                Panel financiero
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Centro financiero
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Lectura ejecutiva de liquidez, riesgo operativo, cartera y
                financieras con una vista mas clara para la toma de decisiones.
              </p>

              <div className="mt-6 flex flex-wrap gap-3 text-sm text-slate-200">
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Cobertura: {coberturaActual}
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Estado: {estadoResumen}
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Actualizado:{" "}
                  {ultimaActualizacion
                    ? formatTimeLabel(ultimaActualizacion)
                    : "Cargando..."}
                </div>
              </div>
            </div>

            <div className="rounded-[30px] border border-white/10 bg-white/8 p-5 backdrop-blur">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                Resultado neto
              </p>
              <p
                className={[
                  "mt-3 text-5xl font-black tracking-tight",
                  resumenGeneral >= 0 ? "text-emerald-300" : "text-rose-300",
                ].join(" ")}
              >
                {formatoPesos(resumenGeneral)}
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-emerald-200/20 bg-emerald-400/10 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-100">
                    Activos
                  </p>
                  <p className="mt-2 text-2xl font-black text-white">
                    {formatoPesos(activos)}
                  </p>
                </div>

                <div className="rounded-2xl border border-rose-200/20 bg-rose-400/10 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-100">
                    Pasivos
                  </p>
                  <p className="mt-2 text-2xl font-black text-white">
                    {formatoPesos(pasivos)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf7f1_100%)] p-5 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <SectionHeader
              badge="Acciones y control"
              title="Operacion financiera"
              description="Accede rapido a los movimientos financieros clave y controla la cobertura del panel."
            />

            <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
              {esAdmin && (
                <label className="flex min-w-[240px] flex-col gap-2 text-sm font-semibold text-slate-700">
                  Cobertura financiera
                  <select
                    value={sedeFiltroId}
                    onChange={(event) => setSedeFiltroId(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="TODAS">Todas las sedes</option>
                    {sedes.map((sede) => (
                      <option key={sede.id} value={String(sede.id)}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="flex flex-wrap gap-3">
                <FinancialPasswordSettings />
                <ActionLink
                  href="/dashboard/financiero/abonos"
                  label="Registrar abono"
                  primary
                />
                <ActionLink
                  href="/dashboard/financiero/cartera"
                  label="Registrar cartera"
                  primary
                />
                <ActionLink
                  href="/dashboard/financiero/abonos/detalle"
                  label="Detalle abonos"
                />
                <ActionLink
                  href="/dashboard/financiero/cartera/detalle"
                  label="Detalle cartera"
                />
                <ActionLink href="/dashboard" label="Volver" />
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {!resumen ? (
          <div className="rounded-[30px] border border-slate-200 bg-white px-6 py-12 text-center text-slate-500 shadow-sm">
            Cargando panel financiero...
          </div>
        ) : (
          <>
            <div className="grid gap-6 xl:grid-cols-[1.45fr_0.95fr]">
              <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
                <SectionHeader
                  badge="Liquidez"
                  title="Lectura operativa"
                  description="Dinero disponible, flujos de transferencia y respaldo financiero inmediato."
                />

                <div className="mt-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                  <MetricCard
                    label="Caja disponible"
                    value={resumen.cajaDisponible}
                    detail="Ventas mas movimientos de caja."
                    tone={resumen.cajaDisponible >= 0 ? "positive" : "negative"}
                  />
                  <MetricCard
                    label="Transferencias saldo"
                    value={resumen.saldoTransferencias}
                    detail="Transferencias menos abonos registrados."
                    tone={resumen.saldoTransferencias >= 0 ? "accent" : "negative"}
                  />
                  <MetricCard
                    label="Financieras saldo"
                    value={totalFinancieras}
                    detail="Pendiente por recaudar en financieras."
                    tone="accent"
                  />
                  <MetricCard
                    label="Prestamos por cobrar"
                    value={resumen.prestamosPorCobrar}
                    detail="Prestamos activos salientes pendientes por cierre o pago."
                    tone={resumen.prestamosPorCobrar > 0 ? "accent" : "neutral"}
                  />
                </div>
              </section>

              <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
                <SectionHeader
                  badge="Alertas"
                  title="Lectura ejecutiva"
                  description="Señales rapidas para priorizar decisiones sin revisar todo el detalle."
                />

                <div className="mt-6 space-y-3">
                  {alertas.map((alerta, index) => {
                    const styles = toneClasses(alerta.tone);

                    return (
                      <div
                        key={`${alerta.title}-${index}`}
                        className={[
                          "rounded-2xl border px-4 py-4",
                          styles.card,
                        ].join(" ")}
                      >
                        <p className={["text-sm font-bold", styles.value].join(" ")}>
                          {alerta.title}
                        </p>
                        <p className={["mt-1 text-sm", styles.detail].join(" ")}>
                          {alerta.detail}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
              <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
                <SectionHeader
                  badge="Riesgo y cartera"
                  title="Compromisos abiertos"
                  description="Pasivos operativos que presionan caja o amarran inventario."
                />

                <div className="mt-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                  <MetricCard
                    label="Gasto cartera"
                    value={resumen.totalGastosCartera}
                    detail="Salidas registradas en cartera."
                    tone="negative"
                  />
                  <MetricCard
                    label="Deuda equipos"
                    value={resumen.deudaEquipos}
                    detail="Equipos con deuda financiera activa."
                    tone="negative"
                  />
                  <MetricCard
                    label="Pendiente"
                    value={resumen.valorPendiente}
                    detail="Inventario inmovilizado por pendiente."
                    tone="accent"
                  />
                  <MetricCard
                    label="Garantia"
                    value={resumen.valorGarantia}
                    detail="Valor comprometido en garantias."
                    tone={resumen.valorGarantia > 0 ? "accent" : "neutral"}
                  />
                </div>
              </section>

              <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
                <SectionHeader
                  badge="Inventario"
                  title="Respaldo operativo"
                  description="Valor del inventario disponible para soportar la operacion."
                />

                <div className="mt-6">
                  <div className="rounded-[28px] border border-[#d7c3a0] bg-[linear-gradient(135deg,#fffdf8_0%,#f8f2e8_100%)] p-6 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Equipos en bodega
                    </p>
                    <p className="mt-3 text-4xl font-black text-[#8f5b24]">
                      {formatoPesos(resumen.valorBodega)}
                    </p>
                    <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
                      Este valor funciona como respaldo inmediato del panel, al
                      concentrar el inventario disponible para venta o rotacion.
                    </p>
                  </div>
                </div>
              </section>
            </div>

            <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <SectionHeader
                  badge="Financieras"
                  title="Ranking de saldos"
                  description="Comparativo visual de las financieras con mayor peso en el corte actual."
                />

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  Total saldo financieras:{" "}
                  <span className="font-bold text-slate-950">
                    {formatoPesos(totalFinancieras)}
                  </span>
                </div>
              </div>

              {financierasOrdenadas.length === 0 ? (
                <p className="mt-6 text-sm text-slate-500">
                  No hay financieras registradas para esta vista.
                </p>
              ) : (
                <div className="mt-6 grid gap-4 xl:grid-cols-2">
                  {financierasOrdenadas.map((item) => {
                    const width =
                      valorMaximoFinanciera > 0
                        ? Math.max(8, (item.valor / valorMaximoFinanciera) * 100)
                        : 0;

                    return (
                      <div
                        key={item.nombre}
                        className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              {item.nombre}
                            </p>
                            <p className="mt-2 text-xl font-black text-slate-950">
                              {formatoPesos(item.valor)}
                            </p>
                          </div>

                          <div className="text-right text-sm text-slate-500">
                            {totalFinancieras > 0
                              ? `${((item.valor / totalFinancieras) * 100).toFixed(1)}%`
                              : "0.0%"}
                          </div>
                        </div>

                        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className="h-full rounded-full bg-[linear-gradient(90deg,#111827_0%,#c79a57_100%)]"
                            style={{ width: `${width}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
