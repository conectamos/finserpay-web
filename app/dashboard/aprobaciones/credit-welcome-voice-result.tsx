"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Headphones, RefreshCw } from "lucide-react";
import { Badge, Button, Card, EmptyState, LoadingState } from "@/app/_components/finser-ui";
import type { WelcomeVoiceCallView } from "@/lib/credit-welcome-voice-http";

const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
const states: Record<string, string> = {
  PENDING: "Pendiente", DISPATCHING: "Solicitando llamada", ACCEPTED: "Llamada solicitada",
  COMPLETED: "Llamada finalizada", FAILED: "Llamada fallida", UNKNOWN: "Por confirmar",
  CANCELLED: "Cancelada", SKIPPED: "No realizada",
};
const outcomes: Record<string, string> = {
  VOICEMAIL: "Buzón de voz", RECORDING_DECLINED: "Grabación no autorizada", CUSTOMER_DISCREPANCY: "Diferencia por revisar",
  CUSTOMER_QUESTIONS: "Preguntas del cliente", TERMS_REVIEWED: "Condiciones repasadas",
  CALL_COMPLETED: "Finalizada", CALL_FAILED: "Fallo de llamada",
};

function dateLabel(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? dates.format(date) : "Sin registro";
}
function durationLabel(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return "Sin registro";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function privateCallLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "app.dapta.ai" && !url.username && !url.password
      && (!url.port || url.port === "443") ? url.href : null;
  } catch { return null; }
}
function tone(status: string): "neutral" | "positive" | "warning" | "danger" {
  return status === "FAILED" ? "danger" : status === "COMPLETED" ? "positive"
    : ["PENDING", "DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(status) ? "warning" : "neutral";
}

export default function CreditWelcomeVoiceResult({ creditId }: { creditId: number }) {
  const [read, setRead] = useState<{ creditId: number; revision: number; items: WelcomeVoiceCallView[]; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const current = read?.creditId === creditId && read.revision === revision ? read : null;
  const items = current?.items || [];
  const loading = current === null;
  const error = current?.error || "";
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/creditos/${creditId}/bienvenida-voz`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as { ok?: boolean; items?: WelcomeVoiceCallView[] } | null;
        if (!response.ok || !body?.ok || !Array.isArray(body.items)) throw new Error("No se pudo consultar la bienvenida por voz.");
        if (!controller.signal.aborted) setRead({ creditId, revision, items: body.items.filter(item => item.creditId === creditId), error: "" });
      })
      .catch(() => { if (!controller.signal.aborted) setRead({ creditId, revision, items: [], error: "No se pudo consultar la bienvenida por voz. Intenta actualizarla." }); });
    return () => controller.abort();
  }, [creditId, revision]);

  return <Card role="region" aria-label="Bienvenida por voz" className="min-w-0 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Headphones size={20} aria-hidden="true" />Bienvenida por voz</h2>
      <Button variant="ghost" disabled={loading} onClick={() => setRevision(value => value + 1)} aria-label="Actualizar resultado de la bienvenida por voz">
        <RefreshCw size={16} aria-hidden="true" />Actualizar
      </Button>
    </div>
    <p className="mt-3 text-sm text-[var(--fp-muted)]">El audio permanece en Dapta y se descarga manualmente allí. FINSER PAY guarda el resultado y el enlace; no guarda el archivo de audio.</p>
    {loading ? <div className="mt-4"><LoadingState label="Consultando llamada de bienvenida..." /></div>
      : error ? <p role="alert" className="mt-4 text-sm text-[var(--fp-danger)]">{error}</p>
        : !items.length ? <EmptyState className="mt-3" title="Sin llamada registrada" description="Todavía no hay una bienvenida por voz asociada a este crédito." />
          : <div className="mt-4 divide-y divide-[var(--fp-border)]">{items.filter(item => item.creditId === creditId).map(call => {
            const href = privateCallLink(call.recordingUrl);
            return <article key={call.id} className="min-w-0 space-y-3 py-4 first:pt-0 last:pb-0" aria-label="Resultado de llamada">
              <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(call.status)}>{states[call.status] || "Por confirmar"}</Badge>
                {call.resultCode && outcomes[call.resultCode] ? <span className="text-sm font-medium">{outcomes[call.resultCode]}</span> : null}
              </div>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-[var(--fp-muted)]">Fecha</dt><dd>{dateLabel(call.completedAt || call.dispatchedAt || call.createdAt)}</dd></div>
                <div><dt className="text-[var(--fp-muted)]">Duración</dt><dd>{durationLabel(call.durationSeconds)}</dd></div>
                <div className="sm:col-span-2"><dt className="text-[var(--fp-muted)]">Identidad</dt><dd>{call.identityVerified ? "Verificada en FINSER PAY" : "Sin verificación registrada"}</dd></div>
              </dl>
              <div><h3 className="text-sm font-semibold">Resumen</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--fp-muted)]">{call.summary || "El resultado de la conversación aún no está disponible."}</p></div>
              {call.doubts ? <div className="border-l-2 border-[var(--fp-amber)] pl-3"><h3 className="text-sm font-semibold">Dudas y diferencias reportadas</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm">{call.doubts}</p></div> : null}
              {href ? <div><a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="fp-ui-button is-secondary"><ExternalLink size={16} aria-hidden="true" />Abrir llamada en Dapta</a><p className="mt-2 text-sm text-[var(--fp-muted)]">Necesitas acceso al espacio de trabajo de Dapta para consultar la llamada y descargar su grabación.</p></div>
                : <p className="text-sm text-[var(--fp-muted)]">No hay un enlace privado disponible para consultar la grabación.</p>}
            </article>;
          })}</div>}
  </Card>;
}
