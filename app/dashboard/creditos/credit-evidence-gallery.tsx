"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  Download,
  Expand,
  ImageOff,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Upload,
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
  estado: string;
  updatedAt: string;
  canCorrect: boolean;
  summary: {
    clientName: string;
    document: string | null;
    imei: string;
    equipment: string;
  } | null;
  items: EvidenceItem[];
};

type Props = {
  creditId: number;
  clientName: string;
};

const MAX_EVIDENCE_DATA_URL_LENGTH = 2_450_000;

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

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("La imagen seleccionada no es valida"));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

async function normalizeEvidenceFile(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Selecciona una imagen PNG o JPEG");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  if (
    originalDataUrl.length <= MAX_EVIDENCE_DATA_URL_LENGTH &&
    /^data:image\/(?:png|jpe?g);base64,/i.test(originalDataUrl)
  ) {
    return originalDataUrl;
  }

  const image = await loadImage(originalDataUrl);
  const maxSide = 2_200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Este navegador no pudo preparar la imagen");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.88, 0.78, 0.68, 0.58]) {
    const compressed = canvas.toDataURL("image/jpeg", quality);
    if (compressed.length <= MAX_EVIDENCE_DATA_URL_LENGTH) return compressed;
  }

  throw new Error("La imagen es demasiado pesada; selecciona una de menor tamano");
}

function EvidenceCard({
  item,
  clientName,
  canCorrect = false,
  replacing = false,
  onReplace,
}: {
  item: EvidenceItem;
  clientName: string;
  canCorrect?: boolean;
  replacing?: boolean;
  onReplace?: (item: EvidenceItem, file: File) => void;
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

      <div className="flex min-h-24 flex-col gap-3 p-3">
        <div>
          <h5 className="text-sm font-black text-[#151a21]">{item.label}</h5>
          <p className="mt-1 text-xs leading-4 text-[#667085]">
            {capturedLabel || item.description}
          </p>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2">
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
          {canCorrect ? (
            <label className="fp-ui-button is-secondary min-h-10 cursor-pointer">
              {replacing ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              {replacing ? "Guardando..." : item.available ? "Reemplazar" : "Cargar"}
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                disabled={replacing}
                aria-label={`${item.available ? "Reemplazar" : "Cargar"} ${item.label}`}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  input.value = "";
                  if (file && onReplace) onReplace(item, file);
                }}
              />
            </label>
          ) : null}
        </div>
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

export function ApprovedCreditEvidenceCorrection({
  creditId,
  clientName,
}: Pick<Props, "creditId" | "clientName">) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [replacingKey, setReplacingKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setLoadError(null);

      try {
        const response = await fetch(`/api/creditos/${creditId}/evidencias?correction=1`, {
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
      } catch (error) {
        if (controller.signal.aborted) return;
        setData(null);
        setLoadError(
          error instanceof Error
            ? error.message
            : "No se pudieron cargar las evidencias"
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [creditId, retryToken]);

  async function replaceEvidence(item: EvidenceItem, file: File) {
    if (!data?.canCorrect || replacingKey) return;

    const confirmed = window.confirm(
      `Se reemplazara ${item.label} del credito ${data.folio}. La correccion quedara auditada. ¿Deseas continuar?`
    );
    if (!confirmed) return;

    setReplacingKey(item.key);
    setMutationError(null);
    setNotice(null);

    try {
      const dataUrl = await normalizeEvidenceFile(file);
      const response = await fetch(`/api/creditos/${creditId}/evidencias`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: item.key,
          dataUrl,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        unchanged?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "No se pudo corregir la evidencia");
      }

      setNotice(
        payload.unchanged
          ? "La imagen seleccionada ya era la evidencia vigente."
          : `${item.label} fue actualizada y la correccion quedo auditada.`
      );
      setRetryToken((value) => value + 1);
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? error.message
          : "No se pudo corregir la evidencia"
      );
    } finally {
      setReplacingKey(null);
    }
  }

  if (loading) {
    return (
      <section
        aria-busy="true"
        aria-label="Cargando correccion de evidencias"
        className="flex min-h-48 items-center justify-center rounded-[var(--fp-radius-lg)] border border-[var(--fp-border)] bg-white p-6 text-[var(--fp-muted)]"
      >
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        Cargando evidencias...
      </section>
    );
  }

  if (loadError || !data) {
    return (
      <section className="flex flex-col gap-4 rounded-[var(--fp-radius-lg)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-black text-[var(--fp-graphite)]">No fue posible abrir la correccion</p>
          <p className="mt-1 text-sm text-[var(--fp-danger)]">
            {loadError || "No se encontraron evidencias"}
          </p>
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

  const availableCount = data.items.filter((item) => item.available).length;
  const canCorrect = data.canCorrect && data.estado !== "ANULADO";

  return (
    <section className="rounded-[var(--fp-radius-lg)] border border-[var(--fp-border)] bg-white p-4 shadow-sm sm:p-6">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--fp-lime-strong)]">
            Correccion controlada
          </p>
          <h2 className="mt-1 text-xl font-black text-[var(--fp-graphite)]">
            Evidencias del credito {data.folio}
          </h2>
          {data.summary ? (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-[var(--fp-muted)]">
              <span>{data.summary.clientName}</span>
              <span>CC {data.summary.document || "No disponible"}</span>
              <span>{data.summary.equipment || "Equipo no disponible"}</span>
              <span>IMEI {data.summary.imei || "No disponible"}</span>
            </div>
          ) : null}
          <p className="mt-1 max-w-2xl text-sm text-[var(--fp-muted)]">
            Reemplaza solo la imagen necesaria. El estado y los datos comerciales del credito no cambian.
          </p>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] px-3 py-1.5 text-xs font-black text-[var(--fp-graphite)]">
          <Camera className="h-4 w-4" aria-hidden="true" />
          {availableCount} de {data.items.length} disponibles
        </div>
      </header>

      <div
        className={`mb-4 flex items-start gap-3 rounded-[var(--fp-radius-md)] border p-4 ${
          canCorrect
            ? "border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]"
            : "border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]"
        }`}
        role="status"
      >
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-sm font-black">
            {canCorrect
              ? "Acceso exclusivo del administrador central FINSER PAY"
              : "No tienes permiso para corregir estas evidencias"}
          </p>
          <p className="mt-1 text-xs leading-5">
            Cada reemplazo conserva fecha, actor y hashes anterior y nuevo. Este flujo no vuelve a consultar DataCredito, Veriff ni FirmaSeguro.
          </p>
        </div>
      </div>

      {mutationError ? (
        <p className="mb-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-danger)]" role="alert">
          {mutationError}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-graphite)]" role="status">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {data.items.map((item) => (
          <EvidenceCard
            key={item.key}
            item={item}
            clientName={data.summary?.clientName || clientName}
            canCorrect={
              canCorrect && (!replacingKey || replacingKey === item.key)
            }
            replacing={replacingKey === item.key}
            onReplace={(selectedItem, file) => {
              void replaceEvidence(selectedItem, file);
            }}
          />
        ))}
      </div>
    </section>
  );
}
