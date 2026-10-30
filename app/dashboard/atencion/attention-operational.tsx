"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, MessageCircle, RefreshCw } from "lucide-react";
import { Button, EmptyState, LoadingState, Select } from "@/app/_components/finser-ui";
import type { AttentionAgenda, AttentionAgendaFilters, AttentionConversation, AttentionDetail, AttentionFilters, AttentionInbox, AttentionQuickReply } from "@/lib/atencion-types";
import styles from "./attention-operational.module.css";

type Request = <T>(url: string, options?: RequestInit) => Promise<T>;
const date = (value: string) => new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const message = (error: unknown) => error instanceof Error ? error.message : "No fue posible actualizar la agenda.";
function errorStatus(error: unknown) { return typeof error === "object" && error && "status" in error ? Number(error.status) : 0; }

export function AttentionWorkFilters({ filter, tag, central, inbox, change }: { filter: AttentionFilters["filter"]; tag: string; central: boolean; inbox: AttentionInbox | null; change: (filter: AttentionFilters["filter"], tag: string) => void }) {
  const items: { value: AttentionFilters["filter"]; label: string; count?: number }[] = [
    { value: "unread", label: "No leídos", count: inbox?.operational?.unread },
    { value: "unanswered", label: "Sin responder", count: inbox?.operational?.unanswered },
    ...(central ? [{ value: "unassigned" as const, label: "Sin asignar", count: inbox?.operational?.unassigned }] : []),
  ];
  return <div className={styles.filters}>
    <div className={styles.queueFilters} role="group" aria-label="Pendientes de conversación">{items.map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} onClick={() => change(filter === item.value ? "all" : item.value, tag)}>{item.label}{typeof item.count === "number" && item.count > 0 && <span>{item.count}</span>}</button>)}</div>
    <div className={styles.selectFilters}><label><span className={styles.srOnly}>Estado de conversaciones</span><Select aria-label="Estado de conversaciones" value={["all", "mine", "pending", "closed"].includes(filter) ? filter : "queue"} onChange={event => change(event.target.value as AttentionFilters["filter"], tag)}>{items.some(item => item.value === filter) && <option value="queue">{items.find(item => item.value === filter)?.label}</option>}<option value="all">Todas</option><option value="mine">Mías</option><option value="pending">Pendientes</option><option value="closed">Finalizadas</option></Select></label>
      <label><span className={styles.srOnly}>Filtrar por etiqueta</span><Select aria-label="Filtrar por etiqueta" value={tag} onChange={event => change(filter, event.target.value)}><option value="">Todas las etiquetas</option>{Array.from(new Set([...(inbox?.availableTags || []), ...(tag ? [tag] : [])])).map(value => <option key={value} value={value}>{value}</option>)}</Select></label></div>
  </div>;
}

export function waitingDuration(since: string | null, now: number) {
  const start = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(start)) return null;
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}
export function AttentionConversationIndicators({ conversation }: { conversation: AttentionConversation }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const waiting = waitingDuration(conversation.waitingSince, now);
  if (!conversation.unreadCount && !waiting) return null;
  return <span className={styles.indicators}>{waiting && <span className={styles.waiting} title={`Sin respuesta desde ${date(conversation.waitingSince!)}`}><CalendarClock aria-hidden="true" size={13} />Espera {waiting}</span>}{conversation.unreadCount > 0 && <span className={styles.unread} aria-label={`${conversation.unreadCount} mensajes no leídos`}>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}</span>;
}

