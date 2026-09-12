"use client";

import { useCallback, useState } from "react";
import { ChevronDown, Expand, ImageOff, RefreshCw, Upload } from "lucide-react";
import { Badge, Button, EmptyState } from "@/app/_components/finser-ui";
import ApprovalEvidenceCorrection from "@/app/dashboard/aprobaciones/approval-evidence-correction";
import type { ApprovalDetail } from "@/app/dashboard/aprobaciones/approval-client";

type Props = {
  detail: ApprovalDetail;
  readOnly: boolean;
  disabled?: boolean;
  onUpdated: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};
type Evidence = ApprovalDetail["evidence"][number];

function EvidenceImage({ item, clientName, thumbnail = false }: {
  item: Evidence; clientName: string; thumbnail?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [resolution, setResolution] = useState("");
  const href = retry ? `${item.href}${item.href.includes("?") ? "&" : "?"}retry=${retry}` : item.href;

  if (thumbnail) {
    return <span className="flex h-14 w-full items-center justify-center overflow-hidden bg-[var(--fp-bg)]">
      {item.available && !failed ? (
        // Private images use the session directly and retain their original bytes.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.href} alt="" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      ) : <ImageOff className="h-5 w-5 text-[var(--fp-muted)]" aria-hidden="true" />}
    </span>;
  }

  return <figure className="min-w-0 space-y-2">
    <div className="relative flex h-64 min-w-0 items-center justify-center overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] sm:h-80" aria-busy={item.available && !failed && !resolution}>
      {item.available && !failed ? (
        <>
          {!resolution ? <span role="status" className="absolute flex items-center gap-2 text-sm text-[var(--fp-muted)]"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />Cargando fotografía...</span> : null}
          {/* Authenticated originals must not go through the public image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={href} src={href} alt={`${item.label} de ${clientName}`} className="h-full w-full object-contain"
            onLoad={(event) => setResolution(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight} px`)}
            onError={() => { setFailed(true); setResolution(""); }} />
        </>
      ) : <div className="flex flex-col items-center gap-3 px-4 text-center text-sm text-[var(--fp-muted)]">
        <ImageOff className="h-7 w-7" aria-hidden="true" />
        <p role={failed ? "alert" : undefined}>{failed ? "No se pudo cargar la fotografía" : "Fotografía no disponible"}</p>
        {failed ? <Button variant="secondary" onClick={() => { setRetry((value) => value + 1); setFailed(false); }}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />Reintentar fotografía
        </Button> : null}
      </div>}
    </div>
    <figcaption className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold">{item.label}</p>
        {resolution ? <p className="text-sm text-[var(--fp-muted)]">Resolución original: {resolution}</p> : null}
      </div>
      {item.available ? <a href={item.href} target="_blank" rel="noopener noreferrer" className="fp-ui-button is-secondary min-h-10"
        aria-label={`Ampliar ${item.label} en resolución original; abre otra pestaña`}>
        <Expand className="h-4 w-4" aria-hidden="true" />Ampliar
      </a> : null}
    </figcaption>
  </figure>;
}

function EvidenceGallery({ detail, readOnly, disabled = false, onUpdated, onBusyChange }: Props) {
  const [selectedKey, setSelectedKey] = useState(detail.evidence.find((item) => item.available)?.key || detail.evidence[0]?.key || "");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const selected = detail.evidence.find((item) => item.key === selectedKey) || detail.evidence[0];
  const availableCount = detail.evidence.filter((item) => item.available).length;
  const correctionId = `shared-evidence-correction-${detail.id}`;
  const handleBusyChange = useCallback((busy: boolean) => {
    setCorrectionBusy(busy);
    onBusyChange(busy);
  }, [onBusyChange]);

  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold">Fotografías del expediente</h3>
      <Badge>{availableCount} de {detail.evidence.length} disponibles</Badge>
    </div>
    {selected ? <>
      <EvidenceImage key={`${selected.key}:${selected.href}`} item={selected} clientName={detail.clienteNombre} />
      <div className="grid min-w-0 grid-cols-3 gap-2 sm:grid-cols-5" role="group" aria-label="Seleccionar fotografía del expediente">
        {detail.evidence.map((item, index) => <button key={item.key} type="button" onClick={() => setSelectedKey(item.key)}
          aria-pressed={selected.key === item.key} aria-label={`${item.label}${item.available ? "" : ", no disponible"}`}
          className={`min-h-10 min-w-0 overflow-hidden rounded-[var(--fp-radius-md)] border text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-graphite)] ${selected.key === item.key ? "border-[var(--fp-graphite)] bg-[var(--fp-lime-soft)] ring-1 ring-[var(--fp-graphite)]" : "border-[var(--fp-border)] bg-[var(--fp-surface)]"}`}>
          <EvidenceImage key={`${item.key}:${item.href}`} item={item} clientName={detail.clienteNombre} thumbnail />
          <span className="block break-words px-1 py-2 text-center text-sm leading-snug"><span className="sr-only">{index + 1}. </span>{item.label}</span>
        </button>)}
      </div>
    </> : <EmptyState title="Sin fotografías registradas" description="No hay evidencias disponibles para este expediente." />}
    <p className="text-sm text-[var(--fp-muted)]">La disponibilidad de un archivo no significa que esté aprobado.</p>
    {!readOnly ? <div className="border-t border-[var(--fp-border)] pt-3">
      <Button variant="secondary" disabled={disabled || correctionBusy || !detail.capabilities.canCorrectEvidence}
        aria-expanded={correctionOpen} aria-controls={correctionId} onClick={() => setCorrectionOpen((open) => !open)}>
        <Upload className="h-4 w-4" aria-hidden="true" />Reemplazar fotografía
        <ChevronDown className={`h-4 w-4 ${correctionOpen ? "rotate-180" : ""}`} aria-hidden="true" />
      </Button>
      {!detail.capabilities.canCorrectEvidence ? <p className="mt-2 text-sm text-[var(--fp-muted)]">{detail.capabilities.correctionBlockedReason || "Este expediente no admite correcciones."}</p> : null}
      {correctionOpen ? <div id={correctionId}>
        <ApprovalEvidenceCorrection detail={detail} disabled={disabled} onUpdated={onUpdated} onBusyChange={handleBusyChange} />
      </div> : null}
    </div> : null}
  </div>;
}

export default function SharedEvidenceGallery(props: Props) {
  // A different credit or revision must not retain the previous image/form state.
  return <EvidenceGallery key={`${props.detail.id}:${props.detail.review.reviewHash}`} {...props} />;
}