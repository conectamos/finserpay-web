"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type InventarioItem = {
  id: number;
  imei: string;
  referencia: string;
  color: string | null;
  costo: number;
  distribuidor: string | null;
  deboA: string | null;
  estadoActual: string | null;
  estadoFinanciero: string | null;
  origen: string | null;
  sedeId: number;
  sede?: {
    id: number;
    nombre: string;
  } | null;
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

type EstadoFiltro = "TODOS" | "BODEGA" | "PENDIENTE" | "GARANTIA" | "PRESTAMO" | "DEUDA";

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function badgeClaseEstadoInventario(estado: string | null) {
  switch ((estado || "").toUpperCase()) {
    case "BODEGA":
      return "bg-slate-100 text-slate-800";
    case "PENDIENTE":
      return "bg-amber-100 text-amber-700";
    case "GARANTIA":
      return "bg-fuchsia-100 text-fuchsia-700";
    case "VENDIDO":
      return "bg-emerald-100 text-emerald-700";
    case "PRESTAMO":
      return "bg-sky-100 text-sky-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function badgeClaseEstadoFinanciero(estado: string | null) {
  switch ((estado || "").toUpperCase()) {
    case "PAGO":
      return "bg-emerald-100 text-emerald-700";
    case "DEUDA":
      return "bg-red-100 text-red-700";
    case "CANCELADO":
      return "bg-slate-200 text-slate-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function TopMetricCard({
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
    <div className="rounded-[28px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className={["mt-3 text-4xl font-black", valueClass].join(" ")}>{value}</p>
      <p className="mt-2 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function SummaryMetricCard({
  label,
  value,
  valueClass = "text-slate-950",
  tone = "neutral",
}: {
  label: string;
  value: string;
  valueClass?: string;
  tone?: "neutral" | "warm" | "success";
}) {
  const toneClass =
    tone === "warm"
      ? "border-amber-200 bg-[linear-gradient(180deg,#fffdf8_0%,#fff7e8_100%)]"
      : tone === "success"
        ? "border-emerald-200 bg-[linear-gradient(180deg,#fafffb_0%,#effcf5_100%)]"
        : "border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)]";

  return (
    <div className={["rounded-[28px] border p-5 shadow-sm", toneClass].join(" ")}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className={["mt-3 text-4xl font-black", valueClass].join(" ")}>{value}</p>
    </div>
  );
}

export default function InventarioPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [items, setItems] = useState<InventarioItem[]>([]);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState<EstadoFiltro>("TODOS");
  const [busqueda, setBusqueda] = useState("");
  const [sedeFiltroId, setSedeFiltroId] = useState("TODAS");

  const [mostrarModalPrestamo, setMostrarModalPrestamo] = useState(false);
  const [itemPrestamo, setItemPrestamo] = useState<InventarioItem | null>(null);
  const [sedeDestinoId, setSedeDestinoId] = useState("");

  const [mostrarModalPago, setMostrarModalPago] = useState(false);
  const [itemPago, setItemPago] = useState<InventarioItem | null>(null);

  const [modalEliminar, setModalEliminar] = useState(false);
  const [idEliminar, setIdEliminar] = useState<number | null>(null);
  const [claveEliminar, setClaveEliminar] = useState("");
  const [errorClave, setErrorClave] = useState("");

  const esAdmin = String(user?.rolNombre || "").toUpperCase() === "ADMIN";

  const cargarUsuario = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error cargando usuario");
        return;
      }

      setUser(data);
    } catch {
      setMensaje("Error cargando usuario");
    }
  }, []);

  const cargarInventario = useCallback(async () => {
    try {
      setMensaje("");
      const params = new URLSearchParams();

      if (esAdmin && sedeFiltroId !== "TODAS") {
        params.set("sedeId", sedeFiltroId);
      }

      const endpoint = params.size
        ? `/api/inventario?${params.toString()}`
        : "/api/inventario";

      const res = await fetch(endpoint, {
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error cargando inventario");
        return;
      }

      setItems(Array.isArray(data) ? data : []);
    } catch {
      setMensaje("Error cargando inventario");
    }
  }, [esAdmin, sedeFiltroId]);

  const cargarSedes = useCallback(async () => {
    try {
      const res = await fetch("/api/sedes", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setSedes(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  const cambiarEstado = async (
    item: InventarioItem,
    estadoActual: "PENDIENTE" | "GARANTIA" | "BODEGA"
  ) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario/cambiar-estado", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: item.id,
          estadoActual,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error actualizando estado");
        return;
      }

      setMensaje(`Estado actualizado a ${estadoActual}`);
      await cargarInventario();
    } catch {
      setMensaje("Error actualizando estado");
    } finally {
      setCargando(false);
    }
  };

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

    void cargarInventario();
  }, [cargarInventario, user]);

  useLiveRefresh(
    async () => {
      await cargarUsuario();
      await cargarInventario();
    },
    { intervalMs: 10000 }
  );

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

  const totalBodega = useMemo(
    () =>
      items.filter((item) => (item.estadoActual || "").toUpperCase() === "BODEGA").length,
    [items]
  );

  const totalPendiente = useMemo(
    () =>
      items.filter((item) => (item.estadoActual || "").toUpperCase() === "PENDIENTE").length,
    [items]
  );

  const totalGarantia = useMemo(
    () =>
      items.filter((item) => (item.estadoActual || "").toUpperCase() === "GARANTIA").length,
    [items]
  );

  const totalPrestamo = useMemo(
    () =>
      items.filter((item) => (item.estadoFinanciero || "").toUpperCase() === "DEUDA").length,
    [items]
  );

  const totalPagados = useMemo(
    () =>
      items.filter((item) => (item.estadoFinanciero || "").toUpperCase() === "PAGO").length,
    [items]
  );

  const totalCancelados = useMemo(
    () =>
      items.filter((item) => (item.estadoFinanciero || "").toUpperCase() === "CANCELADO").length,
    [items]
  );

  const totalDeuda = useMemo(
    () =>
      items
        .filter((item) => (item.estadoFinanciero || "").toUpperCase() === "DEUDA")
        .reduce((acc, item) => acc + Number(item.costo || 0), 0),
    [items]
  );

  const totalPagado = useMemo(
    () =>
      items
        .filter((item) => (item.estadoFinanciero || "").toUpperCase() === "PAGO")
        .reduce((acc, item) => acc + Number(item.costo || 0), 0),
    [items]
  );

  const itemsFiltrados = useMemo(() => {
    return items
      .filter((item) => {
        const estado = (item.estadoActual || "").toUpperCase();
        const estadoFinanciero = (item.estadoFinanciero || "").toUpperCase();

        if (filtroEstado === "TODOS") return true;
        if (filtroEstado === "DEUDA") return estadoFinanciero === "DEUDA";

        return estado === filtroEstado;
      })
      .filter((item) => {
        const termino = busqueda.trim().toLowerCase();

        if (!termino) return true;

        return (
          (item.imei || "").toLowerCase().includes(termino) ||
          (item.referencia || "").toLowerCase().includes(termino) ||
          (item.color || "").toLowerCase().includes(termino) ||
          (item.distribuidor || "").toLowerCase().includes(termino) ||
          (item.deboA || "").toLowerCase().includes(termino) ||
          (item.origen || "").toLowerCase().includes(termino) ||
          (item.sede?.nombre || "").toLowerCase().includes(termino)
        );
      });
  }, [busqueda, filtroEstado, items]);

  const eliminar = async (id: number) => {
    const confirmado = window.confirm("Seguro que deseas eliminar este equipo?");
    if (!confirmado) return;

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario/eliminar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error eliminando equipo");
        return;
      }

      setMensaje("Equipo eliminado correctamente");
      await cargarInventario();
    } catch {
      setMensaje("Error eliminando equipo");
    } finally {
      setCargando(false);
    }
  };

  const devolverABodega = async (item: InventarioItem) => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario/cambiar-estado", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: item.id,
          estadoActual: "BODEGA",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error actualizando estado");
        return;
      }

      setMensaje("Equipo devuelto a BODEGA");
      await cargarInventario();
    } catch {
      setMensaje("Error actualizando estado");
    } finally {
      setCargando(false);
    }
  };

  const abrirPrestamo = (item: InventarioItem) => {
    setItemPrestamo(item);
    setSedeDestinoId("");
    setMostrarModalPrestamo(true);
  };

  const enviarPrestamo = async () => {
    if (!itemPrestamo) return;

    if (!sedeDestinoId) {
      setMensaje("Debes seleccionar una sede destino");
      return;
    }

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/crear-desde-inventario", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inventarioId: itemPrestamo.id,
          sedeDestinoId: Number(sedeDestinoId),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error creando prestamo");
        return;
      }

      setMensaje("Solicitud de prestamo enviada. La sede destino debe aprobarla.");
      setMostrarModalPrestamo(false);
      setItemPrestamo(null);
      setSedeDestinoId("");
      await cargarInventario();
    } catch {
      setMensaje("Error creando prestamo");
    } finally {
      setCargando(false);
    }
  };

  const abrirPagoDeuda = (item: InventarioItem) => {
    setItemPago(item);
    setMostrarModalPago(true);
  };

  const pagarDeuda = async () => {
    if (!itemPago) return;

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario/pagar-deuda", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: itemPago.id,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error pagando deuda");
        return;
      }

      setMensaje("Deuda pagada correctamente");
      setMostrarModalPago(false);
      setItemPago(null);
      await cargarInventario();
    } catch {
      setMensaje("Error pagando deuda");
    } finally {
      setCargando(false);
    }
  };

  const puedeDevolverABodega = (item: InventarioItem) => {
    const estado = (item.estadoActual || "").toUpperCase();
    return estado === "PENDIENTE" || estado === "GARANTIA";
  };

  const puedePasarAPendiente = (item: InventarioItem) => {
    return String(item.estadoActual || "").toUpperCase() === "BODEGA";
  };

  const puedePasarAGarantia = (item: InventarioItem) => {
    return String(item.estadoActual || "").toUpperCase() === "BODEGA";
  };

  const puedeEnviarPrestamo = (item: InventarioItem) => {
    const estadoActual = String(item.estadoActual || "").toUpperCase();

    if (estadoActual !== "BODEGA") {
      return false;
    }

    return true;
  };

  const puedePagarDeuda = (item: InventarioItem) => {
    const estado = String(item.estadoFinanciero || "").trim().toUpperCase();
    const deboA = String(item.deboA || "").trim().toUpperCase();
    const estadoActual = String(item.estadoActual || "").trim().toUpperCase();

    if (estado !== "DEUDA") return false;
    if (estadoActual !== "BODEGA" && estadoActual !== "VENDIDO") return false;
    if (deboA.startsWith("SEDE ")) return false;

    return true;
  };

  const confirmarEliminacion = () => {
    if (false) {
      setErrorClave("Clave incorrecta");
    }

    if (!idEliminar) return;

    void eliminar(idEliminar);
    setModalEliminar(false);
    setIdEliminar(null);
    setClaveEliminar("");
    setErrorClave("");
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_460px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                {esAdmin ? "Inventario global" : "Inventario por sede"}
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                {esAdmin ? "Centro de inventario" : "Inventario operativo"}
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                {esAdmin
                  ? sedeFiltroId === "TODAS"
                    ? "Control consolidado de equipos, estados y trazabilidad para todas las sedes."
                    : `Vista ejecutiva de ${sedeFiltroNombre}, con foco en stock, deuda y movimientos operativos.`
                  : `Control de ${user?.sedeNombre || "tu sede"}, con acceso rapido al inventario, prestamos e historial de IMEI.`}
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Cobertura:{" "}
                  <span className="font-semibold text-white">
                    {esAdmin
                      ? sedeFiltroId === "TODAS"
                        ? "Todas las sedes"
                        : sedeFiltroNombre
                      : user?.sedeNombre || "Tu sede"}
                  </span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Equipos visibles:{" "}
                  <span className="font-semibold text-white">{itemsFiltrados.length}</span>
                </div>
              </div>

              {esAdmin && (
                <div className="mt-6 max-w-sm">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                    Cobertura
                  </label>
                  <select
                    value={sedeFiltroId}
                    onChange={(event) => setSedeFiltroId(event.target.value)}
                    className="w-full rounded-2xl border border-white/10 bg-white/95 px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-white focus:ring-2 focus:ring-white/20"
                  >
                    <option value="TODAS">Todas las sedes</option>
                    {sedes.map((sede) => (
                      <option key={sede.id} value={String(sede.id)}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="grid w-full gap-3 sm:grid-cols-2 xl:ml-auto xl:max-w-[400px]">
              <Link
                href="/dashboard"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-slate-900 transition hover:bg-white"
              >
                Volver
              </Link>

              <Link
                href="/prestamos"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-slate-900 transition hover:bg-white"
              >
                Prestamos
              </Link>

              <Link
                href="/inventario/historial"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-slate-900 transition hover:bg-white"
              >
                Ver historial
              </Link>

              <Link
                href="/inventario/nuevo"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl bg-[#cf2e2e] px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-white transition hover:bg-[#b92525]"
              >
                + Nuevo inventario
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-[26px] border border-slate-200 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <section className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <TopMetricCard
              label="En bodega"
              value={totalBodega}
              detail="Stock listo para operar."
            />
            <TopMetricCard
              label="Pendiente"
              value={totalPendiente}
              detail="Equipos con gestion pendiente."
              valueClass="text-amber-600"
            />
            <TopMetricCard
              label="Garantia"
              value={totalGarantia}
              detail="Seguimiento por postventa."
              valueClass="text-fuchsia-600"
            />
            <TopMetricCard
              label="En prestamo"
              value={totalPrestamo}
              detail="Casos ligados a deuda activa."
              valueClass="text-red-600"
            />
            <TopMetricCard
              label="Pagados"
              value={totalPagados}
              detail="Inventario con pago confirmado."
              valueClass="text-emerald-600"
            />
            <TopMetricCard
              label="Cancelados"
              value={totalCancelados}
              detail="Registros financieros cerrados."
              valueClass="text-slate-700"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
            <SummaryMetricCard
              label="Total que debo"
              value={formatoPesos(totalDeuda)}
              valueClass="text-amber-600"
              tone="warm"
            />
            <SummaryMetricCard
              label="Total pagado"
              value={formatoPesos(totalPagado)}
              valueClass="text-emerald-600"
              tone="success"
            />
          </div>
        </section>

        <section className="mt-6 rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Filtros
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Exploracion de inventario
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                Filtra por estado, deuda o texto libre para encontrar equipos mas rapido sin perder contexto operativo.
              </p>
            </div>

            <div className="flex w-full flex-col gap-4 xl:max-w-[680px]">
              <input
                type="text"
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
                placeholder="Buscar por IMEI, referencia, color, proveedor o sede..."
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />

              <div className="flex flex-wrap gap-2">
                {(["TODOS", "BODEGA", "PENDIENTE", "GARANTIA", "PRESTAMO", "DEUDA"] as EstadoFiltro[]).map((estado) => (
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
            </div>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e2d9ca] bg-white shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Listado
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Equipos registrados
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {itemsFiltrados.length} resultado{itemsFiltrados.length === 1 ? "" : "s"} visibles en esta vista.
              </p>
            </div>

            <div className="text-sm text-slate-500">
              Cobertura actual:{" "}
              <span className="font-semibold text-slate-950">
                {esAdmin
                  ? sedeFiltroId === "TODAS"
                    ? "Todas las sedes"
                    : sedeFiltroNombre
                  : user?.sedeNombre || "Tu sede"}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1400px] text-sm">
              <thead className="sticky top-0 z-10 bg-[#f8f5ef]">
                <tr className="text-left text-slate-600">
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">ID</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">IMEI</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Referencia</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Color</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Costo</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Distribuidor</th>
                  {esAdmin && (
                    <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Sede</th>
                  )}
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Deuda</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Estado</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Estado financiero</th>
                  <th className="px-4 py-4 font-semibold uppercase tracking-[0.12em]">Origen</th>
                  <th className="px-4 py-4 text-right font-semibold uppercase tracking-[0.12em]">Acciones</th>
                </tr>
              </thead>

              <tbody>
                {itemsFiltrados.length === 0 ? (
                  <tr>
                    <td
                      colSpan={esAdmin ? 12 : 11}
                      className="px-6 py-16 text-center"
                    >
                      <div className="mx-auto max-w-md">
                        <p className="text-base font-semibold text-slate-950">
                          No hay equipos registrados
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          Ajusta la cobertura, el filtro o la busqueda para explorar otros resultados.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  itemsFiltrados.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-slate-200 text-slate-700 transition hover:bg-[#fcfaf6]"
                    >
                      <td className="px-4 py-4 font-semibold text-slate-950">{item.id}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">{item.imei}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">{item.referencia}</td>
                      <td className="px-4 py-4">{item.color ?? "-"}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">
                        {formatoPesos(item.costo)}
                      </td>
                      <td className="px-4 py-4">{item.distribuidor ?? "-"}</td>
                      {esAdmin && (
                        <td className="px-4 py-4 font-semibold text-slate-900">
                          {item.sede?.nombre ?? `SEDE ${item.sedeId}`}
                        </td>
                      )}
                      <td className="px-4 py-4">{item.deboA ?? "-"}</td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${badgeClaseEstadoInventario(
                            item.estadoActual
                          )}`}
                        >
                          {item.estadoActual ?? "-"}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${badgeClaseEstadoFinanciero(
                            item.estadoFinanciero
                          )}`}
                        >
                          {item.estadoFinanciero ?? "-"}
                        </span>
                      </td>
                      <td className="px-4 py-4">{item.origen ?? "-"}</td>

                      <td className="px-4 py-4">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {puedeDevolverABodega(item) && (
                            <button
                              onClick={() => devolverABodega(item)}
                              disabled={cargando}
                              title="Devolver a bodega"
                              className="rounded-xl bg-amber-100 p-2.5 transition hover:bg-amber-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-amber-700"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M15 19l-7-7 7-7"
                                />
                              </svg>
                            </button>
                          )}

                          {puedeEnviarPrestamo(item) && (
                            <button
                              onClick={() => abrirPrestamo(item)}
                              disabled={cargando}
                              title="Enviar a sede"
                              className="rounded-xl bg-slate-100 p-2.5 transition hover:bg-slate-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-slate-700"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path d="M2.01 21l20.99-9L2.01 3v7l15 2-15 2z" />
                              </svg>
                            </button>
                          )}

                          {puedePasarAPendiente(item) && (
                            <button
                              onClick={() => cambiarEstado(item, "PENDIENTE")}
                              disabled={cargando}
                              title="Marcar pendiente"
                              className="rounded-xl bg-amber-100 p-2.5 transition hover:bg-amber-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-amber-600"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                              </svg>
                            </button>
                          )}

                          {puedePasarAGarantia(item) && (
                            <button
                              onClick={() => cambiarEstado(item, "GARANTIA")}
                              disabled={cargando}
                              title="Marcar garantia"
                              className="rounded-xl bg-fuchsia-100 p-2.5 transition hover:bg-fuchsia-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-fuchsia-600"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 18h.01M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2zm3 5l-2 3h3l-2 3"
                                />
                              </svg>
                            </button>
                          )}

                          {puedePagarDeuda(item) && (
                            <button
                              onClick={() => abrirPagoDeuda(item)}
                              disabled={cargando}
                              title="Pagar deuda"
                              className="rounded-xl bg-emerald-100 p-2.5 transition hover:bg-emerald-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-emerald-700"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 8c-2.21 0-4 .895-4 2s1.79 2 4 2 4 .895 4 2-1.79 2-4 2m0-10V6m0 12v-2"
                                />
                              </svg>
                            </button>
                          )}

                          {esAdmin && (
                            <button
                              onClick={() => {
                                setIdEliminar(item.id);
                                setModalEliminar(true);
                                setClaveEliminar("");
                                setErrorClave("");
                              }}
                              disabled={cargando}
                              title="Eliminar"
                              className="rounded-xl bg-red-100 p-2.5 transition hover:bg-red-200 disabled:opacity-70"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4 text-red-600"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                            </button>
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

      {mostrarModalPrestamo && itemPrestamo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Enviar a sede
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              IMEI: {itemPrestamo.imei}
            </p>
            <p className="text-sm text-slate-600">
              Referencia: {itemPrestamo.referencia}
            </p>

            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Sede destino
              </label>
              <select
                value={sedeDestinoId}
                onChange={(e) => setSedeDestinoId(e.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="">Seleccionar sede</option>
                {sedes
                  .filter((sede) => sede.id !== itemPrestamo.sedeId)
                  .map((sede) => (
                    <option key={sede.id} value={sede.id}>
                      {sede.nombre}
                    </option>
                  ))}
              </select>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={enviarPrestamo}
                disabled={cargando}
                className="flex-1 rounded-2xl bg-[#cf2e2e] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#b92525] disabled:opacity-70"
              >
                Confirmar envio
              </button>

              <button
                onClick={() => {
                  setMostrarModalPrestamo(false);
                  setItemPrestamo(null);
                  setSedeDestinoId("");
                }}
                className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {mostrarModalPago && itemPago && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Pagar deuda del equipo
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              IMEI: {itemPago.imei}
            </p>
            <p className="text-sm text-slate-600">
              Referencia: {itemPago.referencia}
            </p>
            <p className="mt-3 text-sm text-slate-700">
              Proveedor / acreedor:{" "}
              <span className="font-semibold">{itemPago.deboA || "-"}</span>
            </p>
            <p className="mt-1 text-sm text-slate-700">
              Valor a pagar:{" "}
              <span className="font-semibold">{formatoPesos(itemPago.costo)}</span>
            </p>

            <div className="mt-6 flex gap-3">
              <button
                onClick={pagarDeuda}
                disabled={cargando}
                className="flex-1 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-70"
              >
                Confirmar pago
              </button>

              <button
                onClick={() => {
                  setMostrarModalPago(false);
                  setItemPago(null);
                }}
                className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {modalEliminar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Autorizacion requerida
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              Ingresa la clave para eliminar el registro
            </p>

            <input
              type="password"
              value={claveEliminar}
              onChange={(e) => setClaveEliminar(e.target.value)}
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              placeholder="Ingresa clave"
            />

            {errorClave && (
              <p className="mt-2 text-sm font-medium text-red-600">{errorClave}</p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setModalEliminar(false);
                  setIdEliminar(null);
                  setClaveEliminar("");
                  setErrorClave("");
                }}
                className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>

              <button
                onClick={confirmarEliminacion}
                className="flex-1 rounded-2xl bg-[#cf2e2e] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#b92525]"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
