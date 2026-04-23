"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { triggerLiveRefresh } from "@/lib/use-live-refresh";

type CatalogoPersonalResponse = {
  financieras: Array<{ nombre: string }>;
};

function limpiarNumero(v: string) {
  return v.replace(/\D/g, "");
}

function formatoPesos(v: string | number) {
  const num = Number(v || 0);
  if (!num) return "";
  return `$ ${num.toLocaleString("es-CO")}`;
}

export default function AbonosFinancierosPage() {
  const [financieras, setFinancieras] = useState<string[]>([""]);
  const [tipo, setTipo] = useState("TRANSFERENCIA");
  const [entidad, setEntidad] = useState("");
  const [valor, setValor] = useState("");
  const [observacion, setObservacion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");

  const cargarFinancieras = async () => {
    try {
      const res = await fetch("/api/ventas/catalogo-personal", {
        cache: "no-store",
      });
      const data = (await res.json()) as CatalogoPersonalResponse;

      if (!res.ok) {
        return;
      }

      setFinancieras(
        Array.isArray(data.financieras) && data.financieras.length
          ? ["", ...data.financieras.map((item) => item.nombre)]
          : [""]
      );
    } catch {}
  };

  useEffect(() => {
    void cargarFinancieras();
  }, []);

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/abonos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tipo,
          entidad: tipo === "FINANCIERA" ? entidad : null,
          valor: Number(valor || 0),
          observacion,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`❌ ${data.error || "Error registrando abono"}`);
        return;
      }

      setMensaje("✅ Abono registrado correctamente");
      triggerLiveRefresh("abono-financiero-creado");
      setTipo("TRANSFERENCIA");
      setEntidad("");
      setValor("");
      setObservacion("");
    } catch {
      setMensaje("❌ Error registrando abono");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f6f8] py-10 px-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold uppercase text-red-700">
              Financiero
            </div>
            <h1 className="mt-3 text-4xl font-black text-slate-950">
              Registrar abono
            </h1>
            <p className="mt-2 text-slate-600">
              Abonos de transferencias y financieras.
            </p>
          </div>

          <Link
            href="/dashboard/financiero"
            className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            ← Volver
          </Link>
        </div>

        <div className="rounded-[28px] bg-white p-6 shadow-xl ring-1 ring-slate-200">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Tipo
              </label>
              <select
                value={tipo}
                onChange={(e) => {
                  setTipo(e.target.value);
                  if (e.target.value !== "FINANCIERA") {
                    setEntidad("");
                  }
                }}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
              >
                <option value="TRANSFERENCIA">TRANSFERENCIA</option>
                <option value="FINANCIERA">FINANCIERA</option>
              </select>
            </div>

            {tipo === "FINANCIERA" ? (
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Financiera
                </label>
                <select
                  value={entidad}
                  onChange={(e) => setEntidad(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
                >
                  {financieras.map((fin) => (
                    <option key={fin} value={fin}>
                      {fin || "Seleccionar financiera"}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Entidad
                </label>
                <input
                  value={tipo}
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
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Observación
              </label>
              <input
                value={observacion}
                onChange={(e) => setObservacion(e.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
              />
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={guardar}
              disabled={guardando}
              className="flex-1 rounded-2xl bg-red-600 px-6 py-4 text-lg font-semibold text-white transition hover:bg-red-700 disabled:opacity-70"
            >
              {guardando ? "Guardando..." : "Registrar abono"}
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
