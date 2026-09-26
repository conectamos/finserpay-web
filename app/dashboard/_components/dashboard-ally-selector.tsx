"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LoaderCircle, MapPin, Search } from "lucide-react";
import { Input } from "@/app/_components/finser-ui";

type DashboardAllySelectorProps = {
  allies: Array<{ id: number; nombre: string; codigo: string | null }>;
  selectedAllyId: number | null;
};

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO");
}

export default function DashboardAllySelector({
  allies,
  selectedAllyId,
}: DashboardAllySelectorProps) {
  const router = useRouter();
  const selectorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const selectedAlly = allies.find((ally) => ally.id === selectedAllyId);
  const normalizedQuery = normalizeSearch(query.trim());
  const filteredAllies = allies.filter((ally) =>
    normalizeSearch(`${ally.nombre} ${ally.codigo ?? ""}`).includes(normalizedQuery),
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    selectorRef.current?.querySelector<HTMLInputElement>("input")?.focus();

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!selectorRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function selectAlly(nextAllyId: number | null) {
    setOpen(false);
    triggerRef.current?.focus();

    if (nextAllyId === selectedAllyId) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (nextAllyId === null) {
      params.delete("aliadoId");
    } else {
      params.set("aliadoId", String(nextAllyId));
    }
    const queryString = params.toString();

    startTransition(() => {
      router.push(queryString ? `/dashboard?${queryString}` : "/dashboard", {
        scroll: false,
      });
    });
  }

  return (
    <div ref={selectorRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-busy={isPending}
        aria-controls="dashboard-ally-menu"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Buscar aliado: ${selectedAlly?.nombre ?? "Todas las sedes"}`}
        className="inline-flex min-h-11 max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] px-3 text-sm font-semibold text-[var(--fp-graphite)] transition hover:bg-[var(--fp-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)] disabled:cursor-wait disabled:opacity-70"
        disabled={isPending}
        onClick={() => {
          setQuery("");
          setOpen((currentOpen) => !currentOpen);
        }}
      >
        <MapPin className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 truncate text-left">{selectedAlly?.nombre ?? "Todas las sedes"}</span>
        {isPending ? (
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
      </button>

      {open ? (
        <div
          id="dashboard-ally-menu"
          role="dialog"
          aria-label="Seleccionar aliado del dashboard"
          className="absolute left-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 shadow-[var(--fp-shadow-md)]"
        >
          <label htmlFor="dashboard-ally-search" className="mb-2 block text-sm font-semibold text-[var(--fp-graphite)]">
            Buscar aliado
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-muted)]" aria-hidden="true" />
            <Input
              id="dashboard-ally-search"
              type="search"
              autoComplete="off"
              placeholder="Nombre o código del aliado"
              className="min-h-11 w-full"
              style={{ paddingLeft: "2.25rem" }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="mt-3 max-h-[min(20rem,50vh)] overflow-y-auto">
            <button
              type="button"
              aria-pressed={selectedAllyId === null}
              className={[
                "mb-1 flex min-h-11 w-full items-center rounded-[var(--fp-radius-sm)] px-3 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fp-lime)] disabled:cursor-wait disabled:opacity-70",
                selectedAllyId === null
                  ? "bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]"
                  : "text-[var(--fp-graphite)] hover:bg-[var(--fp-bg)]",
              ].join(" ")}
              disabled={isPending}
              onClick={() => selectAlly(null)}
            >
              Todas las sedes
            </button>
            {filteredAllies.map((ally) => (
              <button
                key={ally.id}
                type="button"
                aria-pressed={ally.id === selectedAllyId}
                className={[
                  "mb-1 flex min-h-11 w-full flex-col justify-center rounded-[var(--fp-radius-sm)] px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fp-lime)] disabled:cursor-wait disabled:opacity-70",
                  ally.id === selectedAllyId
                    ? "bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]"
                    : "text-[var(--fp-graphite)] hover:bg-[var(--fp-bg)]",
                ].join(" ")}
                disabled={isPending}
                onClick={() => selectAlly(ally.id)}
              >
                <span className="font-semibold">{ally.nombre}</span>
                {ally.codigo ? <span className="text-xs text-[var(--fp-muted)]">{ally.codigo}</span> : null}
              </button>
            ))}
            {filteredAllies.length === 0 ? (
              <p className="px-3 py-3 text-sm text-[var(--fp-muted)]" role="status">
                No se encontraron aliados.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}