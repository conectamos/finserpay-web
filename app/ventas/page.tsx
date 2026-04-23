"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import {
  detalleIngresosTexto,
  financierasTexto,
  formatoFechaHoraVenta,
  formatoPesos,
  getCurrentBogotaMonthInput,
  getTodayBogotaDateKey,
  isTodayBogota,
  dinero,
  type VentaLike,
} from "@/lib/ventas-utils";

type Venta = VentaLike & {
  id: number;
};

type CajaMovimiento = {
  id: number;
  tipo: string;
  valor: number;
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

type VistaFiltro = "HOY" | "TODAS";

function metricToneClass(tone: "slate" | "emerald" | "amber" | "blue") {
  switch (tone) {
    case "emerald":
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    case "amber":
      return "bg-amber-50 text-amber-700 ring-amber-100";
    case "blue":
      return "bg-blue-50 text-blue-700 ring-blue-100";
    default:
      return "bg-white text-slate-900 ring-slate-200";
  }
}

function servicioBadge(servicio: string) {
  const normalized = String(servicio || "").toUpperCase();

  if (normalized.includes("FINAN")) {
    return "bg-red-50 text-red-700 ring-red-100";
  }

  if (normalized.includes("ACTIV")) {
    return "bg-blue-50 text-blue-700 ring-blue-100";
  }

  if (normalized.includes("CONTADO")) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  }

  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export default function VentasPage() {
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [movimientosCaja, setMovimientosCaja] = useState<CajaMovimiento[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedesReporte, setSedesReporte] = useState<Sede[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [vista, setVista] = useState<VistaFiltro>("HOY");
  const [vistaSedeId, setVistaSedeId] = useState("TODAS");
  const [descargandoPdf, setDescargandoPdf] = useState(false);
  const [eliminandoVentaId, setEliminandoVentaId] = useState<number | null>(null);
  const [reporteFechaInicial, setReporteFechaInicial] = useState(() => getTodayBogotaDateKey());
  const [reporteFechaFinal, setReporteFechaFinal] = useState(() => getTodayBogotaDateKey());
  const [reporteSedeId, setReporteSedeId] = useState("TODAS");
  const [reporteMesComercial, setReporteMesComercial] = useState(() =>
    getCurrentBogotaMonthInput()
  );
  const [descargandoPdfMensual, setDescargandoPdfMensual] = useState(false);
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

  const cargarVentas = async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && vistaSedeId !== "TODAS") {
        params.set("sedeId", vistaSedeId);
      }

      const endpoint = params.size
        ? `/api/ventas?${params.toString()}`
        : "/api/ventas";

      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();
      setVentas(Array.isArray(data) ? data : []);
    } catch {
      setMensaje("Error cargando ventas");
    }
  };

  const cargarCajaResumen = async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && vistaSedeId !== "TODAS") {
        params.set("sedeId", vistaSedeId);
      }

      const endpoint = params.size
        ? `/api/caja?${params.toString()}`
        : "/api/caja";

      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();
      setMovimientosCaja(Array.isArray(data) ? data : []);
    } catch {
      setMovimientosCaja([]);
    }
  };

  const cargarSedes = async () => {
    try {
      const res = await fetch("/api/sedes", { cache: "no-store" });
      const data = await res.json();
      setSedesReporte(Array.isArray(data) ? data : []);
    } catch {
      setSedesReporte([]);
    }
  };

  useEffect(() => {
    const init = async () => {
      await cargarUsuario();
      await cargarVentas();
      await cargarCajaResumen();
    };

    void init();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!esAdmin) {
      setSedesReporte([]);
      setReporteSedeId("TODAS");
      setVistaSedeId("TODAS");
      return;
    }

    void cargarSedes();
  }, [esAdmin]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) {
      return;
    }

    void Promise.all([cargarVentas(), cargarCajaResumen()]);
  }, [user, vistaSedeId]);

  useLiveRefresh(
    async () => {
      await cargarUsuario();
      await Promise.all([cargarVentas(), cargarCajaResumen()]);
    },
    { intervalMs: 12000 }
  );

  const vistaSedeNombre = useMemo(() => {
    if (!esAdmin) {
      return user?.sedeNombre || "tu sede";
    }

    if (vistaSedeId === "TODAS") {
      return "todas las sedes";
    }

    return (
      sedesReporte.find((sede) => String(sede.id) === vistaSedeId)?.nombre ||
      "la sede seleccionada"
    );
  }, [esAdmin, sedesReporte, user?.sedeNombre, vistaSedeId]);

  const todayKey = useMemo(() => getTodayBogotaDateKey(), []);

  const ventasHoy = useMemo(
    () => ventas.filter((venta) => isTodayBogota(venta.fecha, todayKey)),
    [todayKey, ventas]
  );

  const totalUtilidadHoy = useMemo(
    () => ventasHoy.reduce((acc, venta) => acc + dinero(venta.utilidad), 0),
    [ventasHoy]
  );

  const totalCajaHoy = useMemo(
    () => ventasHoy.reduce((acc, venta) => acc + dinero(venta.cajaOficina), 0),
    [ventasHoy]
  );

  const totalIngresosHoy = useMemo(
    () => ventasHoy.reduce((acc, venta) => acc + dinero(venta.ingreso), 0),
    [ventasHoy]
  );

  const totalCajaGeneral = useMemo(
    () => ventas.reduce((acc, venta) => acc + dinero(venta.cajaOficina), 0),
    [ventas]
  );

  const totalCajaNeta = useMemo(() => {
    const ingresos = movimientosCaja
      .filter((movimiento) => String(movimiento.tipo || "").toUpperCase() === "INGRESO")
      .reduce((acc, movimiento) => acc + Number(movimiento.valor || 0), 0);

    const egresos = movimientosCaja
      .filter((movimiento) => String(movimiento.tipo || "").toUpperCase() === "EGRESO")
      .reduce((acc, movimiento) => acc + Number(movimiento.valor || 0), 0);

    return ingresos - egresos;
  }, [movimientosCaja]);

  const totalCajaAcumulada = totalCajaGeneral + totalCajaNeta;

  const totalIngresos = useMemo(
    () => ventas.reduce((acc, venta) => acc + dinero(venta.ingreso), 0),
    [ventas]
  );

  const ventasMostradas = useMemo(() => {
    const base = vista === "HOY" ? ventasHoy : ventas;
    const termino = busqueda.trim().toLowerCase();

    if (!termino) {
      return base;
    }

    return base.filter((venta) => {
      return (
        String(venta.idVenta || "").toLowerCase().includes(termino) ||
        String(venta.servicio || "").toLowerCase().includes(termino) ||
        String(venta.descripcion || "").toLowerCase().includes(termino) ||
        String(venta.serial || "").toLowerCase().includes(termino) ||
        String(venta.jalador || "").toLowerCase().includes(termino) ||
        String(venta.cerrador || "").toLowerCase().includes(termino) ||
        String(venta.sede?.nombre || "").toLowerCase().includes(termino)
      );
    });
  }, [busqueda, ventas, ventasHoy, vista]);

  const descargarReportePdf = async () => {
    try {
      setDescargandoPdf(true);
      setMensaje("");

      const params = new URLSearchParams();

      if (esAdmin) {
        if (!reporteFechaInicial || !reporteFechaFinal) {
          setMensaje("Debes seleccionar fecha inicial y fecha final para el reporte");
          return;
        }

        if (reporteFechaInicial > reporteFechaFinal) {
          setMensaje("La fecha inicial no puede ser mayor que la final");
          return;
        }

        params.set("fechaInicial", reporteFechaInicial);
        params.set("fechaFinal", reporteFechaFinal);

        if (reporteSedeId && reporteSedeId !== "TODAS") {
          params.set("sedeId", reporteSedeId);
        }
      }

      const endpoint = params.size
        ? `/api/ventas/reporte-dia?${params.toString()}`
        : "/api/ventas/reporte-dia";

      const res = await fetch(endpoint, {
        method: "GET",
        credentials: "same-origin",
      });

      if (!res.ok) {
        let errorMessage = "Error generando reporte PDF del dia";

        try {
          const data = await res.json();
          errorMessage = data.detail || data.error || errorMessage;
        } catch {}

        setMensaje(errorMessage);
        return;
      }

      const blob = await res.blob();

      if (!blob.size) {
        setMensaje("El reporte PDF se genero vacio");
        return;
      }

      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const match = contentDisposition.match(/filename=\"?([^"]+)\"?/i);
      const fileName = match?.[1] || "ventas-dia.pdf";
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = fileName;
      link.target = "_blank";
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();

      window.setTimeout(() => {
        link.remove();
        window.URL.revokeObjectURL(url);
      }, 1500);
    } catch {
      setMensaje("Error generando reporte PDF");
    } finally {
      setDescargandoPdf(false);
    }
  };

  const descargarReporteMensual = async () => {
    try {
      setDescargandoPdfMensual(true);
      setMensaje("");

      if (!reporteMesComercial) {
        setMensaje("Debes seleccionar el mes comercial del reporte");
        return;
      }

      const params = new URLSearchParams({
        month: reporteMesComercial,
      });

      if (reporteSedeId && reporteSedeId !== "TODAS") {
        params.set("sedeId", reporteSedeId);
      }

      const res = await fetch(`/api/ventas/reporte-mensual?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });

      if (!res.ok) {
        let errorMessage = "Error generando reporte mensual comercial";

        try {
          const data = await res.json();
          errorMessage = data.detail || data.error || errorMessage;
        } catch {}

        setMensaje(errorMessage);
        return;
      }

      const blob = await res.blob();

      if (!blob.size) {
        setMensaje("El reporte mensual se genero vacio");
        return;
      }

      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const match = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
      const fileName = match?.[1] || "reporte-comercial-mensual.pdf";
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = fileName;
      link.target = "_blank";
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();

      window.setTimeout(() => {
        link.remove();
        window.URL.revokeObjectURL(url);
      }, 1500);
    } catch {
      setMensaje("Error generando reporte mensual comercial");
    } finally {
      setDescargandoPdfMensual(false);
    }
  };

  const eliminarVenta = async (ventaId: number) => {
    const confirmado = window.confirm(
      "Esta venta se eliminara y el equipo volvera a BODEGA. Deseas continuar?"
    );

    if (!confirmado) {
      return;
    }

    try {
      setEliminandoVentaId(ventaId);
      setMensaje("");

      const res = await fetch(`/api/ventas?id=${ventaId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo eliminar la venta");
        return;
      }

      setMensaje(data.mensaje || "Venta eliminada correctamente");
      await cargarVentas();
    } catch {
      setMensaje("Error eliminando la venta");
    } finally {
      setEliminandoVentaId(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-[1840px]">
        <section className="relative overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_48%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.14),transparent_28%),radial-gradient(circle_at_bottom_left,rgba(248,113,113,0.18),transparent_24%)]" />

          <div className="relative flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-4xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Ventas
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Panel de ventas
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                {user
                  ? user.rolNombre.toUpperCase() === "ADMIN"
                    ? vistaSedeId === "TODAS"
                      ? "Vision operativa de todas las sedes, con foco en el corte del dia y el rendimiento comercial."
                      : `Vision comercial filtrada de ${vistaSedeNombre}.`
                    : `Vision de ${user.sedeNombre}, con corte del dia y detalle completo de las ventas registradas.`
                  : "Cargando informacion de usuario..."}
              </p>

              <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-200">
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Corte del dia: {new Date().toLocaleDateString("es-CO")}
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Ventas hoy: {ventasHoy.length}
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Utilidad hoy: {formatoPesos(totalUtilidadHoy)}
                </div>
                {esAdmin && (
                  <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                    Cobertura: {vistaSedeId === "TODAS" ? "Todas las sedes" : vistaSedeNombre}
                  </div>
                )}
              </div>
            </div>

            <div className="relative z-10 flex flex-col gap-3 sm:flex-row">
              {esAdmin && (
                <Link
                  href="/ventas/equipo-comercial"
                  className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
                >
                  Catalogos de ventas
                </Link>
              )}

              <button
                type="button"
                onClick={() => void descargarReportePdf()}
                disabled={descargandoPdf}
                className="rounded-2xl border border-white/10 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {descargandoPdf
                  ? "Generando PDF..."
                  : esAdmin
                    ? "PDF por rango y sede"
                    : "PDF ventas del dia"}
              </button>

              <Link
                href="/ventas/nuevo"
                className="rounded-2xl bg-red-600 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-red-700"
              >
                + Nueva venta
              </Link>

              <Link
                href="/dashboard"
                className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
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

        {esAdmin && (
          <section className="mt-6 rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Reporte PDF
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                  Descarga por rango y cobertura
                </h2>
                <p className="mt-2 max-w-2xl text-sm text-slate-500">
                  El PDF del administrador puede salir por fechas, por una sede puntual o con todas las sedes consolidadas.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:gap-4 2xl:gap-5 xl:grid-cols-[minmax(190px,1fr)_minmax(190px,1fr)_minmax(220px,1.05fr)_minmax(220px,1.05fr)_minmax(340px,1.2fr)]">
                <label className="flex min-w-[180px] flex-col gap-2 text-sm font-semibold text-slate-700">
                  Fecha inicial
                  <input
                    type="date"
                    value={reporteFechaInicial}
                    onChange={(event) => setReporteFechaInicial(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>

                <label className="flex min-w-[180px] flex-col gap-2 text-sm font-semibold text-slate-700">
                  Fecha final
                  <input
                    type="date"
                    value={reporteFechaFinal}
                    onChange={(event) => setReporteFechaFinal(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>

                <label className="flex min-w-[220px] flex-col gap-2 text-sm font-semibold text-slate-700">
                  Sede
                  <select
                    value={reporteSedeId}
                    onChange={(event) => setReporteSedeId(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="TODAS">Todas las sedes</option>
                    {sedesReporte.map((sede) => (
                      <option key={sede.id} value={String(sede.id)}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex min-w-[180px] flex-col gap-2 text-sm font-semibold text-slate-700">
                  Mes comercial
                  <input
                    type="month"
                    value={reporteMesComercial}
                    onChange={(event) => setReporteMesComercial(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>

                <div className="flex min-w-[220px] flex-col justify-end rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Configuracion actual
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    {reporteFechaInicial} a {reporteFechaFinal}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {reporteSedeId === "TODAS"
                      ? "Cobertura: todas las sedes"
                      : `Sede filtrada: ${
                          sedesReporte.find((sede) => String(sede.id) === reporteSedeId)?.nombre ||
                          "Seleccionada"
                        }`}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void descargarReportePdf()}
                  disabled={descargandoPdf}
                  className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {descargandoPdf ? "Generando PDF..." : "PDF por rango y sede"}
                </button>

                <button
                  type="button"
                  onClick={() => void descargarReporteMensual()}
                  disabled={descargandoPdfMensual}
                  className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {descargandoPdfMensual ? "Generando reporte..." : "PDF resumen mensual"}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm ring-1 ring-inset ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Ventas del dia
            </p>
            <p className="mt-3 text-3xl font-black text-slate-950">{ventasHoy.length}</p>
            <p className="mt-2 text-sm text-slate-500">Corte operativo actual.</p>
          </div>

          <div className={`rounded-[28px] px-5 py-5 shadow-sm ring-1 ring-inset ${metricToneClass("blue")}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]">
              Ingresos del dia
            </p>
            <p className="mt-3 text-3xl font-black">{formatoPesos(totalIngresosHoy)}</p>
            <p className="mt-2 text-sm opacity-80">Ingreso neto registrado hoy.</p>
          </div>

          <div className={`rounded-[28px] px-5 py-5 shadow-sm ring-1 ring-inset ${metricToneClass("slate")}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]">
              Caja del dia
            </p>
            <p className="mt-3 text-3xl font-black">{formatoPesos(totalCajaHoy)}</p>
            <p className="mt-2 text-sm text-slate-500">Disponible segun ventas del dia.</p>
          </div>

          <div className={`rounded-[28px] px-5 py-5 shadow-sm ring-1 ring-inset ${metricToneClass("emerald")}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]">
              Utilidad del dia
            </p>
            <p className="mt-3 text-3xl font-black">{formatoPesos(totalUtilidadHoy)}</p>
            <p className="mt-2 text-sm opacity-80">Resultado neto del corte diario.</p>
          </div>
        </section>

        <section
          className={`mt-4 grid grid-cols-1 gap-4 ${
            esAdmin ? "lg:grid-cols-3" : "lg:grid-cols-2"
          }`}
        >
          <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Acumulado ventas
            </p>
            <p className="mt-3 text-2xl font-black text-slate-950">{ventas.length}</p>
          </div>

          {esAdmin && (
            <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm ring-1 ring-slate-200">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Ingresos acumulados
              </p>
              <p className="mt-3 text-2xl font-black text-slate-950">
                {formatoPesos(totalIngresos)}
              </p>
            </div>
          )}

          <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Caja acumulada
            </p>
            <p className="mt-3 text-2xl font-black text-slate-950">
              {formatoPesos(totalCajaAcumulada)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Suma la caja de ventas mas el neto de ingresos y egresos de caja en esta vista.
            </p>
          </div>
        </section>

        <section className="mt-6 rounded-[30px] bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Filtros
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Seguimiento comercial
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Revisa el corte del dia o explora todo el historico reciente sin perder legibilidad.
              </p>
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="flex flex-wrap gap-2">
                {(["HOY", "TODAS"] as VistaFiltro[]).map((opcion) => (
                  <button
                    key={opcion}
                    type="button"
                    onClick={() => setVista(opcion)}
                    className={[
                      "rounded-2xl px-4 py-2 text-sm font-semibold transition",
                      vista === opcion
                        ? "bg-slate-950 text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    {opcion === "HOY" ? "Solo hoy" : "Todas"}
                  </button>
                ))}
              </div>

              {esAdmin && (
                <select
                  value={vistaSedeId}
                  onChange={(event) => setVistaSedeId(event.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 lg:w-[260px]"
                >
                  <option value="TODAS">Todas las sedes</option>
                  {sedesReporte.map((sede) => (
                    <option key={sede.id} value={String(sede.id)}>
                      {sede.nombre}
                    </option>
                  ))}
                </select>
              )}

              <input
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
                placeholder="Buscar por venta, IMEI, servicio, sede o asesor..."
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 lg:w-[360px]"
              />
            </div>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.10)] ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Listado
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Ventas registradas
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {ventasMostradas.length} resultado
                {ventasMostradas.length === 1 ? "" : "s"} visibles en esta vista.
              </p>
            </div>

            <div className="text-sm text-slate-500">
              Vista actual:{" "}
              <span className="font-semibold text-slate-900">
                {vista === "HOY" ? "Corte del dia" : "Historico"}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1460px] text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-5 py-4 text-left font-semibold">Venta</th>
                  <th className="px-5 py-4 text-left font-semibold">Momento</th>
                  <th className="px-5 py-4 text-left font-semibold">Equipo</th>
                  <th className="px-5 py-4 text-left font-semibold">Participantes</th>
                  <th className="px-5 py-4 text-left font-semibold">Cobro</th>
                  <th className="px-5 py-4 text-left font-semibold">Financieras</th>
                  <th className="px-5 py-4 text-left font-semibold">Resultado</th>
                  <th className="px-5 py-4 text-left font-semibold">Sede</th>
                  {esAdmin && <th className="px-5 py-4 text-left font-semibold">Acciones</th>}
                </tr>
              </thead>

              <tbody>
                {ventasMostradas.length === 0 ? (
                  <tr>
                    <td colSpan={esAdmin ? 9 : 8} className="px-6 py-16 text-center">
                      <div className="mx-auto max-w-md">
                        <p className="text-base font-semibold text-slate-900">
                          No hay ventas para esta vista
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          Ajusta la busqueda o cambia entre corte del dia e historico.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  ventasMostradas.map((venta) => (
                    <tr
                      key={venta.id}
                      className="border-t border-slate-200 align-top transition hover:bg-slate-50/70"
                    >
                      <td className="px-5 py-5">
                        <div className="space-y-3">
                          <p className="font-bold text-slate-950">{venta.idVenta}</p>
                          <span
                            className={[
                              "inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ring-1 ring-inset",
                              servicioBadge(venta.servicio),
                            ].join(" ")}
                          >
                            {venta.servicio}
                          </span>
                        </div>
                      </td>

                      <td className="px-5 py-5">
                        <p className="font-semibold text-slate-900">
                          {formatoFechaHoraVenta(venta.fecha, venta.hora)}
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                          Registro comercial
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="font-semibold text-slate-950">
                          {venta.descripcion || "Sin descripcion"}
                        </p>
                        <p className="mt-2 text-slate-500">IMEI: {venta.serial}</p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="font-semibold text-slate-900">
                          Jalador: {venta.jalador || "-"}
                        </p>
                        <p className="mt-2 text-slate-500">
                          Cerrador: {venta.cerrador || "-"}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="text-lg font-black text-slate-950">
                          {formatoPesos(venta.ingreso)}
                        </p>
                        <p className="mt-2 text-slate-500">
                          {venta.tipoIngreso || "Sin tipo de ingreso"}
                        </p>
                        <p className="mt-3 max-w-[260px] text-xs leading-5 text-slate-500">
                          {detalleIngresosTexto(venta)}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="max-w-[260px] text-xs leading-5 text-slate-500">
                          {financierasTexto(venta)}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="font-semibold text-emerald-700">
                          Utilidad: {formatoPesos(venta.utilidad)}
                        </p>
                        <p className="mt-2 text-slate-700">
                          Caja: {formatoPesos(venta.cajaOficina)}
                        </p>
                        <p className="mt-2 text-slate-500">
                          Comision: {formatoPesos(venta.comision)}
                        </p>
                        <p className="mt-1 text-slate-500">
                          Salida: {formatoPesos(venta.salida)}
                        </p>
                      </td>

                      <td className="px-5 py-5">
                        <p className="font-semibold text-slate-900">
                          {venta.sede?.nombre || "-"}
                        </p>
                      </td>

                      {esAdmin && (
                        <td className="px-5 py-5">
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/ventas/editar/${venta.id}`}
                              className="inline-flex rounded-2xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                            >
                              Editar
                            </Link>
                            <button
                              type="button"
                              onClick={() => void eliminarVenta(venta.id)}
                              disabled={eliminandoVentaId === venta.id}
                              className="inline-flex rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {eliminandoVentaId === venta.id ? "Eliminando..." : "Eliminar"}
                            </button>
                          </div>
                        </td>
                      )}
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