/** Acknowledges only the exact inbound IDs rendered in a visible, bottom-scrolled log. */
export function AttentionObservedRead({ detail, active, log, request, onRead, onError }: { detail: AttentionDetail; active: boolean; log: RefObject<HTMLDivElement | null>; request: Request; onRead: () => void; onError: (error: unknown) => void }) {
  const acknowledged = useRef(new Set<string>());
  const callbacks = useRef({ onRead, onError });
  useEffect(() => { callbacks.current = { onRead, onError }; }, [onRead, onError]);
  useEffect(() => {
    if (!active) return;
    const element = log.current;
    if (!element) return;
    const controller = new AbortController();
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = () => {
      if (pending || controller.signal.aborted || document.visibilityState !== "visible" || !navigator.onLine || !element.clientHeight || document.querySelector("dialog[open], [role=alertdialog][aria-modal=true]") || element.scrollHeight - element.scrollTop - element.clientHeight > 16) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) return;
      const messageIds = detail.messages.filter(item => item.direction === "inbound" && !acknowledged.current.has(item.id)).map(item => item.id).slice(-500);
      if (!messageIds.length) return;
      pending = true;
      void request<{ unreadCount: number; changed: boolean }>(`/api/atencion/${encodeURIComponent(detail.conversation.id)}/read`, { method: "POST", signal: controller.signal, body: JSON.stringify({ messageIds }) }).then(result => {
        if (controller.signal.aborted) return;
        messageIds.forEach(id => acknowledged.current.add(id));
        if (result.changed) callbacks.current.onRead();
      }).catch(error => { if (!controller.signal.aborted) callbacks.current.onError(error); }).finally(() => { pending = false; });
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(observe, 200); };
    schedule(); element.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule); window.addEventListener("online", schedule);
    return () => { controller.abort(); if (timer) clearTimeout(timer); element.removeEventListener("scroll", schedule); document.removeEventListener("visibilitychange", schedule); window.removeEventListener("online", schedule); };
  }, [active, detail, log, request]);
  return null;
}

export function AttentionQuickReplies({ replies, disabled, insert }: { replies: AttentionQuickReply[]; disabled: boolean; insert: (text: string) => void }) {
  if (!replies.length) return null;
  return <label className={styles.quickReplies}><span className={styles.srOnly}>Insertar respuesta rápida</span><Select aria-label="Insertar respuesta rápida" value="" disabled={disabled} onChange={event => { const reply = replies.find(item => item.id === event.target.value); if (reply) insert(reply.text); }}><option value="">Respuesta rápida</option>{replies.map(reply => <option key={reply.id} value={reply.id}>{reply.title}</option>)}</Select></label>;
}

