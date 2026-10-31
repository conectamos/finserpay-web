"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Send } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { Button, Input } from "@/app/_components/finser-ui";
import type { AttentionWorkPhotoSession } from "./attention-work-photo-capture";
import styles from "./attention-work-photo-capture.module.css";

type Upload = { requestId: string; file: File };
function failure(message: string, status?: number) { return Object.assign(new Error(message), { status }); }

export default function AttentionWorkPhotoMobile() {
  const [session, setSession] = useState<AttentionWorkPhotoSession | null>(null), [loading, setLoading] = useState(true), [ended, setEnded] = useState(false);
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState(""), [imageFailed, setImageFailed] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const secret = useRef(""), current = useRef<AttentionWorkPhotoSession | null>(null), upload = useRef<Upload | null>(null), writeLock = useRef(false);
  const alive = useRef(true), epoch = useRef(0), stopped = useRef(false), read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const camera = useRef<HTMLInputElement | null>(null), gallery = useRef<HTMLInputElement | null>(null);
  const abortOperations = useCallback(() => { alive.current = false; epoch.current++; read.current?.abort(); read.current = null; write.current?.abort(); write.current = null; }, []);

  function stop(message: string) { stopped.current = true; setEnded(true); setError(message); setNotice(""); setFile(null); upload.current = null; setUncertain(false); }
  async function request(init: RequestInit) {
    const response = await fetch("/api/atencion/captura", { cache: "no-store", credentials: "omit", ...init, headers: { ...init.headers, Authorization: `Bearer ${secret.current}` } });
    const body = await response.json().catch(() => null);
    if (init.signal?.aborted) throw Object.assign(new Error("Consulta cancelada"), { name: "AbortError" });
    if (!response.ok) throw failure(body?.error || "No se pudo consultar la sesión de fotos.", response.status);
    const result = body as AttentionWorkPhotoSession;
    if (current.current && result.id !== current.current.id) throw failure("La sesión de fotos cambió. Escanea un QR nuevo desde el chat.", 409);
    return result;
  }
  function apply(result: AttentionWorkPhotoSession) {
    current.current = result; setSession(result);
    if (result.state !== "open" || Date.now() >= Date.parse(result.expiresAt)) { stop(result.state === "revoked" ? "Esta captura fue cerrada. Solicita un QR nuevo desde el chat." : "El QR venció. Solicita uno nuevo desde el chat."); return false; }
    return true;
  }
  const load = useCallback(async () => {
    if (!alive.current || !secret.current || stopped.current || writeLock.current || read.current) return;
    const controller = new AbortController(), generation = epoch.current; read.current = controller;
    let timedOut = false; const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const result = await request({ signal: controller.signal });
      if (!alive.current || generation !== epoch.current || controller.signal.aborted || stopped.current) return;
      const open = apply(result); setLoading(false); if (open && !upload.current) setError("");
    } catch (caught) {
      if (!alive.current || generation !== epoch.current || (controller.signal.aborted && !timedOut)) return;
      const status = (caught as { status?: number })?.status, message = timedOut ? "La consulta tardó demasiado. Vuelve a consultar la sesión." : caught instanceof Error ? caught.message : "No se pudo consultar la captura.";
      if ([401, 403, 404, 409, 410].includes(status || 0)) stop(message); else setError(message);
      setLoading(false);
    } finally { clearTimeout(deadline); if (read.current === controller) read.current = null; }
    // The session capability and lifetime are read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    alive.current = true;
    const candidate = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    if (!/^[a-f0-9]{64}$/i.test(candidate)) { stop("Escanea el QR del chat para abrir una sesión de fotos válida."); setLoading(false); return; }
    secret.current = candidate.toLowerCase();
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { abortOperations(); clearInterval(timer); };
  }, [load, abortOperations]);
  useEffect(() => {
    if (!file || ended) { setPreview(""); return; }
    const url = URL.createObjectURL(file); setPreview(url); setImageFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file, ended]);
  useEffect(() => {
    if (!session || ended) return;
    const timer = setInterval(() => { if (Date.now() >= Date.parse(session.expiresAt) && !writeLock.current) stop("El QR venció. Solicita uno nuevo desde el chat."); }, 1000);
    return () => clearInterval(timer);
  }, [session, ended]);

  function choose(next: File | null) {
    if (!next || loading || stopped.current || writeLock.current || upload.current || current.current?.state !== "open") return;
    if (!["image/jpeg", "image/png"].includes(next.type)) { setError("Elige una foto JPG o PNG."); return; }
    if (!next.size || next.size > 5 * 1024 * 1024) { setError("La foto debe pesar entre 1 byte y 5 MB."); return; }
    setFile(next); setError(""); setNotice("");
  }
  async function send() {
    if (!alive.current || stopped.current || writeLock.current || !current.current || (!file && !upload.current)) return;
    upload.current ??= { requestId: crypto.randomUUID(), file: file! };
    const intent = upload.current, generation = ++epoch.current, controller = new AbortController(); write.current = controller; writeLock.current = true;
    read.current?.abort(); read.current = null; setBusy(true); setUncertain(false); setError(""); setNotice("");
    let timedOut = false; const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    const form = new FormData(); form.set("requestId", intent.requestId); form.set("file", intent.file);
    try {
      const result = await request({ method: "POST", body: form, signal: controller.signal });
      if (!alive.current || generation !== epoch.current || controller.signal.aborted || stopped.current) return;
      const open = apply(result); upload.current = null; setUncertain(false); setFile(null); if (open) setNotice("Foto guardada en la plataforma. Puedes tomar otra foto para este mismo chat.");
    } catch (caught) {
      if (!alive.current || generation !== epoch.current || (controller.signal.aborted && !timedOut)) return;
      const status = (caught as { status?: number })?.status, message = timedOut ? "No se confirmó el envío de la foto a tiempo." : caught instanceof Error ? caught.message : "No se confirmó el envío de la foto.";
      if ([401, 403, 404, 409, 410].includes(status || 0)) stop(message);
      else if (status && status < 500) { upload.current = null; setError(message); }
      else { setUncertain(true); setError(`${message} Reintenta el mismo envío para comprobarlo.`); }
    } finally { clearTimeout(deadline); if (write.current === controller) { write.current = null; writeLock.current = false; if (alive.current) setBusy(false); } }
  }

  const locked = loading || ended || busy || uncertain || !session || session.state !== "open";
  return <main className={styles.mobilePage}><div className={styles.mobileShell}>
    <header className={styles.mobileHeader}><FinserBrand wordmarkOnly accentPay showTagline={false}/></header>
    <section className={styles.mobileCard} aria-busy={loading || busy}>
      <h1>Fotos para el chat</h1><p className={styles.muted}>Toma una foto, revísala y envíala. Quedará en la misma conversación de FINSER PAY.</p>
      {loading && <p role="status">Comprobando sesión…</p>}
      {session && <p className={styles.muted}>{session.uploadedCount} {session.uploadedCount === 1 ? "foto recibida" : "fotos recibidas"} en esta sesión.</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.success} role="status">{notice}</p>}
      {!ended && <>
        <div className={styles.cameraActions}><Button type="button" disabled={locked} onClick={() => camera.current?.click()}><Camera aria-hidden="true" size={20}/>Tomar foto</Button><Button type="button" variant="secondary" disabled={locked} onClick={() => gallery.current?.click()}><ImagePlus aria-hidden="true" size={20}/>Elegir foto</Button></div>
        <Input type="file" ref={camera} className={styles.hiddenFile} aria-label="Tomar foto con la cámara" accept="image/jpeg,image/png" capture="environment" disabled={locked} onChange={event => { choose(event.target.files?.[0] || null); event.target.value = ""; }}/>
        <Input type="file" ref={gallery} className={styles.hiddenFile} aria-label="Elegir foto de la galería" accept="image/jpeg,image/png" disabled={locked} onChange={event => { choose(event.target.files?.[0] || null); event.target.value = ""; }}/>
        {file && <div className={styles.preview}>{preview && !imageFailed ? <Image unoptimized src={preview} width={1200} height={1200} className={styles.previewImage} alt="Foto pendiente de enviar" onError={() => setImageFailed(true)}/> : <p className={styles.muted}>Vista previa no disponible.</p>}<p className={styles.previewName}>{file.name} · Sin enviar</p><div className={styles.mobileActions}><Button type="button" disabled={busy || ended} onClick={() => void send()}><Send aria-hidden="true" size={18}/>{busy ? "Enviando foto…" : uncertain ? "Reintentar mismo envío" : "Enviar foto"}</Button><Button type="button" variant="ghost" disabled={busy || uncertain} onClick={() => { setFile(null); setError(""); }}>Quitar foto</Button></div></div>}
        {!file && !loading && error && <Button type="button" variant="secondary" onClick={() => void load()}>Volver a consultar</Button>}
        <p className={styles.muted}>JPG o PNG, hasta 5 MB. Puedes enviar varias fotos, una por una.</p>
      </>}
    </section>
  </div></main>;
}
