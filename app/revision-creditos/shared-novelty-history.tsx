"use client";

import { useEffect, useState } from "react";
import { Clock3, RefreshCw } from "lucide-react";
import { Button, EmptyState, LoadingState } from "@/app/_components/finser-ui";
import { readApprovalNoveltyHistory, type ApprovalNoveltyHistoryEvent, type ApprovalDetail } from "@/app/dashboard/aprobaciones/approval-client";
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
const labels: Record<string, string> = { REPORTED: "Novedad registrada", GENERAL_RESPONDED: "Respuesta del aliado", PHOTO_RESPONDED: "Fotografía corregida", APPROVED_RESOLVED: "Novedades resueltas con el OK" };
function text(value: unknown) { return typeof value === "string" ? value : ""; }
export default function SharedNoveltyHistory({ creditId, evidence = [] }: { creditId: number; evidence?: ApprovalDetail["evidence"] }) {
  const [events, setEvents] = useState<ApprovalNoveltyHistoryEvent[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readApprovalNoveltyHistory(creditId, controller.signal).then(items => { if (!controller.signal.aborted) setEvents(items); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo consultar el historial."); });
    return () => controller.abort();
  }, [creditId, retry]);
  const label = (key: unknown) => evidence.find(item => item.key === key)?.label || (key === "GENERAL" ? "Otra novedad" : "Fotografía del expediente");
  return <section aria-label="Historial de novedades" className="space-y-4">
    <div><h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 size={16} aria-hidden="true" />Historial de novedades</h3><p className="mt-2 text-sm text-[var(--fp-muted)]">Eventos de novedades registrados para este expediente.</p></div>
    {error ? <div><p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p><Button variant="ghost" onClick={() => { setError(""); setEvents(null); setRetry(value => value + 1); }}><RefreshCw size={16} aria-hidden="true" />Reintentar historial</Button></div> : events === null ? <LoadingState label="Consultando historial..." /> : !events.length ? <EmptyState title="Sin novedades registradas" /> : <ol className="space-y-4 border-l border-[var(--fp-border)] pl-4">{events.map(event => <li key={event.id} className="space-y-2 text-sm">
      <p className="font-semibold">{labels[event.type] || "Actualización de novedad"}</p>
      <p className="text-xs text-[var(--fp-muted)]">{dates.format(new Date(event.createdAt))} · {event.actorKind === "SHARED_LINK" ? "Acceso por enlace" : event.actorName}</p>
      {event.type === "REPORTED" && Array.isArray(event.payload.changes) ? event.payload.changes.map((change: unknown, index) => {
        if (!change || typeof change !== "object") return null;
        const item = change as Record<string, unknown>;
        return <p key={index} className="whitespace-pre-wrap break-words"><strong>{label(item.key)}: </strong>{text(item.reason)}</p>;
      }) : null}
      {event.type === "PHOTO_RESPONDED" ? <p>{label(event.payload.key)}</p> : null}
      {text(event.payload.text) ? <p className="whitespace-pre-wrap break-words">{text(event.payload.text)}</p> : null}
    </li>)}</ol>}
  </section>;
}
