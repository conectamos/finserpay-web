"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type SedeItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activa?: boolean;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activo: boolean;
  sedes: SedeItem[];
  totalSedes: number;
  totalCreditos: number;
  totalRecaudos: number;
};

type AliadosPayload = {
  aliados: AliadoItem[];
  sedesSinAliado: SedeItem[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CO").format(value || 0);
}

function normalizeList(items: SedeItem[]) {
  return [...items].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

export default function AliadosClient() {
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [sedesSinAliado, setSedesSinAliado] = useState<SedeItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const [seleccionSedes, setSeleccionSedes] = useState<Record<number, number[]>>({});

  const cargarAliados = async () => {
    try {
      setMensaje("");
      const res = await fetch("/api/aliados/admin", { cache: "no-store" });
      const data = (await res.json()) as Partial<AliadosPayload> & {
        error?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo cargar la gestion de aliados");
        return;
      }

      const items = Array.isArray(data.aliados) ? data.aliados : [];
      setAliados(items);
      setSedesSinAliado(Array.isArray(data.sedesSinAliado) ? data.sedesSinAliado : []);
      setSeleccionSedes(
        items.reduce((acc: Record<number, number[]>, aliado) => {
          acc[aliado.id] = aliado.sedes.map((sede) => sede.id);
          return acc;
        }, {})
      );
    } catch {
      setMensaje("Error cargando la gestion de aliados");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarAliados();
  }, []);

  const todasLasSedes = useMemo(() => {
    const map = new Map<number, SedeItem>();

    aliados.forEach((aliado) => {
      aliado.sedes.forEach((sede) => {
        map.set(sede.id, sede);
      });
    });

    sedesSinAliado.forEach((sede) => {
      map.set(sede.id, sede);
    });

    return normalizeList(Array.from(map.values()));
  }, [aliados, sedesSinAliado]);

  const crearAliado = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/aliados/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nombre,
          codigo,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear el aliado");
        return;
      }

      setMensaje(data.mensaje || "Aliado creado correctamente");
      setNombre("");
      setCodigo("");
      await cargarAliados();
    } catch {
      setMensaje("Error creando aliado");
    } finally {
      setGuardando(false);
    }
  };

  const toggleSede = (aliadoId: number, sedeId: number) => {
    setSeleccionSedes((actual) => {
      const actuales = new Set(actual[aliadoId] || []);

      if (actuales.has(sedeId)) {
        actuales.delete(sedeId);
      } else {
        actuales.add(sedeId);
      }

      return {
        ...actual,
        [aliadoId]: Array.from(actuales),
      };
    });
  };

  const guardarSedes = async (aliado: AliadoItem) => {
    try {
      setProcesandoId(aliado.id);
      setMensaje("");

      const res = await fetch("/api/aliados/admin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aliadoId: aliado.id,
          sedeIds: seleccionSedes[aliado.id] || [],
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo guardar el aliado");
        return;
      }

      setMensaje(data.mensaje || "Aliado actualizado correctamente");
      await cargarAliados();
    } catch {
      setMensaje("Error actualizando aliado");
    } finally {
      setProcesandoId(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#eef3f7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="rounded-[28px] border border-[#d5dde7] bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] sm:p-7">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.28em] text-emerald-700">
                Admin aliados
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-5xl">
                Aliados comerciales
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Agrupa sedes por aliado. FINSER PAY mantiene cartera y control central; cada aliado solo se prepara para ver sus creditos y recaudos por sede.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/dashboard"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:border-slate-300"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/sedes"
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-800 transition hover:bg-emerald-100"
              >
                Sedes
              </Link>
            </div>
          </div>
        </header>

        <section className="rounded-[24px] border border-emerald-200 bg-white p-5 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
          <div className="grid gap-3 lg:grid-cols-[1fr_220px_160px] lg:items-end">
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                Nuevo aliado
              </span>
              <input
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder="Ej: PUNTO CELULAR"
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none transition focus:border-emerald-400"
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                Codigo
              </span>
              <input
                value={codigo}
                onChange={(event) => setCodigo(event.target.value)}
                placeholder="PUNTO-CELULAR"
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none transition focus:border-emerald-400"
              />
            </label>

            <button
              onClick={crearAliado}
              disabled={guardando || !nombre.trim()}
              className="rounded-2xl bg-[#101318] px-5 py-3 text-sm font-black text-white transition hover:bg-[#1f2630] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {guardando ? "Guardando..." : "Crear aliado"}
            </button>
          </div>

          {mensaje ? (
            <p className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
              {mensaje}
            </p>
          ) : null}
        </section>

        {cargando ? (
          <section className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm font-bold text-slate-500">
            Cargando aliados...
          </section>
        ) : (
          <section className="grid gap-4 lg:grid-cols-2">
            {aliados.map((aliado) => {
              const selected = new Set(seleccionSedes[aliado.id] || []);

              return (
                <article
                  key={aliado.id}
                  className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_14px_34px_rgba(15,23,42,0.06)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.24em] text-emerald-700">
                        {aliado.codigo || "SIN CODIGO"}
                      </p>
                      <h2 className="mt-2 text-2xl font-black">{aliado.nombre}</h2>
                      <p className="mt-1 text-xs font-bold text-slate-500">
                        {aliado.activo ? "Activo" : "Inactivo"}
                      </p>
                    </div>

                    <button
                      onClick={() => guardarSedes(aliado)}
                      disabled={procesandoId === aliado.id}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {procesandoId === aliado.id ? "Guardando..." : "Guardar sedes"}
                    </button>
                  </div>

                  <div className="mt-5 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                        Sedes
                      </p>
                      <p className="mt-1 text-xl font-black">{formatNumber(aliado.totalSedes)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                        Creditos
                      </p>
                      <p className="mt-1 text-xl font-black">{formatNumber(aliado.totalCreditos)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                        Recaudos
                      </p>
                      <p className="mt-1 text-xl font-black">{formatNumber(aliado.totalRecaudos)}</p>
                    </div>
                  </div>

                  <div className="mt-5">
                    <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                      Sedes del aliado
                    </p>
                    <div className="mt-3 grid max-h-64 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                      {todasLasSedes.map((sede) => (
                        <label
                          key={`${aliado.id}-${sede.id}`}
                          className={[
                            "flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-bold transition",
                            selected.has(sede.id)
                              ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                              : "border-slate-200 bg-white text-slate-600",
                          ].join(" ")}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(sede.id)}
                            onChange={() => toggleSede(aliado.id, sede.id)}
                            className="h-4 w-4 accent-emerald-600"
                          />
                          <span className="min-w-0">
                            <span className="block truncate">{sede.nombre}</span>
                            <span className="block text-[11px] text-slate-400">
                              {sede.codigo || `SEDE-${sede.id}`}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
