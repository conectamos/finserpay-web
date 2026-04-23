"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FinserBrand from "./_components/finser-brand";

export default function Home() {
  const router = useRouter();

  const [usuario, setUsuario] = useState("");
  const [clave, setClave] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);

  const login = async () => {
    try {
      setCargando(true);
      setMensaje("");

      const res = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ usuario, clave }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`❌ ${data.error || "Error al conectar con el servidor"}`);
        setCargando(false);
        return;
      }

      setMensaje(`✅ Bienvenido ${data.usuario.nombre}`);

      setTimeout(() => {
        router.push("/dashboard");
      }, 700);
    } catch {
      setMensaje("❌ Error al conectar con el servidor");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#fff6ea_0%,transparent_28%),linear-gradient(180deg,#f3efe7_0%,#eef3f8_100%)] px-4">
      <div className="w-full max-w-md rounded-[32px] border border-[#dde3eb] bg-white p-8 shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
        <div className="mb-8 flex justify-center">
          <FinserBrand showTagline />
        </div>

        <p className="mb-6 text-center text-sm font-medium text-slate-500">
          Ingresa con el usuario y la clave de la sede
        </p>

        <input
          type="text"
          placeholder="Usuario de la sede"
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
          className="mb-4 w-full rounded-2xl border border-slate-300 bg-white px-5 py-4 text-xl text-slate-900 outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
        />

        <input
          type="password"
          placeholder="Clave de la sede"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          className="mb-5 w-full rounded-2xl border border-slate-300 bg-white px-5 py-4 text-xl text-slate-900 outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
        />

        <button
          onClick={login}
          disabled={cargando}
          className="w-full rounded-2xl bg-slate-950 py-4 text-2xl font-semibold text-white transition hover:bg-slate-800 disabled:opacity-70"
        >
          {cargando ? "Ingresando..." : "Ingresar"}
        </button>

        {mensaje && (
          <p className="mt-6 text-center text-lg text-slate-700">{mensaje}</p>
        )}
      </div>
    </div>
  );
}
