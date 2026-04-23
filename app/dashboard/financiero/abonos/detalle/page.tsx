"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { triggerLiveRefresh, useLiveRefresh } from "@/lib/use-live-refresh";

type Sede = {
  id: number;
  nombre: string;
};

type AbonoItem = {
  id: number;
  tipo: string;
  entidad: string | null;
  valor: number;
  observacion: string | null;
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

type CatalogoPersonalResponse = {
  financieras: Array<{ nombre: string }>;
};

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function formatoFecha(fecha: string) {
  try {
    return new Date(fecha).toLocaleString("es-CO");
  } catch {
    return fecha;
  }
}

export default function DetalleAbonosPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [financieras, setFinancieras] = useState<string[]>([""]);
  const [items, setItems] = useState<AbonoItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [sedeFiltro, setSedeFiltro] = useState("");
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [tipoEditando, setTipoEditando] = useState("TRANSFERENCIA");
  const [entidadEditando, setEntidadEditando] = useState("");
  const [valorEditando, setValorEditando] = useState("");
  const [observacionEditando, setObservacionEditando] = useState("");
  const [sedeEditando, setSedeEditando] = useState("");
  const [procesando, setProcesando] = useState(false);

  const cargarUsuario = async () => {
    const res = await fetch("/api/session", { cache: "no-store" });
    const data = await res.json();

    if (res.ok) {
      setUser(data);
    }
  };

  const cargarSedes = async () => {
    const res = await fetch("/api/sedes", { cache: "no-store" });
    const data = await res.json();

    if (res.ok) {
      setSedes(Array.isArray(data) ? data : []);
    }
  };

  const cargarFinancieras = async () => {
    try {
      const res = await fetch("/api/ventas/catalogo-personal", {
        cache: "no-store",
      });
      const data = (await res.json()) as CatalogoPersonalResponse;

      if (res.ok) {
        setFinancieras(
          Array.isArray(data.financieras) && data.financieras.length
            ? ["", ...data.financieras.map((item) => item.nombre)]
            : [""]
        );
      }
    } catch {}
  };

  const cargar = async (sedeId?: string) => {
    try {
      setMensaje("");

      const query =
        sedeId && Number(sedeId) > 0
          ? `?sedeId=${Number(sedeId)}`
          : "";

      const res = await fetch(`/api/financiero/abonos${query}`, {
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`❌ ${data.error || "Error cargando abonos"}`);
        return;
      }

      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setMensaje("❌ Error cargando abonos");
    }
  };

  useEffect(() => {
    const init = async () => {
      await Promise.all([cargarUsuario(), cargarSedes(), cargarFinancieras()]);
      await cargar();
    };

    void init();
  }, []);

  useLiveRefresh(async () => {
    await cargarUsuario();
    await cargar(sedeFiltro);
  }, { intervalMs: 10000 });

  const totalAbonos = useMemo(
    () => items.reduce((acc, item) => acc + Number(item.valor || 0), 0),
    [items]
  );

  const esAdmin = String(user?.rolNombre || "").toUpperCase() === "ADMIN";

  const cerrarEdicion = () => {
    setEditandoId(null);
    setTipoEditando("TRANSFERENCIA");
    setEntidadEditando("");
    setValorEditando("");
    setObservacionEditando("");
    setSedeEditando("");
  };

  const abrirEdicion = (item: AbonoItem) => {
    setEditandoId(item.id);
    setTipoEditando(item.tipo);
    setEntidadEditando(item.entidad ?? "");
    setValorEditando(String(Number(item.valor || 0)));
    setObservacionEditando(item.observacion ?? "");
    setSedeEditando(String(item.sedeId));
  };

  const guardarEdicion = async () => {
    if (!editandoId) return;

    try {
      setProcesando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/abonos", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: editandoId,
          tipo: tipoEditando,
          entidad: tipoEditando === "FINANCIERA" ? entidadEditando : null,
          valor: Number(valorEditando || 0),
          observacion: observacionEditando,
          sedeId: Number(sedeEditando || 0),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`❌ ${data.error || "Error actualizando abono"}`);
        return;
      }

      setMensaje("✅ Abono actualizado correctamente");
      triggerLiveRefresh("abono-financiero-actualizado");
      cerrarEdicion();
      await cargar(sedeFiltro);
    } catch {
      setMensaje("❌ Error actualizando abono");
    } finally {
      setProcesando(false);
    }
  };

  const eliminarAbono = async (id: number) => {
    const confirmado = window.confirm("¿Deseas eliminar este abono?");

    if (!confirmado) return;

    try {
      setProcesando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/abonos", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`❌ ${data.error || "Error eliminando abono"}`);
        return;
      }

      if (editandoId === id) {
        cerrarEdicion();
      }

      setMensaje("✅ Abono eliminado correctamente");
      triggerLiveRefresh("abono-financiero-eliminado");
      await cargar(sedeFiltro);
    } catch {
      setMensaje("❌ Error eliminando abono");
    } finally {
      setProcesando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f6f8] py-8 px-4">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-700">
              Financiero
            </div>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-slate-950">
              Detalle de abonos
            </h1>
            <p className="mt-2 text-sm text-slate-600 md:text-base">
              Histórico de abonos de transferencias y financieras.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/dashboard/financiero/abonos"
              className="rounded-2xl bg-red-600 px-5 py-3 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-red-700"
            >
              + Registrar abono
            </Link>

            <Link
              href="/dashboard/financiero"
              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              ← Volver
            </Link>
          </div>
        </div>

        {esAdmin && (
          <div className="mb-6 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Filtrar por sede
                </label>
                <select
                  value={sedeFiltro}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSedeFiltro(value);
                    void cargar(value);
                  }}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                >
                  <option value="">Todas las sedes</option>
                  {sedes.map((sede) => (
                    <option key={sede.id} value={sede.id}>
                      {sede.nombre}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Total abonos</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">
                  {formatoPesos(totalAbonos)}
                </p>
              </div>
            </div>
          </div>
        )}

        {!esAdmin && (
          <div className="mb-6 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">Total abonos</p>
            <p className="mt-2 text-2xl font-bold text-slate-900">
              {formatoPesos(totalAbonos)}
            </p>
          </div>
        )}

        {mensaje && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <div className="overflow-hidden rounded-[28px] bg-white shadow-xl ring-1 ring-slate-200">
          <div className="border-b border-slate-200 px-6 py-5">
            <h2 className="text-lg font-semibold text-slate-900">
              Abonos registrados
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-slate-700">
                  <th className="px-6 py-4 font-semibold">ID</th>
                  <th className="px-6 py-4 font-semibold">Fecha</th>
                  <th className="px-6 py-4 font-semibold">Tipo</th>
                  <th className="px-6 py-4 font-semibold">Entidad</th>
                  <th className="px-6 py-4 font-semibold">Valor</th>
                  <th className="px-6 py-4 font-semibold">Observación</th>
                  <th className="px-6 py-4 font-semibold">Sede</th>
                  {esAdmin && (
                    <th className="px-6 py-4 font-semibold">Acciones</th>
                  )}
                </tr>
              </thead>

              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={esAdmin ? 8 : 7}
                      className="px-6 py-12 text-center text-slate-500"
                    >
                      No hay abonos registrados.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-slate-100 text-slate-700 transition hover:bg-slate-50"
                    >
                      <td className="px-6 py-4 font-medium text-slate-900">
                        {item.id}
                      </td>
                      <td className="px-6 py-4">
                        {formatoFecha(item.createdAt)}
                      </td>
                      <td className="px-6 py-4">{item.tipo}</td>
                      <td className="px-6 py-4">{item.entidad ?? "-"}</td>
                      <td className="px-6 py-4 font-semibold text-emerald-700">
                        {formatoPesos(item.valor)}
                      </td>
                      <td className="px-6 py-4">{item.observacion ?? "-"}</td>
                      <td className="px-6 py-4">
                        {item.sede?.nombre ?? `SEDE ${item.sedeId}`}
                      </td>
                      {esAdmin && (
                        <td className="px-6 py-4">
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => abrirEdicion(item)}
                              disabled={procesando}
                              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                            >
                              Editar
                            </button>

                            <button
                              type="button"
                              onClick={() => eliminarAbono(item.id)}
                              disabled={procesando}
                              className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-70"
                            >
                              Eliminar
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
        </div>

        {esAdmin && editandoId !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-bold text-slate-950">
                    Editar abono
                  </h3>
                  <p className="mt-2 text-sm text-slate-600">
                    Solo el administrador puede modificar o eliminar abonos.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={cerrarEdicion}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Cerrar
                </button>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Tipo
                  </label>
                  <select
                    value={tipoEditando}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTipoEditando(value);
                      if (value !== "FINANCIERA") {
                        setEntidadEditando("");
                      }
                    }}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  >
                    <option value="TRANSFERENCIA">TRANSFERENCIA</option>
                    <option value="FINANCIERA">FINANCIERA</option>
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Sede
                  </label>
                  <select
                    value={sedeEditando}
                    onChange={(e) => setSedeEditando(e.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  >
                    <option value="">Seleccionar sede</option>
                    {sedes.map((sede) => (
                      <option key={sede.id} value={sede.id}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Entidad
                  </label>
                  {tipoEditando === "FINANCIERA" ? (
                    <select
                      value={entidadEditando}
                      onChange={(e) => setEntidadEditando(e.target.value)}
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                    >
                      {financieras.map((financiera) => (
                        <option key={financiera} value={financiera}>
                          {financiera || "Seleccionar financiera"}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value="TRANSFERENCIA"
                      readOnly
                      className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 outline-none"
                    />
                  )}
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Valor
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={valorEditando}
                    onChange={(e) => setValorEditando(e.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Observación
                  </label>
                  <input
                    value={observacionEditando}
                    onChange={(e) => setObservacionEditando(e.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  />
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={guardarEdicion}
                  disabled={procesando}
                  className="flex-1 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-70"
                >
                  {procesando ? "Guardando..." : "Guardar cambios"}
                </button>

                <button
                  type="button"
                  onClick={cerrarEdicion}
                  disabled={procesando}
                  className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
