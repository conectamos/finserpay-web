"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type ItemPrincipal = {
  id: number;
  imei: string;
  referencia: string;
  color: string | null;
  costo: number;
  numeroFactura: string | null;
  distribuidor: string | null;
  estado?: string | null;
  sedeDestinoId?: number | null;
  estadoCobro?: string | null;
};

type Sede = {
  id: number;
  nombre: string;
};

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
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

export default function InventarioPrincipalPage() {
  const [items, setItems] = useState<ItemPrincipal[]>([]);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);
  const [busqueda, setBusqueda] = useState("");

  const [mostrarModal, setMostrarModal] = useState(false);
  const [itemSeleccionado, setItemSeleccionado] = useState<ItemPrincipal | null>(null);
  const [sedeDestinoId, setSedeDestinoId] = useState("");

  const mensajeEsError = mensaje.trim().toUpperCase().startsWith("ERROR");

  const cargarInventarioPrincipal = useCallback(async () => {
    try {
      setMensaje("");

      const res = await fetch("/api/inventario-principal", {
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error cargando bodega principal"}`);
        return;
      }

      setItems(Array.isArray(data) ? data : []);
    } catch {
      setMensaje("Error cargando inventario principal");
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

  useEffect(() => {
    void cargarInventarioPrincipal();
    void cargarSedes();
  }, [cargarInventarioPrincipal, cargarSedes]);

  useLiveRefresh(cargarInventarioPrincipal, { intervalMs: 10000 });

  const totalValor = useMemo(
    () => items.reduce((acc, item) => acc + Number(item.costo || 0), 0),
    [items]
  );

  const equiposDisponibles = useMemo(
    () =>
      items.filter(
        (item) => String(item.estado || "BODEGA").toUpperCase() === "BODEGA"
      ),
    [items]
  );

  const equiposEnviados = useMemo(
    () =>
      items.filter(
        (item) => ["PRESTAMO", "PAGO"].includes(String(item.estado || "").toUpperCase())
      ),
    [items]
  );

  const pendientesCobro = useMemo(
    () => items.filter((item) => String(item.estadoCobro || "").toUpperCase() === "PENDIENTE"),
    [items]
  );

  const itemsFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase();

    if (!termino) {
      return items;
    }

    return items.filter((item) => {
      const sedeDestino =
        sedes.find((sede) => sede.id === item.sedeDestinoId)?.nombre || "";

      return [
        String(item.imei || ""),
        String(item.referencia || ""),
        String(item.color || ""),
        String(item.distribuidor || ""),
        String(item.numeroFactura || ""),
        String(item.estado || ""),
        String(item.estadoCobro || ""),
        sedeDestino,
      ]
        .join(" ")
        .toLowerCase()
        .includes(termino);
    });
  }, [busqueda, items, sedes]);

  const eliminar = async (id: number) => {
    const confirmado = window.confirm(
      "Seguro que deseas eliminar este equipo de bodega principal?"
    );

    if (!confirmado) {
      return;
    }

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario-principal/eliminar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error eliminando equipo"}`);
        return;
      }

      setMensaje("Equipo eliminado correctamente");
      await cargarInventarioPrincipal();
    } catch {
      setMensaje("Error eliminando equipo");
    } finally {
      setCargando(false);
    }
  };

  const cerrarModal = () => {
    setMostrarModal(false);
    setItemSeleccionado(null);
    setSedeDestinoId("");
  };

  const abrirModalEnvio = (item: ItemPrincipal) => {
    setItemSeleccionado(item);
    setSedeDestinoId("");
    setMostrarModal(true);
  };

  const enviarASede = async () => {
    if (!itemSeleccionado) {
      return;
    }

    if (!sedeDestinoId) {
      setMensaje("Debes seleccionar una sede destino");
      return;
    }

    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/inventario-principal/enviar-a-sede", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: itemSeleccionado.id,
          sedeDestinoId: Number(sedeDestinoId),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error enviando a sede"}`);
        return;
      }

      setMensaje(data.mensaje || "Equipo enviado correctamente a la sede");
      cerrarModal();
      await cargarInventarioPrincipal();
    } catch {
      setMensaje("Error enviando equipo a sede");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                Bodega principal
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Centro de inventario principal
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                Controla el stock de bodega antes de enviarlo a sedes, revisa valor disponible y gestiona salidas con una vista mas ejecutiva.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Equipos visibles:{" "}
                  <span className="font-semibold text-white">{itemsFiltrados.length}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Disponibles:{" "}
                  <span className="font-semibold text-white">{equiposDisponibles.length}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Pendientes de cobro:{" "}
                  <span className="font-semibold text-white">{pendientesCobro.length}</span>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:ml-auto xl:max-w-[380px]">
              <Link
                href="/inventario/nuevo"
                className="inline-flex h-[58px] w-full items-center justify-center rounded-2xl bg-[#cf2e2e] px-6 text-center text-[15px] font-bold leading-none tracking-[0.01em] text-white transition hover:bg-[#b92525]"
              >
                + Nuevo inventario
              </Link>

              <Link
                href="/dashboard"
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

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Equipos en bodega"
            value={equiposDisponibles.length}
            detail="Stock listo para enviar a sede."
          />
          <MetricCard
            label="Valor disponible"
            value={formatoPesos(totalValor)}
            detail="Valor total del inventario principal."
          />
          <MetricCard
            label="Enviados a sede"
            value={equiposEnviados.length}
            detail="Equipos ya despachados desde bodega."
            valueClass="text-sky-700"
          />
          <MetricCard
            label="Cobro pendiente"
            value={pendientesCobro.length}
            detail="Casos enviados con seguimiento de cobro."
            valueClass="text-amber-600"
          />
        </section>

        <section className="mt-6 rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Exploracion de bodega
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Stock de inventario principal
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                Busca por IMEI, referencia, factura, distribuidor o estado para operar mas rapido sobre la bodega principal.
              </p>
            </div>

            <div className="w-full xl:max-w-[520px]">
              <input
                type="text"
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
                placeholder="Buscar por IMEI, referencia, factura, distribuidor o estado..."
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
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
                Equipos en bodega principal
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Administra disponibilidad, despacho hacia sedes y eliminacion de registros.
              </p>
            </div>

            <div className="text-sm font-medium text-slate-500">
              {itemsFiltrados.length} resultado(s)
            </div>
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
                  <th className="px-4 py-4">Factura</th>
                  <th className="px-4 py-4">Distribuidor</th>
                  <th className="px-4 py-4">Estado</th>
                  <th className="px-4 py-4">Cobro</th>
                  <th className="px-4 py-4">Sede destino</th>
                  <th className="px-4 py-4">Acciones</th>
                </tr>
              </thead>

              <tbody>
                {itemsFiltrados.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-6 py-16 text-center text-slate-500">
                      No hay equipos que coincidan en inventario principal.
                    </td>
                  </tr>
                ) : (
                  itemsFiltrados.map((item) => {
                    const estadoNormalizado = String(item.estado || "BODEGA").toUpperCase();
                    const enviado = estadoNormalizado === "PRESTAMO";
                    const pagado = estadoNormalizado === "PAGO";
                    const bloqueadoParaEnvio = estadoNormalizado !== "BODEGA";
                    const sedeDestino =
                      sedes.find((sede) => sede.id === item.sedeDestinoId)?.nombre || "-";

                    return (
                      <tr
                        key={item.id}
                        className="border-b border-slate-100 align-top text-slate-700 transition hover:bg-[#faf7f1]"
                      >
                        <td className="px-4 py-4 font-bold text-slate-950">{item.id}</td>
                        <td className="px-4 py-4 font-semibold text-slate-950">{item.imei}</td>
                        <td className="px-4 py-4">{item.referencia}</td>
                        <td className="px-4 py-4">{item.color ?? "-"}</td>
                        <td className="px-4 py-4 font-semibold text-slate-950">
                          {formatoPesos(item.costo)}
                        </td>
                        <td className="px-4 py-4">{item.numeroFactura ?? "-"}</td>
                        <td className="px-4 py-4">{item.distribuidor ?? "-"}</td>
                        <td className="px-4 py-4">
                          <span
                            className={[
                              "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                              enviado
                                ? "border-sky-200 bg-sky-50 text-sky-700"
                                : pagado
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-slate-200 bg-slate-100 text-slate-700",
                            ].join(" ")}
                          >
                            {estadoNormalizado}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={[
                              "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                              String(item.estadoCobro || "").toUpperCase() === "PENDIENTE"
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-slate-200 bg-slate-100 text-slate-500",
                            ].join(" ")}
                          >
                            {item.estadoCobro ?? "-"}
                          </span>
                        </td>
                        <td className="px-4 py-4">{item.sedeDestinoId ? sedeDestino : "-"}</td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => abrirModalEnvio(item)}
                              disabled={cargando || bloqueadoParaEnvio}
                              className="rounded-xl bg-[#111318] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1d2330] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Enviar a sede
                            </button>

                            <button
                              onClick={() => eliminar(item.id)}
                              disabled={cargando}
                              className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-70"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {mostrarModal && itemSeleccionado && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-[30px] border border-[#e2d9ca] bg-white p-6 shadow-2xl">
            <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
              Envio a sede
            </div>
            <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              Confirmar despacho
            </h3>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              <p>
                <span className="font-semibold text-slate-950">IMEI:</span> {itemSeleccionado.imei}
              </p>
              <p>
                <span className="font-semibold text-slate-950">Referencia:</span>{" "}
                {itemSeleccionado.referencia}
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
              El equipo ingresara de inmediato en la sede destino con estado{" "}
              <span className="font-semibold">BODEGA</span> y deuda activa a{" "}
              <span className="font-semibold">Proveedor Finser</span>.
            </div>

            <div className="mt-5">
              <label className="mb-2 block text-[12px] font-bold uppercase tracking-[0.14em] text-slate-600">
                Sede destino
              </label>
              <select
                value={sedeDestinoId}
                onChange={(event) => setSedeDestinoId(event.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="">Seleccionar sede</option>
                {sedes.map((sede) => (
                  <option key={sede.id} value={sede.id}>
                    {sede.nombre}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                onClick={enviarASede}
                disabled={cargando}
                className="inline-flex h-[56px] w-full items-center justify-center rounded-2xl bg-[#111318] px-5 text-sm font-bold text-white transition hover:bg-[#1d2330] disabled:opacity-70"
              >
                Confirmar envio
              </button>

              <button
                onClick={cerrarModal}
                className="inline-flex h-[56px] w-full items-center justify-center rounded-2xl border border-slate-300 bg-white px-5 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
