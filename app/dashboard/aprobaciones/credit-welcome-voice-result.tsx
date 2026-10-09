"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Headphones, Phone, RefreshCw } from "lucide-react";
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

type ManualCall = { canCall: boolean; phone: string | null; reason?: string };
type CallRequest = { creditId: number; requestId: string; eventId?: string; busy: boolean;
  pending: boolean; message: string; error: boolean };
type PendingRequest = { creditId: number; requestId: string; eventId?: string; controller?: AbortController; busy: boolean };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const closedStates = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
function rememberRequest(creditId: number, requestId: string | null) {
  try {
    if (typeof sessionStorage === "undefined") return;
    const key = `finserpay:welcome-voice:request:${creditId}`;
    if (requestId) sessionStorage.setItem(key, requestId); else sessionStorage.removeItem(key);
  } catch { /* The in-memory guard still applies when storage is unavailable. */ }
}
function savedRequest(creditId: number) {
  try {
    const value = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(`finserpay:welcome-voice:request:${creditId}`);
    return value && uuid.test(value) ? value : null;
  } catch { return null; }
}
function requestMessage(status: string) {
  if (status === "UNKNOWN") return "La solicitud está por confirmar. Consulta su estado antes de intentar otra llamada.";
  if (status === "ACCEPTED") return "Dapta aceptó la solicitud. Aún no se confirma que el cliente haya contestado.";
  if (status === "DISPATCHING" || status === "PENDING") return "La llamada se está solicitando. Puedes consultar el estado de este mismo intento.";
  return `Resultado del intento: ${states[status] || "Por confirmar"}.`;
}

