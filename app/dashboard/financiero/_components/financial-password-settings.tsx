"use client";

import { useEffect, useMemo, useState } from "react";

type SedeConfig = {
  id: number;
  nombre: string;
  usaClavePredeterminada: boolean;
};

async function obtenerConfiguracion() {
  const res = await fetch("/api/financiero/acceso", {
    cache: "no-store",
  });
  const data = await res.json();

  return { data, res };
}

export default function FinancialPasswordSettings() {
  const [abierto, setAbierto] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [esAdmin, setEsAdmin] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [nuevaClave, setNuevaClave] = useState("");
  const [sedeId, setSedeId] = useState("");
  const [sedes, setSedes] = useState<SedeConfig[]>([]);

  useEffect(() => {
    const init = async () => {
      try {
        setCargando(true);

        const { data, res } = await obtenerConfiguracion();

        if (!res.ok) {
          setEsAdmin(false);
          return;
        }

        setEsAdmin(Boolean(data.esAdmin));
        setSedes(Array.isArray(data.sedes) ? data.sedes : []);

        if (Array.isArray(data.sedes) && data.sedes.length > 0) {
          setSedeId((current) => current || String(data.sedes[0].id));
        }
      } catch {
        setEsAdmin(false);
      } finally {
        setCargando(false);
      }
    };

    void init();
  }, []);

  const sedeSeleccionada = useMemo(
    () => sedes.find((item) => String(item.id) === String(sedeId)),
    [sedeId, sedes]
  );

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/acceso", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sedeId: Number(sedeId || 0),
          nuevaClave,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error actualizando la clave financiera");
        return;
      }

      setMensaje(data.mensaje || "Clave financiera actualizada");
      setNuevaClave("");

      const config = await obtenerConfiguracion();

      if (config.res.ok) {
        setEsAdmin(Boolean(config.data.esAdmin));
        setSedes(Array.isArray(config.data.sedes) ? config.data.sedes : []);

        if (Array.isArray(config.data.sedes) && config.data.sedes.length > 0) {
          setSedeId((current) => current || String(config.data.sedes[0].id));
        }
      }
    } catch {
      setMensaje("Error actualizando la clave financiera");
    } finally {
      setGuardando(false);
    }
  };

  if (cargando || !esAdmin) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMensaje("");
          setAbierto(true);
        }}
        className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Clave por sede
      </button>

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-[28px] bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black text-slate-950">
                  Clave financiera por sede
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  Solo el administrador puede cambiar la clave del panel
                  financiero. Las sedes sin personalizaci&oacute;n siguen usando
                  la clave inicial `Adm1995`.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cerrar
              </button>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Sede
                </label>
                <select
                  value={sedeId}
                  onChange={(event) => setSedeId(event.target.value)}
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

              {sedeSeleccionada && (
                <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  Estado actual:{" "}
                  <span className="font-semibold text-slate-900">
                    {sedeSeleccionada.usaClavePredeterminada
                      ? "Usando clave inicial"
                      : "Clave personalizada"}
                  </span>
                </div>
              )}

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Nueva clave
                </label>
                <input
                  type="password"
                  value={nuevaClave}
                  onChange={(event) => setNuevaClave(event.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                  placeholder="Ingresa la nueva clave"
                />
              </div>
            </div>

            {mensaje && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
                {mensaje}
              </div>
            )}

            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={guardar}
                disabled={guardando}
                className="flex-1 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-70"
              >
                {guardando ? "Guardando..." : "Actualizar clave"}
              </button>

              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
