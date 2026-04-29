"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import FinserBrand from "./_components/finser-brand";

export default function Home() {
  const router = useRouter();

  const [usuario, setUsuario] = useState("");
  const [clave, setClave] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(false);

  const login = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

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
    <main className="min-h-screen overflow-x-hidden bg-[#f6f8f6] text-slate-950 lg:grid lg:grid-cols-[minmax(420px,0.88fr)_minmax(520px,1.12fr)]">
      <section className="flex min-h-screen w-full items-center overflow-hidden px-6 py-10 sm:px-10 lg:px-16">
        <div className="mx-auto w-full min-w-0 max-w-[calc(100vw-3rem)] sm:max-w-[460px]">
          <FinserBrand showTagline />

          <div className="mt-14">
            <span className="inline-flex rounded-full border border-emerald-500/25 bg-emerald-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-emerald-700">
              Acceso sede
            </span>
            <h1 className="mt-5 text-[2.6rem] font-black leading-[1.02] tracking-tight text-slate-950 sm:text-5xl">
              Bienvenido
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">
              Ingresa con las credenciales de la sede.
            </p>
          </div>

          <form onSubmit={login} className="mt-10 space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                Usuario
              </span>
              <input
                type="text"
                placeholder="Usuario de la sede"
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                className="w-full rounded-[14px] border border-slate-200 bg-white px-4 py-4 text-base text-slate-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                autoComplete="username"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                Clave
              </span>
              <input
                type="password"
                placeholder="Clave de la sede"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                className="w-full rounded-[14px] border border-slate-200 bg-white px-4 py-4 text-base text-slate-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                autoComplete="current-password"
              />
            </label>

            <button
              type="submit"
              disabled={cargando}
              className="fp-action mt-2 w-full rounded-[14px] py-4 text-base font-black text-white transition hover:translate-y-[-1px] disabled:opacity-70"
            >
              {cargando ? "Ingresando..." : "Ingresar"}
            </button>
          </form>

          {mensaje && (
            <p className="mt-5 rounded-[14px] border border-emerald-950/10 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-900">
              {mensaje}
            </p>
          )}
        </div>
      </section>

      <section className="relative hidden min-h-screen overflow-hidden bg-[#12211d] px-10 py-10 text-white lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_20%,rgba(18,184,134,0.32),transparent_28%),linear-gradient(135deg,#13231f_0%,#263832_52%,#0d1715_100%)]" />
        <div className="absolute right-[-120px] top-[-120px] h-80 w-80 rounded-full border border-white/10" />
        <div className="absolute bottom-[-160px] left-[12%] h-96 w-96 rounded-full border border-emerald-300/10" />

        <div className="relative m-auto grid w-full max-w-[820px] items-center gap-8 xl:grid-cols-[0.92fr_1.08fr]">
          <div className="space-y-8">
            <div>
              <span className="inline-flex rounded-full border border-white/15 bg-white/8 px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] text-emerald-100">
                Fabrica de creditos
              </span>
              <h2 className="mt-5 text-5xl font-black leading-[0.98] tracking-tight xl:text-6xl">
                Venta movil en una sola ruta
              </h2>
            </div>

            <div className="grid gap-3">
              {["Cliente", "Equipo", "Identidad", "Contrato", "Entrega"].map(
                (step, index) => (
                  <div
                    key={step}
                    className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/[0.06] px-4 py-3 backdrop-blur"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-sm font-black text-slate-950">
                      {index + 1}
                    </span>
                    <span className="text-sm font-black">{step}</span>
                  </div>
                ),
              )}
            </div>
          </div>

          <div className="relative min-h-[560px]">
            <div className="absolute left-4 top-8 h-[490px] w-[250px] rounded-[38px] border border-white/12 bg-[#07100f] p-4 shadow-[0_34px_90px_rgba(0,0,0,0.38)]">
              <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-white/20" />
              <div className="rounded-[28px] bg-white p-4 text-slate-950">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-700">
                  Captura movil
                </p>
                <div className="mt-4 h-32 rounded-[22px] bg-[linear-gradient(135deg,#e9f8f4_0%,#f8fbff_100%)]" />
                <div className="mt-4 space-y-2">
                  <div className="h-3 w-28 rounded-full bg-slate-200" />
                  <div className="h-3 w-36 rounded-full bg-slate-100" />
                </div>
                <div className="mt-5 rounded-[18px] bg-slate-950 px-4 py-3 text-center text-sm font-black text-white">
                  Tomar foto
                </div>
              </div>
            </div>

            <div className="absolute right-0 top-0 w-[360px] rounded-[32px] border border-white/14 bg-white p-6 text-slate-950 shadow-[0_34px_90px_rgba(0,0,0,0.24)]">
              <p className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-500">
                Panel comercial
              </p>
              <h3 className="mt-3 text-3xl font-black leading-none">
                FINSER PAY
              </h3>
              <div className="mt-6 grid gap-3">
                {[
                  ["QR movil", "Listo"],
                  ["Pagare", "Firmado"],
                  ["Plan de pagos", "Emitido"],
                ].map(([label, status]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-[18px] border border-slate-100 bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-black">{label}</span>
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-700">
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="absolute bottom-2 right-8 rounded-[28px] border border-white/12 bg-white/10 p-5 backdrop-blur">
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-emerald-100">
                Estado
              </p>
              <p className="mt-2 text-4xl font-black">Entregable</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
