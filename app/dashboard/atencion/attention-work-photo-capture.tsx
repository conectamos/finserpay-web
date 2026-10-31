"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/_components/finser-ui";
import styles from "./attention-work-photo-capture.module.css";

export type AttentionWorkPhotoSession = { id: string; expiresAt: string; state: "open" | "revoked" | "expired"; uploadedCount: number; lastUploadedAt: string | null };
type Creation = { requestId: string; version: number; token: string };
type Props = { workId: string; mode: "seller" | "attention"; version: number; active: boolean; disabled?: boolean; onReceived: () => void; onClose: () => void; onAccessDenied?: (error: unknown) => void };

function captureError(message: string, status?: number) { return Object.assign(new Error(message), { status }); }
function isStopped(error: unknown) { return [401, 403, 404, 409, 410].includes((error as { status?: number })?.status || 0); }
function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join(""); }

export default function AttentionWorkPhotoCapture(props: Props) {
  const [session, setSession] = useState<AttentionWorkPhotoSession | null>(null), [qr, setQr] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating" | "uncertain" | "cancelling" | "cancel-uncertain">("idle");
  const [error, setError] = useState(""), [validated, setValidated] = useState(false), [blocked, setBlocked] = useState(false);
  const live = useRef(props); live.current = props;
  const current = useRef<AttentionWorkPhotoSession | null>(null), creation = useRef<Creation | null>(null), secret = useRef("");
  const generation = useRef(0), writing = useRef(false), controller = useRef<AbortController | null>(null), reading = useRef<AbortController | null>(null);
  const binding = useRef(""), closing = useRef(false), received = useRef(0), revoked = useRef(false);
  const endpoint = `/api/${props.mode === "seller" ? "ventas/atencion" : "atencion/solicitudes"}/${encodeURIComponent(props.workId)}/capture`;
  const endpointRef = useRef(endpoint); endpointRef.current = endpoint;
  const abortOperations = useCallback(() => { generation.current++; reading.current?.abort(); reading.current = null; controller.current?.abort(); controller.current = null; writing.current = false; }, []);

  function valid(epoch: number, scope: string, signal?: AbortSignal) { return propsKey(live.current) === scope && live.current.active && epoch === generation.current && !signal?.aborted; }
  function propsKey(value: Props) { return `${value.mode}:${value.workId}`; }
  async function request(url: string, init: RequestInit) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
    const data = await response.json().catch(() => null);
    if (init.signal?.aborted) throw Object.assign(new Error("Consulta cancelada"), { name: "AbortError" });
    if (!response.ok) throw captureError(data?.error || "No se pudo consultar la captura móvil.", response.status);
    return data as AttentionWorkPhotoSession;
  }
  function apply(next: AttentionWorkPhotoSession) {
    current.current = next; setSession(next);
    if (next.uploadedCount > received.current) { received.current = next.uploadedCount; live.current.onReceived(); }
    if (next.state !== "open") setQr("");
  }
  function access(error: unknown) {
    if ([401, 403, 404].includes((error as { status?: number })?.status || 0)) { setBlocked(true); setQr(""); live.current.onAccessDenied?.(error); }
  }

  const load = useCallback(async () => {
    const known = current.current;
    if (!live.current.active || !known || writing.current || reading.current || closing.current) return;
    const read = new AbortController(), epoch = generation.current, scope = propsKey(live.current); reading.current = read;
    let timedOut = false; const deadline = setTimeout(() => { timedOut = true; read.abort(); }, 20_000);
    try {
      const next = await request(`${endpointRef.current}/${encodeURIComponent(known.id)}`, { signal: read.signal });
      if (!valid(epoch, scope, read.signal)) return;
      if (next.id !== known.id) throw captureError("La sesión de fotos cambió. Vuelve a abrir la captura desde el chat.", 409);
      apply(next); setValidated(true); setError("");
    } catch (failure) {
      if (valid(epoch, scope, timedOut ? undefined : read.signal)) { setError(timedOut ? "La consulta tardó demasiado. Vuelve a consultar el QR." : failure instanceof Error ? failure.message : "No se pudo consultar el QR."); setValidated(false); access(failure); if (isStopped(failure) && current.current) apply({ ...current.current, state: "revoked" }); }
    } finally { clearTimeout(deadline); if (reading.current === read) reading.current = null; }
    // The operation reads the latest binding and callbacks from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(fresh = false) {
    if (!live.current.active || live.current.disabled || writing.current || blocked) return;
    if (fresh) { creation.current = null; closing.current = false; received.current = 0; }
    creation.current ??= { requestId: crypto.randomUUID(), version: live.current.version, token: token() };
    const intent = creation.current, scope = propsKey(live.current), epoch = ++generation.current, write = new AbortController();
    reading.current?.abort(); reading.current = null; writing.current = true; controller.current = write;
    setPhase("creating"); setValidated(false); setQr(""); setError("");
    let timedOut = false; const deadline = setTimeout(() => { timedOut = true; write.abort(); }, 30_000);
    let confirmed = false;
    try {
      const next = await request(endpointRef.current, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent), signal: write.signal });
      if (!valid(epoch, scope, write.signal)) return;
      secret.current = intent.token; creation.current = null; revoked.current = false; apply(next); setValidated(!closing.current); setPhase("idle"); confirmed = true;
    } catch (failure) {
      if (!valid(epoch, scope, timedOut ? undefined : write.signal)) return;
      const status = (failure as { status?: number })?.status;
      if (status && status < 500) creation.current = null;
      setPhase(!status || status >= 500 ? "uncertain" : "idle"); setError(timedOut ? "No se confirmó la creación del QR a tiempo. Consulta el mismo intento antes de generar otro." : failure instanceof Error ? failure.message : "No se confirmó la creación del QR."); access(failure);
    } finally {
      clearTimeout(deadline);
      if (controller.current === write) { controller.current = null; writing.current = false; }
    }
    if (confirmed && closing.current && live.current.active) void cancel();
  }

  async function cancel() {
    if (!live.current.active || live.current.disabled || writing.current) return;
    closing.current = true; setQr(""); setValidated(false);
    if (creation.current) { void create(); return; }
    const known = current.current;
    if (!known) { if (creation.current) { void create(); return; } live.current.onClose(); return; }
    const epoch = ++generation.current, scope = propsKey(live.current), write = new AbortController();
    reading.current?.abort(); reading.current = null; controller.current = write; writing.current = true; setPhase("cancelling"); setError("");
    let timedOut = false; const deadline = setTimeout(() => { timedOut = true; write.abort(); }, 30_000);
    try {
      const next = await request(`${endpointRef.current}/${encodeURIComponent(known.id)}`, { method: "DELETE", signal: write.signal });
      if (!valid(epoch, scope, write.signal)) return;
      if (next.id !== known.id || next.state === "open") throw captureError("La cancelación no quedó confirmada. Vuelve a intentarlo.");
      revoked.current = true; secret.current = ""; apply(next); setPhase("idle"); live.current.onClose();
    } catch (failure) { if (valid(epoch, scope, timedOut ? undefined : write.signal)) { setPhase("cancel-uncertain"); setError(timedOut ? "No se confirmó el cierre a tiempo. Reintenta cerrar el mismo QR." : failure instanceof Error ? failure.message : "No se confirmó la cancelación del QR."); access(failure); } }
    finally { clearTimeout(deadline); if (controller.current === write) { controller.current = null; writing.current = false; } }
  }

  useEffect(() => {
    const scope = propsKey(live.current), address = endpointRef.current;
    if (binding.current !== scope) { binding.current = scope; current.current = null; creation.current = null; secret.current = ""; received.current = 0; closing.current = false; revoked.current = false; setSession(null); setQr(""); setBlocked(false); setError(""); }
    if (props.active) { if (current.current) void load(); else void create(); }
    const timer = props.active ? setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000) : null;
    return () => {
      abortOperations();
      if (timer) clearInterval(timer);
      const known = current.current;
      if (known && !revoked.current) { revoked.current = true; void fetch(`${address}/${encodeURIComponent(known.id)}`, { method: "DELETE", credentials: "same-origin", cache: "no-store", keepalive: true }).catch(() => {}); }
    };
    // The panel is opened by an explicit gesture. Version updates must not rotate its intent or QR.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workId, props.mode, props.active, load, abortOperations]);

  useEffect(() => {
    if (!props.active || !validated || session?.state !== "open" || !secret.current || closing.current) { setQr(""); return; }
    let alive = true;
    const url = `${window.location.origin}/atencion-captura#token=${secret.current}`;
    void QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 320, color: { dark: "#151a21", light: "#ffffff" } }).then(value => { if (alive) setQr(value); }).catch(() => { if (alive) setError("No se pudo mostrar el QR. Vuelve a consultarlo."); });
    return () => { alive = false; };
  }, [props.active, validated, session?.id, session?.state]);

  useEffect(() => {
    if (!props.active || session?.state !== "open") return;
    const timer = setInterval(() => { if (current.current?.state === "open" && Date.now() >= Date.parse(current.current.expiresAt)) { apply({ ...current.current, state: "expired" }); setValidated(false); } }, 1000);
    return () => clearInterval(timer);
  }, [props.active, session?.id, session?.state]);

  if (!props.active) return null;
  const busy = phase === "creating" || phase === "cancelling", ended = session && session.state !== "open";
  const mobileUrl = validated && session?.state === "open" && !blocked && !closing.current && secret.current ? `${window.location.origin}/atencion-captura#token=${secret.current}` : "";
  return <section className={styles.capture} aria-label="Fotos desde el celular" aria-busy={busy}>
    <header><div><h3>Fotos desde el celular</h3><p className={styles.muted}>Escanea el QR para tomar y enviar fotos a este mismo chat.</p></div><Button type="button" variant="ghost" className={styles.closeCapture} disabled={props.disabled || busy} onClick={() => void cancel()}>{phase === "cancelling" ? "Cerrando QR…" : "Cerrar captura"}</Button></header>
    {phase === "creating" && <p role="status">Preparando QR…</p>}
    {session && <div className={styles.qrLayout}>{qr && validated && !blocked && !closing.current ? <Image unoptimized width={320} height={320} src={qr} alt="QR para enviar fotos a este chat" className={styles.qr}/> : <p className={styles.muted}>{ended ? session.state === "expired" ? "Este QR venció." : "Este QR ya está cerrado." : "El QR aparecerá al confirmar la sesión."}</p>}<div className={styles.status}><strong>{session.uploadedCount} {session.uploadedCount === 1 ? "foto recibida" : "fotos recibidas"}</strong><p className={styles.muted}>{session.state === "open" ? `Vence a las ${new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" }).format(new Date(session.expiresAt))}.` : "Las fotos enviadas permanecen en el historial del chat."}</p>{mobileUrl && <a href={mobileUrl} target="_blank" rel="noopener noreferrer">Abrir captura en este dispositivo</a>}</div></div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}>
      {!blocked && (phase === "uncertain" ? <Button type="button" disabled={props.disabled || busy} onClick={() => void create()}>Consultar / reintentar mismo QR</Button> : phase === "cancel-uncertain" ? <Button type="button" disabled={props.disabled || busy} onClick={() => void cancel()}>Reintentar cierre</Button> : ended || (!session && !busy) ? <Button type="button" disabled={props.disabled || busy} onClick={() => void create(true)}>Generar nuevo QR</Button> : error ? <Button type="button" variant="secondary" disabled={props.disabled || busy} onClick={() => { setValidated(false); void load(); }}>Actualizar QR</Button> : null)}
    </div>
  </section>;
}