export function AttentionAgendaView({ request, revision, disabled, openChat, busyChanged, saved, accessDenied }: { request: Request; revision: unknown; disabled: boolean; openChat: (id: string) => void; busyChanged: (value: boolean) => void; saved: () => void; accessDenied: (error: unknown, conversationId?: string) => boolean }) {
  const [filter, setFilter] = useState<AttentionAgendaFilters["filter"]>("today");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AttentionAgenda | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [completing, setCompleting] = useState<string | null>(null);
  const serial = useRef(0); const alive = useRef(true); const mutation = useRef<{ payload: string; requestId: string } | null>(null); const locked = useRef(false);
  const callbacks = useRef({ accessDenied, busyChanged, saved });
  useEffect(() => { callbacks.current = { accessDenied, busyChanged, saved }; }, [accessDenied, busyChanged, saved]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++serial.current; setLoading(true); setError("");
    try {
      const result = await request<AttentionAgenda>(`/api/atencion/agenda?${new URLSearchParams({ filter, page: String(page) })}`, { signal });
      if (alive.current && !signal?.aborted && current === serial.current) { setData(result); if (page > 1 && !result.items.length) setPage(Math.max(1, Math.ceil(result.total / result.pageSize))); }
    } catch (failure) {
      if (alive.current && !signal?.aborted && current === serial.current) { if (callbacks.current.accessDenied(failure)) setData(null); setError(message(failure)); }
    } finally { if (alive.current && !signal?.aborted && current === serial.current) setLoading(false); }
  }, [filter, page, request]);
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => { void load(controller.signal); }, 0); return () => { clearTimeout(timer); controller.abort(); }; }, [load, revision]);
  async function complete(item: AttentionAgenda["items"][number]) {
    if (locked.current || disabled) return;
    const payload = JSON.stringify({ action: "complete_task", taskId: item.id, version: item.conversation.version });
    if (mutation.current?.payload !== payload) mutation.current = { payload, requestId: crypto.randomUUID() };
    locked.current = true; callbacks.current.busyChanged(true); setCompleting(item.id); setError(""); setNotice(""); ++serial.current;
    try {
      await request(`/api/atencion/${encodeURIComponent(item.conversation.id)}`, { method: "PATCH", body: JSON.stringify({ ...JSON.parse(payload), requestId: mutation.current.requestId }) });
      mutation.current = null;
      if (alive.current) { setNotice("Tarea completada."); await load(); }
      callbacks.current.saved();
    } catch (failure) {
      const denied = callbacks.current.accessDenied(failure, item.conversation.id);
      if (alive.current) {
        if (denied) setData(null);
        if ([404, 409].includes(errorStatus(failure))) { mutation.current = null; await load(); }
        setError(errorStatus(failure) === 409 ? "La conversación cambió. Actualizamos la tarea; revísala antes de completarla nuevamente." : message(failure));
      }
    } finally { locked.current = false; callbacks.current.busyChanged(false); if (alive.current) setCompleting(null); }
  }
  const counts = data?.counts;
  return <section className={styles.agenda} aria-label="Agenda de seguimiento"><div className={styles.agendaHeader}><div><p>Seguimientos pendientes · hora de Colombia</p><div className={styles.agendaFilters} role="group" aria-label="Filtrar agenda">{([{ value: "today", label: "Hoy", count: counts?.today }, { value: "overdue", label: "Vencidas", count: counts?.overdue }, { value: "upcoming", label: "Próximas", count: counts?.upcoming }, { value: "all", label: "Todas", count: counts?.total }] as const).map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} disabled={Boolean(completing)} onClick={() => { setFilter(item.value); setPage(1); setData(null); }}>{item.label}{typeof item.count === "number" && <span>{item.count}</span>}</button>)}</div></div><Button variant="ghost" aria-label="Actualizar agenda" disabled={loading || disabled} onClick={() => void load()}><RefreshCw size={18} aria-hidden="true" /></Button></div>
    {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="secondary" disabled={loading || disabled} onClick={() => void load()}>Actualizar agenda</Button></div>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.agendaList} aria-busy={loading}>{loading && !data ? <LoadingState label="Consultando seguimientos…" /> : !data?.items.length ? <EmptyState title={error ? "Agenda no disponible" : "No hay tareas en este período"} description={error ? "Vuelve a consultar para obtener las tareas actuales." : "Los recordatorios de las fichas aparecen aquí hasta que los completes."} /> : data.items.map(item => <article key={item.id} className={styles.task}><CalendarClock aria-hidden="true" size={20} /><div className={styles.taskBody}><strong>{item.title}</strong><span>{item.conversation.name || item.conversation.phone || "Contacto de WhatsApp"}</span><small>{item.dueAt ? date(item.dueAt) : "Sin fecha"} · {item.author}</small></div><div className={styles.taskActions}><Button variant="secondary" disabled={Boolean(completing)} onClick={() => openChat(item.conversation.id)}><MessageCircle size={16} aria-hidden="true" />Abrir chat</Button><Button variant="ghost" disabled={disabled || Boolean(completing)} onClick={() => void complete(item)}><Check size={17} aria-hidden="true" />{completing === item.id ? "Guardando…" : "Completar"}</Button></div></article>)}</div>
    {data && <div className={styles.agendaFooter}><span>{data.total} tareas{filter === "all" && counts?.undated ? ` · ${counts.undated} sin fecha` : ""}</span><div><Button variant="ghost" aria-label="Página anterior de agenda" disabled={loading || disabled || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></Button><span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><Button variant="ghost" aria-label="Página siguiente de agenda" disabled={loading || disabled || page * data.pageSize >= data.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></Button></div></div>}
  </section>;
}
