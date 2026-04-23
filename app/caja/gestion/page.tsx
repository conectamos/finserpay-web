"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Sede = {
  id: number;
  nombre: string;
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

type CajaMovimiento = {
  id: number;
  tipo: string;
  concepto: string;
  valor: number;
  descripcion: string | null;
  sedeId: number;
  createdAt: string;
  editable: boolean;
  sede?: {
    nombre: string;
  };
};

function limpiarNumero(value: string) {
  return value.replace(/\D/g, "");
}

function formatoPesos(value: string | number) {
  const numero = Number(value || 0);
  if (!numero) return "";
  return `$ ${numero.toLocaleString("es-CO")}`;
}

function formatoFecha(value: string) {
  return new Date(value).toLocaleString("es-CO");
}

function tipoBadgeClass(tipo: string) {
  return String(tipo || "").toUpperCase() === "INGRESO"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-red-200 bg-red-50 text-red-700";
}

export default function CajaGestionPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [movimientos, setMovimientos] = useState<CajaMovimiento[]>([]);

  const [tipo, setTipo] = useState<"INGRESO" | "EGRESO">("INGRESO");
  const [concepto, setConcepto] = useState("");
  const [valor, setValor] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [sedeId, setSedeId] = useState("");
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [eliminandoId, setEliminandoId] = useState<number | null>(null);

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const cargarUsuario = async () => {
    try {
      const resUser = await fetch("/api/session", { cache: "no-store" });
      const dataUser = await resUser.json();

      if (resUser.ok) {
        setUser(dataUser);
        setSedeId((current) => current || String(dataUser.sedeId || ""));
      }

      if (dataUser?.rolNombre?.toUpperCase() === "ADMIN") {
        const resSedes = await fetch("/api/sedes", { cache: "no-store" });
        const dataSedes = await resSedes.json();

        if (resSedes.ok) {
          setSedes(Array.isArray(dataSedes) ? dataSedes : []);
        }
      }
    } catch {
      setMensaje("Error cargando informacion inicial");
    }
  };

  const cargarMovimientos = async () => {
    try {
      const params = new URLSearchParams();

      if (esAdmin && sedeId) {
        params.set("sedeId", sedeId);
      }

      const endpoint = params.size ? `/api/caja?${params.toString()}` : "/api/caja";
      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setMovimientos(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  useEffect(() => {
    void cargarUsuario();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) {
      return;
    }

    const timer = window.setTimeout(() => {
      void cargarMovimientos();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [user, sedeId]);

  useLiveRefresh(cargarMovimientos, { intervalMs: 12000 });

  const limpiarFormulario = () => {
    setTipo("INGRESO");
    setConcepto("");
    setValor("");
    setDescripcion("");
    setEditandoId(null);
  };

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      if (!tipo) {
        setMensaje("Debes seleccionar el tipo");
        return;
      }

      if (!concepto.trim()) {
        setMensaje("Debes ingresar el concepto");
        return;
      }

      if (!valor || Number(valor) <= 0) {
        setMensaje("Debes ingresar un valor mayor a 0");
        return;
      }

      if (!sedeId || Number(sedeId) <= 0) {
        setMensaje("Debes seleccionar la sede");
        return;
      }

      const endpoint = editandoId ? `/api/caja?id=${editandoId}` : "/api/caja/registrar";
      const method = editandoId ? "PUT" : "POST";

      const res = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tipo,
          concepto,
          valor: Number(valor),
          descripcion,
          sedeId: Number(sedeId),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error al guardar movimiento");
        return;
      }

      setMensaje(
        data.mensaje ||
          (editandoId
            ? "Movimiento actualizado correctamente"
            : "Movimiento registrado correctamente")
      );

      limpiarFormulario();
      await cargarMovimientos();
    } catch {
      setMensaje("Error al guardar movimiento");
    } finally {
      setGuardando(false);
    }
  };

  const iniciarEdicion = (movimiento: CajaMovimiento) => {
    setEditandoId(movimiento.id);
    setTipo(
      String(movimiento.tipo).toUpperCase() === "EGRESO" ? "EGRESO" : "INGRESO"
    );
    setConcepto(movimiento.concepto || "");
    setValor(String(Math.trunc(Number(movimiento.valor || 0))));
    setDescripcion(movimiento.descripcion || "");
    setSedeId(String(movimiento.sedeId));
    setMensaje("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const eliminar = async (movimiento: CajaMovimiento) => {
    const confirmado = window.confirm(
      `Deseas eliminar el movimiento #${movimiento.id}?`
    );

    if (!confirmado) {
      return;
    }

    try {
      setEliminandoId(movimiento.id);
      setMensaje("");

      const res = await fetch(`/api/caja?id=${movimiento.id}`, {
        method: "DELETE",
      });
      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo eliminar el movimiento");
        return;
      }

      if (editandoId === movimiento.id) {
        limpiarFormulario();
      }

      setMensaje(data.mensaje || "Movimiento eliminado correctamente");
      await cargarMovimientos();
    } catch {
      setMensaje("Error eliminando movimiento");
    } finally {
      setEliminandoId(null);
    }
  };

  const totalManualVisible = useMemo(
    () => movimientos.filter((movimiento) => movimiento.editable).length,
    [movimientos]
  );

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#eef2f7_28%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1480px]">
        <section className="relative overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_48%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_26%),radial-gradient(circle_at_bottom_left,rgba(251,191,36,0.18),transparent_24%)]" />

          <div className="relative flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Caja / Gestion
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Ingresos y egresos
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Registra movimientos manuales de caja y, si eres administrador,
                corrige o elimina los registros manuales sin tocar los movimientos
                automaticos del sistema.
              </p>

              <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-200">
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Cobertura:{" "}
                  <span className="font-semibold text-white">
                    {esAdmin
                      ? sedes.find((sede) => String(sede.id) === sedeId)?.nombre ||
                        "Sede seleccionada"
                      : user?.sedeNombre || "Sede actual"}
                  </span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Manuales visibles:{" "}
                  <span className="font-semibold text-white">
                    {totalManualVisible}
                  </span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Modo:{" "}
                  <span className="font-semibold text-white">
                    {editandoId ? "Edicion" : "Registro"}
                  </span>
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
              <Link
                href="/caja"
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

        <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <section className="overflow-hidden rounded-[32px] border border-[#e8e0d1] bg-[linear-gradient(180deg,#ffffff_0%,#fbf9f4_100%)] shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
            <div className="border-b border-[#ece5d8] px-6 py-5">
              <div className="inline-flex rounded-full border border-[#ddd2bf] bg-[#faf6ee] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7b5b2b]">
                {editandoId ? "Edicion manual" : "Registro manual"}
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                {editandoId ? "Editar movimiento" : "Registrar movimiento"}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {editandoId
                  ? "Actualiza el movimiento seleccionado y guarda los cambios."
                  : "Registra entradas o salidas de dinero directamente en caja."}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-5 p-6 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Tipo
                </label>
                <select
                  value={tipo}
                  onChange={(event) =>
                    setTipo(event.target.value as "INGRESO" | "EGRESO")
                  }
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200"
                >
                  <option value="INGRESO">INGRESO</option>
                  <option value="EGRESO">EGRESO</option>
                </select>
              </div>

              {esAdmin ? (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Sede
                  </label>
                  <select
                    value={sedeId}
                    onChange={(event) => setSedeId(event.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  >
                    <option value="">Seleccionar sede</option>
                    {sedes.map((sede) => (
                      <option key={sede.id} value={sede.id}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Sede
                  </label>
                  <input
                    value={user?.sedeNombre || ""}
                    readOnly
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base text-slate-700 outline-none"
                  />
                </div>
              )}

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Concepto
                </label>
                <input
                  value={concepto}
                  onChange={(event) => setConcepto(event.target.value)}
                  placeholder="Ej: INGRESO EXTRA, PAGO TRANSPORTE, APOYO COMERCIAL..."
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Valor
                </label>
                <input
                  value={valor ? formatoPesos(valor) : ""}
                  onChange={(event) => setValor(limpiarNumero(event.target.value))}
                  placeholder="$ 0"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Descripcion
                </label>
                <input
                  value={descripcion}
                  onChange={(event) => setDescripcion(event.target.value)}
                  placeholder="Detalle opcional"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200"
                />
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-[#ece5d8] px-6 py-5 sm:flex-row">
              <button
                type="button"
                onClick={() => void guardar()}
                disabled={guardando}
                className="flex-1 rounded-2xl bg-red-600 px-6 py-4 text-lg font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {guardando
                  ? "Guardando..."
                  : editandoId
                    ? "Guardar cambios"
                    : `Registrar ${tipo.toLowerCase()}`}
              </button>

              <button
                type="button"
                onClick={limpiarFormulario}
                className="flex-1 rounded-2xl border border-slate-300 bg-white px-6 py-4 text-lg font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                {editandoId ? "Cancelar edicion" : "Limpiar"}
              </button>
            </div>
          </section>

          <section className="overflow-hidden rounded-[32px] border border-[#e8e0d1] bg-[linear-gradient(180deg,#ffffff_0%,#fbf9f4_100%)] shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
            <div className="flex flex-col gap-3 border-b border-[#ece5d8] px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-[#ddd2bf] bg-[#faf6ee] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7b5b2b]">
                  Historial visible
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                  Movimientos recientes
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  {esAdmin
                    ? "El administrador puede editar o eliminar solo movimientos manuales. Los automaticos quedan protegidos."
                    : "Consulta los movimientos recientes registrados dentro de tu sede."}
                </p>
              </div>

              <div className="text-sm text-slate-500">
                {movimientos.length} registro{movimientos.length === 1 ? "" : "s"}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[980px] text-sm">
                <thead className="bg-[#f8f5ee] text-slate-600">
                  <tr>
                    <th className="px-5 py-4 text-left font-semibold">ID</th>
                    <th className="px-5 py-4 text-left font-semibold">Tipo</th>
                    <th className="px-5 py-4 text-left font-semibold">Concepto</th>
                    <th className="px-5 py-4 text-left font-semibold">Valor</th>
                    <th className="px-5 py-4 text-left font-semibold">Sede</th>
                    <th className="px-5 py-4 text-left font-semibold">Descripcion</th>
                    <th className="px-5 py-4 text-left font-semibold">Fecha</th>
                    {esAdmin && (
                      <th className="px-5 py-4 text-left font-semibold">Acciones</th>
                    )}
                  </tr>
                </thead>

                <tbody>
                  {movimientos.length === 0 ? (
                    <tr>
                      <td
                        colSpan={esAdmin ? 8 : 7}
                        className="px-6 py-16 text-center text-slate-500"
                      >
                        No hay movimientos visibles para esta sede.
                      </td>
                    </tr>
                  ) : (
                    movimientos.map((movimiento) => (
                      <tr
                        key={movimiento.id}
                        className="border-t border-[#eee7da] align-top transition hover:bg-white/80"
                      >
                        <td className="px-5 py-5">
                          <span className="font-bold text-slate-950">
                            #{movimiento.id}
                          </span>
                        </td>

                        <td className="px-5 py-5">
                          <span
                            className={[
                              "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                              tipoBadgeClass(movimiento.tipo),
                            ].join(" ")}
                          >
                            {movimiento.tipo}
                          </span>
                        </td>

                        <td className="px-5 py-5">
                          <p className="font-semibold text-slate-950">
                            {movimiento.concepto}
                          </p>
                          {!movimiento.editable && (
                            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                              Automatico del sistema
                            </p>
                          )}
                        </td>

                        <td className="px-5 py-5">
                          <p
                            className={[
                              "text-lg font-black",
                              movimiento.tipo === "INGRESO"
                                ? "text-emerald-600"
                                : "text-red-600",
                            ].join(" ")}
                          >
                            {formatoPesos(movimiento.valor)}
                          </p>
                        </td>

                        <td className="px-5 py-5 text-slate-700">
                          {movimiento.sede?.nombre || `SEDE ${movimiento.sedeId}`}
                        </td>

                        <td className="px-5 py-5">
                          <p className="max-w-[280px] leading-6 text-slate-600">
                            {movimiento.descripcion || "-"}
                          </p>
                        </td>

                        <td className="px-5 py-5 text-slate-600">
                          {formatoFecha(movimiento.createdAt)}
                        </td>

                        {esAdmin && (
                          <td className="px-5 py-5">
                            {movimiento.editable ? (
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => iniciarEdicion(movimiento)}
                                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                                >
                                  Editar
                                </button>

                                <button
                                  type="button"
                                  onClick={() => void eliminar(movimiento)}
                                  disabled={eliminandoId === movimiento.id}
                                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-70"
                                >
                                  {eliminandoId === movimiento.id
                                    ? "Eliminando..."
                                    : "Eliminar"}
                                </button>
                              </div>
                            ) : (
                              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                                Protegido
                              </span>
                            )}
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
    </div>
  );
}
