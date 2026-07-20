"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  LockKeyhole,
  PenLine,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import FinserBrand from "./_components/finser-brand";

const REMEMBERED_USER_KEY = "finserpay-remembered-user";

const saleSteps = ["Cliente", "Equipo", "Identidad", "Contrato"];

export default function Home() {
  const router = useRouter();
  const [usuario, setUsuario] = useState("");
  const [clave, setClave] = useState("");
  const [recordarUsuario, setRecordarUsuario] = useState(false);
  const [mostrarClave, setMostrarClave] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [mensajeTipo, setMensajeTipo] = useState<"error" | "info" | "success">("info");
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    const rememberedUser = window.localStorage.getItem(REMEMBERED_USER_KEY);

    if (rememberedUser) {
      setUsuario(rememberedUser);
      setRecordarUsuario(true);
    }
  }, []);

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
        setMensajeTipo("error");
        setMensaje(data.error || "Error al conectar con el servidor");
        return;
      }

      if (recordarUsuario) {
        window.localStorage.setItem(REMEMBERED_USER_KEY, usuario.trim());
      } else {
        window.localStorage.removeItem(REMEMBERED_USER_KEY);
      }

      setMensajeTipo("success");
      setMensaje(`Bienvenido ${data.usuario.nombre}`);

      window.setTimeout(() => {
        router.push("/dashboard");
      }, 700);
    } catch {
      setMensajeTipo("error");
      setMensaje("Error al conectar con el servidor");
    } finally {
      setCargando(false);
    }
  };

  const mostrarAyuda = () => {
    setMensajeTipo("info");
    setMensaje("Solicita apoyo al administrador asignado a tu sede.");
  };

  return (
    <main className="grid min-h-[100svh] flex-1 bg-[#fbfaf7] text-[#15171b] xl:grid-cols-[43%_57%]">
      <section className="flex min-h-[100svh] items-center px-5 py-8 sm:px-10 xl:px-12 2xl:px-20">
        <div className="mx-auto w-full max-w-[480px]">
          <div>
            <FinserBrand showTagline={false} />
            <p className="ml-20 mt-[-18px] text-sm text-[#70737a] sm:text-base">
              Acceso comercial seguro
            </p>
          </div>

          <div className="mt-12 sm:mt-14">
            <span className="inline-flex rounded-lg border border-[#a7d52b] px-3 py-1 text-[11px] font-black uppercase text-[#568313]">
              Acceso sede
            </span>
            <h1 className="mt-5 text-[2.25rem] font-black leading-[1.08] sm:text-[2.35rem]">
              Bienvenido de nuevo
            </h1>
            <p className="mt-2 text-sm leading-6 text-[#70737a] sm:text-base">
              Ingresa con las credenciales asignadas a tu sede.
            </p>
          </div>

          <form onSubmit={login} className="mt-8 space-y-5">
            <label className="block" htmlFor="login-usuario">
              <span className="mb-2 block text-xs font-black uppercase text-[#555960]">
                Usuario
              </span>
              <span className="relative block">
                <UserRound
                  className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#858990]"
                  strokeWidth={1.7}
                />
                <input
                  id="login-usuario"
                  type="text"
                  placeholder="Usuario de la sede"
                  value={usuario}
                  onChange={(event) => setUsuario(event.target.value)}
                  className="h-14 w-full rounded-lg border border-[#cfd2d6] bg-white pl-12 pr-4 text-base text-[#15171b] outline-none transition focus:border-[#7fad18] focus:ring-4 focus:ring-[#a7d52b]/15"
                  autoComplete="username"
                  required
                />
              </span>
            </label>

            <label className="block" htmlFor="login-clave">
              <span className="mb-2 block text-xs font-black uppercase text-[#555960]">
                Clave
              </span>
              <span className="relative block">
                <LockKeyhole
                  className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#858990]"
                  strokeWidth={1.7}
                />
                <input
                  id="login-clave"
                  type={mostrarClave ? "text" : "password"}
                  placeholder="Clave de la sede"
                  value={clave}
                  onChange={(event) => setClave(event.target.value)}
                  className="h-14 w-full rounded-lg border border-[#cfd2d6] bg-white pl-12 pr-12 text-base text-[#15171b] outline-none transition focus:border-[#7fad18] focus:ring-4 focus:ring-[#a7d52b]/15"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setMostrarClave((current) => !current)}
                  className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-lg text-[#777b82] transition hover:bg-[#f1f2f2] hover:text-[#15171b]"
                  aria-label={mostrarClave ? "Ocultar clave" : "Mostrar clave"}
                  title={mostrarClave ? "Ocultar clave" : "Mostrar clave"}
                >
                  {mostrarClave ? (
                    <EyeOff className="h-5 w-5" strokeWidth={1.7} />
                  ) : (
                    <Eye className="h-5 w-5" strokeWidth={1.7} />
                  )}
                </button>
              </span>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[#555960]">
              <label className="flex cursor-pointer items-center gap-2" htmlFor="recordar-usuario">
                <input
                  id="recordar-usuario"
                  type="checkbox"
                  checked={recordarUsuario}
                  onChange={(event) => setRecordarUsuario(event.target.checked)}
                  className="h-5 w-5 rounded border-[#c6c9ce] accent-[#80ad1b]"
                />
                Recordar usuario
              </label>
              <button
                type="button"
                onClick={mostrarAyuda}
                className="font-semibold underline decoration-[#aeb1b6] underline-offset-4 hover:text-[#15171b]"
              >
                Necesitas ayuda?
              </button>
            </div>

            <button
              type="submit"
              disabled={cargando}
              className="relative flex h-14 w-full items-center justify-center rounded-lg bg-[#191a1d] px-14 text-base font-black text-white shadow-[0_12px_26px_rgba(21,23,27,0.16)] transition hover:bg-[#26282c] disabled:cursor-wait disabled:opacity-65"
            >
              <span>{cargando ? "Ingresando..." : "Ingresar"}</span>
              <ArrowRight className="absolute right-5 h-6 w-6 text-[#a9dd2d]" strokeWidth={2} />
            </button>
          </form>

          {mensaje ? (
            <p
              role={mensajeTipo === "error" ? "alert" : "status"}
              className={[
                "mt-4 rounded-lg border px-4 py-3 text-sm font-semibold",
                mensajeTipo === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : mensajeTipo === "success"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-[#d6d9dc] bg-white text-[#555960]",
              ].join(" ")}
            >
              {mensaje}
            </p>
          ) : null}

          <div className="mt-6 flex items-center justify-center gap-2 text-sm text-[#70737a]">
            <LockKeyhole className="h-4 w-4" strokeWidth={1.7} />
            Conexion segura y protegida
          </div>
        </div>
      </section>

      <section className="relative hidden min-h-[100svh] overflow-hidden bg-[#111317] text-white xl:flex">
        <div className="pointer-events-none absolute -right-24 -top-28 h-[360px] w-[360px] rounded-full border border-[#9ac524]/20" />
        <div className="pointer-events-none absolute -right-10 -top-20 h-[280px] w-[280px] rounded-full border border-[#9ac524]/15" />
        <div className="pointer-events-none absolute bottom-[-190px] left-[-70px] h-[430px] w-[430px] rounded-full border border-white/[0.05]" />
        <div className="pointer-events-none absolute bottom-[-130px] left-[-10px] h-[320px] w-[320px] rounded-full border border-white/[0.04]" />

        <div className="relative z-10 m-auto grid w-full max-w-[920px] grid-cols-[minmax(250px,0.82fr)_minmax(340px,1.18fr)] items-center gap-10 px-10 py-10 2xl:gap-16 2xl:px-16">
          <div>
            <p className="text-xs font-black uppercase text-[#a9dd2d]">
              Plataforma comercial
            </p>
            <h2
              className="mt-6 text-5xl leading-[1.05] 2xl:text-[3.8rem]"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
            >
              Vende, valida
              <br />
              y entrega<span className="text-[#a9dd2d]">.</span>
            </h2>
            <p className="mt-8 max-w-[280px] text-lg leading-8 text-[#c8cbd0]">
              Todo el proceso de financiacion en un solo lugar.
            </p>

            <div className="mt-32 flex items-center gap-3 text-sm font-semibold text-[#e2e4e7]">
              <ShieldCheck className="h-5 w-5 text-[#a9dd2d]" strokeWidth={1.8} />
              <span>Rapido</span>
              <span className="text-[#a9dd2d]">•</span>
              <span>Seguro</span>
              <span className="text-[#a9dd2d]">•</span>
              <span>Trazable</span>
            </div>
          </div>

          <div className="relative min-h-[560px]">
            <div className="absolute left-0 top-0 w-[330px] rounded-lg border border-white/20 bg-[#17191d] p-7 shadow-[0_28px_72px_rgba(0,0,0,0.34)] 2xl:w-[360px]">
              <h3 className="text-lg font-black">Nueva venta</h3>
              <div className="mt-5 border-t border-white/10 pt-2">
                {saleSteps.map((step, index) => (
                  <div key={step} className="relative flex min-h-[68px] items-center gap-4">
                    {index < saleSteps.length - 1 ? (
                      <span className="absolute bottom-[-6px] left-[14px] top-[41px] w-px bg-[#aeb3ba]" />
                    ) : null}
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#9acb28] text-sm font-black text-white shadow-[0_0_16px_rgba(154,203,40,0.28)]">
                      {index + 1}
                    </span>
                    <span className="text-sm text-[#d8dade]">{step}</span>
                    <Check className="ml-auto h-5 w-5 text-[#a9dd2d]" strokeWidth={2.2} />
                  </div>
                ))}

                <div className="mt-2 flex min-h-[62px] items-center gap-4 rounded-lg border border-[#96c51f]/50 bg-[#101216] px-2">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 border-[#a9dd2d] text-base font-black">
                    5
                  </span>
                  <span className="text-sm font-black">Listo para entregar</span>
                </div>
              </div>
            </div>

            <div className="absolute bottom-6 right-[-32px] w-[220px] rounded-lg border border-[#d8dadd] bg-[#fbfaf7] p-5 text-[#15171b] shadow-[0_24px_58px_rgba(0,0,0,0.34)]">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-black">Credito aprobado</p>
                <span className="h-2.5 w-2.5 rounded-full bg-[#9acb28]" />
              </div>
              <div className="mt-4 divide-y divide-[#dadcdf] border-t border-[#dadcdf]">
                <div className="flex items-center gap-3 py-3 text-xs font-semibold">
                  <ShieldCheck className="h-5 w-5 text-[#6f747b]" strokeWidth={1.6} />
                  Identidad verificada
                </div>
                <div className="flex items-center gap-3 py-3 text-xs font-semibold">
                  <PenLine className="h-5 w-5 text-[#6f747b]" strokeWidth={1.6} />
                  Pagare firmado
                </div>
                <div className="flex items-center gap-3 py-3 text-xs font-semibold">
                  <FileText className="h-5 w-5 text-[#6f747b]" strokeWidth={1.6} />
                  Plan de pagos emitido
                </div>
              </div>
            </div>

            <FileCheck2 className="absolute right-8 top-8 h-8 w-8 text-white/10" strokeWidth={1.2} />
          </div>
        </div>
      </section>
    </main>
  );
}
