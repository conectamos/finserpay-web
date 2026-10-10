"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Headphones, History, Phone, RefreshCw, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState } from "@/app/_components/finser-ui";
import type { WelcomeVoiceCallView } from "@/lib/credit-welcome-voice-http";
import { normalizeManualVoicePhone } from "@/lib/credit-welcome-voice-phone";
import { formatWelcomeVoiceCallDate as dateLabel, formatWelcomeVoiceCallDuration as durationLabel,
  orderedWelcomeVoiceCalls, welcomeVoiceHistoryPage, welcomeVoicePresentation } from "@/lib/credit-welcome-voice-presentation";
import styles from "./credit-welcome-voice-result.module.css";

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

function privateCallLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "app.dapta.ai" && !url.username && !url.password
      && (!url.port || url.port === "443") ? url.href : null;
  } catch { return null; }
}

type ManualCall = { canCall: boolean; phone: string | null; reason?: string };
type CallRequest = { creditId: number; requestId: string; eventId?: string; busy: boolean;
  pending: boolean; message: string; error: boolean };
type PendingRequest = { creditId: number; requestId: string; phone?: string; eventId?: string; controller?: AbortController; busy: boolean };
type SavedRequest = { requestId: string; phone?: string };
type Destination = { creditId: number; other: boolean; value: string };
type RequestLookup = { requestId: string; found: boolean; eventId?: string; status?: string };
type VoiceOverlay = { creditId: number; view: "history" | "detail"; page: number; callId?: string; fromHistory?: boolean };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const closedStates = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
function rememberRequest(creditId: number, requestId: string | null, phone?: string) {
  try {
    if (typeof sessionStorage === "undefined") return;
    const key = `finserpay:welcome-voice:request:${creditId}`;
    if (requestId) sessionStorage.setItem(key, JSON.stringify({ requestId, ...(phone ? { phone } : {}) }));
    else sessionStorage.removeItem(key);
  } catch { /* The in-memory guard still applies when storage is unavailable. */ }
}
function savedRequest(creditId: number): SavedRequest | null {
  try {
    const value = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(`finserpay:welcome-voice:request:${creditId}`);
    if (!value) return null;
    if (uuid.test(value)) return { requestId: value };
    const saved = JSON.parse(value) as SavedRequest | null;
    if (!saved || typeof saved.requestId !== "string" || !uuid.test(saved.requestId) ||
      (saved.phone !== undefined && (typeof saved.phone !== "string" || normalizeManualVoicePhone(saved.phone) !== saved.phone))) return null;
    return { requestId: saved.requestId, ...(saved.phone ? { phone: saved.phone } : {}) };
  } catch { return null; }
}
function requestMessage(status: string) {
  if (status === "UNKNOWN") return "Solicitud por confirmar.";
  if (status === "ACCEPTED") return "Llamada solicitada.";
  if (status === "DISPATCHING" || status === "PENDING") return "Solicitando la llamada…";
  return `Resultado del intento: ${states[status] || "Por confirmar"}.`;
}

