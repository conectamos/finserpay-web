"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Prestamo = {
  id: number;
  imei: string;
  referencia: string;
  color: string | null;
  costo: number;
  sedeOrigenId: number;
  sedeDestinoId: number;
  sedeOrigenNombre?: string;
  sedeDestinoNombre?: string;
  estado: string;
  deboAActual?: string | null;
  estadoFinancieroActual?: string | null;
  estadoActualActual?: string | null;
  requiereAprobacionEntreSedes?: boolean;
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

export default function PrestamosPage() {
  const [prestamos, setPrestamos] = useState<Prestamo[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeFiltroId, setSedeFiltroId] = useState("TODAS");
  const [filtroEstado, setFiltroEstado] = useState("TODOS");
  const [busqueda, setBusqueda] = useState("");

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const mensajeEsError = mensaje.trim().toUpperCase().startsWith("ERROR");

  const cargarUsuario = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setUser(data);
      }
    } catch {
      setMensaje("Error cargando sesion");
    }
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

  const cargarPrestamos = useCallback(async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && sedeFiltroId !== "TODAS") {
        params.set("sedeId", sedeFiltroId);
      }

      const endpoint = params.size
        ? `/api/prestamos?${params.toString()}`
        : "/api/prestamos";

      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();
      setPrestamos(Array.isArray(data) ? data : []);
    } catch {
      setMensaje("Error cargando prestamos");
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

    void cargarPrestamos();
  }, [cargarPrestamos, user]);

  useLiveRefresh(async () => {
    await cargarUsuario();
    await cargarPrestamos();
  }, { intervalMs: 10000 });

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

  const devolverPrestamo = async (id: number) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/devolver", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error devolviendo prestamo");
        return;
      }

      setMensaje("Prestamo devuelto correctamente");
      await cargarPrestamos();
    } catch {
      setMensaje("Error de conexion al devolver prestamo");
    } finally {
      setCargando(false);
    }
  };

  const solicitarPagoPrestamo = async (id: number) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/solicitar-pago", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error solicitando pago");
        return;
      }

      setMensaje("Solicitud de pago enviada correctamente");
      await cargarPrestamos();
    } catch {
      setMensaje("Error de conexion al solicitar pago");
    } finally {
      setCargando(false);
    }
  };

  const aprobarPagoPrestamo = async (id: number) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/aprobar-pago", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error aprobando pago");
        return;
      }

      setMensaje("Pago aprobado correctamente");
      await cargarPrestamos();
    } catch {
      setMensaje("Error de conexion al aprobar pago");
    } finally {
      setCargando(false);
    }
  };

  const aprobarPrestamo = async (id: number) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/aprobar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error aprobando prestamo");
        return;
      }

      setMensaje("Prestamo aprobado correctamente");
      await cargarPrestamos();
    } catch {
      setMensaje("Error de conexion al aprobar prestamo");
    } finally {
      setCargando(false);
    }
  };

  const cerrarPrestamoPendiente = async (
    id: number,
    accion: "RECHAZADO" | "CANCELADO"
  ) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/cerrar-pendiente", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, accion }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error cerrando solicitud");
        return;
      }

      setMensaje(
        accion === "RECHAZADO"
          ? "Solicitud rechazada correctamente"
          : "Solicitud cancelada correctamente"
      );
      await cargarPrestamos();
    } catch {
      setMensaje("Error de conexion al cerrar solicitud");
    } finally {
      setCargando(false);
    }
  };

  const puedeDevolver = (prestamo: Prestamo) => {
    if (!user) return false;

    const destino = user.sedeId === prestamo.sedeDestinoId;
    const estadoActual = String(prestamo.estadoActualActual || "")
      .trim()
      .toUpperCase();

    return (
      prestamo.estado === "APROBADO" &&
      estadoActual === "BODEGA" &&
      (esAdmin || destino)
    );
  };

  const puedeSolicitarPago = (prestamo: Prestamo) => {
    if (!user) return false;

    const destino = user.sedeId === prestamo.sedeDestinoId;

    return (
      prestamo.estado === "APROBADO" &&
      Boolean(prestamo.requiereAprobacionEntreSedes) &&
      (esAdmin || destino)
    );
  };

  const puedeAprobarPrestamo = (prestamo: Prestamo) => {
    if (!user) return false;

    const destino = user.sedeId === prestamo.sedeDestinoId;
    return prestamo.estado === "PENDIENTE" && (esAdmin || destino);
  };

  const puedeRechazarPrestamo = (prestamo: Prestamo) => {
    if (!user) return false;

    const destino = user.sedeId === prestamo.sedeDestinoId;
    return prestamo.estado === "PENDIENTE" && (esAdmin || destino);
  };

  const puedeCancelarPrestamo = (prestamo: Prestamo) => {
    if (!user) return false;

    const origen = user.sedeId === prestamo.sedeOrigenId;
    return prestamo.estado === "PENDIENTE" && (esAdmin || origen);
  };

  const puedeAprobarPago = (prestamo: Prestamo) => {
    if (!user) return false;

    const origen = user.sedeId === prestamo.sedeOrigenId;
    return prestamo.estado === "PAGO_PENDIENTE_APROBACION" && (esAdmin || origen);
  };

  const prestamosFiltrados = useMemo(() => {
    return prestamos
      .filter((prestamo) => {
        if (filtroEstado === "TODOS") return true;
        return prestamo.estado === filtroEstado;
      })
      .filter((prestamo) => {
        const termino = busqueda.trim().toLowerCase();
        if (!termino) return true;

        return (
          prestamo.imei.toLowerCase().includes(termino) ||
          prestamo.referencia.toLowerCase().includes(termino) ||
          String(prestamo.color || "").toLowerCase().includes(termino) ||
          String(prestamo.sedeOrigenNombre || prestamo.sedeOrigenId)
            .toLowerCase()
            .includes(termino) ||
          String(prestamo.sedeDestinoNombre || prestamo.sedeDestinoId)
            .toLowerCase()
            .includes(termino) ||
          prestamo.estado.toLowerCase().includes(termino)
        );
      });
  }, [prestamos, filtroEstado, busqueda]);

  const totalPrestamos = prestamos.length;
  const totalPendientes = prestamos.filter((p) => p.estado === "PENDIENTE").length;
  const totalAprobados = prestamos.filter((p) => p.estado === "APROBADO").length;
  const totalPagoPendiente = prestamos.filter(
    (p) => p.estado === "PAGO_PENDIENTE_APROBACION"
  ).length;
  const totalFinalizados = prestamos.filter(
    (p) =>
      p.estado === "RECHAZADO" ||
      p.estado === "CANCELADO" ||
      p.estado === "DEVUELTO" ||
      p.estado === "PAGADO" ||
      p.estado === "FINALIZADO"
  ).length;

  const valorTotalPrestamos = prestamos.reduce(
    (acc, p) => acc + Number(p.costo || 0),
    0
  );

  const estadosFiltro = [
    "TODOS",
    "PENDIENTE",
    "APROBADO",
    "PAGO_PENDIENTE_APROBACION",
    "PAGADO",
    "RECHAZADO",
    "CANCELADO",
    "DEVUELTO",
    "FINALIZADO",
  ];

  const claseEstado = (estado: string) => {
    const normalizado = String(estado || "").toUpperCase();

    if (normalizado === "PENDIENTE") return "bg-amber-100 text-amber-700";
    if (normalizado === "APROBADO") return "bg-sky-100 text-sky-700";
    if (normalizado === "PAGO_PENDIENTE_APROBACION") {
      return "bg-yellow-100 text-yellow-700";
    }
    if (normalizado === "PAGADO" || normalizado === "FINALIZADO") {
      return "bg-emerald-100 text-emerald-700";
    }
    if (normalizado === "RECHAZADO") return "bg-rose-100 text-rose-700";
    if (normalizado === "CANCELADO") return "bg-slate-200 text-slate-700";
    if (normalizado === "DEVUELTO") return "bg-slate-200 text-slate-700";
    return "bg-slate-200 text-slate-700";
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                Prestamos entre sedes
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Centro de prestamos
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                {user
                  ? esAdmin
                    ? sedeFiltroId === "TODAS"
                      ? "Lectura general de todos los prestamos entre sedes, con foco en aprobacion, devolucion y pagos."
                      : `Vista ejecutiva de prestamos para ${sedeFiltroNombre}.`
                    : `Vista operativa de prestamos relacionados con ${user.sedeNombre}.`
                  : "Cargando usuario..."}
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Cobertura: <span className="font-semibold text-white">{sedeFiltroNombre}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Activos visibles: <span className="font-semibold text-white">{prestamosFiltrados.length}</span>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:ml-auto xl:max-w-[380px]">
              <Link
                href="/prestamos/nuevo"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl bg-[#cf2e2e] px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-white transition hover:bg-[#b92525]"
              >
                + Nuevo prestamo
              </Link>

              <Link
                href="/inventario"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-slate-900 transition hover:bg-white"
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

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            label="Total prestamos"
            value={totalPrestamos}
            detail="Solicitudes visibles en esta cobertura."
          />
          <MetricCard
            label="Pendientes"
            value={totalPendientes}
            detail="Solicitudes a la espera de aprobacion."
            valueClass="text-amber-600"
          />
          <MetricCard
            label="Aprobados"
            value={totalAprobados}
            detail="Prestamos activos listos para seguimiento."
            valueClass="text-sky-600"
          />
          <MetricCard
            label="Pago pendiente"
            value={totalPagoPendiente}
            detail="Casos a la espera de aprobacion."
            valueClass="text-amber-600"
          />
          <MetricCard
            label="Finalizados"
            value={totalFinalizados}
            detail="Ciclos ya cerrados por pago o devolucion."
            valueClass="text-emerald-600"
          />
        </section>

        <section className="mt-6 rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Control operativo
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Seguimiento de prestamos
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                Filtra por estado o texto libre para revisar prestamos, devoluciones y aprobaciones sin perder trazabilidad.
              </p>
            </div>

            <div className="grid w-full gap-4 xl:max-w-[760px] xl:grid-cols-[minmax(0,1fr)_260px]">
              <input
                placeholder="Buscar IMEI, referencia, color, sede o estado..."
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
              />

              {esAdmin ? (
                <select
                  value={sedeFiltroId}
                  onChange={(event) => setSedeFiltroId(event.target.value)}
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                >
                  <option value="TODAS">Todas las sedes</option>
                  {sedes.map((sede) => (
                    <option key={sede.id} value={String(sede.id)}>
                      {sede.nombre}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center rounded-2xl border border-[#e4dccd] bg-[#faf7f1] px-4 py-3.5 text-sm font-semibold text-slate-700">
                  Cobertura: {user?.sedeNombre || "Tu sede"}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {estadosFiltro.map((estado) => (
              <button
                key={estado}
                type="button"
                onClick={() => setFiltroEstado(estado)}
                className={[
                  "rounded-2xl px-4 py-2.5 text-sm font-semibold transition",
                  filtroEstado === estado
                    ? "border border-[#111318] bg-[#111318] text-white shadow-sm"
                    : "border border-[#d9cfbe] bg-white text-slate-700 hover:bg-[#faf7f1]",
                ].join(" ")}
              >
                {estado}
              </button>
            ))}
          </div>

          <div className="mt-6 rounded-[28px] border border-slate-200 bg-white p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Valor total en prestamos
            </p>
            <p className="mt-3 text-4xl font-black tracking-tight text-rose-600">
              $ {valorTotalPrestamos.toLocaleString("es-CO")}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Exposicion economica acumulada de la cartera de prestamos visible.
            </p>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e2d9ca] bg-white shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Solicitudes
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Prestamos registrados
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Consulta cada solicitud, revisa su estado y ejecuta acciones segun tu alcance.
              </p>
            </div>

            <span className="text-sm font-medium text-slate-500">
              {prestamosFiltrados.length} resultado(s)
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1180px] text-sm">
              <thead className="sticky top-0 bg-[#f8fafc]">
                <tr className="border-b border-slate-200 text-left text-[12px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-4 py-4">ID</th>
                  <th className="px-4 py-4">IMEI</th>
                  <th className="px-4 py-4">Referencia</th>
                  <th className="px-4 py-4">Color</th>
                  <th className="px-4 py-4">Costo</th>
                  <th className="px-4 py-4">Sede origen</th>
                  <th className="px-4 py-4">Sede destino</th>
                  <th className="px-4 py-4">Estado</th>
                  <th className="px-4 py-4">Accion</th>
                </tr>
              </thead>

              <tbody>
                {prestamosFiltrados.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-16 text-center text-slate-500">
                      No hay prestamos registrados en esta vista.
                    </td>
                  </tr>
                ) : (
                  prestamosFiltrados.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-100 align-top text-slate-700 transition hover:bg-[#faf7f1]"
                    >
                      <td className="px-4 py-4 font-bold text-slate-950">{item.id}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">{item.imei}</td>
                      <td className="px-4 py-4 font-medium text-slate-900">{item.referencia}</td>
                      <td className="px-4 py-4">{item.color ?? "-"}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">
                        $ {Number(item.costo).toLocaleString("es-CO")}
                      </td>
                      <td className="px-4 py-4">
                        {item.sedeOrigenNombre ?? `SEDE ${item.sedeOrigenId}`}
                      </td>
                      <td className="px-4 py-4">
                        {item.sedeDestinoNombre ?? `SEDE ${item.sedeDestinoId}`}
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${claseEstado(
                            item.estado
                          )}`}
                        >
                          {item.estado}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          {puedeDevolver(item) && (
                            <button
                              type="button"
                              onClick={() => void devolverPrestamo(item.id)}
                              disabled={cargando}
                              className="rounded-xl bg-[#111318] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1d2330] disabled:opacity-70"
                            >
                              Devolver
                            </button>
                          )}

                          {puedeAprobarPrestamo(item) && (
                            <button
                              type="button"
                              onClick={() => void aprobarPrestamo(item.id)}
                              disabled={cargando}
                              className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-700 disabled:opacity-70"
                            >
                              Aprobar
                            </button>
                          )}

                          {puedeRechazarPrestamo(item) && (
                            <button
                              type="button"
                              onClick={() =>
                                void cerrarPrestamoPendiente(item.id, "RECHAZADO")
                              }
                              disabled={cargando}
                              className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-70"
                            >
                              Rechazar
                            </button>
                          )}

                          {puedeCancelarPrestamo(item) && (
                            <button
                              type="button"
                              onClick={() =>
                                void cerrarPrestamoPendiente(item.id, "CANCELADO")
                              }
                              disabled={cargando}
                              className="rounded-xl bg-slate-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:opacity-70"
                            >
                              Cancelar
                            </button>
                          )}

                          {puedeSolicitarPago(item) && (
                            <button
                              type="button"
                              onClick={() => void solicitarPagoPrestamo(item.id)}
                              disabled={cargando}
                              className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-70"
                            >
                              Solicitar pago
                            </button>
                          )}

                          {puedeAprobarPago(item) && (
                            <button
                              type="button"
                              onClick={() => void aprobarPagoPrestamo(item.id)}
                              disabled={cargando}
                              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-70"
                            >
                              Aprobar pago
                            </button>
                          )}

                          {!puedeDevolver(item) &&
                            !puedeAprobarPrestamo(item) &&
                            !puedeRechazarPrestamo(item) &&
                            !puedeCancelarPrestamo(item) &&
                            !puedeSolicitarPago(item) &&
                            !puedeAprobarPago(item) && (
                              <span className="text-xs font-medium text-slate-400">
                                Sin acciones
                              </span>
                            )}
                        </div>
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
