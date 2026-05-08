"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

function limpiarNumero(v: string) {
  return v.replace(/\D/g, "");
}

function formatoPesos(v: string | number) {
  const num = Number(v || 0);
  if (!num) return "";
  return `$ ${num.toLocaleString("es-CO")}`;
}

type GastoCarteraFormProps = {
  backHref?: string;
  badgeLabel?: string;
  detailHref?: string | null;
  description?: string;
};

export default function GastoCarteraForm({
  backHref = "/dashboard",
  badgeLabel = "Financiero",
  detailHref = "/dashboard/financiero/cartera/detalle",
  description = "Registra gastos de operacion que afectan las ganancias de cartera.",
}: GastoCarteraFormProps) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeId, setSedeId] = useState("");
  const [valor, setValor] = useState("");
  const [observacion, setObservacion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");

  useEffect(() => {
    const init = async () => {
      try {
        const resUser = await fetch("/api/session", { cache: "no-store" });
        const dataUser = await resUser.json();

        if (resUser.ok) {
          setUser(dataUser);
          setSedeId(String(dataUser.sedeId || ""));
        }

        if (String(dataUser?.rolNombre || "").toUpperCase() === "ADMIN") {
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

    void init();
  }, []);

  const esAdmin = String(user?.rolNombre || "").toUpperCase() === "ADMIN";

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/cartera", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          valor: Number(valor || 0),
          observacion,
          sedeId: Number(sedeId || 0),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error registrando gasto de operacion");
        return;
      }

      setMensaje("Gasto de operacion registrado correctamente");
      setValor("");
      setObservacion("");
    } catch {
      setMensaje("Error registrando gasto de operacion");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f6f8] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex rounded-full border border-[#b9e5d3] bg-[#ecfdf5] px-3 py-1 text-xs font-semibold uppercase text-[#0f766e]">
              {badgeLabel}
            </div>
            <h1 className="mt-3 text-4xl font-black text-slate-950">
              Registrar gasto de operacion
            </h1>
            <p className="mt-2 text-slate-600">{description}</p>
          </div>

          <div className="flex gap-3">
            {detailHref ? (
              <Link
                href={detailHref}
                className="rounded-2xl bg-[#111318] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2a2d33]"
              >
                Detalle gastos
              </Link>
            ) : null}

            <Link
              href={backHref}
              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Volver
            </Link>
          </div>
        </div>

        <div className="rounded-[28px] bg-white p-6 shadow-xl ring-1 ring-slate-200">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {esAdmin ? (
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Sede
                </label>
                <select
                  value={sedeId}
                  onChange={(e) => setSedeId(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-emerald-100"
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
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 outline-none"
                />
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Valor
              </label>
              <input
                value={valor ? formatoPesos(valor) : ""}
                onChange={(e) => setValor(limpiarNumero(e.target.value))}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-emerald-100"
              />
            </div>

            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Observacion
              </label>
              <input
                value={observacion}
                onChange={(e) => setObservacion(e.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={guardar}
              disabled={guardando}
              className="flex-1 rounded-2xl bg-[#0f766e] px-6 py-4 text-lg font-semibold text-white transition hover:bg-[#0b5f59] disabled:opacity-70"
            >
              {guardando ? "Guardando..." : "Registrar gasto de operacion"}
            </button>
          </div>

          {mensaje && (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-center text-base font-medium text-slate-700">
              {mensaje}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
