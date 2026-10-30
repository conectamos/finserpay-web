"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCheck } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Card, Input } from "@/app/_components/finser-ui";
import styles from "./attention-close-all.module.css";

type Review = { reviewToken: string; cutoff: string; expiresAt: string; totalCount: number; openCount: number; closeCount: number; unreadCount: number; skippedCount: number };
type Result = { closedCount: number; readCount: number; skippedCount: number; cutoff: string };
type Attempt = { review: Review; requestId: string };
type Props = { actorKey: string; request: <T>(url: string, init?: RequestInit) => Promise<T>; onDone: () => void; busyChanged: (busy: boolean) => void; accessDenied: (error: unknown) => boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const format = (value: string) => new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
function localNow() {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const part = (name: string) => p.find(v => v.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}
function restore(key: string): Attempt | null {
  try {
    const raw = sessionStorage.getItem(key); const value = raw && raw.length < 4000 ? JSON.parse(raw) : null;
    if (value && uuid.test(value.requestId) && uuid.test(value.review?.reviewToken)
      && [value.review.cutoff, value.review.expiresAt].every(v => typeof v === "string" && Number.isFinite(Date.parse(v)))
      && ["totalCount", "openCount", "closeCount", "unreadCount", "skippedCount"].every(k => Number.isSafeInteger(value.review[k]) && value.review[k] >= 0)) return value;
  } catch { /* An invalid stored intent never starts an operation. */ }
  return null;
}

export default function AttentionCloseAll({ actorKey, request, onDone, busyChanged, accessDenied }: Props) {
  const [cutoff, setCutoff] = useState(localNow);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true), working = useRef(false), controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDone, busyChanged, accessDenied }); callbacks.current = { onDone, busyChanged, accessDenied };
  const storageKey = `finser:attention:close-all:${actorKey}`;
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => { setPending(restore(storageKey)); setRestored(true); }, 0);
    return () => { alive.current = false; clearTimeout(timer); controller.current?.abort(); callbacks.current.busyChanged(false); };
  }, [storageKey]);
  function remember(attempt: Attempt | null) {
    setPending(attempt);
    try { if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt)); else sessionStorage.removeItem(storageKey); } catch { /* Server idempotency still protects this mounted intent. */ }
  }
  function setWorking(value: boolean) { working.current = value; if (alive.current) { setBusy(value); callbacks.current.busyChanged(value); } }
  async function preview() {
    if (working.current || pending || !restored) return;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(cutoff) || !Number.isFinite(Date.parse(`${cutoff}-05:00`))) { setError("Selecciona una fecha y hora válidas de Colombia."); return; }
    const current = new AbortController(); controller.current = current; setWorking(true); setError(""); setResult(null);
    try {
      const data = await request<Review>(`/api/atencion/close-all?cutoff=${encodeURIComponent(new Date(`${cutoff}-05:00`).toISOString())}`, { signal: current.signal });
      if (alive.current && !current.signal.aborted) setReview(data);
    } catch (failure) { if (alive.current && !current.signal.aborted && !callbacks.current.accessDenied(failure)) setError(failure instanceof Error ? failure.message : "No se pudo revisar la bandeja."); }
    finally { if (controller.current === current) controller.current = null; setWorking(false); }
  }
  async function commit(attempt: Attempt) {
    if (working.current) return;
    setWorking(true); setError(""); remember(attempt); setReview(null);
    try {
      const data = await request<Result>("/api/atencion/close-all", { method: "POST", body: JSON.stringify({ reviewToken: attempt.review.reviewToken, requestId: attempt.requestId, confirmed: true }) });
      if (!alive.current) return;
      remember(null); setResult(data); callbacks.current.onDone();
    } catch (failure) {
      if (!alive.current || callbacks.current.accessDenied(failure)) return;
      const status = failure && typeof failure === "object" && "status" in failure ? failure.status : 0;
      if ([400, 404, 409].includes(Number(status))) remember(null);
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar el cierre. Comprueba la misma solicitud antes de otra operación.");
    } finally { setWorking(false); }
  }
  return <Card className={styles.card}>
    <h2><CheckCheck aria-hidden="true" size={20} /> Cierre de la bandeja</h2>
    <p>Finaliza los chats revisados hasta una hora de corte y marca sus mensajes como leídos para tu usuario. Conserva el historial y la asignación.</p>
    <label>Mensajes hasta (hora de Colombia)<Input type="datetime-local" step="1" value={cutoff} onInput={event => { setCutoff(event.currentTarget.value); setReview(null); setResult(null); }} onChange={event => { setCutoff(event.target.value); setReview(null); setResult(null); }} disabled={busy || Boolean(pending)} /></label>
    <p className={styles.note}>Los chats con actividad posterior al corte o con un envío en curso quedan pendientes. Los mensajes nuevos conservan su estado de lectura.</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {pending ? <div className={styles.pending} role="status"><p>Hay una solicitud por confirmar, con corte {format(pending.review.cutoff)}. Se conserva el mismo intento.</p><Button variant="secondary" disabled={busy} onClick={() => void commit(pending)}>{busy ? "Comprobando…" : "Comprobar cierre pendiente"}</Button></div>
      : <Button variant="secondary" disabled={busy || !restored || !cutoff} onClick={() => void preview()}>{busy ? "Revisando…" : "Revisar cierre de chats"}</Button>}
    {result && <div className={styles.result} role="status"><strong>{result.closedCount} chats finalizados</strong><p>{result.readCount} mensajes marcados como leídos para tu usuario.</p><p>{result.skippedCount} chats conservados por cambios o actividad posterior.</p><small>Corte: {format(result.cutoff)} · Bogotá</small></div>}
    <div className={styles.confirmation}><ConfirmDialog open={Boolean(review)} title="Finalizar los chats revisados" description={review ? `Corte: ${format(review.cutoff)} (Bogotá).\n\n${review.closeCount} chats se pueden finalizar y ${review.unreadCount} mensajes se marcarán como leídos para tu usuario.\n\n${review.skippedCount} chats se conservarán por actividad posterior o envíos en curso. Si otro chat cambia antes de confirmar, también se conservará.\n\nEsta acción conserva mensajes, secciones y responsables.` : ""} confirmLabel="Finalizar y marcar leídos" busy={busy} onCancel={() => { if (!working.current) setReview(null); }} onConfirm={() => { if (review) void commit({ review, requestId: crypto.randomUUID() }); }} /></div>
  </Card>;
}
