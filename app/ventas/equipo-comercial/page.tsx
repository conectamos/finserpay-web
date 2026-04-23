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

type OpcionCatalogo = {
  id: number;
  nombre: string;
  aplicaIntermediacion?: boolean;
  porcentajeIntermediacion?: number;
};

type CatalogoResponse = {
  jaladores: OpcionCatalogo[];
  cerradores: OpcionCatalogo[];
  financieras: OpcionCatalogo[];
};

type TipoCatalogo = "JALADOR" | "CERRADOR" | "FINANCIERA";

const tipoMeta: Record<
  TipoCatalogo,
  {
    titulo: string;
    descripcion: string;
    badge: string;
    ring: string;
    text: string;
    button: string;
  }
> = {
  JALADOR: {
    titulo: "Jaladores",
    descripcion: "Equipo comercial que impulsa la venta desde la prospeccion.",
    badge: "Operacion comercial",
    ring: "ring-blue-100",
    text: "text-blue-700",
    button: "bg-blue-600 hover:bg-blue-700",
  },
  CERRADOR: {
    titulo: "Cerradores",
    descripcion: "Responsables del cierre y formalizacion final de la venta.",
    badge: "Cierre comercial",
    ring: "ring-emerald-100",
    text: "text-emerald-700",
    button: "bg-emerald-600 hover:bg-emerald-700",
  },
  FINANCIERA: {
    titulo: "Financieras",
    descripcion: "Catalogo de entidades financieras disponibles para ventas y abonos.",
    badge: "Cobertura financiera",
    ring: "ring-amber-100",
    text: "text-amber-700",
    button: "bg-amber-600 hover:bg-amber-700",
  },
};

