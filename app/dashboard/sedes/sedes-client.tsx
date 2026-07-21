"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { KeyRound, MapPin, Store } from "lucide-react";
import { MetricCard, PageHeader } from "@/app/_components/finser-ui";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  aliadoAccesoId?: number | null;
  aliadoAccesoNombre?: string | null;
  aliadoAccesoCodigo?: string | null;
  rolId: number;
  rolNombre: string;
};

type SedeAdminItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activa: boolean;
  aliado: {
    id: number;
    nombre: string;
    codigo: string | null;
  } | null;
  acceso: {
    id: number;
    nombre: string;
    usuario: string;
    activo: boolean;
  } | null;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

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

function usuarioSugeridoSede(
  aliado: { codigo?: string | null; nombre?: string | null },
  sedeNombre: string
) {
  const aliadoSlug = slugUsuarioSede(aliado.codigo || aliado.nombre || "");
  const sedeSlug = slugUsuarioSede(sedeNombre);

  return [aliadoSlug, sedeSlug].filter(Boolean).join(".");
}

function esAliadoFinserPay(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
}

export default function GestionSedesPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeAdminItem[]>([]);
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardandoNueva, setGuardandoNueva] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);

  const [nuevaSedeNombre, setNuevaSedeNombre] = useState("");
  const [nuevaSedeCodigo, setNuevaSedeCodigo] = useState("");
  const [nuevoAliadoId, setNuevoAliadoId] = useState("");
  const [nuevoUsuario, setNuevoUsuario] = useState("");
  const [nuevaClave, setNuevaClave] = useState("");

  const [ediciones, setEdiciones] = useState<
    Record<
      number,
      {
        nombre: string;
        codigo: string;
        aliadoId: string;
        usuario: string;
        clave: string;
      }
    >
  >({});

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const esAdminCentral = esAdmin && esAliadoFinserPay(user?.aliadoAccesoCodigo);
  const aliadoActualNombre = user?.aliadoAccesoNombre || "tu aliado";
  const aliadoSeleccionado = aliados.find(
    (aliado) => String(aliado.id) === nuevoAliadoId
  );
  const sedesVisibles = useMemo(
    () =>
      esAdminCentral && nuevoAliadoId
        ? sedes.filter((sede) => String(sede.aliado?.id) === nuevoAliadoId)
        : sedes,
    [esAdminCentral, nuevoAliadoId, sedes]
  );
  const accesosActivos = sedesVisibles.filter((sede) => sede.acceso?.activo).length;
  const aliadoNuevaSede = useMemo(
    () =>
      esAdminCentral
        ? aliados.find((aliado) => String(aliado.id) === nuevoAliadoId) || null
        : {
            codigo: user?.aliadoAccesoCodigo || null,
            nombre: user?.aliadoAccesoNombre || null,
          },
    [
      aliados,
      esAdminCentral,
      nuevoAliadoId,
      user?.aliadoAccesoCodigo,
      user?.aliadoAccesoNombre,
    ]
  );

  const cargarTodo = async () => {
    try {
      const [resSession, resSedes, resAliados] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch("/api/sedes/admin", { cache: "no-store" }),
        fetch("/api/aliados/admin", { cache: "no-store" }),
      ]);

      const sessionData = await resSession.json();
      const sedesData = await resSedes.json();
      const aliadosData = await resAliados.json();

      if (resSession.ok) {
        setUser(sessionData);
      }

      if (resSedes.ok) {
        const items = Array.isArray(sedesData?.sedes) ? sedesData.sedes : [];
        setSedes(items);
        setEdiciones(
          items.reduce(
            (acc: Record<number, { nombre: string; codigo: string; aliadoId: string; usuario: string; clave: string }>, sede: SedeAdminItem) => {
              acc[sede.id] = {
                nombre: sede.nombre,
                codigo: sede.codigo || "",
                aliadoId: sede.aliado?.id ? String(sede.aliado.id) : "",
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

      if (resAliados.ok) {
        const items = Array.isArray(aliadosData?.aliados) ? aliadosData.aliados : [];
        setAliados(items);
        setNuevoAliadoId((actual) => actual || (items[0]?.id ? String(items[0].id) : ""));
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
    const sugerido = aliadoNuevaSede
      ? usuarioSugeridoSede(aliadoNuevaSede, nuevaSedeNombre)
      : slugUsuarioSede(nuevaSedeNombre);
    const sugeridosAliados = aliados.map((aliado) =>
      usuarioSugeridoSede(aliado, nuevaSedeNombre)
    );
    const sugeridoPlano = slugUsuarioSede(nuevaSedeNombre);

    if (
      !nuevoUsuario ||
      nuevoUsuario === sugeridoPlano ||
      sugeridosAliados.includes(nuevoUsuario)
    ) {
      setNuevoUsuario(sugerido);
    }
  }, [aliadoNuevaSede, aliados, nuevaSedeNombre, nuevoUsuario]);

  const actualizarEdicion = (
    sedeId: number,
    campo: "nombre" | "codigo" | "aliadoId" | "usuario" | "clave",
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
          aliadoId: Number(nuevoAliadoId || 0),
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
          aliadoId: Number(payload?.aliadoId || 0),
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

  const eliminarSede = async (sede: SedeAdminItem) => {
    const confirmar = window.confirm(
      `Eliminar la sede "${sede.nombre}"? Se desactivara su acceso y sus asignaciones.`
    );

    if (!confirmar) {
      return;
    }

    try {
      setProcesandoId(sede.id);
      setMensaje("");

      const res = await fetch("/api/sedes/admin", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sedeId: sede.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo eliminar la sede");
        return;
      }

      setMensaje(data.mensaje || "Sede eliminada correctamente");
      await cargarTodo();
    } catch {
      setMensaje("Error eliminando la sede");
    } finally {
      setProcesandoId(null);
    }
  };

  if (cargando) {
    return (
      <div className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-[#e4e7ec] bg-white px-6 py-12 text-center text-sm font-semibold text-[#667085]">
          Cargando gestion de sedes...
        </div>
      </div>
    );
  }

  if (!esAdmin) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="rounded-lg border border-[#e4e7ec] bg-white p-8 shadow-sm">
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
              className="fp-ui-button is-primary"
            >
              Volver al dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
        <PageHeader
          eyebrow="Administracion"
          title="Sedes y accesos"
          description="Crea puntos de venta y administra sus credenciales de ingreso."
        />

        <section className="mt-4 grid gap-3 sm:grid-cols-3">
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><Store className="h-4 w-4 text-[#5c7a13]" /> Sedes registradas</span>} value={<span className="!text-2xl">{sedesVisibles.length}</span>} detail={aliadoSeleccionado?.nombre || aliadoActualNombre} />
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-[#5c7a13]" /> Accesos activos</span>} value={<span className="!text-2xl">{accesosActivos}</span>} detail="Credenciales habilitadas" />
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><MapPin className="h-4 w-4 text-[#b54708]" /> Sin acceso</span>} value={<span className="!text-2xl">{sedesVisibles.length - accesosActivos}</span>} detail="Requieren configuracion" />
        </section>

        {mensaje && (
          <div className="mt-4 rounded-lg border border-[#d0d5dd] bg-white px-4 py-3 text-sm font-medium text-[#344054]" role="status">
            {mensaje}
          </div>
        )}

        <section className="mt-4 rounded-lg border border-[#e4e7ec] bg-white p-5 shadow-[0_4px_18px_rgba(16,24,40,0.05)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                Nueva sede
              </div>
              <h2 className="mt-2 text-xl font-black text-[#151a21]">
                Crear sede con acceso
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                El usuario de acceso se usa directamente en el login del sistema.
              </p>
            </div>
          </div>

          <div
            className={[
              "mt-6 grid gap-4",
              esAdminCentral
                ? "lg:grid-cols-[1fr_0.7fr_0.8fr_0.8fr_0.8fr_160px]"
                : "lg:grid-cols-[1.2fr_0.8fr_0.9fr_0.9fr_160px]",
            ].join(" ")}
          >
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Nombre de sede
              <input
                value={nuevaSedeNombre}
                onChange={(event) => setNuevaSedeNombre(event.target.value)}
                placeholder="Ej: Stand PuntoNet"
                className="fp-ui-input"
              />
            </label>

            {esAdminCentral ? (
              <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                Aliado
                <select
                  value={nuevoAliadoId}
                  onChange={(event) => setNuevoAliadoId(event.target.value)}
                  className="fp-ui-input"
                >
                  {aliados.map((aliado) => (
                    <option key={aliado.id} value={aliado.id}>
                      {aliado.nombre}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="rounded-md border border-[#d9e8ad] bg-[#fbfdf5] px-4 py-3 text-sm font-bold text-[#344054]">
                <span className="block text-[11px] uppercase tracking-[0.14em] text-[#5c7a13]">
                  Aliado
                </span>
                {aliadoActualNombre}
              </div>
            )}

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Codigo
              <input
                value={nuevaSedeCodigo}
                onChange={(event) => setNuevaSedeCodigo(event.target.value)}
                placeholder="Opcional"
                className="fp-ui-input"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Usuario de acceso
              <input
                value={nuevoUsuario}
                onChange={(event) => setNuevoUsuario(normalizarUsuarioLogin(event.target.value))}
                placeholder={
                  aliadoNuevaSede
                    ? usuarioSugeridoSede(aliadoNuevaSede, "principal")
                    : "aliado.principal"
                }
                className="fp-ui-input"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Clave inicial
              <input
                type="password"
                value={nuevaClave}
                onChange={(event) => setNuevaClave(event.target.value)}
                placeholder="Asignar clave"
                className="fp-ui-input"
              />
            </label>

            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => void crearSede()}
                disabled={guardandoNueva || (esAdminCentral && !nuevoAliadoId)}
                className="fp-ui-button is-primary w-full"
              >
                {guardandoNueva ? "Creando..." : "Crear sede"}
              </button>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-[#e4e7ec] bg-white shadow-[0_4px_18px_rgba(16,24,40,0.05)]">
          <div>
            <div className="px-5 pt-5 text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
              Accesos existentes
            </div>
            <h2 className="mt-2 px-5 text-xl font-black text-[#151a21]">
              Sedes registradas
            </h2>
            <p className="mt-1.5 px-5 pb-5 text-sm text-[#667085]">
              {esAdminCentral && aliadoSeleccionado
                ? `Mostrando sedes de ${aliadoSeleccionado.nombre}. Puedes cambiar nombre, codigo, usuario de acceso y asignar una nueva clave.`
                : "Puedes cambiar nombre, codigo, usuario de acceso y asignar una nueva clave."}
            </p>
          </div>

          <div className="divide-y divide-[#e4e7ec] border-t border-[#e4e7ec]">
            {sedesVisibles.map((sede) => {
              const edicion = ediciones[sede.id] || {
                nombre: sede.nombre,
                codigo: sede.codigo || "",
                aliadoId: sede.aliado?.id ? String(sede.aliado.id) : "",
                usuario: sede.acceso?.usuario || "",
                clave: "",
              };

              return (
                <section
                  key={sede.id}
                  className="p-5"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[#667085]">
                        Sede #{sede.id}
                      </div>
                      <h3 className="mt-2 text-xl font-black text-[#151a21]">
                        {sede.nombre}
                      </h3>
                      <p className="mt-2 text-sm text-slate-500">
                        {sede.acceso
                          ? `Acceso actual: ${sede.acceso.usuario}`
                          : "Esta sede aun no tiene usuario de acceso."}
                      </p>
                      <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-[#5c7a13]">
                        {sede.aliado?.nombre || "Sin aliado"}
                      </p>
                    </div>

                    <div className="rounded-md border border-[#d0d5dd] bg-[#f8fafb] px-4 py-3 text-sm">
                      <p className="font-semibold text-slate-900">
                        {sede.acceso ? "Acceso activo" : "Sin acceso"}
                      </p>
                      <p className="mt-1 text-slate-500">
                        {sede.codigo ? `Codigo: ${sede.codigo}` : "Sin codigo"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Nombre de sede
                      <input
                        value={edicion.nombre}
                        onChange={(event) =>
                          actualizarEdicion(sede.id, "nombre", event.target.value)
                        }
                        className="fp-ui-input"
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
                        className="fp-ui-input"
                      />
                    </label>

                    {esAdminCentral ? (
                      <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                        Aliado
                        <select
                          value={edicion.aliadoId}
                          onChange={(event) =>
                            actualizarEdicion(sede.id, "aliadoId", event.target.value)
                          }
                          className="fp-ui-input"
                        >
                          <option value="">Seleccionar aliado</option>
                          {aliados.map((aliado) => (
                            <option key={aliado.id} value={aliado.id}>
                              {aliado.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Usuario de acceso
                      <input
                        value={edicion.usuario}
                        onChange={(event) =>
                          actualizarEdicion(
                            sede.id,
                            "usuario",
                            normalizarUsuarioLogin(event.target.value)
                          )
                        }
                        placeholder="usuario de login"
                        className="fp-ui-input"
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
                        className="fp-ui-input"
                      />
                    </label>
                  </div>

                  <div className="mt-5 flex flex-col justify-end gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => void eliminarSede(sede)}
                      disabled={procesandoId === sede.id}
                      className="fp-ui-button is-danger"
                    >
                      Eliminar sede
                    </button>
                    <button
                      type="button"
                      onClick={() => void guardarSede(sede.id)}
                      disabled={procesandoId === sede.id}
                      className="fp-ui-button is-primary"
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
            {!sedesVisibles.length && (
              <div className="m-5 rounded-lg border border-dashed border-[#d0d5dd] bg-[#f8fafb] px-5 py-8 text-sm text-[#667085]">
                Este aliado aun no tiene sedes registradas.
              </div>
            )}
          </div>
        </section>
    </main>
  );
}
