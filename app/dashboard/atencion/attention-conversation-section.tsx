"use client";

import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Button, LoadingState, Select } from "@/app/_components/finser-ui";
import type { AttentionBoardMoveResult, AttentionBoardPlacement } from "@/lib/atencion-board-types";
import styles from "./attention.module.css";

type Props = {
  conversationId: string; actorKey: string; active: boolean; disabled: boolean;
  request: <T>(url: string, options?: RequestInit) => Promise<T>;
  busyChanged: (busy: boolean) => void; onMoved: () => void;
  accessDenied: (error: unknown) => boolean;
};
const keyOf = (id: string | null) => id ?? "none";
const message = (error: unknown) => error instanceof Error ? error.message : "No fue posible consultar el tablero.";

export default function AttentionConversationSection(props: Props) {
  const { conversationId, actorKey, active, disabled } = props;
  const binding = `${actorKey}:${conversationId}`;
  const [stored, setStored] = useState<{ binding: string; data: AttentionBoardPlacement } | null>(null);
  const [destination, setDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const intent = useRef<{ payload: string; requestId: string } | null>(null);
  const context = useRef({ ...props, binding });
  context.current = { ...props, binding };
  const data = stored?.binding === binding ? stored.data : null;
  const url = `/api/atencion/${encodeURIComponent(conversationId)}/section`;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; mutation.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let disposed = false;
    const current = () => !disposed && alive.current && context.current.active && context.current.binding === binding;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    const timer = setTimeout(async () => {
      setLoading(true); setError(""); setDestination("");
      try {
        const result = await context.current.request<AttentionBoardPlacement>(url, { signal: controller.signal });
        if (!current()) return;
        if (controller.signal.aborted) throw new Error("La consulta tardó demasiado. Actualiza la ubicación del chat.");
        if (result.conversationId !== conversationId) throw new Error("No se pudo confirmar la ubicación de este chat.");
        setStored({ binding, data: result }); setNeedsRefresh(false);
      } catch (failure) {
        if (!current()) return;
        setStored(null); setNeedsRefresh(true);
        if (!context.current.accessDenied(failure)) setError(controller.signal.aborted ? "La consulta tardó demasiado. Actualiza la ubicación del chat." : message(failure));
      } finally {
        clearTimeout(deadline);
        if (current()) setLoading(false);
      }
    }, 0);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [active, binding, conversationId, revision, url]);

  async function move() {
    const section = data?.sections.find(item => keyOf(item.id) === destination);
    if (!active || disabled || loading || needsRefresh || locked.current || !data?.permissions.move || !section || section.id === data.sectionId) return;
    const input = { sectionId: section.id, boardVersion: data.boardVersion };
    const payload = JSON.stringify({ binding, ...input });
    if (intent.current?.payload !== payload) intent.current = { payload, requestId: crypto.randomUUID() };
    const controller = new AbortController(); mutation.current = controller;
    const deadline = setTimeout(() => controller.abort(), 30_000);
    locked.current = true; setSaving(true); setError(""); setNotice(""); props.busyChanged(true);
    const current = () => alive.current && context.current.binding === binding;
    try {
      const result = await props.request<AttentionBoardMoveResult>(url, { method: "POST", signal: controller.signal, body: JSON.stringify({ ...input, requestId: intent.current.requestId }) });
      if (!current()) return;
      if (controller.signal.aborted || result.conversationId !== conversationId) throw new Error("No se confirmó el movimiento. Actualiza la ubicación antes de continuar.");
      intent.current = null;
      setStored({ binding, data: { ...data, sectionId: result.sectionId, boardVersion: result.boardVersion } });
      setDestination(""); setNotice(`Chat en ${data.sections.find(item => item.id === result.sectionId)?.name || "la sección seleccionada"}.`);
      context.current.onMoved();
    } catch (failure) {
      if (!current()) return;
      setNeedsRefresh(true); setNotice("");
      if (!context.current.accessDenied(failure)) setError(`${message(failure)} Actualiza la ubicación y revísala antes de volver a mover el chat.`);
    } finally {
      clearTimeout(deadline); if (mutation.current === controller) mutation.current = null;
      locked.current = false; props.busyChanged(false);
      if (current()) setSaving(false);
    }
  }

  const lockedForm = disabled || saving || loading || needsRefresh;
  const sectionName = data?.sections.find(item => item.id === data.sectionId)?.name;
  return <section className={styles.customerSection} aria-label="Tablero de este chat" aria-busy={loading || saving}>
    <h3><Columns3 aria-hidden="true" size={18} /> Tablero</h3>
    {loading && <LoadingState label="Consultando ubicación…" />}
    {error && <p className={styles.panelValidation} role="alert">{error}</p>}
    {!loading && data && <>
      <dl className={styles.keyValues}><div><dt>Sección actual</dt><dd>{sectionName || "Ubicación no disponible"}</dd></div></dl>
      {data.permissions.move ? <form className={styles.compactForm} onSubmit={event => { event.preventDefault(); void move(); }}>
        <label>Mover al tablero<Select aria-label="Sección del tablero" value={destination} disabled={lockedForm} onChange={event => { setDestination(event.target.value); setNotice(""); }}>
          <option value="">Selecciona una sección…</option>
          {data.sections.filter(section => section.id !== data.sectionId).map(section => <option key={keyOf(section.id)} value={keyOf(section.id)}>{section.name}</option>)}
        </Select></label>
        <Button type="submit" variant="secondary" disabled={lockedForm || !destination}>{saving ? "Moviendo…" : "Mover chat"}</Button>
      </form> : <p className={styles.muted}>No tienes permiso para mover esta conversación.</p>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {needsRefresh && !loading && <Button variant="secondary" disabled={disabled || saving} onClick={() => { if (!locked.current) { setLoading(true); setRevision(value => value + 1); } }}>Actualizar ubicación</Button>}
  </section>;
}
