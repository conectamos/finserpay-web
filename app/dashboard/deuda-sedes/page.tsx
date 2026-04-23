"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type DeudaItem = {
  id: number;
  prestamoId: number;
  imei: string;
  referencia: string;
  valor: number;
  sedeOrigenId: number;
  sedeOrigenNombre: string;
  sedeDestinoId: number;
  sedeDestinoNombre: string;
  fechaSolicitudPago: string;
  estado: string;
  puedeAprobar: boolean;
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
  if (!valor) {
    return "-";
  }

  return new Date(valor).toLocaleString("es-CO");
}

function MetricCard({
  label,
  value,
  detail,
  valueClass = "text-slate-950",
}: {
  label: string;
  value: string | number;
  detail: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-[28px] border border-[#e2d9ca] bg-white p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className={["mt-3 text-4xl font-black tracking-tight", valueClass].join(" ")}>
        {value}
      </p>
      <p className="mt-2 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

export default function DeudaSedesPage() {
  const [items, setItems] = useState<DeudaItem[]>([]);
  const [totalPendiente, setTotalPendiente] = useState(0);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeFiltroId, setSedeFiltroId] = useState("TODAS");

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const mensajeEsError = mensaje.trim().toUpperCase().startsWith("ERROR");

  const cargarUsuario = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setUser(data);
      }
    } catch {}
  }, []);

  const cargarSedes = useCallback(async () => {
    try {
      const res = await fetch("/api/sedes", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setSedes(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  const cargar = useCallback(async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && sedeFiltroId !== "TODAS") {
        params.set("sedeId", sedeFiltroId);
      }

      const endpoint = params.size
        ? `/api/dashboard/deuda-sedes?${params.toString()}`
        : "/api/dashboard/deuda-sedes";

      const res = await fetch(endpoint, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error cargando deuda"}`);
        return;
      }

      setItems(Array.isArray(data.items) ? data.items : []);
      setTotalPendiente(Number(data.totalPendiente || 0));
    } catch {
      setMensaje("Error cargando deuda entre sedes");
    }
  }, [esAdmin, sedeFiltroId]);

  useEffect(() => {
    const init = async () => {
      await cargarUsuario();
      await cargarSedes();
    };

    void init();
  }, [cargarSedes, cargarUsuario]);

  useEffect(() => {
    if (!user) {
      return;
    }

    void cargar();
  }, [cargar, user]);

  useLiveRefresh(cargar, { intervalMs: 10000 });

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

  const aprobarPago = async (item: DeudaItem) => {
    const confirmado = window.confirm(
      `Confirmas aprobar el pago del IMEI ${item.imei} por ${formatoPesos(item.valor)}?`
    );

    if (!confirmado) {
      return;
    }

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/aprobar-pago", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prestamoId: item.prestamoId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error aprobando pago"}`);
        return;
      }

      setMensaje("Pago aprobado correctamente");
      await cargar();
    } catch {
      setMensaje("Error aprobando pago");
    } finally {
      setCargando(false);
    }
  };

  const totalSolicitudes = items.length;
  const promedioPendiente = useMemo(() => {
    if (!items.length) {
      return 0;
    }

    return totalPendiente / items.length;
  }, [items, totalPendiente]);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                Deuda entre sedes
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Pagos pendientes por aprobar
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                {esAdmin
                  ? sedeFiltroId === "TODAS"
                    ? "Monitorea solicitudes de pago entre sedes en toda la operacion y aprueba movimientos pendientes."
                    : `Vista ejecutiva de pagos pendientes relacionados con ${sedeFiltroNombre}.`
                  : "Revisa los pagos entre sedes que siguen esperando aprobacion dentro de tu alcance."}
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Cobertura: <span className="font-semibold text-white">{sedeFiltroNombre}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Solicitudes visibles: <span className="font-semibold text-white">{items.length}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:items-end">
              <Link
                href="/dashboard"
                className="inline-flex h-[56px] min-w-[180px] items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold text-slate-900 transition hover:bg-white"
              >
                Volver
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div
            className={[
              "mt-6 rounded-[26px] border px-5 py-4 text-sm font-medium shadow-sm",
              mensajeEsError
                ? "border-rose-200 bg-rose-50 text-rose-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800",
            ].join(" ")}
          >
            {mensaje}
          </div>
        )}

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            label="Total pendiente"
            value={formatoPesos(totalPendiente)}
            detail="Capital pendiente por aprobar entre sedes."
            valueClass="text-amber-600"
          />
          <MetricCard
            label="Solicitudes activas"
            value={totalSolicitudes}
            detail="Movimientos listos para aprobacion."
          />
          <MetricCard
            label="Promedio por solicitud"
            value={formatoPesos(promedioPendiente)}
            detail="Valor medio pendiente en esta vista."
          />
        </section>

        <section className="mt-6 rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Control de cobertura
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Foco de aprobacion
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                Revisa pagos pendientes por sede y concentra la aprobacion donde realmente hay exposicion financiera.
              </p>
            </div>

            {esAdmin ? (
              <div className="w-full xl:max-w-[320px]">
                <select
                  value={sedeFiltroId}
                  onChange={(event) => setSedeFiltroId(event.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                >
                  <option value="TODAS">Todas las sedes</option>
                  {sedes.map((sede) => (
                    <option key={sede.id} value={String(sede.id)}>
                      {sede.nombre}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e2d9ca] bg-white shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Solicitudes pendientes
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Movimientos listos para aprobar
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Pagos entre sedes en espera de validacion por parte del origen o administrador.
              </p>
            </div>

            <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {totalSolicitudes} registro{totalSolicitudes === 1 ? "" : "s"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1120px] text-sm">
              <thead className="sticky top-0 bg-[#f8fafc]">
                <tr className="border-b border-slate-200 text-left text-[12px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-6 py-4">Prestamo</th>
                  <th className="px-6 py-4">IMEI</th>
                  <th className="px-6 py-4">Referencia</th>
                  <th className="px-6 py-4">Valor</th>
                  <th className="px-6 py-4">Sede origen</th>
                  <th className="px-6 py-4">Sede destino</th>
                  <th className="px-6 py-4">Solicitado</th>
                  <th className="px-6 py-4">Accion</th>
                </tr>
              </thead>

              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-16 text-center text-slate-500">
                      No hay pagos pendientes por aprobar entre sedes.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-100 align-top text-slate-700 transition hover:bg-[#faf7f1]"
                    >
                      <td className="px-6 py-4 font-bold text-slate-950">#{item.prestamoId}</td>
                      <td className="px-6 py-4 font-semibold text-slate-950">{item.imei}</td>
                      <td className="px-6 py-4">{item.referencia}</td>
                      <td className="px-6 py-4 font-semibold text-amber-600">
                        {formatoPesos(item.valor)}
                      </td>
                      <td className="px-6 py-4">
                        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                          {item.sedeOrigenNombre}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                          {item.sedeDestinoNombre}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {formatoFecha(item.fechaSolicitudPago)}
                      </td>
                      <td className="px-6 py-4">
                        {item.puedeAprobar ? (
                          <button
                            type="button"
                            onClick={() => void aprobarPago(item)}
                            disabled={cargando}
                            className="rounded-2xl bg-[#111318] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1d2330] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Aprobar pago
                          </button>
                        ) : (
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            En espera
                          </span>
                        )}
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
