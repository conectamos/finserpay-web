"use client";

import { useEffect, useState } from "react";
import { Clock3, RefreshCw } from "lucide-react";
import { Button, EmptyState, LoadingState } from "@/app/_components/finser-ui";
import {
  readApprovalData,
  readApprovalNoveltyHistory,
  type ApprovalDataHistoryEvent,
  type ApprovalDataHistoryField,
  type ApprovalDetail,
  type ApprovalNoveltyHistoryEvent,
} from "@/app/dashboard/aprobaciones/approval-client";
import { getColombiaDepartmentLabel } from "@/lib/colombia-locations";

const dates = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const noveltyLabels: Record<string, string> = {
  REPORTED: "Novedad registrada",
  GENERAL_RESPONDED: "Respuesta del aliado",
  PHOTO_RESPONDED: "Fotografía corregida",
  ANALYST_VERIFIED: "Novedad solucionada por el analista",
  APPROVED_RESOLVED: "Novedades resueltas con el OK",
};
const dataLabels: Record<ApprovalDataHistoryField, string> = {
  clienteCorreo: "Correo",
  clienteTelefono: "Teléfono",
  clienteDepartamento: "Departamento",
  clienteCiudad: "Ciudad",
  clienteDireccion: "Dirección",
  referenciaEquipo: "Referencia del equipo",
};

type TimelineEntry =
  | { kind: "novelty"; event: ApprovalNoveltyHistoryEvent }
  | { kind: "data"; event: ApprovalDataHistoryEvent };

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function actorLabel(actorKind: "USER" | "SHARED_LINK", actorName: string) {
  return actorKind === "SHARED_LINK" ? "Acceso por enlace" : actorName;
}

function dataValue(field: ApprovalDataHistoryField, value: string | null) {
  if (!value?.trim()) return "No disponible";
  return field === "clienteDepartamento" ? getColombiaDepartmentLabel(value) : value;
}

export default function SharedNoveltyHistory({
  creditId,
  evidence = [],
}: {
  creditId: number;
  evidence?: ApprovalDetail["evidence"];
}) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      readApprovalNoveltyHistory(creditId, controller.signal),
      readApprovalData(creditId, controller.signal),
    ]).then(([novelties, corrections]) => {
      if (controller.signal.aborted) return;
      if (novelties.status === "rejected" && corrections.status === "rejected") {
        const cause = corrections.reason instanceof Error ? corrections.reason : novelties.reason;
        setError(cause instanceof Error ? cause.message : "No se pudo consultar el historial.");
        setEntries([]);
        return;
      }

      const next: TimelineEntry[] = [];
      if (novelties.status === "fulfilled") {
        next.push(...novelties.value.map((event) => ({ kind: "novelty" as const, event })));
      }
      if (corrections.status === "fulfilled") {
        next.push(...corrections.value.history.map((event) => ({ kind: "data" as const, event })));
      }
      next.sort((left, right) => new Date(right.event.createdAt).getTime() - new Date(left.event.createdAt).getTime());
      setEntries(next);
      if (novelties.status === "rejected") setWarning("No fue posible cargar las novedades. Las correcciones disponibles se muestran a continuación.");
      if (corrections.status === "rejected") setWarning("No fue posible cargar las correcciones de datos. Las novedades disponibles se muestran a continuación.");
    });
    return () => controller.abort();
  }, [creditId, retry]);

  const evidenceLabel = (key: unknown) =>
    evidence.find((item) => item.key === key)?.label
    || (key === "GENERAL" ? "Otra novedad" : "Fotografía del expediente");

  function retryHistory() {
    setEntries(null);
    setError("");
    setWarning("");
    setRetry((value) => value + 1);
  }

  return (
    <section aria-label="Historial del expediente" className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 size={16} aria-hidden="true" />Historial del expediente</h3>
        <p className="mt-2 text-sm text-[var(--fp-muted)]">Novedades y correcciones de información registradas para este crédito.</p>
      </div>
      {error ? (
        <div>
          <p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p>
          <Button variant="ghost" onClick={retryHistory}><RefreshCw size={16} aria-hidden="true" />Reintentar historial</Button>
        </div>
      ) : entries === null ? (
        <LoadingState label="Consultando historial..." />
      ) : (
        <>
          {warning ? <div className="space-y-2"><p role="alert" className="text-sm text-[var(--fp-danger)]">{warning}</p><Button variant="ghost" onClick={retryHistory}><RefreshCw size={16} aria-hidden="true" />Reintentar historial completo</Button></div> : null}
          {!entries.length ? <EmptyState title="Sin eventos registrados" description="Las novedades y correcciones aparecerán aquí." /> : (
            <ol className="space-y-4 border-l border-[var(--fp-border)] pl-4">
              {entries.map((entry) => entry.kind === "data" ? (
                <li key={`data:${entry.event.id}`} className="space-y-2 text-sm">
                  <p className="font-semibold">Información corregida</p>
                  <p className="text-xs text-[var(--fp-muted)]">{dates.format(new Date(entry.event.createdAt))} · {actorLabel(entry.event.actorKind, entry.event.actorName)}</p>
                  <p className="whitespace-pre-wrap break-words"><strong>Motivo: </strong>{entry.event.reason}</p>
                  <ul className="space-y-2">
                    {entry.event.changes.map((change, index) => (
                      <li key={`${change.field}:${index}`} className="rounded-[var(--fp-radius-sm)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3">
                        <strong>{dataLabels[change.field]}</strong>
                        <span className="mt-1 block break-words text-[var(--fp-muted)]">
                          {dataValue(change.field, change.before)} <span aria-hidden="true">→</span><span className="sr-only"> cambió a </span> {dataValue(change.field, change.after)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ) : (
                <li key={`novelty:${entry.event.id}`} className="space-y-2 text-sm">
                  <p className="font-semibold">{noveltyLabels[entry.event.type] || "Actualización de novedad"}</p>
                  <p className="text-xs text-[var(--fp-muted)]">{dates.format(new Date(entry.event.createdAt))} · {actorLabel(entry.event.actorKind, entry.event.actorName)}</p>
                  {entry.event.type === "REPORTED" && Array.isArray(entry.event.payload.changes) ? entry.event.payload.changes.map((change: unknown, index) => {
                    if (!change || typeof change !== "object") return null;
                    const item = change as Record<string, unknown>;
                    return <p key={index} className="whitespace-pre-wrap break-words"><strong>{evidenceLabel(item.key)}: </strong>{text(item.reason)}</p>;
                  }) : null}
                  {entry.event.type === "PHOTO_RESPONDED" ? <p>{evidenceLabel(entry.event.payload.key)}</p> : null}
                  {entry.event.type === "ANALYST_VERIFIED" ? <><p><strong>{evidenceLabel(entry.event.payload.key)}</strong></p><p className="whitespace-pre-wrap break-words">{text(entry.event.payload.note) || "El analista confirmó que la novedad quedó solucionada."}</p></> : null}
                  {text(entry.event.payload.text) ? <p className="whitespace-pre-wrap break-words">{text(entry.event.payload.text)}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
