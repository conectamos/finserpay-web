"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  ArrowRight,
  LockKeyhole,
  MapPin,
  Search,
  UsersRound,
  X,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import {
  normalizarAvatarPerfil,
  obtenerAvatarPerfilSrc,
} from "@/lib/profile-avatars";
import LogoutButton from "./logout-button";

type SellerAccessItem = {
  id: number;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  debeCambiarPin: boolean;
  tipoPerfil?: string | null;
  avatarKey?: string | null;
};

type SedeAccessItem = {
  id: number;
  nombre: string;
  codigo: string | null;
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

function getSellerAvatarSrc(seller: SellerAccessItem) {
  const visualKind = resolveSellerVisualKind(seller);
  const tipo = visualKind === "supervisor" ? "SUPERVISOR" : "VENDEDOR";
  return obtenerAvatarPerfilSrc(normalizarAvatarPerfil(seller.avatarKey, tipo));
}

function ProfileAvatar({
  seller,
  size = "large",
}: {
  seller: SellerAccessItem;
  size?: "compact" | "large" | "medium";
}) {
  const avatarSrc = getSellerAvatarSrc(seller);
  const dimensions =
    size === "large"
      ? "h-28 w-28"
      : size === "medium"
        ? "h-20 w-20"
        : "h-[52px] w-[52px]";

  return (
    <div
      className={[
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--fp-border)] bg-[var(--fp-bg)]",
        dimensions,
      ].join(" ")}
    >
      <Image
        src={avatarSrc}
        alt={seller.nombre}
        width={112}
        height={112}
        className="h-full w-full object-cover"
      />
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
  const [search, setSearch] = useState("");
  const [selectedSeller, setSelectedSeller] = useState<SellerAccessItem | null>(null);
  const [pin, setPin] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [abriendo, setAbriendo] = useState(false);
  const [selectingSede, setSelectingSede] = useState(false);
  const [availableSedes, setAvailableSedes] = useState<SedeAccessItem[]>([]);

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

  const openSellerProfile = async (sedeId?: number) => {
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
          ...(sedeId ? { sedeId } : {}),
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        requiresSedeSelection?: boolean;
        availableSedes?: SedeAccessItem[];
        mustChangePin?: boolean;
      };

      if (!response.ok) {
        setMensaje(data.error || "No se pudo abrir el perfil");
        return;
      }

      if (data.requiresSedeSelection) {
        setAvailableSedes(data.availableSedes || []);
        setSelectingSede(true);
        return;
      }

      setPin("");
      setSelectedSeller(null);
      setSelectingSede(false);
      setAvailableSedes([]);
      window.location.assign(data.mustChangePin ? "/dashboard/pin" : "/dashboard");
    } catch {
      setMensaje("No se pudo abrir el perfil seleccionado");
    } finally {
      setAbriendo(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--fp-bg)] text-[var(--fp-graphite)]">
      <header className="border-b border-white/10 bg-[var(--fp-navy)] text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <FinserBrand dark mini accentPay showTagline={false} />
            <span className="hidden h-8 w-px bg-white/15 sm:block" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase text-[var(--fp-lime)]">
                Sede activa
              </p>
              <p className="truncate text-sm font-semibold text-white sm:text-base">
                {sedeNombre}
              </p>
            </div>
          </div>

          <LogoutButton className="min-h-11 shrink-0 justify-center px-4 sm:min-w-[140px]" />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">
        <section aria-labelledby="seller-access-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase text-[var(--fp-lime-strong)]">
                Perfiles de acceso
              </p>
              <h1
                id="seller-access-title"
                className="mt-2 text-3xl font-bold text-[var(--fp-navy)] sm:text-4xl"
              >
                Selecciona un asesor
              </h1>
            </div>

            <div className="inline-flex min-h-11 w-fit items-center gap-2 rounded-[8px] border border-[var(--fp-border)] bg-white px-3 text-sm font-semibold text-[var(--fp-muted)]">
              <UsersRound className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />
              {filteredSellers.length} de {sellers.length} perfiles
            </div>
          </div>

          <div className="mt-6 flex min-h-14 items-center gap-3 rounded-[12px] border border-[var(--fp-border)] bg-white px-4 shadow-[var(--fp-shadow-sm)] focus-within:border-[var(--fp-lime-strong)] focus-within:ring-2 focus-within:ring-[var(--fp-lime-soft)]">
            <Search className="h-5 w-5 shrink-0 text-[var(--fp-muted)]" aria-hidden="true" />
            <label htmlFor="seller-search" className="sr-only">
              Buscar asesor
            </label>
            <input
              id="seller-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por nombre, cédula o teléfono"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent py-3 text-base text-[var(--fp-graphite)] outline-none placeholder:text-slate-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] text-[var(--fp-muted)] transition hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)]"
                aria-label="Limpiar búsqueda"
                title="Limpiar búsqueda"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
          </div>

        </section>

        {mensaje && !selectedSeller && (
          <div
            role="alert"
            className="mt-5 rounded-[8px] border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
          >
            {mensaje}
          </div>
        )}

        <section
          className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          aria-label="Perfiles disponibles"
        >
          {filteredSellers.map((seller) => {
            const visualKind = resolveSellerVisualKind(seller);

            return (
              <button
                key={seller.id}
                type="button"
                onClick={() => {
                  setMensaje("");
                  setPin("");
                  setSelectingSede(false);
                  setAvailableSedes([]);
                  setSelectedSeller(seller);
                }}
                className="group flex min-h-[84px] items-center gap-3 rounded-[12px] border border-[var(--fp-border)] bg-white px-3 py-3 text-left shadow-[var(--fp-shadow-sm)] transition hover:border-[var(--fp-lime-strong)] hover:bg-[var(--fp-lime-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] focus-visible:ring-offset-2"
                aria-label={`Abrir perfil de ${seller.nombre}`}
              >
                <ProfileAvatar seller={seller} size="compact" />

                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-base font-bold leading-5 text-[var(--fp-navy)]">
                    {seller.nombre}
                  </p>
                  <p className="mt-1 text-xs font-semibold uppercase text-[var(--fp-muted)]">
                    {visualKind === "supervisor" ? "Supervisor" : "Vendedor"}
                  </p>
                </div>

                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] bg-[var(--fp-graphite)] text-white transition group-hover:bg-[var(--fp-lime-strong)]">
                  <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </span>
              </button>
            );
          })}

          {!filteredSellers.length && (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-[12px] border border-dashed border-[var(--fp-border)] bg-white px-6 py-8 text-center md:col-span-2 xl:col-span-3">
              <UsersRound className="h-8 w-8 text-[var(--fp-muted)]" aria-hidden="true" />
              <p className="mt-3 font-semibold text-[var(--fp-navy)]">
                No encontramos asesores
              </p>
              <p className="mt-1 text-sm text-[var(--fp-muted)]">
                Ajusta la búsqueda para ver otros perfiles asignados a esta sede.
              </p>
            </div>
          )}
        </section>
      </main>

      {selectedSeller && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fp-navy)]/70 px-4 py-6">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="seller-access-dialog-title"
            className="relative max-h-full w-full max-w-md overflow-y-auto rounded-[12px] border border-[var(--fp-border)] bg-white p-5 shadow-[var(--fp-shadow-md)] sm:p-6"
          >
            <button
              type="button"
              onClick={() => {
                setSelectedSeller(null);
                setSelectingSede(false);
                setAvailableSedes([]);
              }}
              className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-[8px] border border-[var(--fp-border)] bg-white text-[var(--fp-muted)] transition hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)]"
              aria-label="Cerrar acceso al perfil"
              title="Cerrar"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>

            <div className="flex items-center gap-3 pr-12">
              <ProfileAvatar seller={selectedSeller} size="compact" />
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase text-[var(--fp-lime-strong)]">
                  {selectingSede ? "Sede de venta" : "Acceso al perfil"}
                </p>
                <h2
                  id="seller-access-dialog-title"
                  className="mt-1 text-2xl font-bold text-[var(--fp-navy)]"
                >
                  {selectingSede ? "Selecciona la sede" : "Ingresa tu PIN"}
                </h2>
                <p className="mt-1 truncate text-sm text-[var(--fp-muted)]">
                  {selectingSede
                    ? "El crédito se registrará en la sede elegida."
                    : selectedSeller.nombre}
                </p>
              </div>
            </div>

            {mensaje && (
              <div
                role="alert"
                className="mt-5 rounded-[8px] border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
              >
                {mensaje}
              </div>
            )}

            {selectingSede ? (
              <div className="mt-5 space-y-2">
                {availableSedes.map((sede) => (
                  <button
                    key={sede.id}
                    type="button"
                    onClick={() => void openSellerProfile(sede.id)}
                    disabled={abriendo}
                    className="flex min-h-14 w-full items-center gap-3 rounded-[8px] border border-[var(--fp-border)] bg-white px-4 py-3 text-left transition hover:border-[var(--fp-lime-strong)] hover:bg-[var(--fp-lime-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] disabled:cursor-wait disabled:opacity-60"
                  >
                    <MapPin className="h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-[var(--fp-navy)]">
                        {sede.nombre}
                      </span>
                      {sede.codigo && (
                        <span className="mt-0.5 block text-xs font-semibold uppercase text-[var(--fp-muted)]">
                          {sede.codigo}
                        </span>
                      )}
                    </span>
                    <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => setSelectingSede(false)}
                  disabled={abriendo}
                  className="mt-3 min-h-11 w-full rounded-[8px] border border-[var(--fp-border)] bg-white px-4 text-sm font-bold text-[var(--fp-graphite)] transition hover:bg-[var(--fp-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] disabled:opacity-60"
                >
                  Volver al PIN
                </button>
              </div>
            ) : (
              <div className="mt-5">
                <label
                  htmlFor="seller-pin"
                  className="mb-2 block text-sm font-semibold text-[var(--fp-graphite)]"
                >
                  PIN personal
                </label>
                <div className="flex min-h-14 items-center gap-3 rounded-[8px] border border-[var(--fp-border)] px-4 focus-within:border-[var(--fp-lime-strong)] focus-within:ring-2 focus-within:ring-[var(--fp-lime-soft)]">
                  <LockKeyhole className="h-5 w-5 shrink-0 text-[var(--fp-muted)]" aria-hidden="true" />
                  <input
                    id="seller-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="current-password"
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="4 a 6 dígitos"
                    className="min-w-0 flex-1 bg-transparent py-3 text-lg text-[var(--fp-graphite)] outline-none placeholder:text-slate-400"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => void openSellerProfile()}
                  disabled={abriendo}
                  aria-busy={abriendo}
                  className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-[var(--fp-graphite)] px-5 text-base font-bold text-white transition hover:bg-[var(--fp-lime-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                >
                  {abriendo ? "Validando..." : "Confirmar acceso"}
                  {!abriendo && <ArrowRight className="h-5 w-5" aria-hidden="true" />}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
