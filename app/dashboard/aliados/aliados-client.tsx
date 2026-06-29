"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SedeItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activo: boolean;
  redescuentoPorcentaje: number;
  sedes: SedeItem[];
  totalSedes: number;
  totalCreditos: number;
  totalRecaudos: number;
};

type NuevaSedeState = {
  nombre: string;
  codigo: string;
  usuario: string;
  clave: string;
};

type AliadosPayload = {
  scope?: {
    central: boolean;
    aliadoId: number | null;
  };
  sistemaCentral?: AliadoItem | null;
  aliados: AliadoItem[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CO").format(value || 0);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function slugUsuarioSede(valor: string) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizarUsuarioLogin(valor: string) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

function usuarioSugeridoSede(aliado: Pick<AliadoItem, "codigo" | "nombre">, sedeNombre: string) {
  const aliadoSlug = slugUsuarioSede(aliado.codigo || aliado.nombre);
  const sedeSlug = slugUsuarioSede(sedeNombre);

  return [aliadoSlug, sedeSlug].filter(Boolean).join(".");
}

function emptySedeForm(): NuevaSedeState {
  return {
    nombre: "",
    codigo: "",
    usuario: "",
    clave: "",
  };
}

export default function AliadosClient() {
  const [sistemaCentral, setSistemaCentral] = useState<AliadoItem | null>(null);
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const [redescuentoPorcentaje, setRedescuentoPorcentaje] = useState("10");
  const [redescuentoInputs, setRedescuentoInputs] = useState<Record<number, string>>({});
  const [sedesForm, setSedesForm] = useState<Record<number, NuevaSedeState>>({});
  const [esCentral, setEsCentral] = useState(true);

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
      setSistemaCentral(data.sistemaCentral || null);
      setAliados(items);
      setEsCentral(Boolean(data.scope?.central));
      setRedescuentoInputs(
        items.reduce((acc: Record<number, string>, aliado) => {
          acc[aliado.id] = String(Number(aliado.redescuentoPorcentaje || 0));
          return acc;
        }, {})
      );
      setSedesForm((actual) =>
        items.reduce((acc: Record<number, NuevaSedeState>, aliado) => {
          acc[aliado.id] = actual[aliado.id] || emptySedeForm();
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
          redescuentoPorcentaje,
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
      setRedescuentoPorcentaje("10");
      await cargarAliados();
    } catch {
      setMensaje("Error creando aliado");
    } finally {
      setGuardando(false);
    }
  };

  const actualizarSedeForm = (
    aliadoId: number,
    campo: keyof NuevaSedeState,
    valor: string
  ) => {
    setSedesForm((actual) => {
      const previo = actual[aliadoId] || emptySedeForm();
      const siguiente = {
        ...previo,
        [campo]: valor,
      };

      if (
        campo === "nombre" &&
        (!previo.usuario ||
          previo.usuario === usuarioSugeridoSede(
            aliados.find((aliado) => aliado.id === aliadoId) || {
              codigo: "",
              nombre: "",
            },
            previo.nombre
          ))
      ) {
        const aliado = aliados.find((item) => item.id === aliadoId);
        siguiente.usuario = aliado ? usuarioSugeridoSede(aliado, valor) : slugUsuarioSede(valor);
      }

      return {
        ...actual,
        [aliadoId]: siguiente,
      };
    });
  };

  const crearSede = async (aliado: AliadoItem) => {
    const form = sedesForm[aliado.id] || emptySedeForm();

    try {
      setProcesandoId(aliado.id);
      setMensaje("");

      const res = await fetch("/api/sedes/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aliadoId: aliado.id,
          nombre: form.nombre,
          codigo: form.codigo,
          usuario: form.usuario,
          clave: form.clave,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear la sede");
        return;
      }

      setMensaje(`${data.mensaje || "Sede creada correctamente"} para ${aliado.nombre}`);
      setSedesForm((actual) => ({
        ...actual,
        [aliado.id]: emptySedeForm(),
      }));
      await cargarAliados();
    } catch {
      setMensaje("Error creando sede");
    } finally {
      setProcesandoId(null);
    }
  };

  const actualizarRedescuentoInput = (aliadoId: number, valor: string) => {
    const sanitized = valor.replace(/[^0-9,.]/g, "").replace(",", ".");

    setRedescuentoInputs((actual) => ({
      ...actual,
      [aliadoId]: sanitized,
    }));
  };

  const guardarRedescuento = async (aliado: AliadoItem) => {
    if (!esCentral) {
      return;
    }

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
          redescuentoPorcentaje:
            redescuentoInputs[aliado.id] ?? aliado.redescuentoPorcentaje,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo actualizar el redescuento");
        return;
      }

      setMensaje(data.mensaje || "Redescuento actualizado correctamente");
      await cargarAliados();
    } catch {
      setMensaje("Error actualizando el redescuento");
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
                Sistema central
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-5xl">
                Aliados y sedes
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                FINSER PAY opera como plataforma central. Debajo se crean aliados comerciales, y cada aliado administra solo sus propias sedes, vendedores, creditos y recaudos.
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

        {sistemaCentral ? (
          <section className="rounded-[24px] border border-emerald-200 bg-[#f6fffb] p-5 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.28em] text-emerald-700">
                  Sistema central
                </p>
                <h2 className="mt-2 text-2xl font-black sm:text-3xl">
                  FINSER PAY
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  Aqui quedan las funciones internas de la financiera: cartera, recaudo digital, administracion global y control de aliados.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/dashboard/cartera"
                  className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-black text-emerald-800 transition hover:bg-emerald-50"
                >
                  Cartera central
                </Link>
                <Link
                  href="/dashboard/sedes"
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:border-slate-300"
                >
                  Ver sedes
                </Link>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-white p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Sedes internas
                </p>
                <p className="mt-2 text-2xl font-black">
                  {formatNumber(sistemaCentral.totalSedes)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Creditos globales
                </p>
                <p className="mt-2 text-2xl font-black">
                  {formatNumber(sistemaCentral.totalCreditos)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Recaudos centralizados
                </p>
                <p className="mt-2 text-2xl font-black">
                  {formatNumber(sistemaCentral.totalRecaudos)}
                </p>
              </div>
            </div>

            <div className="mt-5">
              <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                Sedes del sistema
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {sistemaCentral.sedes.length ? (
                  sistemaCentral.sedes.map((sede) => (
                    <div
                      key={sede.id}
                      className="rounded-2xl border border-emerald-100 bg-white px-4 py-3"
                    >
                      <p className="truncate text-sm font-black">{sede.nombre}</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-400">
                        {sede.codigo || `SEDE-${sede.id}`}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl border border-dashed border-emerald-200 bg-white px-4 py-4 text-sm font-bold text-slate-500">
                    No hay sedes internas configuradas.
                  </p>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {esCentral ? (
          <section className="rounded-[24px] border border-emerald-200 bg-white p-5 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
            <div className="grid gap-3 lg:grid-cols-[1fr_220px_170px_160px] lg:items-end">
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                  Nuevo aliado comercial
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

              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                  Redescuento %
                </span>
                <input
                  value={redescuentoPorcentaje}
                  onChange={(event) =>
                    setRedescuentoPorcentaje(
                      event.target.value.replace(/[^0-9,.]/g, "").replace(",", ".")
                    )
                  }
                  inputMode="decimal"
                  placeholder="10"
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
          </section>
        ) : null}

        {mensaje ? (
          <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
            {mensaje}
          </p>
        ) : null}

        {cargando ? (
          <section className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm font-bold text-slate-500">
            Cargando aliados...
          </section>
        ) : (
          <section className="space-y-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500">
                Aliados comerciales
              </p>
              <h2 className="mt-2 text-2xl font-black">
                Sedes de aliados
              </h2>
            </div>

            {aliados.length ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {aliados.map((aliado) => {
              const form = sedesForm[aliado.id] || emptySedeForm();

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
                  </div>

                  <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                        Redescuento
                      </p>
                      <p className="mt-1 text-xl font-black">
                        {formatPercent(aliado.redescuentoPorcentaje)}%
                      </p>
                    </div>
                  </div>

                  {esCentral ? (
                    <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                        Redescuento de respaldo
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px]">
                        <label>
                          <span className="sr-only">Porcentaje de redescuento</span>
                          <input
                            value={
                              redescuentoInputs[aliado.id] ??
                              String(Number(aliado.redescuentoPorcentaje || 0))
                            }
                            onChange={(event) =>
                              actualizarRedescuentoInput(aliado.id, event.target.value)
                            }
                            inputMode="decimal"
                            placeholder="0"
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-400"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => guardarRedescuento(aliado)}
                          disabled={procesandoId === aliado.id}
                          className="rounded-2xl bg-[#101318] px-5 py-3 text-sm font-black text-white transition hover:bg-[#1f2630] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {procesandoId === aliado.id ? "Guardando..." : "Guardar %"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-5 rounded-3xl border border-emerald-100 bg-emerald-50/50 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.24em] text-emerald-700">
                      Crear sede para {aliado.nombre}
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <input
                        value={form.nombre}
                        onChange={(event) =>
                          actualizarSedeForm(aliado.id, "nombre", event.target.value)
                        }
                        placeholder="Nombre de sede"
                        className="rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-400"
                      />
                      <input
                        value={form.codigo}
                        onChange={(event) =>
                          actualizarSedeForm(aliado.id, "codigo", event.target.value)
                        }
                        placeholder="Codigo de sede"
                        className="rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-400"
                      />
                      <input
                        value={form.usuario}
                        onChange={(event) =>
                          actualizarSedeForm(
                            aliado.id,
                            "usuario",
                            normalizarUsuarioLogin(event.target.value)
                          )
                        }
                        placeholder={`${slugUsuarioSede(aliado.codigo || aliado.nombre)}.principal`}
                        className="rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-400"
                      />
                      <input
                        value={form.clave}
                        onChange={(event) =>
                          actualizarSedeForm(aliado.id, "clave", event.target.value)
                        }
                        placeholder="Clave inicial"
                        type="password"
                        className="rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-400"
                      />
                    </div>
                    <button
                      onClick={() => crearSede(aliado)}
                      disabled={
                        procesandoId === aliado.id ||
                        !form.nombre.trim() ||
                        !form.usuario.trim() ||
                        !form.clave.trim()
                      }
                      className="mt-3 w-full rounded-2xl bg-[#0f766e] px-5 py-3 text-sm font-black text-white transition hover:bg-[#115e59] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {procesandoId === aliado.id ? "Creando..." : "Crear sede"}
                    </button>
                  </div>

                  <div className="mt-5">
                    <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                      Sedes actuales
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {aliado.sedes.length ? (
                        aliado.sedes.map((sede) => (
                          <div
                            key={sede.id}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                          >
                            <p className="truncate text-sm font-black">{sede.nombre}</p>
                            <p className="mt-1 text-[11px] font-bold text-slate-400">
                              {sede.codigo || `SEDE-${sede.id}`}
                            </p>
                          </div>
                        ))
                      ) : (
                        <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-sm font-bold text-slate-500">
                          Este aliado aun no tiene sedes.
                        </p>
                      )}
                    </div>
                  </div>
                </article>
              );
                })}
              </div>
            ) : (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 text-sm font-bold text-slate-500">
                Aun no hay aliados comerciales creados.
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