export default function CreditWelcomeVoiceResult({ creditId }: { creditId: number }) {
  const [read, setRead] = useState<{ creditId: number; revision: number; items: WelcomeVoiceCallView[]; error: string; manualCall?: ManualCall } | null>(null);
  const [revision, setRevision] = useState(0);
  const [request, setRequest] = useState<CallRequest | null>(null);
  const pendingRequest = useRef<PendingRequest | null>(null);
  const current = read?.creditId === creditId && read.revision === revision ? read : null;
  const items = current?.items || [];
  const loading = current === null;
  const error = current?.error || "";
  const manualCall = current?.manualCall;
  const currentRequest = request?.creditId === creditId ? request : null;
  const busy = currentRequest?.busy === true;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/creditos/${creditId}/bienvenida-voz`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as { ok?: boolean; items?: WelcomeVoiceCallView[]; manualCall?: ManualCall } | null;
        if (!response.ok || !body?.ok || !Array.isArray(body.items)) throw new Error("No se pudo consultar la bienvenida por voz.");
        if (controller.signal.aborted) return;
        const items = body.items.filter(item => item.creditId === creditId);
        const supplied = body.manualCall;
        const manualCall = supplied && typeof supplied.canCall === "boolean" &&
          (supplied.phone === null || (typeof supplied.phone === "string" && supplied.phone.length <= 32))
          ? { canCall: supplied.canCall, phone: supplied.phone,
            reason: typeof supplied.reason === "string" ? supplied.reason.slice(0, 240) : undefined } : undefined;
        setRead({ creditId, revision, items, error: "", manualCall });
        let pending = pendingRequest.current;
        if (!pending || pending.creditId !== creditId) {
          const requestId = savedRequest(creditId);
          pending = requestId ? { creditId, requestId, busy: false } : null;
          pendingRequest.current = pending;
          if (pending) setRequest({ ...pending, pending: true, error: false,
            message: "Hay una solicitud pendiente de confirmar. Consulta su estado para continuar con el mismo intento." });
        }
        const completed = pending?.eventId ? items.find(item => item.id === pending.eventId && closedStates.has(item.status)) : null;
        if (pending && !pending.busy && completed) {
          rememberRequest(creditId, null);
          pendingRequest.current = null;
          setRequest({ creditId, requestId: pending.requestId, eventId: completed.id, busy: false, pending: false,
            error: false, message: requestMessage(completed.status) });
        }
      })
      .catch(() => { if (!controller.signal.aborted) setRead({ creditId, revision, items: [], error: "No se pudo consultar la bienvenida por voz. Intenta actualizarla." }); });
    return () => controller.abort();
  }, [creditId, revision]);
  useEffect(() => () => {
    const pending = pendingRequest.current;
    if (pending?.creditId === creditId) {
      pending.controller?.abort();
      pendingRequest.current = null;
    }
  }, [creditId]);

  async function callNow() {
    if (!manualCall || loading) return;
    const previous = pendingRequest.current?.creditId === creditId ? pendingRequest.current : null;
    if (previous?.busy || (!manualCall.canCall && !previous)) return;
    const requestId = previous?.requestId || savedRequest(creditId) || crypto.randomUUID();
    const controller = new AbortController();
    const pending: PendingRequest = { creditId, requestId, eventId: previous?.eventId, busy: true, controller };
    pendingRequest.current = pending;
    rememberRequest(creditId, requestId);
    setRequest({ creditId, requestId, eventId: pending.eventId, busy: true, pending: true, error: false,
      message: previous ? "Consultando el estado del intento..." : "Solicitando la llamada..." });
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`/api/creditos/${creditId}/bienvenida-voz`, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ requestId }) });
      const body = await response.json().catch(() => null) as {
        ok?: boolean; eventId?: string; status?: string; requestCreated?: boolean; error?: string;
      } | null;
      if (body?.ok === false && body.requestCreated === false) {
        if (controller.signal.aborted || pendingRequest.current !== pending) return;
        rememberRequest(creditId, null);
        pendingRequest.current = null;
        const rejection = typeof body.error === "string" ? body.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) : "";
        setRequest({ creditId, requestId, busy: false, pending: false, error: true,
          message: rejection || "No se creó una llamada. Actualiza el expediente para revisar su disponibilidad." });
        setRevision(value => value + 1);
        return;
      }
      if (!response.ok || body?.ok !== true || typeof body.eventId !== "string" || !uuid.test(body.eventId) ||
        typeof body.status !== "string" || !Object.prototype.hasOwnProperty.call(states, body.status)) throw new Error("CALL_NOT_CONFIRMED");
      if (controller.signal.aborted || pendingRequest.current !== pending) return;
      pending.eventId = body.eventId;
      const closed = closedStates.has(body.status);
      if (closed) { rememberRequest(creditId, null); pendingRequest.current = null; }
      setRequest({ creditId, requestId, eventId: body.eventId, busy: false, pending: !closed,
        message: requestMessage(body.status), error: false });
      setRevision(value => value + 1);
    } catch {
      if (pendingRequest.current !== pending) return;
      setRequest({ creditId, requestId, eventId: pending.eventId, busy: false, pending: true, error: true,
        message: "No se pudo confirmar la solicitud. Consulta el estado del mismo intento; no se iniciará otra llamada." });
    } finally {
      clearTimeout(timeout);
      pending.busy = false;
    }
  }

  return <Card role="region" aria-label="Bienvenida por voz" className="min-w-0 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Headphones size={20} aria-hidden="true" />Bienvenida por voz</h2>
      <div className="flex flex-wrap items-center gap-2">
      {manualCall ? <Button disabled={loading || busy || (!currentRequest?.pending && (!manualCall.canCall || !manualCall.phone))}
        onClick={() => { void callNow(); }} aria-label={currentRequest?.pending ? "Consultar estado del intento de llamada" : "Llamar ahora al celular registrado"}>
        <Phone size={16} aria-hidden="true" />{busy ? "Procesando..." : currentRequest?.pending ? "Consultar estado" : "Llamar ahora"}
      </Button> : null}
      <Button variant="ghost" disabled={loading || busy} onClick={() => setRevision(value => value + 1)} aria-label="Actualizar resultado de la bienvenida por voz">
        <RefreshCw size={16} aria-hidden="true" />Actualizar
      </Button>
      </div>
    </div>
    {manualCall ? <p className="mt-3 text-sm text-[var(--fp-muted)]">{manualCall.phone ? `Celular registrado: ${manualCall.phone}. ` : ""}{!manualCall.canCall ? manualCall.reason || "No se puede solicitar una nueva llamada en este momento." : "La llamada y su resultado quedarán en este expediente."}</p> : null}
    {currentRequest ? <p role="status" aria-live="polite" className={`mt-3 text-sm ${currentRequest.error ? "text-[var(--fp-danger)]" : "text-[var(--fp-muted)]"}`}>{currentRequest.message}</p> : null}
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
