"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type SedeAdminItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activa: boolean;
  acceso: {
    id: number;
    nombre: string;
    usuario: string;
    activo: boolean;
  } | null;
};

function slugUsuarioSede(valor: string) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export default function GestionSedesPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeAdminItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardandoNueva, setGuardandoNueva] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);

  const [nuevaSedeNombre, setNuevaSedeNombre] = useState("");
  const [nuevaSedeCodigo, setNuevaSedeCodigo] = useState("");
  const [nuevoUsuario, setNuevoUsuario] = useState("");
  const [nuevaClave, setNuevaClave] = useState("");

  const [ediciones, setEdiciones] = useState<
    Record<
      number,
      {
        nombre: string;
        codigo: string;
        usuario: string;
        clave: string;
      }
    >
  >({});

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const cargarTodo = async () => {
    try {
      const [resSession, resSedes] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch("/api/sedes/admin", { cache: "no-store" }),
      ]);

      const sessionData = await resSession.json();
      const sedesData = await resSedes.json();

      if (resSession.ok) {
        setUser(sessionData);
      }

      if (resSedes.ok) {
        const items = Array.isArray(sedesData?.sedes) ? sedesData.sedes : [];
        setSedes(items);
        setEdiciones(
          items.reduce(
            (acc: Record<number, { nombre: string; codigo: string; usuario: string; clave: string }>, sede: SedeAdminItem) => {
              acc[sede.id] = {
                nombre: sede.nombre,
                codigo: sede.codigo || "",
                usuario: sede.acceso?.usuario || "",
                clave: "",
              };
              return acc;
            },
            {}
          )
        );
      } else {
        setMensaje(sedesData.error || "No se pudo cargar la gestion de sedes");
      }
    } catch {
      setMensaje("Error cargando la gestion de sedes");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarTodo();
  }, []);

  useEffect(() => {
    if (!nuevoUsuario || nuevoUsuario === slugUsuarioSede(nuevaSedeNombre)) {
      setNuevoUsuario(slugUsuarioSede(nuevaSedeNombre));
    }
  }, [nuevaSedeNombre, nuevoUsuario]);

  const actualizarEdicion = (
    sedeId: number,
    campo: "nombre" | "codigo" | "usuario" | "clave",
    valor: string
  ) => {
    setEdiciones((actual) => ({
      ...actual,
      [sedeId]: {
        ...actual[sedeId],
        [campo]: valor,
      },
    }));
  };

  const crearSede = async () => {
    try {
      setGuardandoNueva(true);
      setMensaje("");

      const res = await fetch("/api/sedes/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nombre: nuevaSedeNombre,
          codigo: nuevaSedeCodigo,
          usuario: nuevoUsuario,
          clave: nuevaClave,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear la sede");
        return;
      }

      setMensaje(data.mensaje || "Sede creada correctamente");
      setNuevaSedeNombre("");
      setNuevaSedeCodigo("");
      setNuevoUsuario("");
      setNuevaClave("");
      await cargarTodo();
    } catch {
      setMensaje("Error creando la sede");
    } finally {
      setGuardandoNueva(false);
    }
  };

  const guardarSede = async (sedeId: number) => {
    try {
      setProcesandoId(sedeId);
      setMensaje("");

      const payload = ediciones[sedeId];

      const res = await fetch("/api/sedes/admin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sedeId,
          nombre: payload?.nombre,
          codigo: payload?.codigo,
          usuario: payload?.usuario,
          clave: payload?.clave,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo guardar la sede");
        return;
      }

      setMensaje(data.mensaje || "Sede actualizada correctamente");
      await cargarTodo();
    } catch {
      setMensaje("Error actualizando la sede");
    } finally {
      setProcesandoId(null);
    }
  };

  if (cargando) {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-7xl rounded-[32px] bg-white px-8 py-12 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Sedes
          </p>
          <h1 className="mt-3 text-3xl font-black text-slate-950">
            Cargando gestion de sedes...
          </h1>
        </div>
      </div>
    );
  }

  if (!esAdmin) {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-4xl rounded-[32px] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">
            Acceso restringido
          </div>
          <h1 className="mt-4 text-3xl font-black text-slate-950">
            Solo el administrador puede gestionar sedes
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            Esta pantalla permite crear sedes y administrar sus credenciales de acceso.
          </p>
          <div className="mt-6">
            <Link
              href="/dashboard"
              className="inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Volver al dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <section className="overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_48%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Administracion
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Gestion de sedes
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
                Crea sedes nuevas, asigna su usuario de acceso y cambia la clave de las sedes existentes.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/dashboard"
                className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Volver al dashboard
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Nueva sede
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Crear sede con acceso
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                El usuario de acceso se usa directamente en el login del sistema.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_0.6fr_0.9fr_0.9fr_180px]">
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Nombre de sede
              <input
                value={nuevaSedeNombre}
                onChange={(event) => setNuevaSedeNombre(event.target.value)}
                placeholder="Ej: Stand PuntoNet"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Codigo
              <input
                value={nuevaSedeCodigo}
                onChange={(event) => setNuevaSedeCodigo(event.target.value)}
                placeholder="Opcional"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Usuario de acceso
              <input
                value={nuevoUsuario}
                onChange={(event) => setNuevoUsuario(slugUsuarioSede(event.target.value))}
                placeholder="sede8"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Clave inicial
              <input
                type="password"
                value={nuevaClave}
                onChange={(event) => setNuevaClave(event.target.value)}
                placeholder="Asignar clave"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => void crearSede()}
                disabled={guardandoNueva}
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {guardandoNueva ? "Creando..." : "Crear sede"}
              </button>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div>
            <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
              Accesos existentes
            </div>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              Sedes registradas
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Puedes cambiar nombre, codigo, usuario de acceso y asignar una nueva clave.
            </p>
          </div>

          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            {sedes.map((sede) => {
              const edicion = ediciones[sede.id] || {
                nombre: sede.nombre,
                codigo: sede.codigo || "",
                usuario: sede.acceso?.usuario || "",
                clave: "",
              };

              return (
                <section
                  key={sede.id}
                  className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-5"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                        Sede #{sede.id}
                      </div>
                      <h3 className="mt-3 text-2xl font-black text-slate-950">
                        {sede.nombre}
                      </h3>
                      <p className="mt-2 text-sm text-slate-500">
                        {sede.acceso
                          ? `Acceso actual: ${sede.acceso.usuario}`
                          : "Esta sede aun no tiene usuario de acceso."}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                      <p className="font-semibold text-slate-900">
                        {sede.acceso ? "Acceso activo" : "Sin acceso"}
                      </p>
                      <p className="mt-1 text-slate-500">
                        {sede.codigo ? `Codigo: ${sede.codigo}` : "Sin codigo"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Nombre de sede
                      <input
                        value={edicion.nombre}
                        onChange={(event) =>
                          actualizarEdicion(sede.id, "nombre", event.target.value)
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Codigo
                      <input
                        value={edicion.codigo}
                        onChange={(event) =>
                          actualizarEdicion(sede.id, "codigo", event.target.value.toUpperCase())
                        }
                        placeholder="Opcional"
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Usuario de acceso
                      <input
                        value={edicion.usuario}
                        onChange={(event) =>
                          actualizarEdicion(
                            sede.id,
                            "usuario",
                            slugUsuarioSede(event.target.value)
                          )
                        }
                        placeholder="usuario de login"
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Nueva clave
                      <input
                        type="password"
                        value={edicion.clave}
                        onChange={(event) =>
                          actualizarEdicion(sede.id, "clave", event.target.value)
                        }
                        placeholder={
                          sede.acceso ? "Dejar vacio para conservarla" : "Clave inicial"
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>
                  </div>

                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void guardarSede(sede.id)}
                      disabled={procesandoId === sede.id}
                      className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {procesandoId === sede.id
                        ? "Guardando..."
                        : sede.acceso
                          ? "Guardar cambios"
                          : "Crear acceso"}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
