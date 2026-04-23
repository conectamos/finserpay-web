"use client";

import { useState } from "react";

type RankingItem = {
  nombre: string;
  total: number;
  monto: number;
};

type UtilitySummary = {
  periodo: string;
  cobertura: string;
  utilidad: number;
  caja: number;
  ingresos: number;
  ventas: number;
  topJaladores: RankingItem[];
  topCerradores: RankingItem[];
  topFinancieras: RankingItem[];
};

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

export default function DashboardUtilityGate({
  coverageLabel,
}: {
  coverageLabel: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [clave, setClave] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [resumen, setResumen] = useState<UtilitySummary | null>(null);

  const consultarUtilidad = async () => {
    try {
      setCargando(true);
      setError("");

      const res = await fetch("/api/dashboard/utilidad", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ clave }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "No se pudo consultar la utilidad");
        return;
      }

      setResumen(data.resumen);
      setClave("");
      setAbierto(false);
    } catch {
      setError("Error consultando la utilidad");
    } finally {
      setCargando(false);
    }
  };

  return (
    <>
      <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e7ddcd] bg-[linear-gradient(135deg,#fffdf8_0%,#f8f2e8_42%,#f3f6fb_100%)] shadow-[0_20px_55px_rgba(15,23,42,0.08)]">
        <div className="px-6 py-6 sm:px-8">
          <div className="inline-flex rounded-full border border-[#dfcfb3] bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8f5b24]">
            {resumen ? "Resumen mensual" : "Resumen mensual protegido"}
          </div>

          <h3 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
            Utilidad del mes
          </h3>

          {!resumen ? (
            <>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                La utilidad mensual queda oculta por seguridad. Usa el boton
                <span className="font-semibold text-slate-950"> UTILIDAD </span>
                para visualizarla con clave.
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <div className="rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Cobertura: {coverageLabel}
                </div>
                <div className="rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Acceso: Protegido por clave
                </div>
              </div>

              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setAbierto(true);
                  }}
                  className="inline-flex rounded-2xl bg-slate-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  UTILIDAD
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Acumulado de {resumen.periodo} para {resumen.cobertura}. Este
                valor se reinicia automaticamente al comenzar un nuevo mes.
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <div className="rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Periodo: {resumen.periodo}
                </div>
                <div className="rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Cobertura: {resumen.cobertura}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-2xl border border-[#dfcfb3] bg-white/90 px-5 py-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    UTILIDAD DEL MES
                  </p>
                  <p className="mt-2 text-3xl font-black text-emerald-600">
                    {formatoPesos(resumen.utilidad)}
                  </p>
                </div>

                <div className="rounded-2xl border border-[#e6dece] bg-white/75 px-5 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    VENTAS DEL MES
                  </p>
                  <p className="mt-2 text-2xl font-black text-slate-950">
                    {resumen.ventas}
                  </p>
                </div>

                <div className="rounded-2xl border border-[#e6dece] bg-white/75 px-5 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    CAJA DEL MES
                  </p>
                  <p className="mt-2 text-2xl font-black text-slate-950">
                    {formatoPesos(resumen.caja)}
                  </p>
                </div>
              </div>

              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setResumen(null)}
                  className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Ocultar utilidad
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black text-slate-950">
                  Acceso a utilidad
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  Ingresa la clave para visualizar la utilidad mensual.
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

            <div className="mt-6">
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Clave
              </label>
              <input
                type="password"
                value={clave}
                onChange={(event) => setClave(event.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                placeholder="Ingresa la clave"
              />
            </div>

            {error && (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {error}
              </div>
            )}

            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => void consultarUtilidad()}
                disabled={cargando}
                className="flex-1 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-70"
              >
                {cargando ? "Validando..." : "Ver utilidad"}
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