export default function EquipoComercialPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoResponse>({
    jaladores: [],
    cerradores: [],
    financieras: [],
  });
  const [tipo, setTipo] = useState<TipoCatalogo>("JALADOR");
  const [nombre, setNombre] = useState("");
  const [aplicaIntermediacion, setAplicaIntermediacion] = useState(false);
  const [porcentajeIntermediacion, setPorcentajeIntermediacion] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [eliminandoId, setEliminandoId] = useState<number | null>(null);

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const cargarTodo = async () => {
    try {
      const [resSession, resCatalogo] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch("/api/ventas/catalogo-personal", { cache: "no-store" }),
      ]);

      const sessionData = await resSession.json();
      const catalogoData = await resCatalogo.json();

      if (resSession.ok) {
        setUser(sessionData);
      }

      if (resCatalogo.ok) {
        setCatalogo(catalogoData);
      } else {
        setMensaje(catalogoData.error || "No se pudo cargar el catalogo comercial");
      }
    } catch {
      setMensaje("Error cargando el catalogo comercial");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarTodo();
  }, []);

  useEffect(() => {
    if (tipo !== "FINANCIERA") {
      setAplicaIntermediacion(false);
      setPorcentajeIntermediacion("");
    }
  }, [tipo]);

  const agregarRegistro = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const nombreLimpio = nombre.trim();

      if (!nombreLimpio) {
        setMensaje("Debes ingresar un nombre");
        return;
      }

      if (
        tipo === "FINANCIERA" &&
        aplicaIntermediacion &&
        Number(porcentajeIntermediacion || 0) <= 0
      ) {
        setMensaje("Define un porcentaje valido de intermediacion");
        return;
      }

      const res = await fetch("/api/ventas/catalogo-personal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tipo,
          nombre: nombreLimpio,
          aplicaIntermediacion: tipo === "FINANCIERA" ? aplicaIntermediacion : false,
          porcentajeIntermediacion:
            tipo === "FINANCIERA" && aplicaIntermediacion
              ? Number(porcentajeIntermediacion || 0)
              : 0,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo guardar el registro");
        return;
      }

      setCatalogo(data.catalogo);
      setNombre("");
      setAplicaIntermediacion(false);
      setPorcentajeIntermediacion("");
      setMensaje(data.mensaje || "Registro agregado correctamente");
    } catch {
      setMensaje("Error guardando el registro");
    } finally {
      setGuardando(false);
    }
  };

  const eliminarRegistro = async (id: number) => {
    const confirmado = window.confirm(
      "Este registro dejara de estar disponible en ventas. Deseas continuar?"
    );

    if (!confirmado) {
      return;
    }

    try {
      setEliminandoId(id);
      setMensaje("");

      const res = await fetch(`/api/ventas/catalogo-personal?id=${id}`, {
        method: "DELETE",
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo eliminar el registro");
        return;
      }

      setCatalogo(data.catalogo);
      setMensaje(data.mensaje || "Registro eliminado correctamente");
    } catch {
      setMensaje("Error eliminando el registro");
    } finally {
      setEliminandoId(null);
    }
  };

  const seccionCatalogo = (
    tipoActual: TipoCatalogo,
    items: OpcionCatalogo[]
  ) => {
    const meta = tipoMeta[tipoActual];

    return (
      <section
        className={`rounded-[30px] bg-white p-6 shadow-sm ring-1 ${meta.ring}`}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
              {meta.badge}
            </div>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              {meta.titulo}
            </h2>
            <p className="mt-2 text-sm text-slate-500">{meta.descripcion}</p>
          </div>

          <div className={`text-sm font-semibold ${meta.text}`}>
            {items.length} registro{items.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          {items.length === 0 ? (
            <div className="w-full rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              No hay registros en esta lista.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
              >
                <span className="text-sm font-semibold text-slate-900">
                  {item.nombre}
                </span>
                {tipoActual === "FINANCIERA" && (
                  <span className={`rounded-xl px-3 py-1 text-[11px] font-semibold ${
                    item.aplicaIntermediacion
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                      : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  }`}>
                    {item.aplicaIntermediacion
                      ? `Intermediacion ${Number(item.porcentajeIntermediacion || 0)}%`
                      : "Sin intermediacion"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void eliminarRegistro(item.id)}
                  disabled={eliminandoId === item.id}
                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {eliminandoId === item.id ? "Eliminando..." : "Eliminar"}
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    );
  };

  if (cargando) {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-6xl rounded-[32px] bg-white px-8 py-12 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Ventas
          </p>
          <h1 className="mt-3 text-3xl font-black text-slate-950">
            Cargando equipo comercial...
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
            Solo el administrador puede gestionar jaladores, cerradores y financieras
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            Esta pantalla esta reservada para mantenimiento del catalogo comercial y financiero.
          </p>
          <div className="mt-6">
            <Link
              href="/ventas"
              className="inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Volver a ventas
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <section className="overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_48%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Ventas
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Equipo comercial
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
                Administra el catalogo de jaladores, cerradores y financieras
                que aparece en los formularios de ventas y abonos.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/ventas/nuevo"
                className="rounded-2xl border border-white/10 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
              >
                Nueva venta
              </Link>
              <Link
                href="/ventas"
                className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Volver a ventas
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
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Tipo de registro
              <select
                value={tipo}
                onChange={(event) => setTipo(event.target.value as TipoCatalogo)}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="JALADOR">Jalador</option>
                <option value="CERRADOR">Cerrador</option>
                <option value="FINANCIERA">Financiera</option>
              </select>
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Nombre
              <input
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder={`Agregar ${
                  tipo === "JALADOR"
                    ? "jalador"
                    : tipo === "CERRADOR"
                      ? "cerrador"
                      : "financiera"
                }`}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => void agregarRegistro()}
                disabled={guardando}
                className={`rounded-2xl px-5 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-70 ${tipoMeta[tipo].button}`}
              >
                {guardando ? "Guardando..." : "Agregar"}
              </button>
            </div>
          </div>

          {tipo === "FINANCIERA" && (
            <div className="mt-5 grid gap-4 rounded-[24px] border border-amber-100 bg-amber-50/60 p-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <label className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                <input
                  type="checkbox"
                  checked={aplicaIntermediacion}
                  onChange={(event) => setAplicaIntermediacion(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-300"
                />
                Aplica intermediacion
              </label>

              <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                Porcentaje de intermediacion
                <input
                  value={porcentajeIntermediacion}
                  onChange={(event) =>
                    setPorcentajeIntermediacion(
                      event.target.value.replace(/[^\d.]/g, "").replace(/(\..*?)\..*/g, "$1")
                    )
                  }
                  disabled={!aplicaIntermediacion}
                  placeholder="%"
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                />
              </label>
            </div>
          )}
        </section>

        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          {seccionCatalogo("JALADOR", catalogo.jaladores)}
          {seccionCatalogo("CERRADOR", catalogo.cerradores)}
          {seccionCatalogo("FINANCIERA", catalogo.financieras)}
        </div>
      </div>
    </div>
  );
}
