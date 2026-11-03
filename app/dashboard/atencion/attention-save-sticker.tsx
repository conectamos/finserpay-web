"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import type { AttentionMessage } from "@/lib/atencion-types";
import styles from "./attention-sticker-picker.module.css";

type Source = { conversationId: string; message: AttentionMessage };

function SaveSticker({ source, onClose }: { source: Source; onClose: () => void }) {
  const [name, setName] = useState("Sticker de WhatsApp");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false), [archived, setArchived] = useState(false);
  const alive = useRef(true), locked = useRef(false), requestId = useRef<string | null>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const canonicalUrl = `/api/atencion/${source.conversationId}/messages/${source.message.id}/media`;
  const available = source.message.attachment?.kind === "sticker" && source.message.attachment.url === canonicalUrl;

  async function save() {
    if (!available || locked.current || !name.trim() || saved) return;
    locked.current = true; setBusy(true); setError(""); requestId.current ||= crypto.randomUUID();
    const read = new AbortController(); controller.current = read;
    const timeout = setTimeout(() => read.abort(), 25_000);
    try {
      const response = await fetch("/api/atencion/stickers/from-message", { method: "POST", credentials: "same-origin", cache: "no-store", signal: read.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: requestId.current, name: name.trim(), conversationId: source.conversationId, messageId: source.message.id }) });
      const body = await response.json().catch(() => null);
      if (!alive.current) return;
      if ([401, 403, 404].includes(response.status)) { onClose(); return; }
      if (!response.ok) throw new Error(body?.error || "No se pudo guardar el sticker.");
      setArchived(body?.sticker?.archived === true); setSaved(true);
    } catch (failure) {
      if (alive.current) setError(read.signal.aborted ? "La consulta tardó demasiado. Puedes volver a guardar; no se duplicará el sticker." : failure instanceof Error ? failure.message : "No se pudo guardar el sticker.");
    } finally { clearTimeout(timeout); locked.current = false; if (alive.current) setBusy(false); }
  }

  return <FinserSidePanel open title="Guardar sticker" closeLabel="Cerrar guardar sticker" busy={busy} onClose={onClose}><div className={styles.library}>
    <p>Guárdalo en tu biblioteca personal para prepararlo y enviarlo desde otros chats.</p>
    {available ? <div className={styles.sourcePreview}>
      {/* Private same-origin media is not passed to an image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={canonicalUrl} alt="Sticker que vas a guardar" width={192} height={192} />
    </div> : <p role="alert">Este sticker no está disponible para guardar.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {saved ? <><p role="status">{archived ? "El sticker ya estaba en tu biblioteca. Puedes restaurarlo desde Stickers → Archivados." : "Sticker guardado. Ábrelo desde Stickers → Guardados en el chat."}</p><Button type="button" onClick={onClose}>Listo</Button></> : <div className={styles.add}>
      <label>Nombre<Input maxLength={60} value={name} disabled={busy || !available} onChange={event => { setName(event.target.value); requestId.current = null; }} /></label>
      <Button type="button" disabled={busy || !available || !name.trim()} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar en mis stickers"}</Button>
    </div>}
  </div></FinserSidePanel>;
}

export default function AttentionSaveStickerPanel({ source, onClose }: { source: Source | null; onClose: () => void }) {
  return source ? <SaveSticker key={`${source.conversationId}:${source.message.id}`} source={source} onClose={onClose} /> : null;
}
