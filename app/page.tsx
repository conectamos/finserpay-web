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
        setMensaje(data.error || "Error al conectar con el servidor");
        setCargando(false);
        return;
      }

      setMensaje(`Bienvenido ${data.usuario.nombre}`);

      setTimeout(() => {
        router.push("/dashboard");
      }, 700);
    } catch {
      setMensaje("Error al conectar con el servidor");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="fp-shell flex min-h-screen items-center justify-center px-4 py-8">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[30px] border border-emerald-950/10 bg-white shadow-[0_28px_80px_rgba(23,32,29,0.16)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="fp-hero relative flex min-h-[520px] flex-col justify-between px-7 py-8 text-white sm:px-9">
          <div>
            <FinserBrand dark showTagline />
            <div className="mt-12 h-px w-full max-w-sm bg-white/14" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {["Sede segura", "Credito movil"].map((item) => (
              <div
                key={item}
                className="rounded-[22px] border border-white/12 bg-white/8 px-4 py-4 backdrop-blur"
              >
                <p className="text-sm font-black">{item}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="px-7 py-8 sm:px-9">
          <div className="mb-8">
            <div className="inline-flex rounded-full border fp-kicker px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]">
              Acceso sede
            </div>
            <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
              Ingresa a operar
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Usa el usuario y clave de la sede para abrir el panel comercial.
            </p>
          </div>

          <input
            type="text"
            placeholder="Usuario de la sede"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            className="mb-4 w-full rounded-[18px] border border-emerald-950/14 bg-[#f8fbf8] px-5 py-4 text-lg text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
          />

          <input
            type="password"
            placeholder="Clave de la sede"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            className="mb-5 w-full rounded-[18px] border border-emerald-950/14 bg-[#f8fbf8] px-5 py-4 text-lg text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
          />

          <button
            onClick={login}
            disabled={cargando}
            className="fp-action w-full rounded-[18px] py-4 text-lg font-black text-white transition hover:scale-[1.01] disabled:opacity-70"
          >
            {cargando ? "Ingresando..." : "Ingresar"}
          </button>

          {mensaje && (
            <p className="mt-6 rounded-[18px] border border-emerald-950/10 bg-emerald-50 px-4 py-3 text-center text-sm font-semibold text-emerald-900">
              {mensaje}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
