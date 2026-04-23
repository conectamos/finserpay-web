"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PinChangeForm({
  sellerName,
}: {
  sellerName: string;
}) {
  const router = useRouter();
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);

  const savePin = async () => {
    try {
      setMensaje("");

      if (nextPin !== confirmPin) {
        setMensaje("La confirmacion del nuevo PIN no coincide.");
        return;
      }

      setGuardando(true);

      const response = await fetch("/api/vendedores/pin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPin,
          nextPin,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        mensaje?: string;
      };

      if (!response.ok) {
        setMensaje(data.error || "No se pudo actualizar el PIN");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setMensaje("No se pudo actualizar el PIN");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
        Seguridad del vendedor
      </div>
      <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
        Cambiar PIN de acceso
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Perfil actual: {sellerName}. Este PIN se usa despues del ingreso a la sede.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
          PIN actual
          <input
            type="password"
            value={currentPin}
            onChange={(event) =>
              setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
          Nuevo PIN
          <input
            type="password"
            value={nextPin}
            onChange={(event) =>
              setNextPin(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
          Confirmar PIN
          <input
            type="password"
            value={confirmPin}
            onChange={(event) =>
              setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
          />
        </label>
      </div>

      {mensaje && (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {mensaje}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void savePin()}
          disabled={guardando}
          className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-70"
        >
          {guardando ? "Guardando..." : "Guardar nuevo PIN"}
        </button>
        <button
          type="button"
          onClick={() => router.replace("/dashboard")}
          className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Volver
        </button>
      </div>
    </div>
  );
}
