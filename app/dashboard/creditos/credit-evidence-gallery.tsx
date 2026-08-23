"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  Download,
  Expand,
  ImageOff,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

type EvidenceItem = {
  key: string;
  label: string;
  description: string;
  available: boolean;
  capturedAt: string | null;
  source: string | null;
  href: string;
};

type EvidenceResponse = {
  ok: true;
  creditId: number;
  folio: string;
  platform: string;
  items: EvidenceItem[];
};

type Props = {
  creditId: number;
  clientName: string;
};

function capturedAtLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function downloadHref(href: string) {
  return `${href}${href.includes("?") ? "&" : "?"}download=1`;
}

function EvidenceCard({
  item,
  clientName,
}: {
  item: EvidenceItem;
  clientName: string;
}) {
  const capturedLabel = capturedAtLabel(item.capturedAt);

  return (
    <article className="overflow-hidden rounded-lg border border-[#d8dee5] bg-white shadow-[0_4px_14px_rgba(16,24,40,0.04)]">
      {item.available ? (
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative block aspect-[4/3] overflow-hidden bg-[#eef1f3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#93c01f]"
          aria-label={`Ver ${item.label} en tamano completo`}
        >
          {/* Authenticated API images cannot use the public image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.href}
            alt={`${item.label} de ${clientName}`}
            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
          />
          <span className="absolute bottom-2 right-2 inline-flex h-10 w-10 items-center justify-center rounded-md bg-[#111820] text-white shadow-lg">
            <Expand className="h-4 w-4" aria-hidden="true" />
          </span>
        </a>
      ) : (
        <div className="flex aspect-[4/3] flex-col items-center justify-center bg-[#f5f6f7] px-4 text-center text-[#87909c]">
          <ImageOff className="h-7 w-7" strokeWidth={1.6} aria-hidden="true" />
          <span className="mt-2 text-xs font-bold">No disponible</span>
        </div>
      )}

      <div className="flex min-h-24 items-start justify-between gap-2 p-3">
        <div>
          <h5 className="text-sm font-black text-[#151a21]">{item.label}</h5>
          <p className="mt-1 text-xs leading-4 text-[#667085]">
            {capturedLabel || item.description}
          </p>
        </div>
        {item.available ? (
          <a
            href={downloadHref(item.href)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#d8dee5] text-[#151a21] transition hover:border-[#93c01f] hover:text-[#5c7a13]"
            aria-label={`Descargar ${item.label}`}
            title={`Descargar ${item.label}`}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </article>
  );
}

export default function CreditEvidenceGallery({ creditId, clientName }: Props) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/creditos/${creditId}/evidencias`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as
          | EvidenceResponse
          | { error?: string };

        if (!response.ok || !("ok" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "No se pudieron cargar las evidencias"
          );
        }

        setData(payload);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudieron cargar las evidencias"
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [creditId, retryToken]);

  const availableCount = useMemo(
    () => data?.items.filter((item) => item.available).length || 0,
    [data]
  );

  if (loading) {
    return (
      <section
        aria-busy="true"
        aria-label="Cargando evidencias del credito"
        className="flex min-h-36 items-center justify-center border-t border-[#d8dee5] pt-4 text-[#5f6b7a]"
      >
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        Cargando evidencias...
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-4 border-t border-[#d8dee5] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold text-[#151a21]">No fue posible cargar las evidencias</p>
          <p className="mt-1 text-sm text-[#667085]">{error}</p>
        </div>
        <button
          type="button"
          onClick={() => setRetryToken((value) => value + 1)}
          className="fp-ui-button is-secondary min-h-11"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Reintentar
        </button>
      </section>
    );
  }

  if (!data || (data.platform !== "IPHONE" && availableCount === 0)) {
    return null;
  }

  return (
    <section className="border-t border-[#d8dee5] pt-5">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#5c7a13]">
            Evidencias de cierre
          </p>
          <h4 className="mt-1 text-xl font-black text-[#151a21]">
            {data.platform === "IPHONE"
              ? "Entrega y validacion iPhone"
              : "Evidencias del credito"}
          </h4>
          <p className="mt-1 max-w-2xl text-sm text-[#667085]">
            Fotografias tomadas durante la validacion y entrega del equipo.
          </p>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#d5dfbd] bg-[#f5fae9] px-3 py-1.5 text-xs font-black text-[#3f6212]">
          <Camera className="h-4 w-4" aria-hidden="true" />
          {availableCount} de {data.items.length} disponibles
        </div>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {data.items.map((item) => (
          <EvidenceCard
            key={item.key}
            item={item}
            clientName={clientName}
          />
        ))}
      </div>
    </section>
  );
}
