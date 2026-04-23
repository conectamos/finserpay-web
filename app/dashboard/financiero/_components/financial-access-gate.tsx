"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type FinancialAccessGateProps = {
  sedeNombre: string;
};

export default function FinancialAccessGate({
  sedeNombre,
}: FinancialAccessGateProps) {
  const router = useRouter();
  const [clave, setClave] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [validando, setValidando] = useState(false);

  const cancelar = () => {
    if (window.history.length > 1) {
      router.back();
      return;
    }

    router.push("/dashboard");
  };

  const ingresar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      setValidando(true);
      setMensaje("");

      const res = await fetch("/api/financiero/acceso", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ clave }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error validando la clave");
        return;
      }

      setClave("");
      router.refresh();
    } catch {
      setMensaje("Error validando la clave");
    } finally {
      setValidando(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-lg rounded-[28px] bg-white p-8 shadow-xl ring-1 ring-slate-200">
        <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-700">
          Financiero
        </div>

        <h1 className="mt-4 text-4xl font-black tracking-tight text-slate-950">
          Clave de acceso
        </h1>

        <p className="mt-3 text-sm text-slate-600">
          Ingresa la clave del panel financiero para continuar en {sedeNombre}.
        </p>

        <form className="mt-6 space-y-4" onSubmit={ingresar}>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              Clave financiera
            </label>
            <input
              type="password"
              value={clave}
              onChange={(event) => setClave(event.target.value)}
              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
              placeholder="Ingresa la clave"
            />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              disabled={validando}
              className="flex-1 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-70"
            >
              {validando ? "Validando..." : "Ingresar al panel financiero"}
            </button>

            <button
              type="button"
              onClick={cancelar}
              className="flex-1 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              CANCELAR
            </button>
          </div>
        </form>

        {mensaje && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {mensaje}
          </div>
        )}
      </div>
    </div>
  );
}
