"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Smile, Square, Trash2, X } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import styles from "./attention-composer-tools.module.css";

const emojis = [
  ["😀", "Sonrisa"], ["😊", "Sonrisa amable"], ["🙂", "Cara sonriente"], ["😉", "Guiño"],
  ["👍", "Pulgar arriba"], ["👋", "Saludo"], ["🙏", "Gracias"], ["🤝", "Acuerdo"],
  ["✅", "Confirmado"], ["💚", "Corazón verde"], ["🎉", "Celebración"], ["💬", "Mensaje"],
  ["📄", "Documento"], ["📅", "Calendario"], ["⏰", "Reloj"], ["📌", "Recordatorio"],
  ["📱", "Teléfono"], ["💳", "Tarjeta"], ["💰", "Pago"], ["🙌", "Manos arriba"],
] as const;
type Recording = { file: File; url: string };
type Props = { conversationId: string; disabled: boolean; audioDisabled?: boolean; onAudio: (file: File) => void; onEmoji: (emoji: string) => void };

export default function AttentionComposerTools({ conversationId, disabled, audioDisabled, onAudio, onEmoji }: Props) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "preparing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const epoch = useRef(0);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tools = useRef<HTMLDivElement>(null);

  function release() {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  }
  function clearPreview() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null; setRecording(null);
  }
  function cancel() {
    epoch.current++; active.current = false; controller.current?.abort(); controller.current = null;
    release(); clearPreview(); setPhase("idle"); setError(""); setSeconds(0);
  }
  useEffect(() => () => {
    epoch.current++; active.current = false; controller.current?.abort();
    if (timer.current) clearInterval(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach(track => track.stop());
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, [conversationId]);
  useEffect(() => {
    if (!disabled && !audioDisabled) return;
    // Defer state cleanup but invalidate pending capture synchronously.
    epoch.current++; active.current = false; controller.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach(track => track.stop());
    if (timer.current) clearInterval(timer.current);
    const timeout = setTimeout(() => { setPhase("idle"); setSeconds(0); }, 0);
    return () => clearTimeout(timeout);
  }, [disabled, audioDisabled]);
  useEffect(() => {
    if (!emojiOpen) return;
    const dismiss = (event: PointerEvent) => { if (!tools.current?.contains(event.target as Node)) setEmojiOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [emojiOpen]);

  async function start() {
    if (disabled || audioDisabled || active.current) return;
    setError(""); clearPreview();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Este navegador no puede grabar. Puedes adjuntar un audio MP3, M4A u OGG desde Archivos."); return;
    }
    // Specify codecs: MP4 with Opus is not a WhatsApp audio format.
    const mime = ["audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) { setError("La grabación no está disponible en este navegador. Adjunta un archivo de audio."); return; }
    active.current = true; const currentEpoch = ++epoch.current;
    setPhase("requesting"); setEmojiOpen(false);
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (currentEpoch !== epoch.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const device = new MediaRecorder(input, { mimeType: mime, audioBitsPerSecond: 48000 });
      recorder.current = device; const chunks: Blob[] = []; let size = 0;
      device.ondataavailable = event => {
        if (currentEpoch !== epoch.current || !event.data.size) return;
        size += event.data.size;
        if (size > 8 * 1024 * 1024) { cancel(); setError("El audio supera 8 MB. Graba un mensaje más corto."); return; }
        chunks.push(event.data);
      };
      device.onerror = () => { if (currentEpoch === epoch.current) { cancel(); setError("No se pudo grabar. Revisa el micrófono e intenta de nuevo."); } };
      device.onstop = () => {
        input.getTracks().forEach(track => track.stop());
        if (currentEpoch !== epoch.current) return;
        if (timer.current) { clearInterval(timer.current); timer.current = null; }
        recorder.current = null; stream.current = null; active.current = false;
        if (!chunks.length) { setPhase("idle"); setError("No se registró audio. Intenta nuevamente."); return; }
        const type = mime.split(";")[0]; const extension = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "webm";
        const file = new File(chunks, `audio-${Date.now()}.${extension}`, { type });
        const url = URL.createObjectURL(file); previewUrl.current = url;
        setRecording({ file, url }); setPhase("idle");
      };
      device.start(1000); setPhase("recording"); setSeconds(0); const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(Math.min(elapsed, 300));
        if (elapsed >= 300 && device.state === "recording") device.stop();
      }, 250);
    } catch (cause) {
      if (currentEpoch !== epoch.current) return;
      release(); active.current = false; setPhase("idle");
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Permite el acceso al micrófono en tu navegador para grabar audio."
        : "No se encontró un micrófono disponible. Revisa su conexión.");
    }
  }
  async function attachRecording() {
    if (!recording || disabled || audioDisabled || active.current) return;
    const currentEpoch = epoch.current; active.current = true; setError(""); setPhase("preparing");
    try {
      let file = recording.file;
      if (file.type === "audio/webm") {
        const abort = new AbortController(); controller.current = abort;
        const timeout = setTimeout(() => abort.abort(), 60_000);
        try {
          const form = new FormData(); form.set("file", file);
          const response = await fetch(`/api/atencion/${encodeURIComponent(conversationId)}/audio`, { method: "POST", body: form, signal: abort.signal });
          if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error || "No se pudo preparar el audio."); }
          if (response.headers.get("content-type")?.split(";")[0] !== "audio/ogg") throw new Error("La respuesta de audio no es válida.");
          file = new File([await response.blob()], `audio-${Date.now()}.ogg`, { type: "audio/ogg" });
        } finally { clearTimeout(timeout); }
      }
      if (currentEpoch !== epoch.current) return;
      onAudio(file); clearPreview();
    } catch (cause) {
      if (currentEpoch === epoch.current) setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "La preparación tardó demasiado. Puedes intentarlo nuevamente.");
    } finally {
      if (currentEpoch === epoch.current) { active.current = false; controller.current = null; setPhase("idle"); }
    }
  }
  return <div className={styles.tools} ref={tools} onKeyDown={event => {
    if (event.key === "Escape" && emojiOpen) { setEmojiOpen(false); tools.current?.querySelector("button")?.focus(); }
  }}>
    <div className={styles.buttons}>
      <Button variant="ghost" aria-label="Elegir emoji" aria-expanded={emojiOpen} disabled={disabled} onClick={() => setEmojiOpen(value => !value)}><Smile size={20} aria-hidden="true" /><span>Emojis</span></Button>
      <Button variant="ghost" disabled={disabled || audioDisabled || phase !== "idle" || !!recording} onClick={() => void start()} title={audioDisabled ? "Envía primero el texto o archivo que estás preparando." : "Grabar un audio"}><Mic size={20} aria-hidden="true" /><span>Grabar audio</span></Button>
    </div>
    {emojiOpen && !disabled && <div className={styles.emojiPanel} role="group" aria-label="Emojis disponibles">
      <div className={styles.panelHeading}><strong>Elige un emoji</strong><Button variant="ghost" aria-label="Cerrar emojis" onClick={() => { setEmojiOpen(false); tools.current?.querySelector("button")?.focus(); }}><X size={18} /></Button></div>
      <div className={styles.emojiGrid}>{emojis.map(([emoji, name]) => <Button variant="ghost" key={emoji} aria-label={name} onClick={() => onEmoji(emoji)}>{emoji}</Button>)}</div>
    </div>}
    {(phase === "requesting" || phase === "recording") && <div className={styles.recording}>
      <span role="status">{phase === "requesting" ? "Esperando permiso del micrófono…" : `Grabando ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 5:00`}</span>
      {phase === "recording" && <Button variant="secondary" onClick={() => { if (recorder.current?.state === "recording") recorder.current.stop(); }}><Square size={16} aria-hidden="true" />Detener y escuchar</Button>}
      <Button variant="ghost" onClick={cancel}>Cancelar</Button>
    </div>}
    {recording && <div className={styles.preview}>
      <span>Escucha tu audio antes de adjuntarlo</span>
      <audio controls src={recording.url} preload="metadata" aria-label="Vista previa de tu grabación" />
      <div className={styles.buttons}><Button variant="secondary" disabled={disabled || audioDisabled || phase === "preparing"} onClick={() => void attachRecording()}>{phase === "preparing" ? "Preparando audio…" : "Usar audio"}</Button><Button variant="ghost" onClick={cancel}><Trash2 size={16} aria-hidden="true" />Descartar</Button></div>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
