"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Forward, RefreshCw, Search, Send } from "lucide-react";
import { Button, Input } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import type { AttentionConversation, AttentionDetail, AttentionInbox, AttentionMessage } from "@/lib/atencion-types";
import { attentionMessageSummary } from "./attention-message-actions";
import styles from "./attention-forward-message.module.css";

export type AttentionForwardSource = { conversationId: string; contactName: string; message: AttentionMessage };
type Intent = { requestId: string; version: number; destinationId: string; sourceConversationId: string; sourceMessageId: string };
class ForwardError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const accepted = new Set(["accepted", "sent", "delivered", "read"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const name = (item: AttentionConversation) => item.customerIdentity?.name || item.name || item.phone || "Contacto de WhatsApp";
function canSend(detail: AttentionDetail) { return detail.conversation.channel === "whatsapp" && detail.permissions.canSend && detail.messaging?.canReply && Date.parse(detail.messaging.windowExpiresAt || "") > Date.now(); }
function restoredIntent(raw: string | null): Intent | null {
  try {
    const value = raw && raw.length <= 700 ? JSON.parse(raw) : null;
    return value && Object.keys(value).sort().join(",") === "destinationId,requestId,sourceConversationId,sourceMessageId,version"
      && [value.requestId, value.destinationId, value.sourceConversationId, value.sourceMessageId].every(item => typeof item === "string" && uuid.test(item))
      && Number.isSafeInteger(value.version) && value.version > 0 ? value : null;
  } catch { return null; }
}

export default function AttentionForwardMessage({ actorKey, source, onClose, onSent, onBusyChange, onAccessDenied }: {
  actorKey: string; source: AttentionForwardSource | null; onClose: () => void;
  onSent: (destinationId: string) => void; onBusyChange: (busy: boolean) => void; onAccessDenied: (status: number, message: string) => void;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [page, setPage] = useState(1);
  const [inbox, setInbox] = useState<AttentionInbox | null>(null), [destination, setDestination] = useState<AttentionDetail | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<Intent | null>(null), [outcome, setOutcome] = useState<"missing" | "failed" | "pending" | null>(null), [notice, setNotice] = useState("");
  const alive = useRef(true), working = useRef(false), read = useRef<AbortController | null>(null), operation = useRef<AbortController | null>(null), generation = useRef(0);
  const current = useRef({ source, actorKey }); current.current = { source, actorKey };
  const storageKey = `finser-attention-forward:${actorKey}`;
  useEffect(() => {
    alive.current = true;
    try { setPending(restoredIntent(sessionStorage.getItem(storageKey))); } catch { /* In-memory recovery remains available. */ }
    return () => { alive.current = false; read.current?.abort(); operation.current?.abort(); };
  }, [storageKey]);
  useEffect(() => {
    if (!source) return;
    setOpen(true); setSearch(""); setPage(1); setDestination(null); setInbox(null); setError(""); setNotice("");
  }, [source]);
  function remember(intent: Intent | null) {
    setPending(intent);
    try { if (intent) sessionStorage.setItem(storageKey, JSON.stringify(intent)); else sessionStorage.removeItem(storageKey); } catch { /* Do not repeat an ambiguous send when storage is unavailable. */ }
  }
  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, { ...init, cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ForwardError(typeof body?.error === "string" ? body.error : "No fue posible completar el reenvío.", response.status);
    return body;
  }
  function denied(failure: unknown) {
    if (!(failure instanceof ForwardError) || ![401, 403, 404].includes(failure.status)) return false;
    setInbox(null); setDestination(null); setNotice(""); setOpen(false); onClose();
    // A missing destination must not be interpreted as loss of the source chat.
    // Keep only the opaque recovery identifiers until access can be checked again.
    onAccessDenied(failure.status, failure.message); return true;
  }
  useEffect(() => {
    if (!open || pending || destination || !source || notice) return;
    const controller = new AbortController(), binding = ++generation.current;
    read.current?.abort(); read.current = controller; setLoading(true); setError("");
    const delay = setTimeout(() => {
      const timeout = setTimeout(() => { controller.abort(); if (alive.current && generation.current === binding) setError("La búsqueda tardó demasiado. Vuelve a buscar o abre de nuevo el panel."); }, 20_000);
      const query = new URLSearchParams({ search, page: String(page), filter: "all", collection: "clients", dashboard: "0" });
      void request<AttentionInbox>(`/api/atencion?${query}`, { signal: controller.signal }).then(value => {
        if (alive.current && !controller.signal.aborted && generation.current === binding) setInbox(value);
      }).catch(failure => {
        if (alive.current && !controller.signal.aborted && generation.current === binding && !denied(failure)) setError(failure instanceof Error ? failure.message : "No se pudo consultar la bandeja.");
      }).finally(() => {
        clearTimeout(timeout); if (alive.current && generation.current === binding) setLoading(false);
      });
    }, 250);
    return () => { clearTimeout(delay); controller.abort(); };
    // The source identity is stable while choosing a destination; reads stop on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending, destination, source, search, page, notice]);
  async function choose(item: AttentionConversation) {
    if (working.current || pending || !current.current.source) return;
    read.current?.abort(); const controller = new AbortController(), binding = ++generation.current;
    read.current = controller; setLoading(true); setError(""); const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const value = await request<AttentionDetail>(`/api/atencion/${item.id}`, { signal: controller.signal });
      if (alive.current && !controller.signal.aborted && generation.current === binding) setDestination(value);
    } catch (failure) {
      if (alive.current && generation.current === binding && !denied(failure)) setError(controller.signal.aborted ? "La consulta tardó demasiado. Vuelve a seleccionar el chat." : failure instanceof Error ? failure.message : "No se pudo consultar el destinatario.");
    } finally { clearTimeout(timeout); if (alive.current && generation.current === binding) setLoading(false); }
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); onBusyChange(true); setError("");
    const controller = new AbortController(); operation.current = controller; const timeout = setTimeout(() => controller.abort(), 60_000);
    try { await action(controller.signal); }
    catch (failure) { if (alive.current && !denied(failure)) setError(`${controller.signal.aborted ? "La consulta tardó demasiado." : failure instanceof Error ? failure.message : "No se pudo comprobar el envío."} Consulta el estado antes de volver a enviar.`); }
    finally { clearTimeout(timeout); if (operation.current === controller) operation.current = null; working.current = false; if (alive.current) { setBusy(false); onBusyChange(false); } }
  }
  function result(intent: Intent, message: AttentionMessage | null) {
    if (!alive.current) return;
    if (message && accepted.has(message.deliveryStatus || "")) {
      remember(null); setOutcome(null); setDestination(null); setNotice("Mensaje reenviado. La entrega se actualizará en el chat de destino."); onSent(intent.destinationId);
    } else {
      setOutcome(message === null ? "missing" : message.deliveryStatus === "failed" ? "failed" : "pending");
      setError(message === null ? "El intento aún no aparece registrado. Consulta de nuevo o cancélalo antes de preparar otro."
        : message.deliveryStatus === "failed" ? message.deliveryError || "WhatsApp confirmó que el mensaje no fue enviado."
        : "El reenvío sigue pendiente de confirmación. Consulta su estado antes de volver a enviar.");
    }
  }
  async function send() {
    const selected = current.current.source;
    if (pending || working.current || !selected || !destination) return;
    if (!canSend(destination)) { setError(destination.messaging?.reason || "La ventana de respuesta terminó o cambió el acceso. Actualiza el destinatario antes de reenviar."); return; }
    const intent: Intent = { requestId: crypto.randomUUID(), version: destination.conversation.version, destinationId: destination.conversation.id, sourceConversationId: selected.conversationId, sourceMessageId: selected.message.id };
    remember(intent); setOutcome("pending");
    await run(async signal => {
      const form = new FormData(); form.set("requestId", intent.requestId); form.set("version", String(intent.version)); form.set("forwardConversationId", intent.sourceConversationId); form.set("forwardMessageId", intent.sourceMessageId);
      const reply = await request<{ message: AttentionMessage; uncertain?: boolean }>(`/api/atencion/${intent.destinationId}/messages`, { method: "POST", body: form, signal });
      result(intent, reply.uncertain ? { ...reply.message, deliveryStatus: "uncertain" } : reply.message);
    });
  }
  async function resolve() {
    if (!pending) return; const intent = pending;
    await run(async signal => result(intent, (await request<{ message: AttentionMessage | null }>(`/api/atencion/${intent.destinationId}/messages?requestId=${intent.requestId}`, { signal })).message));
  }
  async function discard() {
    if (!pending || outcome !== "missing") return; const intent = pending;
    await run(async signal => {
      const response = await request<{ cancelled: boolean }>(`/api/atencion/${intent.destinationId}/messages?requestId=${intent.requestId}`, { method: "DELETE", signal });
      if (!response.cancelled) throw new Error("No se confirmó la cancelación del intento.");
      if (alive.current) { remember(null); setOutcome(null); setDestination(null); setError(""); if (!current.current.source) { setOpen(false); onClose(); } }
    });
  }
  function close() { if (working.current) return; read.current?.abort(); generation.current++; setOpen(false); setInbox(null); setDestination(null); onClose(); }
  const candidates = inbox?.conversations.filter(item => item.channel === "whatsapp" && item.id !== source?.conversationId) || [];
  const shownSource = source && (!pending || pending.sourceConversationId === source.conversationId && pending.sourceMessageId === source.message.id) ? source : null;
  return <>
    {pending && !open && <div className={styles.pending}><Button type="button" variant="secondary" onClick={() => { setOpen(true); setNotice(""); setError(""); }}><Forward aria-hidden="true" size={18} />Reenvío por confirmar</Button></div>}
    <FinserSidePanel open={open} title="Reenviar mensaje" closeLabel="Cerrar reenvío" busy={busy} onClose={close}><div className={styles.panel}>
      {shownSource && <section className={styles.preview}><small>Mensaje de {shownSource.contactName}</small><p>{attentionMessageSummary(shownSource.message)}</p></section>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <><p role="status" className={styles.notice}>{notice}</p><Button type="button" onClick={close}>Volver al chat</Button></>}
      {pending ? <section className={styles.recovery}><p>Este intento conserva su identificador para evitar mensajes duplicados.</p><Button type="button" variant="secondary" disabled={busy} onClick={() => void resolve()}><RefreshCw aria-hidden="true" size={18} />{busy ? "Consultando…" : "Consultar estado"}</Button>{outcome === "missing" && <Button type="button" variant="secondary" disabled={busy} onClick={() => void discard()}>Cancelar intento</Button>}{outcome === "failed" && <Button type="button" disabled={busy} onClick={() => { remember(null); setOutcome(null); setDestination(null); setError(""); if (!current.current.source) close(); }}>Preparar nuevo intento</Button>}</section>
        : !notice && (destination ? <section className={styles.review}><Button type="button" variant="ghost" disabled={busy} onClick={() => setDestination(null)}><ArrowLeft aria-hidden="true" size={18} />Elegir otro chat</Button><h3>Enviar a {name(destination.conversation)}</h3><p>{destination.conversation.phone || "WhatsApp"}</p><p>Se enviará una copia de este mensaje a este contacto. La conversación original se conserva.</p>{!canSend(destination) && <p role="status" className={styles.error}>{destination.messaging?.reason || "Este chat no permite responder. Revisa su asignación y la ventana de atención."}</p>}<Button type="button" disabled={busy || !canSend(destination)} onClick={() => void send()}><Send aria-hidden="true" size={18} />Reenviar mensaje</Button></section>
          : <><p>Selecciona un chat autorizado y revisa el destinatario antes de reenviar.</p><label className={styles.search}><Search aria-hidden="true" size={18} /><span className={styles.srOnly}>Buscar destinatario</span><Input type="search" value={search} maxLength={120} placeholder="Buscar nombre o teléfono…" disabled={busy} onChange={event => { setSearch(event.target.value); setPage(1); setInbox(null); }} /></label>{loading && <p role="status">Consultando chats…</p>}<div className={styles.chats}>{candidates.map(item => <button type="button" key={item.id} disabled={loading || busy} onClick={() => void choose(item)}><strong>{name(item)}</strong><span>{item.phone || "WhatsApp"} · {item.assigneeName || "Sin asignar"}</span></button>)}</div>{!loading && !candidates.length && <p role="status">No hay chats disponibles para esta búsqueda.</p>}<div className={styles.pages}><Button type="button" variant="ghost" aria-label="Página anterior de destinatarios" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden="true" size={18} /></Button><span>{page} / {Math.max(1, Math.ceil((inbox?.total || 0) / (inbox?.pageSize || 40)))}</span><Button type="button" variant="ghost" aria-label="Página siguiente de destinatarios" disabled={loading || !inbox || page * inbox.pageSize >= inbox.total} onClick={() => setPage(value => value + 1)}><ChevronRight aria-hidden="true" size={18} /></Button></div></>)}
    </div></FinserSidePanel>
  </>;
}