export default function CreditWelcomeVoiceResult({ creditId }: { creditId: number }) {
  const [read, setRead] = useState<{ creditId: number; revision: number; items: WelcomeVoiceCallView[]; error: string; manualCall?: ManualCall } | null>(null);
  const [revision, setRevision] = useState(0);
  const [request, setRequest] = useState<CallRequest | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [overlay, setOverlay] = useState<VoiceOverlay | null>(null);
  const pendingRequest = useRef<PendingRequest | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const phoneFieldId = useId();
  const dialogTitleId = useId();
  const current = read?.creditId === creditId ? read : null;
  const items = orderedWelcomeVoiceCalls(current?.items || [], creditId);
  const latestCall = items[0];
  const activeAttempt = items.some(call => welcomeVoicePresentation(call).active);
  const loading = current === null;
  const refreshing = loading || current?.revision !== revision;
  const error = current?.error || "";
  const manualCall = current?.manualCall;
  const currentRequest = request?.creditId === creditId ? request : null;
  const busy = currentRequest?.busy === true;
  const retainedRequest = pendingRequest.current?.creditId === creditId ? pendingRequest.current : null;
  const currentDestination = destination?.creditId === creditId ? destination : { creditId, other: false, value: "" };
  const alternatePhone = currentDestination.other ? normalizeManualVoicePhone(currentDestination.value) : null;
  const destinationLocked = refreshing || busy || activeAttempt || Boolean(retainedRequest) || !manualCall?.canCall;
  const currentOverlay = overlay?.creditId === creditId ? overlay : null;
  const selectedCall = currentOverlay?.view === "detail" ? items.find(call => call.id === currentOverlay.callId) : null;
  const history = welcomeVoiceHistoryPage(items, currentOverlay?.page || 1);
  const dialogOpen = Boolean(currentOverlay);
  useEffect(() => {
    const controller = new AbortController();
    const requestedPending = pendingRequest.current?.creditId === creditId ? pendingRequest.current : null;
    const requestId = requestedPending?.requestId || savedRequest(creditId)?.requestId;
    const query = requestId ? `?requestId=${encodeURIComponent(requestId)}` : "";
    void fetch(`/api/creditos/${creditId}/bienvenida-voz${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as {
          ok?: boolean; items?: WelcomeVoiceCallView[]; manualCall?: ManualCall; request?: RequestLookup;
        } | null;
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
          const saved = savedRequest(creditId);
          pending = saved ? { creditId, ...saved, busy: false } : null;
          pendingRequest.current = pending;
          if (pending) setRequest({ ...pending, pending: true, error: false,
            message: "Verificando el estado de la solicitud anterior..." });
        }
        const restoredPhone = pending?.phone;
        setDestination(previous => previous?.creditId === creditId ? previous
          : { creditId, other: Boolean(restoredPhone), value: restoredPhone || "" });
        const lookup = body.request;
        if (!pending || pending.busy || !requestId || pending.requestId !== requestId ||
          (requestedPending && pending !== requestedPending)) return;
        setRequest({ creditId, requestId, eventId: pending.eventId, busy: false, pending: true, error: false,
          message: "Verificando el estado de la solicitud anterior..." });
        if (!lookup || lookup.requestId !== requestId || typeof lookup.found !== "boolean") return;
        if (!lookup.found) {
          // Keep the key: an earlier POST can still arrive after a lost response.
          pending.eventId = undefined;
          setRequest({ creditId, requestId, busy: false, pending: false, error: false,
            message: "No se había registrado la llamada. Puedes iniciarla con Llamar ahora." });
          return;
        }
        if (typeof lookup.eventId !== "string" || !uuid.test(lookup.eventId) || typeof lookup.status !== "string" ||
          !Object.prototype.hasOwnProperty.call(states, lookup.status)) return;
        pending.eventId = lookup.eventId;
        if (closedStates.has(lookup.status)) {
          rememberRequest(creditId, null);
          pendingRequest.current = null;
          setDestination({ creditId, other: false, value: "" });
          setRequest({ creditId, requestId, eventId: lookup.eventId, busy: false, pending: false,
            error: false, message: requestMessage(lookup.status) });
        } else {
          setRequest({ creditId, requestId, eventId: lookup.eventId, busy: false, pending: true,
            error: false, message: requestMessage(lookup.status) });
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
  useEffect(() => {
    if (busy || refreshing) return;
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      setRevision(value => value + 1);
    };
    const timeout = setTimeout(refresh, 5000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", refresh);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
    }
    return () => {
      clearTimeout(timeout);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refresh);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh);
      }
    };
  }, [creditId, currentRequest?.pending, busy, refreshing, revision]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialogOpen || !dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [dialogOpen, creditId]);

  async function callNow() {
    if (!manualCall || refreshing || error || activeAttempt) return;
    const previous = pendingRequest.current?.creditId === creditId ? pendingRequest.current : null;
    const retained = previous || savedRequest(creditId);
    if (previous?.busy || currentRequest?.pending || !manualCall.canCall || !manualCall.phone ||
      (!retained && currentDestination.other && !alternatePhone)) return;
    const requestId = retained?.requestId || crypto.randomUUID();
    const phone = retained ? retained.phone : currentDestination.other && alternatePhone ? alternatePhone : undefined;
    const controller = new AbortController();
    const pending: PendingRequest = { creditId, requestId, phone, eventId: previous?.eventId, busy: true, controller };
    pendingRequest.current = pending;
    rememberRequest(creditId, requestId, phone);
    setRequest({ creditId, requestId, eventId: pending.eventId, busy: true, pending: true, error: false,
      message: "Solicitando la llamada..." });
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`/api/creditos/${creditId}/bienvenida-voz`, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ requestId, ...(phone ? { phone } : {}) }) });
      const body = await response.json().catch(() => null) as {
        ok?: boolean; eventId?: string; status?: string; requestCreated?: boolean; error?: string;
      } | null;
      if (body?.ok === false && body.requestCreated === false) {
        if (controller.signal.aborted || pendingRequest.current !== pending) return;
        rememberRequest(creditId, null);
        pendingRequest.current = null;
        setDestination({ creditId, other: false, value: "" });
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
      if (closed) {
        rememberRequest(creditId, null); pendingRequest.current = null;
        setDestination({ creditId, other: false, value: "" });
      }
      setRequest({ creditId, requestId, eventId: body.eventId, busy: false, pending: !closed,
        message: requestMessage(body.status), error: false });
      setRevision(value => value + 1);
    } catch {
      if (pendingRequest.current !== pending) return;
      setRequest({ creditId, requestId, eventId: pending.eventId, busy: false, pending: true, error: true,
        message: "No se pudo confirmar la solicitud. El estado se consultará automáticamente; también puedes usar Actualizar." });
      setRevision(value => value + 1);
    } finally {
      clearTimeout(timeout);
      pending.busy = false;
    }
  }

  return <Card role="region" aria-label="Bienvenida por voz" className="min-w-0 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Headphones size={20} aria-hidden="true" />Bienvenida por voz</h2>
      <div className="flex flex-wrap items-center gap-2">
      {manualCall ? <Button disabled={refreshing || Boolean(error) || busy || activeAttempt || currentRequest?.pending || !manualCall.canCall || !manualCall.phone || (currentDestination.other && !alternatePhone)}
        onClick={() => { void callNow(); }} aria-label={currentDestination.other ? "Llamar ahora al número indicado" : "Llamar ahora al celular registrado"}>
        <Phone size={16} aria-hidden="true" />Llamar ahora
      </Button> : null}
      <Button variant="secondary" aria-label={`Ver historial (${items.length})`} disabled={!items.length}
        onClick={() => setOverlay({ creditId, view: "history", page: 1 })}>
        <History size={16} aria-hidden="true" />Ver historial ({items.length})
      </Button>
      <Button variant="ghost" disabled={refreshing || busy} onClick={() => setRevision(value => value + 1)} aria-label="Actualizar resultado de la bienvenida por voz" title="Actualizar">
        <RefreshCw size={16} aria-hidden="true" />
      </Button>
      </div>
    </div>
    {manualCall ? <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
      {manualCall.phone ? <p className="text-sm text-[var(--fp-muted)]">Celular registrado: {manualCall.phone}</p> : null}
      <label className="inline-flex min-h-10 items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="h-4 w-4 accent-[var(--fp-graphite)]" checked={currentDestination.other}
          disabled={destinationLocked} onChange={event => {
            if (!destinationLocked && pendingRequest.current?.creditId !== creditId) setDestination({ ...currentDestination, other: event.target.checked });
          }} />Llamar a otro número
      </label>
      {currentDestination.other ? <div className="w-full space-y-2">
        <label htmlFor={phoneFieldId} className="block text-sm font-medium">Número para esta llamada</label>
        <Input id={phoneFieldId} className="max-w-sm" type="tel" inputMode="tel" autoComplete="tel" maxLength={40}
          value={currentDestination.value} disabled={destinationLocked} aria-describedby={`${phoneFieldId}-help`}
          aria-invalid={Boolean(currentDestination.value && !alternatePhone)} onChange={event => {
            if (!destinationLocked && pendingRequest.current?.creditId !== creditId) setDestination({ ...currentDestination, value: event.target.value });
          }} />
        <p id={`${phoneFieldId}-help`} className={`text-sm ${currentDestination.value && !alternatePhone ? "text-[var(--fp-danger)]" : "text-[var(--fp-muted)]"}`}>
          {currentDestination.value && !alternatePhone ? "Ingresa un celular colombiano válido, sin letras ni extensiones. " : "Puedes escribir los 10 dígitos del celular o incluir +57. "}
          Se usará únicamente para esta llamada. No cambia el celular registrado del cliente.
        </p>
      </div> : null}
    </div> : null}
    {manualCall && !manualCall.canCall ? <p className="mt-1 text-sm text-[var(--fp-muted)]">{manualCall.reason || "No se puede solicitar una nueva llamada en este momento."}</p> : null}
    {currentRequest && (busy || currentRequest.error || !latestCall) ? <p role="status" aria-live="polite" className={`mt-3 text-sm ${currentRequest.error ? "text-[var(--fp-danger)]" : "text-[var(--fp-muted)]"}`}>{currentRequest.message}</p> : null}
    {loading ? <div className="mt-4"><LoadingState label="Consultando llamada de bienvenida..." /></div>
      : error ? <p role="alert" className="mt-4 text-sm text-[var(--fp-danger)]">{error}</p>
        : !items.length ? <EmptyState className="mt-3" title="Sin llamada registrada" description="Todavía no hay una bienvenida por voz asociada a este crédito." />
          : latestCall ? <article className={styles.latest} aria-label="Último intento de llamada">
            <div><span className={styles.caption}>Último intento</span><Badge tone={welcomeVoicePresentation(latestCall).tone}>{welcomeVoicePresentation(latestCall).label}</Badge></div>
            <dl className={styles.latestData}>
              <div><dt>Destino</dt><dd>{latestCall.destinationPhone || "Sin registro"}</dd></div>
              <div><dt>Fecha</dt><dd>{dateLabel(latestCall.dispatchedAt || latestCall.createdAt)}</dd></div>
              {latestCall.durationSeconds !== null ? <div><dt>Duración</dt><dd>{durationLabel(latestCall.durationSeconds)}</dd></div> : null}
            </dl>
            <Button variant="secondary" aria-label="Ver detalle del último intento" onClick={() => setOverlay({ creditId, view: "detail", callId: latestCall.id, page: 1 })}>Ver detalle</Button>
          </article> : null}
    {currentOverlay ? <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={dialogTitleId}
      onCancel={event => { event.preventDefault(); setOverlay(null); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOverlay(null);
      }}>
      <header className={styles.dialogHeader}>
        <div><h2 id={dialogTitleId}>{currentOverlay.view === "history" ? "Historial de llamadas" : "Detalle del intento"}</h2>
          {currentOverlay.view === "history" ? <p>{items.length} {items.length === 1 ? "intento" : "intentos"}</p> : null}
        </div>
        <Button variant="ghost" aria-label={currentOverlay.view === "history" ? "Cerrar historial de llamadas" : "Cerrar detalle de llamada"} onClick={() => setOverlay(null)}><X size={20} aria-hidden="true" /></Button>
      </header>
      {error ? <p role="alert" className="p-6 text-[var(--fp-danger)]">{error}</p>
        : currentOverlay.view === "history" ? <>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr><th>Fecha</th><th>Destino</th><th>Resultado</th><th>Duración</th><th><span className="sr-only">Detalle</span></th></tr></thead>
              <tbody>{history.items.map(call => {
                const presentation = welcomeVoicePresentation(call);
                return <tr key={call.id}>
                  <td>{dateLabel(call.dispatchedAt || call.createdAt)}</td><td>{call.destinationPhone || "Sin registro"}</td>
                  <td><Badge tone={presentation.tone}>{presentation.label}</Badge></td><td>{durationLabel(call.durationSeconds)}</td>
                  <td><Button variant="secondary" aria-label={`Ver detalle del intento ${call.id}`} onClick={() => setOverlay({ creditId, view: "detail", callId: call.id, page: history.page, fromHistory: true })}>Ver detalle</Button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {!items.length ? <EmptyState title="Sin llamadas registradas" /> : null}
          <footer className={styles.pagination}>
            <p>Mostrando {history.start}–{history.end} de {history.total} intentos</p>
            <nav aria-label="Páginas del historial de llamadas">
              <Button variant="ghost" disabled={history.page === 1} onClick={() => setOverlay({ ...currentOverlay, page: history.page - 1 })}>Anterior</Button>
              {Array.from({ length: history.pageCount }, (_, index) => index + 1).filter(page => page === 1 || page === history.pageCount || Math.abs(page - history.page) <= 1).map((page, index, pages) => <span key={page} className={styles.pageNumber}>
                {index > 0 && page - pages[index - 1] > 1 ? <span aria-hidden="true">…</span> : null}
                <Button variant={page === history.page ? "primary" : "ghost"} aria-current={page === history.page ? "page" : undefined} aria-label={`Página ${page}`} onClick={() => setOverlay({ ...currentOverlay, page })}>{page}</Button>
              </span>)}
              <Button variant="ghost" disabled={history.page === history.pageCount} onClick={() => setOverlay({ ...currentOverlay, page: history.page + 1 })}>Siguiente</Button>
            </nav>
          </footer>
        </> : selectedCall ? <div className={styles.detail}>
          {currentOverlay.fromHistory ? <Button variant="ghost" onClick={() => setOverlay({ creditId, view: "history", page: history.page })}><ArrowLeft size={16} aria-hidden="true" />Volver al historial</Button> : null}
          <Badge tone={welcomeVoicePresentation(selectedCall).tone}>{welcomeVoicePresentation(selectedCall).label}</Badge>
          {selectedCall.resultCode && outcomes[selectedCall.resultCode] && outcomes[selectedCall.resultCode] !== welcomeVoicePresentation(selectedCall).label ? <p className="text-sm font-medium">{outcomes[selectedCall.resultCode]}</p> : null}
          <dl className={styles.detailData}>
            <div><dt>Destino</dt><dd>{selectedCall.destinationPhone || "Sin registro"}</dd></div>
            <div><dt>Fecha</dt><dd>{dateLabel(selectedCall.dispatchedAt || selectedCall.createdAt)}</dd></div>
            <div><dt>Duración</dt><dd>{durationLabel(selectedCall.durationSeconds)}</dd></div>
            <div><dt>Identidad</dt><dd>{selectedCall.identityVerified === true ? "Verificada en FINSER PAY" : "Sin verificación registrada"}</dd></div>
          </dl>
          <section><h3>Resumen</h3><p className="whitespace-pre-wrap break-words">{selectedCall.summary || "El resultado de la conversación aún no está disponible."}</p></section>
          {selectedCall.doubts ? <section className={styles.doubts}><h3>Dudas y diferencias reportadas</h3><p className="whitespace-pre-wrap break-words">{selectedCall.doubts}</p></section> : null}
          <section><h3>Grabación</h3>
            {privateCallLink(selectedCall.recordingUrl) ? <>
              <a href={privateCallLink(selectedCall.recordingUrl)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="fp-ui-button is-secondary"><ExternalLink size={16} aria-hidden="true" />Abrir llamada en Dapta</a>
              <p className="text-sm">Necesitas acceso al espacio de trabajo de Dapta para consultar la llamada y descargar su grabación.</p>
            </> : <p>No hay un enlace privado disponible para consultar la grabación.</p>}
          </section>
        </div> : <EmptyState title="Intento no disponible" description="Actualiza el historial para consultarlo." />}
    </dialog> : null}
  </Card>;
}
