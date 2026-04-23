"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "./logout-button";

type SellerAccessItem = {
  id: number;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  debeCambiarPin: boolean;
  tipoPerfil?: string | null;
};

type SellerVisualKind = "vendedor" | "supervisor";

function resolveSellerVisualKind(seller: SellerAccessItem): SellerVisualKind {
  const profileType = String(seller.tipoPerfil || "").trim().toUpperCase();
  const sellerName = String(seller.nombre || "").trim().toUpperCase();

  if (profileType === "SUPERVISOR" || sellerName.includes("SUPERVISOR")) {
    return "supervisor";
  }

  return "vendedor";
}

function SellerPhoneIllustration({ label }: { label: string }) {
  return (
    <div className="seller-avatar-shell relative mx-auto flex h-32 w-32 items-center justify-center">
      <div className="absolute inset-0 rounded-[36px] bg-[linear-gradient(180deg,#ffffff_0%,#d7dbe3_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_16px_28px_rgba(15,23,42,0.16)]" />
      <div className="absolute inset-[7px] rounded-[30px] border border-white/80 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.96),rgba(228,232,239,0.72)_56%,rgba(199,204,214,0.45)_100%)]" />

      <svg
        viewBox="0 0 160 160"
        className="relative z-10 h-[104px] w-[104px] overflow-visible"
        aria-hidden="true"
        role="img"
      >
        <title>{label}</title>

        <defs>
          <linearGradient id="sellerCoat" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#15171d" />
            <stop offset="100%" stopColor="#3a3f4b" />
          </linearGradient>
          <linearGradient id="sellerPhone" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#263042" />
          </linearGradient>
        </defs>

        <g className="seller-float">
          <ellipse cx="78" cy="136" rx="32" ry="7" fill="rgba(15,23,42,0.13)" />
          <circle cx="79" cy="43" r="18" fill="#ffd7b5" />
          <path
            d="M60 44c0-12 8-22 20-22 8 0 15 4 19 11-8-3-15-2-21 2-5 3-9 7-18 9z"
            fill="#1a1b20"
          />
          <path
            d="M50 126c2-26 15-43 29-43s27 17 29 43H50z"
            fill="url(#sellerCoat)"
          />
          <path
            d="M70 84l9 11 10-11"
            fill="none"
            stroke="#f8fafc"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M64 58c2 4 7 6 14 6s12-2 15-6"
            fill="none"
            stroke="#d6a77a"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <g className="seller-phone-tilt">
            <path
              d="M102 82c7 6 10 13 9 22"
              fill="none"
              stroke="#ffd7b5"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <rect
              x="103"
              y="74"
              width="18"
              height="32"
              rx="5"
              fill="url(#sellerPhone)"
            />
            <rect x="107" y="79" width="10" height="19" rx="2" fill="#cbd5e1" />
            <circle cx="112" cy="101" r="1.9" fill="#94a3b8" />
            <circle className="seller-signal seller-signal-1" cx="126" cy="72" r="3.2" fill="#d8dde6" />
            <circle className="seller-signal seller-signal-2" cx="134" cy="64" r="2.6" fill="#eef2f7" />
          </g>
          <path
            d="M58 84c-8 7-12 16-12 28"
            fill="none"
            stroke="#ffd7b5"
            strokeWidth="7"
            strokeLinecap="round"
          />
        </g>
      </svg>

      <style jsx>{`
        @keyframes sellerFloat {
          0%,
          100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-4px);
          }
        }

        @keyframes sellerPhoneTilt {
          0%,
          100% {
            transform: rotate(-2deg) translateY(0px);
          }
          50% {
            transform: rotate(4deg) translateY(-1px);
          }
        }

        @keyframes sellerPulse {
          0%,
          100% {
            opacity: 0.35;
            transform: scale(0.9);
          }
          50% {
            opacity: 0.95;
            transform: scale(1.12);
          }
        }

        .seller-avatar-shell::after {
          content: "";
          position: absolute;
          inset: auto 20px 8px;
          height: 18px;
          border-radius: 9999px;
          background: radial-gradient(circle, rgba(148, 163, 184, 0.18), transparent 72%);
          filter: blur(8px);
        }

        .seller-float {
          transform-origin: center;
          animation: sellerFloat 4.4s ease-in-out infinite;
        }

        .seller-phone-tilt {
          transform-origin: 112px 90px;
          animation: sellerPhoneTilt 2.8s ease-in-out infinite;
        }

        .seller-signal {
          transform-origin: center;
          animation: sellerPulse 1.8s ease-in-out infinite;
        }

        .seller-signal-2 {
          animation-delay: 0.35s;
        }

        @media (prefers-reduced-motion: reduce) {
          .seller-float,
          .seller-phone-tilt,
          .seller-signal {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

function SupervisorObservationIllustration({ label }: { label: string }) {
  return (
    <div className="seller-avatar-shell relative mx-auto flex h-32 w-32 items-center justify-center">
      <div className="absolute inset-0 rounded-[36px] bg-[linear-gradient(180deg,#ffffff_0%,#d7dbe3_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_16px_28px_rgba(15,23,42,0.16)]" />
      <div className="absolute inset-[7px] rounded-[30px] border border-white/80 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.96),rgba(228,232,239,0.72)_56%,rgba(199,204,214,0.45)_100%)]" />

      <svg
        viewBox="0 0 160 160"
        className="relative z-10 h-[104px] w-[104px] overflow-visible"
        aria-hidden="true"
        role="img"
      >
        <title>{label}</title>

        <defs>
          <linearGradient id="supervisorCoat" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#17191f" />
            <stop offset="100%" stopColor="#424856" />
          </linearGradient>
          <linearGradient id="supervisorPanel" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#d7dde6" />
          </linearGradient>
        </defs>

        <g className="seller-float">
          <ellipse cx="80" cy="138" rx="34" ry="7" fill="rgba(15,23,42,0.13)" />
          <rect x="98" y="76" width="28" height="22" rx="5" fill="url(#supervisorPanel)" />
          <rect x="101" y="79" width="22" height="12" rx="3" fill="#1f2937" />
          <path
            d="M109 103h6"
            stroke="#64748b"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="78" cy="42" r="18" fill="#ffd7b5" />
          <path
            d="M60 42c1-13 10-22 21-22 9 0 17 4 20 12-9-3-16-2-22 2-5 3-8 6-19 8z"
            fill="#1a1b20"
          />
          <path
            d="M52 128c2-26 15-43 28-43 14 0 27 17 29 43H52z"
            fill="url(#supervisorCoat)"
          />
          <path
            d="M68 86l11 12 10-12"
            fill="none"
            stroke="#f8fafc"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M92 84c9 4 15 12 17 23"
            fill="none"
            stroke="#ffd7b5"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <path
            d="M63 87c-8 5-13 12-14 22"
            fill="none"
            stroke="#ffd7b5"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <circle className="seller-signal seller-signal-1" cx="128" cy="66" r="3.2" fill="#d8dde6" />
          <path
            className="supervisor-check"
            d="M121 65l3 3 6-7"
            fill="none"
            stroke="#0f766e"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>

      <style jsx>{`
        @keyframes sellerFloat {
          0%,
          100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-4px);
          }
        }

        @keyframes sellerPulse {
          0%,
          100% {
            opacity: 0.35;
            transform: scale(0.92);
          }
          50% {
            opacity: 1;
            transform: scale(1.08);
          }
        }

        @keyframes supervisorCheck {
          0%,
          100% {
            opacity: 0.85;
          }
          50% {
            opacity: 1;
          }
        }

        .seller-avatar-shell::after {
          content: "";
          position: absolute;
          inset: auto 20px 8px;
          height: 18px;
          border-radius: 9999px;
          background: radial-gradient(circle, rgba(148, 163, 184, 0.18), transparent 72%);
          filter: blur(8px);
        }

        .seller-float {
          transform-origin: center;
          animation: sellerFloat 4.4s ease-in-out infinite;
        }

        .seller-signal {
          transform-origin: center;
          animation: sellerPulse 1.8s ease-in-out infinite;
        }

        .supervisor-check {
          animation: supervisorCheck 1.8s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .seller-float,
          .seller-signal,
          .supervisor-check {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

export default function SellerProfileAccess({
  sedeNombre,
  sellers,
}: {
  sedeNombre: string;
  sellers: SellerAccessItem[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [selectedSeller, setSelectedSeller] = useState<SellerAccessItem | null>(null);
  const [pin, setPin] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [abriendo, setAbriendo] = useState(false);

  const filteredSellers = useMemo(() => {
    const normalized = search.trim().toLowerCase();

    if (!normalized) {
      return sellers;
    }

    return sellers.filter((seller) =>
      [seller.nombre, seller.documento || "", seller.telefono || ""]
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
  }, [search, sellers]);

  const openSellerProfile = async () => {
    if (!selectedSeller) {
      return;
    }

    try {
      setAbriendo(true);
      setMensaje("");

      const response = await fetch("/api/vendedores/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendedorId: selectedSeller.id,
          pin,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        mustChangePin?: boolean;
      };

      if (!response.ok) {
        setMensaje(data.error || "No se pudo abrir el perfil");
        return;
      }

      setPin("");
      setSelectedSeller(null);
      router.replace(data.mustChangePin ? "/dashboard/pin" : "/dashboard");
      router.refresh();
    } catch {
      setMensaje("No se pudo abrir el perfil seleccionado");
    } finally {
      setAbriendo(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f2f4f7_0%,#e4e7ec_58%,#dde1e7_100%)] text-slate-950">
      <header className="border-b border-zinc-800 bg-[linear-gradient(135deg,#050506_0%,#18181b_42%,#3f3f46_100%)] px-4 py-5 text-white shadow-[0_16px_40px_rgba(15,23,42,0.20)] sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="rounded-full border border-white/16 bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] p-3">
              <FinserBrand compact dark />
            </div>
            <div>
              <p className="text-2xl font-black tracking-tight">FINSER PAY</p>
              <p className="text-sm text-zinc-300">Ingreso por sede: {sedeNombre}</p>
            </div>
          </div>

          <LogoutButton className="min-w-[180px] justify-center" />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
        <section className="relative overflow-hidden rounded-[30px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef1f5_58%,#e1e5eb_100%)] px-6 py-6 shadow-[0_20px_40px_rgba(15,23,42,0.10)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.82),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_34%)]" />
          <p className="relative text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-700">
            Perfil del asesor
          </p>
          <h1 className="relative mt-3 text-4xl font-black tracking-tight text-slate-950">
            Selecciona el perfil de esta sede
          </h1>
          <p className="relative mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            Primero entra la sede con usuario y clave. Luego cada vendedor o
            supervisor abre su perfil con PIN propio para que el sistema sepa
            quien crea clientes, supervisa creditos y recibe abonos.
          </p>

          <div className="mt-6 max-w-2xl">
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              Nombre del asesor
            </label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar asesor o supervisor..."
              className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-zinc-700 focus:ring-2 focus:ring-zinc-200"
            />
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-2xl border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_100%)] px-4 py-4 text-sm font-medium text-zinc-800">
            {mensaje}
          </div>
        )}

        <section className="mt-8 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {filteredSellers.map((seller) => {
            const visualKind = resolveSellerVisualKind(seller);

            return (
              <button
                key={seller.id}
                type="button"
                onClick={() => {
                  setMensaje("");
                  setPin("");
                  setSelectedSeller(seller);
                }}
                className="relative overflow-hidden rounded-[30px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef1f5_58%,#e1e5eb_100%)] px-6 py-7 text-center shadow-[0_18px_38px_rgba(15,23,42,0.10)] transition hover:-translate-y-1 hover:shadow-[0_24px_42px_rgba(15,23,42,0.14)]"
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.82),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_34%)]" />
                <div className="relative">
                  {visualKind === "supervisor" ? (
                    <SupervisorObservationIllustration
                      label={`Supervisor ${seller.nombre} revisando la operacion`}
                    />
                  ) : (
                    <SellerPhoneIllustration
                      label={`Asesor ${seller.nombre} con celular`}
                    />
                  )}
                </div>
                <p className="relative mt-5 text-2xl font-black tracking-tight text-slate-950">
                  {seller.nombre}
                </p>
                <p className="relative mt-2 text-sm text-slate-500">
                  {visualKind === "supervisor"
                    ? "Supervisor"
                    : seller.documento || "Vendedor"}
                </p>
                <p className="relative mt-1 text-sm text-zinc-700">
                  {seller.debeCambiarPin ? "PIN pendiente de cambio" : "Perfil activo"}
                </p>
              </button>
            );
          })}

          {!filteredSellers.length && (
            <div className="rounded-[28px] border border-dashed border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef1f5_100%)] px-5 py-8 text-sm text-slate-500 sm:col-span-2 xl:col-span-4">
              No hay perfiles asignados a esta sede para ese filtro.
            </div>
          )}
        </section>
      </main>

      {selectedSeller && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4">
          <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef1f5_60%,#e1e5eb_100%)] px-6 py-6 shadow-[0_30px_70px_rgba(15,23,42,0.24)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.82),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_34%)]" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="relative text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  Acceso al perfil
                </p>
                <h2 className="relative mt-2 text-3xl font-black tracking-tight text-slate-950">
                  Ingresa tu PIN
                </h2>
                <p className="relative mt-2 text-sm text-slate-500">{selectedSeller.nombre}</p>
              </div>

              <button
                type="button"
                onClick={() => setSelectedSeller(null)}
                className="relative rounded-full border border-zinc-300 bg-white/70 px-3 py-1 text-sm font-semibold text-zinc-600 transition hover:bg-white"
              >
                X
              </button>
            </div>

            <div className="relative mt-6">
              <input
                type="password"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="PIN de 4 a 6 digitos"
                className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-center text-2xl tracking-[0.3em] text-slate-900 outline-none transition focus:border-zinc-700 focus:ring-2 focus:ring-zinc-200"
              />
            </div>

            <button
              type="button"
              onClick={() => void openSellerProfile()}
              disabled={abriendo}
              className="relative mt-5 w-full rounded-2xl bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] px-5 py-3 text-lg font-bold text-white shadow-[0_12px_24px_rgba(15,23,42,0.18)] transition hover:opacity-95 disabled:opacity-70"
            >
              {abriendo ? "Validando..." : "Confirmar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
