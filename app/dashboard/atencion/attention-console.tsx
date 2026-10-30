"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronLeft, ChevronRight, ClipboardList, Clock3, FileText, Inbox, LockKeyhole, MessageCircle, Plus, RefreshCw, Search, Send, ShieldCheck, Tag, UserRound, Users, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState, MetricCard, PageHeader, Select, StatusPill } from "@/app/_components/finser-ui";
import type { AttentionActor, AttentionConversation, AttentionCustomer, AttentionDetail, AttentionFilters, AttentionInbox, AttentionMutation } from "@/lib/atencion-types";
import styles from "./attention.module.css";

const statusNames = { pending: "Pendiente", open: "En atención", closed: "Finalizada" } as const;
const filters: { value: AttentionFilters["filter"]; label: string }[] = [
  { value: "mine", label: "Mis chats" }, { value: "all", label: "Todas" },
  { value: "pending", label: "Pendientes" }, { value: "closed", label: "Finalizadas" },
];
const money = (value: number | null) => value === null ? "No disponible" : new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
function date(value: string | null, short = false) {
  if (!value) return "Sin contacto registrado";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-05:00` : value);
  if (Number.isNaN(parsed.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "short", ...(short ? {} : { hour: "2-digit", minute: "2-digit" }) }).format(parsed);
}
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "C"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "No fue posible completar la solicitud. Intenta nuevamente."; }
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store", headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "No fue posible completar la solicitud. Intenta nuevamente.");
  return body as T;
}
function Status({ conversation }: { conversation: AttentionConversation }) {
  return <StatusPill tone={conversation.status === "pending" ? "warning" : conversation.status === "open" ? "positive" : "neutral"}>{statusNames[conversation.status]}</StatusPill>;
}

export default function AttentionConsole({ actor }: { actor: AttentionActor }) {
  const [inbox, setInbox] = useState<AttentionInbox | null>(null);
  const [detail, setDetail] = useState<AttentionDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AttentionFilters["filter"]>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const [syncSede, setSyncSede] = useState("");
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const newRequestKey = useRef<string | null>(null);
  const mutationKey = useRef<{ payload: string; id: string } | null>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
  const customerHeading = useRef<HTMLHeadingElement>(null);

  const loadInbox = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRequest.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ search, filter, page: String(page) });
      const result = await api<AttentionInbox>(`/api/atencion?${query}`, { signal });
      if (request === listRequest.current) setInbox(result);
    } catch (err) {
      if (!signal?.aborted && request === listRequest.current) setError(errorMessage(err));
    } finally {
      if (!signal?.aborted && request === listRequest.current) setLoading(false);
    }
  }, [filter, page, search]);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const request = ++detailRequest.current;
    setDetailLoading(true); setDetailError("");
    try {
      const result = await api<AttentionDetail>(`/api/atencion/${encodeURIComponent(id)}`, { signal });
      if (request === detailRequest.current && selectionRef.current === id) setDetail(result);
    } catch (err) {
      if (!signal?.aborted && request === detailRequest.current && selectionRef.current === id) {
        setDetail(null); setDetailError(errorMessage(err));
      }
    } finally {
      if (!signal?.aborted && request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => { void loadInbox(controller.signal); }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [loadInbox]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => { void loadDetail(selected, controller.signal); }, 0);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [selected, loadDetail]);
  useEffect(() => {
    if (selected) (showCustomer ? customerHeading : chatHeading).current?.focus({ preventScroll: true });
  }, [selected, showCustomer]);

  function selectConversation(id: string | null) {
    selectionRef.current = id; ++detailRequest.current;
    setSelected(id); setDetail(null); setDetailError(""); setDetailLoading(Boolean(id)); setShowCustomer(false); setDraft("");
    mutationKey.current = null;
  }
  async function mutate(input: Omit<AttentionMutation, "version" | "requestId">) {
    if (!detail || busyRef.current) return false;
    const id = detail.conversation.id;
    const payload = JSON.stringify({ ...input, version: detail.conversation.version });
    if (mutationKey.current?.payload !== payload) mutationKey.current = { payload, id: crypto.randomUUID() };
    busyRef.current = true; setBusy(true); setDetailError(""); setNotice("");
    try {
      await api(`/api/atencion/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...input, version: detail.conversation.version, requestId: mutationKey.current.id }) });
      mutationKey.current = null;
      setNotice(input.action === "human_request" ? "Solicitud interna registrada. La IA no se ha pausado ni se ha confirmado una transferencia en Dapta." : "Gestión guardada en FINSER PAY.");
      if (input.action === "transfer" && !actor.admin && !actor.supervisor && input.assigneeKey !== actor.key) selectConversation(null);
      await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]);
      return true;
    } catch (err) { setDetailError(errorMessage(err)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current) return;
    const data = new FormData(event.currentTarget);
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    newRequestKey.current ||= crypto.randomUUID();
    try {
      const result = await api<{ id: string }>("/api/atencion", { method: "POST", body: JSON.stringify({ phone: data.get("phone"), name: data.get("name"), sedeId: Number(data.get("sedeId")), requestId: newRequestKey.current }) });
      newRequestKey.current = null; setShowNew(false); selectConversation(result.id);
      setNotice("Gestión interna registrada. No se envió un mensaje ni se creó una ficha de cliente.");
      await loadInbox();
    } catch (err) { setError(errorMessage(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function sync() {
    if (busyRef.current || !syncSede) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ imported: number; skipped: number; nextCursor: string | null }>("/api/atencion/sync", { method: "POST", body: JSON.stringify({ sedeId: Number(syncSede), cursor: syncCursor }) });
      setSyncCursor(result.nextCursor);
      setNotice(`Sincronización guardada: ${result.imported} conversaciones procesadas${result.skipped ? `; ${result.skipped} omitidas por no cumplir los criterios de importación` : ""}.${result.nextCursor ? " Hay más conversaciones disponibles." : ""}`);
      await Promise.all([loadInbox(), selected ? loadDetail(selected) : Promise.resolve()]);
    } catch (err) { setError(errorMessage(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const currentActor = inbox?.actor ?? actor;
  const canSupervise = currentActor.admin || currentActor.supervisor;
  const contentReady = Boolean(inbox?.schemaReady);

  return <>
    <PageHeader eyebrow="RELACIONES QUE AVANZAN" title="Atención al cliente" description="Conversaciones y seguimiento, con la información de FINSER PAY." actions={<>
      <Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || busy}><RefreshCw aria-hidden="true" size={16} /> Actualizar</Button>
      <Button onClick={() => { setShowNew(value => !value); newRequestKey.current = null; }} disabled={!contentReady || busy}><Plus aria-hidden="true" size={17} /> Nueva gestión</Button>
    </>} />

    <div className={styles.metrics} aria-label="Resumen de conversaciones autorizadas">
      <MetricCard label="En atención" value={inbox?.metrics.open ?? "—"} detail="Conversaciones abiertas"><MessageCircle className={styles.metricIcon} aria-hidden="true" /></MetricCard>
      <MetricCard label="Pendientes" value={inbox?.metrics.pending ?? "—"} detail="Por gestionar"><Clock3 className={styles.metricIcon} aria-hidden="true" /></MetricCard>
      <MetricCard label="Asignadas a mí" value={inbox?.metrics.mine ?? "—"} detail="Mi bandeja de atención"><UserRound className={styles.metricIcon} aria-hidden="true" /></MetricCard>
      <MetricCard label="Finalizadas" value={inbox?.metrics.closed ?? "—"} detail="Gestiones cerradas"><CheckCheck className={styles.metricIcon} aria-hidden="true" /></MetricCard>
    </div>

    {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || busy}>Reintentar</Button></div>}
    {notice && <div className={styles.notice} role="status"><Check aria-hidden="true" size={18} /><span>{notice}</span><Button variant="ghost" aria-label="Ocultar confirmación" onClick={() => setNotice("")}><X size={16} aria-hidden="true" /></Button></div>}
    {inbox && <div className={styles.connection}>
      <div><span className={styles.connectionIcon}><ShieldCheck aria-hidden="true" size={20} /></span><div><strong>{inbox.integration.configured ? "Dapta · consulta de conversaciones" : "WhatsApp · conexión pendiente"}</strong><p>{inbox.integration.message}</p></div></div>
      {currentActor.central && <Button variant="secondary" disabled={!contentReady || !inbox.integration.canSync || busy} onClick={() => setShowSync(value => !value)}><RefreshCw aria-hidden="true" size={16} /> Sincronizar</Button>}
    </div>}
    {inbox && !inbox.schemaReady && <Card className={styles.setupNotice}><strong>El espacio de atención está preparado para su instalación.</strong><p>Falta habilitar el almacenamiento del módulo. La bandeja mostrará los registros reales cuando se complete la configuración.</p></Card>}

    {showNew && inbox && <Card className={styles.formCard}>
      <div className={styles.sectionHeading}><div><h2>Nueva gestión interna</h2><p>Registra un contacto para dar seguimiento. No inicia una conversación de WhatsApp.</p></div><Button variant="ghost" aria-label="Cerrar nueva gestión" disabled={busy} onClick={() => setShowNew(false)}><X aria-hidden="true" size={18} /></Button></div>
      <form className={styles.newForm} onSubmit={createCase} onChange={() => { if (!busy) newRequestKey.current = null; }}>
        <label>Nombre del contacto<Input name="name" required maxLength={120} autoComplete="off" disabled={busy} /></label>
        <label>Teléfono<Input name="phone" type="tel" required maxLength={24} placeholder="Con indicativo de país" autoComplete="off" disabled={busy} /></label>
        <label>Sede<Select name="sedeId" required disabled={busy} defaultValue={inbox.branches.length === 1 ? inbox.branches[0].id : ""}><option value="" disabled>Seleccionar sede</option>{inbox.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select></label>
        <Button type="submit" disabled={busy || !inbox.branches.length}>{busy ? "Guardando…" : "Registrar gestión"}</Button>
      </form>
    </Card>}
    {showSync && currentActor.central && inbox && <Card className={styles.formCard}>
      <div className={styles.sectionHeading}><div><h2>Importar desde Dapta</h2><p>La sede elegida determina qué equipo puede consultar las conversaciones nuevas. No se modifica el proveedor ni se envían mensajes.</p></div><Button variant="ghost" disabled={busy} aria-label="Cerrar sincronización" onClick={() => setShowSync(false)}><X aria-hidden="true" size={18} /></Button></div>
      <div className={styles.inlineForm}><label>Sede responsable<Select value={syncSede} disabled={busy || Boolean(syncCursor)} onChange={event => { setSyncSede(event.target.value); setSyncCursor(null); }}><option value="">Seleccionar sede</option>{inbox.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select></label><Button disabled={busy || !syncSede || !inbox.integration.canSync} onClick={() => void sync()}>{busy ? "Sincronizando…" : syncCursor ? "Importar siguiente página" : "Importar conversaciones"}</Button>{syncCursor && <Button variant="ghost" disabled={busy} onClick={() => setSyncCursor(null)}>Reiniciar selección</Button>}</div>
    </Card>}

    <section className={`${styles.workspace} ${selected ? styles.hasSelection : ""} ${showCustomer ? styles.showCustomer : ""}`} aria-label="Bandeja de atención">
      <aside className={styles.inbox} aria-label="Conversaciones">
        <div className={styles.inboxHeading}><h2>Conversaciones</h2><Badge>{inbox?.total ?? "—"}</Badge></div>
        <label className={styles.search}><Search aria-hidden="true" size={18} /><span className={styles.srOnly}>Buscar por nombre o teléfono</span><Input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Nombre o teléfono" maxLength={100} /></label>
        <div className={styles.filters} role="group" aria-label="Filtrar conversaciones">{filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}</div>
        <div className={styles.conversationList} aria-busy={loading}>
          {loading ? <LoadingState label="Cargando conversaciones…" /> : error ? <EmptyState title="No se pudo abrir la bandeja" description="Vuelve a intentar la consulta." /> : !inbox?.conversations.length ? <div className={styles.inboxEmpty}><Inbox size={30} aria-hidden="true" /><strong>{search ? "Sin coincidencias" : "Bandeja sin conversaciones"}</strong><p>{search ? "Prueba con otro nombre o teléfono." : filter === "mine" ? "Aquí aparecerán las conversaciones que tomes o te asignen." : "Las conversaciones autorizadas aparecerán al sincronizar Dapta. También puedes registrar una gestión interna."}</p></div> : inbox.conversations.map(conversation => <button type="button" key={conversation.id} className={`${styles.conversation} ${selected === conversation.id ? styles.selected : ""}`} aria-pressed={selected === conversation.id} onClick={() => selectConversation(conversation.id)}>
            <span className={styles.avatar}>{initials(conversation.name)}</span><span className={styles.conversationBody}><span className={styles.conversationTitle}><strong>{conversation.name || conversation.phone}</strong><time dateTime={conversation.lastContactAt || undefined}>{conversation.lastContactAt ? date(conversation.lastContactAt, true) : ""}</time></span><span className={styles.phone}>{conversation.phone}</span><span className={styles.preview}>{conversation.preview || (conversation.channel === "internal" ? "Gestión interna · sin mensajes" : "Sin mensajes sincronizados")}</span><span className={styles.conversationFooter}><Status conversation={conversation} /><small>{conversation.assigneeName || "Sin asignar"}</small></span></span>
          </button>)}
        </div>
        <div className={styles.pagination}><Button variant="ghost" aria-label="Página anterior de conversaciones" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden="true" size={18} /></Button><span>Página {page} de {Math.max(1, Math.ceil((inbox?.total ?? 0) / (inbox?.pageSize || 25)))}</span><Button variant="ghost" aria-label="Siguiente página de conversaciones" disabled={loading || !inbox || page * inbox.pageSize >= inbox.total} onClick={() => setPage(value => value + 1)}><ChevronRight aria-hidden="true" size={18} /></Button></div>
      </aside>

      <section className={styles.chat} aria-label="Historial de la conversación">
        {!selected ? <div className={styles.selectPrompt}><span><MessageCircle aria-hidden="true" size={32} /></span><h2>Cada conversación, una mejor atención</h2><p>Selecciona un contacto para consultar su historial, registrar una gestión y abrir su ficha autorizada.</p><div><LockKeyhole aria-hidden="true" size={15} /> Información visible según tu rol y sede</div></div> : <>
          <div className={styles.chatHeader}><Button variant="ghost" className={styles.backButton} aria-label="Volver a conversaciones" onClick={() => selectConversation(null)}><ArrowLeft aria-hidden="true" size={18} /></Button><span className={styles.avatar}>{initials(detail?.conversation.name || "Contacto")}</span><div className={styles.chatIdentity}><h2 ref={chatHeading} tabIndex={-1}>{detail?.conversation.name || "Conversación"}</h2><span>{detail?.conversation.phone || "Consultando historial…"}{detail && ` · ${detail.conversation.channel === "whatsapp" ? "WhatsApp" : "Gestión interna"}`}</span></div><Button variant="secondary" className={styles.customerToggle} onClick={() => setShowCustomer(true)}><UserRound aria-hidden="true" size={16} /> Ficha</Button></div>
          {detailError && <div className={styles.error} role="alert"><span>{detailError}</span><Button variant="secondary" disabled={busy || detailLoading} onClick={() => void loadDetail(selected)}>Actualizar ficha</Button></div>}
          {detailLoading && !detail ? <LoadingState label="Consultando historial y ficha…" /> : detail && <>
            <div className={styles.chatActions}><Status conversation={detail.conversation} /><span className={styles.assignee}><UserRound aria-hidden="true" size={14} />{detail.conversation.assigneeName || "Sin asignar"}</span>{detail.permissions.claim && <Button disabled={busy} onClick={() => void mutate({ action: "claim" })}>Tomar chat</Button>}{detail.permissions.manage && <Button variant="secondary" disabled={busy} onClick={() => void mutate({ action: detail.conversation.status === "closed" ? "reopen" : "close" })}>{detail.conversation.status === "closed" ? "Reabrir" : "Finalizar"}</Button>}</div>
            {detail.permissions.manage && <div className={styles.assignment}><label className={styles.srOnly} htmlFor="attention-transfer">Transferir responsable</label><Select id="attention-transfer" value="" disabled={busy} onChange={event => { if (event.target.value) void mutate({ action: "transfer", assigneeKey: event.target.value }); }}><option value="">Transferir responsable…</option>{inbox?.team.filter(person => person.sedeIds.includes(detail.conversation.sedeId) && person.key !== detail.conversation.assigneeKey).map(person => <option key={person.key} value={person.key}>{person.name}</option>)}</Select><span>Asignación interna en FINSER PAY</span></div>}
            <div className={styles.messages} role="log" aria-label="Mensajes sincronizados">
              {detail.historyTruncated && <p className={styles.historyNotice}>Se muestra una parte del historial disponible en Dapta.</p>}
              {detail.messages.length ? detail.messages.map(message => <article key={message.id} className={`${styles.message} ${message.direction === "outbound" ? styles.outbound : ""}`}><span>{message.direction === "inbound" ? "Contacto" : message.author || "Dapta"}</span><p>{message.text}</p><time dateTime={message.sentAt}>{date(message.sentAt)}</time></article>) : <div className={styles.messagesEmpty}><MessageCircle aria-hidden="true" size={26} /><strong>{detail.conversation.channel === "internal" ? "Gestión interna" : "Sin mensajes sincronizados"}</strong><p>{detail.conversation.channel === "internal" ? "Utiliza las notas y tareas para registrar el seguimiento del contacto." : "El historial aparecerá después de una sincronización válida con Dapta."}</p></div>}
            </div>
            <div className={styles.composer}><div className={styles.composerHeading}><label htmlFor="attention-draft">Borrador de respuesta</label><Select aria-label="Insertar respuesta rápida aprobada" disabled={!inbox?.quickReplies.length} value="" onChange={event => { const reply = inbox?.quickReplies.find(item => item.id === event.target.value); if (reply) setDraft(reply.text); }}><option value="">Respuestas aprobadas</option>{inbox?.quickReplies.map(reply => <option key={reply.id} value={reply.id}>{reply.title}</option>)}</Select></div><textarea id="attention-draft" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={4000} placeholder="Puedes preparar un texto. El envío aún no está habilitado." /><div className={styles.composerFooter}><p><LockKeyhole aria-hidden="true" size={14} /> El conector disponible es de lectura. No se pueden enviar respuestas desde esta bandeja.</p><Button disabled title="Envío pendiente de habilitación oficial"><Send aria-hidden="true" size={16} /> Enviar</Button></div></div>
          </>}
        </>}
      </section>

      <aside className={styles.customer} aria-label="Ficha y seguimiento del cliente"><div className={styles.customerHeader}><Button className={styles.backButton} variant="ghost" aria-label="Volver al chat" onClick={() => setShowCustomer(false)}><ArrowLeft aria-hidden="true" size={18} /></Button><h2 ref={customerHeading} tabIndex={-1}>Ficha del cliente</h2><ShieldCheck aria-hidden="true" size={18} /></div>{detail ? <CustomerPanel key={detail.conversation.id} detail={detail} busy={busy} mutate={mutate} canOpenRecord={canSupervise} /> : <div className={styles.customerEmpty}><UserRound aria-hidden="true" size={30} /><p>La ficha reúne la información existente de FINSER PAY que puedes consultar.</p></div>}</aside>
    </section>

    <div className={styles.bottomGrid}>
      {canSupervise && <Card className={styles.teamPanel}><div className={styles.sectionHeading}><h2><Users aria-hidden="true" size={19} /> Equipo autorizado</h2><Badge>{inbox?.team.length ?? "—"}</Badge></div><p>Asesores disponibles para asignar gestiones dentro de tu alcance.</p>{inbox?.team.length ? <div className={styles.teamList}>{inbox.team.map(person => <div key={person.key}><span className={styles.smallAvatar}>{initials(person.name)}</span><strong>{person.name}</strong><span>{person.sedeIds.length} {person.sedeIds.length === 1 ? "sede" : "sedes"}</span></div>)}</div> : <p className={styles.muted}>No hay asesores autorizados para mostrar.</p>}</Card>}
      <Card className={styles.repliesPanel}><div className={styles.sectionHeading}><h2><FileText aria-hidden="true" size={19} /> Respuestas rápidas</h2>{currentActor.central && <Button variant="ghost" disabled={!contentReady || busy} onClick={() => setShowReplies(value => !value)}>{showReplies ? "Cerrar" : "Aprobar respuesta"}</Button>}</div><p>Solo contenido aprobado por administración de FINSER PAY.</p>{inbox?.quickReplies.length ? <ul className={styles.replyList}>{inbox.quickReplies.map(reply => <li key={reply.id}><strong>{reply.title}</strong><p>{reply.text}</p><small>Aprobada por {reply.approvedBy} · {date(reply.approvedAt, true)}</small></li>)}</ul> : <p className={styles.muted}>Aún no hay respuestas aprobadas.</p>}{showReplies && currentActor.central && <QuickReplyForm disabled={busy} saved={() => { setShowReplies(false); setNotice("Respuesta aprobada y guardada en FINSER PAY."); void loadInbox(); }} />}</Card>
    </div>
  </>;
}

type Mutate = (input: Omit<AttentionMutation, "version" | "requestId">) => Promise<boolean>;
function CustomerPanel({ detail, busy, mutate, canOpenRecord }: { detail: AttentionDetail; busy: boolean; mutate: Mutate; canOpenRecord: boolean }) {
  const [note, setNote] = useState("");
  const [task, setTask] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [tag, setTag] = useState("");
  const [candidate, setCandidate] = useState("");
  const { customer, conversation, permissions } = detail;
  const matchMessages: Record<AttentionCustomer["match"], string> = {
    linked: "Vinculada a la ficha existente", none: "Contacto nuevo · sin coincidencia autorizada",
    ambiguous: "El teléfono coincide con varias fichas. Verifica la identidad antes de vincular.",
    restricted: "La ficha no está disponible para tu alcance de acceso.",
  };
  return <div className={styles.customerContent}>
    <section className={styles.customerSection}><div className={styles.customerIdentity}><span className={styles.avatar}>{initials(customer.name || conversation.name)}</span><div><h3>{customer.name || conversation.name}</h3><span>{customer.documentMasked || conversation.phone}</span></div></div><p className={styles.matchMessage}>{matchMessages[customer.match]}</p>{customer.match === "none" && <Link href="/dashboard/creditos" className={styles.textLink}>Completar en el flujo de solicitudes <ArrowRight aria-hidden="true" size={14} /></Link>}
      {permissions.manage && customer.candidates.length > 0 && customer.match !== "linked" && <div className={styles.compactForm}><label>Ficha autorizada<Select value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)}><option value="">Seleccionar ficha</option>{customer.candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.documentMasked} · {item.folio}</option>)}</Select></label><Button variant="secondary" disabled={busy || !candidate} onClick={() => void mutate({ action: "link", creditId: Number(candidate) })}>Vincular ficha</Button></div>}
      {permissions.manage && conversation.linkedCreditId && <Button variant="ghost" disabled={busy} onClick={() => void mutate({ action: "unlink" })}>Quitar vínculo manual</Button>}
      <dl className={styles.keyValues}><div><dt>Último contacto</dt><dd>{date(conversation.lastContactAt)}</dd></div><div><dt>Responsable</dt><dd>{conversation.assigneeName || "Sin asignar"}</dd></div></dl>
    </section>
    <section className={styles.customerSection}><h3><FileText aria-hidden="true" size={16} /> Créditos y pagos</h3>{!customer.financialAllowed && <p className={styles.muted}>Tu rol no permite consultar importes ni pagos desde atención.</p>}{customer.credits.length ? customer.credits.map(credit => <div className={styles.credit} key={credit.id}><div><strong>{credit.folio}</strong><Badge>{credit.state}</Badge></div><p>{credit.equipment || "Equipo sin referencia"}</p>{customer.financialAllowed && <dl className={styles.keyValues}><div><dt>Saldo</dt><dd>{money(credit.balance)}</dd></div><div><dt>Próxima cuota</dt><dd>{credit.nextDueAt ? date(credit.nextDueAt, true) : "No disponible"}</dd></div><div><dt>Valor pendiente</dt><dd>{money(credit.nextAmount)}</dd></div></dl>}{customer.financialAllowed && credit.payments.length > 0 && <details><summary>Pagos registrados ({credit.payments.length})</summary>{credit.payments.map((payment, index) => <p className={styles.payment} key={`${payment.date}-${index}`}><span>{date(payment.date, true)} · {payment.method}</span><strong>{money(payment.amount)}</strong></p>)}</details>}{canOpenRecord && <Link className={styles.textLink} href={`/dashboard/clientes?selected=${credit.id}`}>Ver expediente <ArrowRight aria-hidden="true" size={13} /></Link>}</div>) : <p className={styles.muted}>Sin créditos vinculados dentro de tu alcance.</p>}</section>
    <section className={styles.customerSection}><h3><ClipboardList aria-hidden="true" size={16} /> Estudios de crédito</h3>{customer.studies.length ? customer.studies.map(study => <div className={styles.study} key={study.id}><Badge>{study.state}</Badge><time dateTime={study.createdAt}>{date(study.createdAt, true)}</time></div>) : <p className={styles.muted}>Sin estudios disponibles para esta ficha.</p>}</section>
    <section className={styles.customerSection}><h3><ShieldCheck aria-hidden="true" size={16} /> Atención humana</h3><p className={styles.muted}>{conversation.mode === "human_requested" ? "Hay una solicitud interna de atención humana. Falta confirmar el traspaso en Dapta." : "Solicitar apoyo registra una gestión interna. No pausa la IA ni transfiere automáticamente el chat en Dapta."}</p>{permissions.manage && <Button variant="secondary" disabled={busy || conversation.mode === "human_requested" || conversation.status === "closed"} onClick={() => void mutate({ action: "human_request" })}>Solicitar apoyo humano</Button>}</section>
    <section className={styles.customerSection}><h3><Tag aria-hidden="true" size={16} /> Etiquetas</h3><div className={styles.tags}>{conversation.tags.length ? conversation.tags.map(value => <span key={value}><Badge>{value}</Badge>{permissions.manage && <button type="button" aria-label={`Quitar etiqueta ${value}`} disabled={busy} onClick={() => void mutate({ action: "tags", tags: conversation.tags.filter(item => item !== value) })}><X aria-hidden="true" size={13} /></button>}</span>) : <p className={styles.muted}>Sin etiquetas</p>}</div>{permissions.manage && <form className={styles.tagForm} onSubmit={async event => { event.preventDefault(); const value = tag.trim(); if (value && await mutate({ action: "tags", tags: [...conversation.tags, value] })) setTag(""); }}><Input aria-label="Nueva etiqueta" value={tag} disabled={busy} onChange={event => setTag(event.target.value)} maxLength={30} placeholder="Añadir etiqueta" /><Button variant="secondary" type="submit" aria-label="Guardar etiqueta" disabled={busy || !tag.trim() || conversation.tags.length >= 8}><Plus aria-hidden="true" size={16} /></Button></form>}</section>
    <section className={styles.customerSection}><h3><MessageCircle aria-hidden="true" size={16} /> Notas internas</h3><p className={styles.muted}>Visibles para el equipo autorizado. No se envían al cliente.</p>{detail.notesTruncated && <p className={styles.historyNotice}>Se muestran las 300 notas más recientes; hay notas anteriores registradas.</p>}{detail.notes.map(item => <article className={styles.note} key={item.id}><p>{item.text}</p><small>{item.author} · {date(item.createdAt)}</small></article>)}{permissions.manage && <form className={styles.compactForm} onSubmit={async event => { event.preventDefault(); if (await mutate({ action: "note", text: note.trim() })) setNote(""); }}><label className={styles.srOnly} htmlFor="attention-note">Texto de la nota interna</label><textarea id="attention-note" rows={3} maxLength={2000} required value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Registrar una gestión…" /><Button variant="secondary" type="submit" disabled={busy || !note.trim()}>Guardar nota</Button></form>}</section>
    <section className={styles.customerSection}><h3><Clock3 aria-hidden="true" size={16} /> Tareas y recordatorios</h3>{detail.tasksTruncated && <p className={styles.historyNotice}>Se muestran hasta 300 tareas, con prioridad para las pendientes.</p>}{detail.tasks.length ? detail.tasks.map(item => <div className={styles.task} key={item.id}><div><strong className={item.completedAt ? styles.completed : undefined}>{item.title}</strong><small>{item.completedAt ? `Completada · ${date(item.completedAt)}` : item.dueAt ? `Recordatorio · ${date(item.dueAt)}` : "Sin fecha"}</small></div>{permissions.manage && !item.completedAt && <Button variant="ghost" aria-label={`Completar tarea: ${item.title}`} disabled={busy} onClick={() => void mutate({ action: "complete_task", taskId: item.id })}><Check aria-hidden="true" size={17} /></Button>}</div>) : <p className={styles.muted}>Sin tareas registradas.</p>}{permissions.manage && <form className={styles.compactForm} onSubmit={async event => { event.preventDefault(); if (await mutate({ action: "task", text: task.trim(), dueAt: dueAt ? new Date(`${dueAt}:00-05:00`).toISOString() : null })) { setTask(""); setDueAt(""); } }}><label>Tarea<Input value={task} disabled={busy} maxLength={240} required onChange={event => setTask(event.target.value)} placeholder="Próxima gestión" /></label><label>Recordatorio (hora de Colombia)<Input type="datetime-local" value={dueAt} disabled={busy} onChange={event => setDueAt(event.target.value)} /></label><Button variant="secondary" type="submit" disabled={busy || !task.trim()}>Crear tarea</Button><small className={styles.muted}>El recordatorio queda en esta ficha; no envía avisos externos.</small></form>}</section>
  </div>;
}

function QuickReplyForm({ disabled, saved }: { disabled: boolean; saved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    requestKey.current ||= crypto.randomUUID(); submitting.current = true; setBusy(true); setError("");
    try {
      await api("/api/atencion/quick-replies", { method: "POST", body: JSON.stringify({ title: data.get("title"), text: data.get("text"), requestId: requestKey.current }) });
      requestKey.current = null; saved();
    } catch (err) { setError(errorMessage(err)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <form className={styles.compactForm} onSubmit={submit} onChange={() => { if (!busy) requestKey.current = null; }}>{error && <p role="alert" className={styles.error}>{error}</p>}<label>Título<Input name="title" required maxLength={80} disabled={disabled || busy} /></label><label>Texto aprobado<textarea name="text" required rows={4} maxLength={2000} disabled={disabled || busy} /></label><label className={styles.approval}><input type="checkbox" required disabled={disabled || busy} /> Confirmo que este contenido está aprobado para atención en FINSER PAY.</label><Button type="submit" disabled={disabled || busy}>{busy ? "Guardando…" : "Aprobar y guardar"}</Button></form>;
}
