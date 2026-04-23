"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type CajaMovimiento = {
  id: number;
  tipo: string;
  concepto: string;
  valor: number;
  descripcion: string | null;
  sedeId: number;
  createdAt: string;
  sede?: {
    nombre: string;
  };
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

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function formatoFecha(valor: string) {
  return new Date(valor).toLocaleString("es-CO");
}

function tipoBadgeClass(tipo: string) {
  return String(tipo || "").toUpperCase() === "INGRESO"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-red-200 bg-red-50 text-red-700";
}

function metricToneClass(tone: "emerald" | "red" | "slate" | "amber") {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-[linear-gradient(180deg,#ffffff_0%,#f2fbf6_100%)]";
    case "red":
      return "border-red-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff4f4_100%)]";
    case "amber":
      return "border-amber-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff8eb_100%)]";
    default:
      return "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]";
  }
}

export default function CajaPage() {
  const [movimientos, setMovimientos] = useState<CajaMovimiento[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeFiltroId, setSedeFiltroId] = useState("TODAS");

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const cargarUsuario = async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setUser(data);
      }
    } catch {}
  };

  const cargarSedes = async () => {
    try {
      const res = await fetch("/api/sedes", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setSedes(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  const cargarCaja = async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && sedeFiltroId !== "TODAS") {
        params.set("sedeId", sedeFiltroId);
      }

      const endpoint = params.size
        ? `/api/caja?${params.toString()}`
        : "/api/caja";

      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();
      setMovimientos(Array.isArray(data) ? data : []);
    } catch {
      setMensaje("Error cargando caja");
    }
  };

  useEffect(() => {
    const init = async () => {
      await cargarUsuario();
      await cargarSedes();
    };

    void init();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) {
      return;
    }

    const timer = window.setTimeout(() => {
      void cargarCaja();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [user, sedeFiltroId]);

  useLiveRefresh(cargarCaja, { intervalMs: 10000 });

  const sedeFiltroNombre = useMemo(() => {
    if (!esAdmin) {
      return user?.sedeNombre || "tu sede";
    }

    if (sedeFiltroId === "TODAS") {
      return "todas las sedes";
    }

    return (
      sedes.find((sede) => String(sede.id) === sedeFiltroId)?.nombre ||
      "la sede seleccionada"
    );
  }, [esAdmin, sedeFiltroId, sedes, user?.sedeNombre]);

  const totalIngresos = useMemo(
    () =>
      movimientos
        .filter((movimiento) => movimiento.tipo === "INGRESO")
        .reduce((acc, movimiento) => acc + Number(movimiento.valor || 0), 0),
    [movimientos]
  );

  const totalEgresos = useMemo(
    () =>
      movimientos
        .filter((movimiento) => movimiento.tipo === "EGRESO")
        .reduce((acc, movimiento) => acc + Number(movimiento.valor || 0), 0),
    [movimientos]
  );

  const saldo = totalIngresos - totalEgresos;
  const ultimoMovimiento = movimientos[0] ?? null;
  const totalMovimientos = movimientos.length;

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#eef2f7_28%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1680px]">
        <section className="relative overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_48%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_26%),radial-gradient(circle_at_bottom_left,rgba(251,191,36,0.18),transparent_24%)]" />

          <div className="relative flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Caja / Gestion
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                {esAdmin ? "Caja consolidada" : "Caja por sede"}
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                {esAdmin
                  ? sedeFiltroId === "TODAS"
                    ? "Control consolidado del flujo de dinero en todas las sedes, con lectura inmediata de ingresos, egresos y saldo operativo."
                    : `Control financiero filtrado de ${sedeFiltroNombre}, con lectura inmediata del flujo de caja.`
                  : `Vista operativa de ${user?.sedeNombre || "tu sede"}, con seguimiento claro de ingresos, egresos y saldo disponible.`}
              </p>

              <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-200">
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Cobertura:{" "}
                  <span className="font-semibold text-white">
                    {esAdmin
                      ? sedeFiltroId === "TODAS"
                        ? "Todas las sedes"
                        : sedeFiltroNombre
                      : user?.sedeNombre || "Sede actual"}
                  </span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Movimientos:{" "}
                  <span className="font-semibold text-white">{totalMovimientos}</span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Ultimo registro:{" "}
                  <span className="font-semibold text-white">
                    {ultimoMovimiento
                      ? formatoFecha(ultimoMovimiento.createdAt)
                      : "Sin movimientos"}
                  </span>
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
              {esAdmin && (
                <label className="flex min-w-[260px] flex-col gap-2 text-sm font-semibold text-white">
                  Cobertura
                  <select
                    value={sedeFiltroId}
                    onChange={(event) => setSedeFiltroId(event.target.value)}
                    className="rounded-2xl border border-white/15 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-white focus:ring-2 focus:ring-white/30"
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

              <Link
                href="/caja/arqueo"
                className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Arqueo
              </Link>

              <Link
                href="/dashboard"
                className="rounded-2xl border border-white/10 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
              >
                ← Volver
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div
            className={`rounded-[30px] border px-5 py-5 shadow-sm ${metricToneClass("emerald")}`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Ingresos
            </p>
            <p className="mt-3 text-3xl font-black text-emerald-600">
              {formatoPesos(totalIngresos)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Entradas registradas en caja.
            </p>
          </div>

          <div
            className={`rounded-[30px] border px-5 py-5 shadow-sm ${metricToneClass("red")}`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Egresos
            </p>
            <p className="mt-3 text-3xl font-black text-red-600">
              {formatoPesos(totalEgresos)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Salidas operativas acumuladas.
            </p>
          </div>

          <div
            className={`rounded-[30px] border px-5 py-5 shadow-sm ${
              saldo >= 0 ? metricToneClass("slate") : metricToneClass("amber")
            }`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Saldo
            </p>
            <p
              className={[
                "mt-3 text-3xl font-black",
                saldo >= 0 ? "text-slate-950" : "text-amber-700",
              ].join(" ")}
            >
              {formatoPesos(saldo)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Balance neto de la vista actual.
            </p>
          </div>

          <div
            className={`rounded-[30px] border px-5 py-5 shadow-sm ${metricToneClass("slate")}`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Ultimo movimiento
            </p>
            <p className="mt-3 text-lg font-black text-slate-950">
              {ultimoMovimiento ? ultimoMovimiento.concepto : "Sin registros"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {ultimoMovimiento
                ? formatoFecha(ultimoMovimiento.createdAt)
                : "Todavia no hay actividad en caja."}
            </p>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e8e0d1] bg-[linear-gradient(180deg,#ffffff_0%,#fbf9f4_100%)] shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
          <div className="flex flex-col gap-3 border-b border-[#ece5d8] px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#ddd2bf] bg-[#faf6ee] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7b5b2b]">
                Detalle operativo
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Movimientos de caja
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Historial limpio y legible de ingresos y egresos dentro de la
                cobertura actual.
              </p>
            </div>

            <div className="text-sm text-slate-500">
              Vista activa:{" "}
              <span className="font-semibold text-slate-900">
                {esAdmin
                  ? sedeFiltroId === "TODAS"
                    ? "Todas las sedes"
                    : sedeFiltroNombre
                  : user?.sedeNombre || "Sede actual"}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1180px] text-sm">
              <thead className="bg-[#f8f5ee] text-slate-600">
                <tr>
                  <th className="px-5 py-4 text-left font-semibold">ID</th>
                  <th className="px-5 py-4 text-left font-semibold">Tipo</th>
                  <th className="px-5 py-4 text-left font-semibold">Concepto</th>
                  <th className="px-5 py-4 text-left font-semibold">Valor</th>
                  <th className="px-5 py-4 text-left font-semibold">Descripcion</th>
                  <th className="px-5 py-4 text-left font-semibold">Sede</th>
                  <th className="px-5 py-4 text-left font-semibold">Fecha</th>
                </tr>
              </thead>

              <tbody>
                {movimientos.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-16 text-center">
                      <div className="mx-auto max-w-md">
                        <p className="text-base font-semibold text-slate-900">
                          No hay movimientos para esta vista
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          Cuando haya actividad en caja, aparecera aqui con el
                          mismo detalle operativo del resto del sistema.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  movimientos.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-[#eee7da] align-top transition hover:bg-white/80"
                    >
                      <td className="px-5 py-5">
                        <span className="font-bold text-slate-950">#{item.id}</span>
                      </td>

                      <td className="px-5 py-5">
                        <span
                          className={[
                            "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                            tipoBadgeClass(item.tipo),
                          ].join(" ")}
                        >
                          {item.tipo}
                        </span>
                      </td>

                      <td className="px-5 py-5">
                        <p className="max-w-[240px] font-semibold text-slate-950">
                          {item.concepto}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p
                          className={[
                            "text-lg font-black",
                            item.tipo === "INGRESO"
                              ? "text-emerald-600"
                              : "text-red-600",
                          ].join(" ")}
                        >
                          {formatoPesos(item.valor)}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="max-w-[360px] leading-6 text-slate-600">
                          {item.descripcion ?? "-"}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <span className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                          {item.sede?.nombre ?? `SEDE ${item.sedeId}`}
                        </span>
                      </td>

                      <td className="px-5 py-5 text-slate-600">
                        {formatoFecha(item.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
