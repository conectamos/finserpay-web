"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, BarChart3, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Copy, ExternalLink, FileText, House, Image as ImageIcon, Inbox, LockKeyhole, Menu, MessageCircle, Mic, Plus, RefreshCw, Search, Settings, ShieldCheck, Tag, UserRound, Users, Video, X, type LucideIcon } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "@/app/dashboard/_components/logout-button";
import { Badge, Button, Card, EmptyState, Input, LoadingState, ProgressBar, Select, StatusPill } from "@/app/_components/finser-ui";
import type { AttentionActor, AttentionConversation, AttentionCustomer, AttentionDetail, AttentionFilters, AttentionInbox, AttentionMutation } from "@/lib/atencion-types";
import styles from "./attention.module.css";

type View = "dashboard" | "conversations" | "team" | "settings";
const DAPTA_INBOX_URL = "https://app.dapta.ai/agents-studio/inbox";
const statusNames = { pending: "Pendiente", open: "En atención", closed: "Finalizada" } as const;
const filters: { value: AttentionFilters["filter"]; label: string }[] = [
  { value: "all", label: "Todas" }, { value: "mine", label: "Mis conversaciones" },
  { value: "pending", label: "Pendientes" }, { value: "closed", label: "Finalizadas" },
];
const money = (value: number | null) => value === null ? "No disponible" : new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
function date(value: string | null, short = false) {
  if (!value) return "Sin contacto registrado";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-05:00` : value);
  if (Number.isNaN(parsed.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "short", ...(short ? {} : { hour: "2-digit", minute: "2-digit" }) }).format(parsed);
}
function time(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "C"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "No fue posible completar la solicitud. Intenta nuevamente."; }
type SyncProgress = { batches: number; imported: number; skipped: number };
type SyncBatch = { imported: number; processed?: number; skipped: number; nextCursor: string | null };
type SyncCheckpoint = { cursor: string; progress: SyncProgress };
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message); this.name = "ApiError";
  }
}
function safeRetrySeconds(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 && Number.isSafeInteger(Math.ceil(value)) ? Math.max(1, Math.ceil(value)) : undefined;
}
function headerRetrySeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  return safeRetrySeconds(/^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000);
}
function readSyncCheckpoint(key: string): SyncCheckpoint | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = raw.length <= 8192 ? JSON.parse(raw) : null;
    if (typeof value === "object" && value !== null && "cursor" in value && "progress" in value) {
      const { cursor, progress } = value;
      if (typeof cursor === "string" && cursor.trim().length > 0 && cursor.length <= 4096 && typeof progress === "object" && progress !== null && "batches" in progress && "imported" in progress && "skipped" in progress) {
        const { batches, imported, skipped } = progress;
        if ([batches, imported, skipped].every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0)) {
          return { cursor, progress: { batches: batches as number, imported: imported as number, skipped: skipped as number } };
        }
      }
    }
    sessionStorage.removeItem(key);
  } catch {
    try { sessionStorage.removeItem(key); } catch { /* Storage can be unavailable. */ }
  }
  return null;
}
function saveSyncCheckpoint(key: string, cursor: string | null, progress: SyncProgress) {
  try {
    if (cursor) sessionStorage.setItem(key, JSON.stringify({ cursor, progress }));
    else sessionStorage.removeItem(key);
  } catch { /* Do not interrupt a successful import when browser storage is unavailable. */ }
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store", headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof body?.error === "string" ? body.error : "No fue posible completar la solicitud. Intenta nuevamente.", response.status, safeRetrySeconds(body?.retryAfterSeconds) ?? headerRetrySeconds(response.headers.get("Retry-After")));
  return body as T;
}
async function requestSyncBatch(cursor: string | null, shouldStop: () => boolean, waiting: (seconds: number) => void): Promise<SyncBatch | null> {
  for (let retries = 0; ; retries++) {
    if (shouldStop()) return null;
    try {
      return await api<SyncBatch>("/api/atencion/sync", { method: "POST", body: JSON.stringify({ cursor }) });
    } catch (error) {
      if (shouldStop()) return null;
      if (!(error instanceof ApiError) || ![429, 502, 503, 504].includes(error.status)) throw error;
      if (error.retryAfterSeconds && error.retryAfterSeconds > 120) throw new ApiError(`Dapta solicita esperar al menos ${error.retryAfterSeconds} segundos antes de reanudar. El avance guardado se conserva.`, error.status, error.retryAfterSeconds);
      if (retries >= 3) throw error;
      const delay = error.retryAfterSeconds ?? [10, 20, 30][retries];
      for (let remaining = delay; remaining > 0; remaining--) {
        if (shouldStop()) { waiting(0); return null; }
        waiting(remaining);
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
      waiting(0);
    }
  }
}
function Status({ conversation }: { conversation: AttentionConversation }) {
  return <StatusPill tone={conversation.status === "pending" ? "warning" : conversation.status === "open" ? "positive" : "neutral"}>{statusNames[conversation.status]}</StatusPill>;
}
function Metric({ label, value, detail, icon: Icon, warning = false }: { label: string; value: number | string; detail: string; icon: LucideIcon; warning?: boolean }) {
  return <Card className={styles.metric}><span className={`${styles.metricIcon} ${warning ? styles.warningIcon : ""}`}><Icon aria-hidden="true" size={24} strokeWidth={1.8} /></span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></Card>;
}
function MessageContent({ text, dapta }: { text: string; dapta: boolean }) {
  const attachment = dapta ? /^\[(Imagen|Audio|Video|Documento|Sticker) de WhatsApp(?: · [^\]]*)?\]$/.exec(text) : null;
  if (!attachment) return <p>{text}</p>;
  const kind = attachment[1];
  const Icon = kind === "Audio" ? Mic : kind === "Video" ? Video : kind === "Imagen" || kind === "Sticker" ? ImageIcon : FileText;
  return <div className={styles.mediaCard}><span className={styles.mediaIcon}><Icon aria-hidden="true" size={25} /></span><div><strong>{kind} de WhatsApp</strong><p>Consulta el archivo en la bandeja de Dapta.</p><a href={DAPTA_INBOX_URL} target="_blank" rel="noopener noreferrer">Ver en Dapta <ExternalLink aria-hidden="true" size={14} /></a></div></div>;
}
function DaptaConversationActions({ conversation }: { conversation: AttentionConversation }) {
  const [copyResult, setCopyResult] = useState("");
  const [copying, setCopying] = useState(false);
  const identity = conversation.phone || conversation.externalId;
  async function copyContact() {
    if (!identity || copying) return;
    setCopying(true); setCopyResult("");
    try {
      await navigator.clipboard.writeText(identity);
      setCopyResult(conversation.phone ? "Teléfono copiado. Puedes buscarlo en Dapta." : "ID de conversación copiado.");
    } catch { setCopyResult(`No fue posible copiar. Selecciona este dato para copiarlo manualmente: ${identity}`); }
    finally { setCopying(false); }
  }
  return <footer className={styles.daptaFooter}><p>Respuestas y archivos disponibles en la bandeja de Dapta.</p>{!conversation.phone && identity && <small>ID de conversación: <span>{identity}</span></small>}<div><Button variant="secondary" onClick={() => void copyContact()} disabled={!identity || copying} title={identity || undefined}><Copy aria-hidden="true" size={16} />{copying ? "Copiando…" : conversation.phone ? "Copiar teléfono" : "Copiar ID"}</Button><a className="fp-ui-button is-primary" href={DAPTA_INBOX_URL} target="_blank" rel="noopener noreferrer">Responder en Dapta <ExternalLink aria-hidden="true" size={16} /></a></div>{copyResult && <small role="status">{copyResult}</small>}</footer>;
}

export default function AttentionConsole({ actor }: { actor: AttentionActor }) {
  const [view, setView] = useState<View>("dashboard");
  const [mobileMenu, setMobileMenu] = useState(false);
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
  const [showLatest, setShowLatest] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const [syncRestored, setSyncRestored] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncWaitSeconds, setSyncWaitSeconds] = useState(0);
  const [stoppingSync, setStoppingSync] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({ batches: 0, imported: 0, skipped: 0 });
  const [syncRevision, setSyncRevision] = useState(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const syncingRef = useRef(false);
  const stopSync = useRef(false);
  const mounted = useRef(true);
  const newRequestKey = useRef<string | null>(null);
  const mutationKey = useRef<{ payload: string; id: string } | null>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
  const customerHeading = useRef<HTMLHeadingElement>(null);
  const messageLog = useRef<HTMLDivElement>(null);
  const displayedHistory = useRef<string | null>(null);
  const followLatest = useRef(true);
  const currentActor = inbox?.actor ?? actor;
  const syncStorageKey = `finser:attention:sync:${actor.key}`;
  const canSupervise = currentActor.central;
  const contentReady = Boolean(inbox?.schemaReady);
  const dashboard = inbox?.dashboard;
  const analysts = inbox?.team.filter(person => person.key.startsWith("analyst:")) ?? [];
  const team = dashboard?.team.filter(person => person.key.startsWith("analyst:")) ?? [];
  const activeConversations = dashboard?.activeConversations ?? [];
  const role = currentActor.central ? "Administración de atención" : "Analista de atención";

  const loadInbox = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRequest.current; setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ search, filter, page: String(page) });
      const result = await api<AttentionInbox>(`/api/atencion?${query}`, { signal });
      if (request === listRequest.current) setInbox(result);
    } catch (err) { if (!signal?.aborted && request === listRequest.current) setError(errorMessage(err)); }
    finally { if (!signal?.aborted && request === listRequest.current) setLoading(false); }
  }, [filter, page, search]);
  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const request = ++detailRequest.current; setDetailLoading(true); setDetailError("");
    try {
      const result = await api<AttentionDetail>(`/api/atencion/${encodeURIComponent(id)}`, { signal });
      if (request === detailRequest.current && selectionRef.current === id) setDetail(result);
    } catch (err) {
      if (!signal?.aborted && request === detailRequest.current && selectionRef.current === id) { setDetail(null); setDetailError(errorMessage(err)); }
    } finally { if (!signal?.aborted && request === detailRequest.current) setDetailLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); const timeout = setTimeout(() => { void loadInbox(controller.signal); }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [loadInbox, syncRevision]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopSync.current = true; };
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => {
      const checkpoint = readSyncCheckpoint(syncStorageKey);
      setSyncCursor(checkpoint?.cursor ?? null);
      setSyncProgress(checkpoint?.progress ?? { batches: 0, imported: 0, skipped: 0 });
      setSyncRestored(true);
    }, 0);
    return () => { clearTimeout(timeout); };
  }, [syncStorageKey]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); const timeout = setTimeout(() => { void loadDetail(selected, controller.signal); }, 0);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [selected, loadDetail]);
  useEffect(() => { if (selected) (showCustomer ? customerHeading : chatHeading).current?.focus({ preventScroll: true }); }, [selected, showCustomer, view]);
  const historyId = detail?.conversation.id;
  const historyLength = detail?.messages.length;
  const historyTail = detail?.messages[detail.messages.length - 1]?.id;
  useEffect(() => {
    if (!historyId || view !== "conversations") return;
    const frame = requestAnimationFrame(() => {
      const log = messageLog.current;
      if (!log || !log.clientHeight) return;
      if (displayedHistory.current !== historyId || followLatest.current) log.scrollTop = log.scrollHeight;
      displayedHistory.current = historyId;
      const away = log.scrollHeight - log.scrollTop - log.clientHeight > 100;
      followLatest.current = !away; setShowLatest(away);
    });
    return () => cancelAnimationFrame(frame);
  }, [historyId, historyLength, historyTail, showCustomer, view]);
  function goToLatest() {
    const log = messageLog.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    followLatest.current = true; setShowLatest(false);
  }
  function navigate(next: View) { setView(next); setMobileMenu(false); setShowNew(false); }
  function selectConversation(id: string | null) {
    selectionRef.current = id; ++detailRequest.current; setSelected(id); setDetail(null); setDetailError("");
    setDetailLoading(Boolean(id)); setShowCustomer(false); setShowLatest(false); displayedHistory.current = null; followLatest.current = true; mutationKey.current = null;
    if (id) { setView("conversations"); setMobileMenu(false); }
  }
  async function mutate(input: Omit<AttentionMutation, "version" | "requestId">) {
    if (!detail || busyRef.current) return false;
    const id = detail.conversation.id; const payload = JSON.stringify({ ...input, version: detail.conversation.version });
    if (mutationKey.current?.payload !== payload) mutationKey.current = { payload, id: crypto.randomUUID() };
    busyRef.current = true; setBusy(true); setDetailError(""); setNotice("");
    try {
      await api(`/api/atencion/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...input, version: detail.conversation.version, requestId: mutationKey.current.id }) });
      mutationKey.current = null;
      setNotice(input.action === "human_request" ? "Solicitud interna guardada. Falta confirmar el traspaso en Dapta." : input.action === "transfer" ? "Conversación asignada al analista." : "Gestión guardada en FINSER PAY.");
      await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]); return true;
    } catch (err) { setDetailError(errorMessage(err)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current) return;
    const data = new FormData(event.currentTarget); busyRef.current = true; setBusy(true); setError(""); setNotice(""); newRequestKey.current ||= crypto.randomUUID();
    try {
      const result = await api<{ id: string }>("/api/atencion", { method: "POST", body: JSON.stringify({ phone: data.get("phone"), name: data.get("name"), requestId: newRequestKey.current }) });
      newRequestKey.current = null; setShowNew(false); selectConversation(result.id); setNotice("Gestión interna registrada. No se envió ningún mensaje."); await loadInbox();
    } catch (err) { setError(errorMessage(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function sync() {
    if (syncingRef.current || !syncRestored || !currentActor.central) return;
    syncingRef.current = true; stopSync.current = false;
    setSyncing(true); setStoppingSync(false); setSyncWaitSeconds(0); setSyncError(""); setNotice("");
    let cursor = syncCursor;
    let progress = cursor ? { ...syncProgress } : { batches: 0, imported: 0, skipped: 0 };
    let completed = false;
    let advanced = false;
    setSyncProgress(progress);
    try {
      do {
        const result = await requestSyncBatch(cursor, () => stopSync.current || !mounted.current, seconds => { if (mounted.current) setSyncWaitSeconds(seconds); });
        if (!result) break;
        const previousCursor = cursor;
        cursor = result.nextCursor;
        progress = { batches: progress.batches + 1, imported: progress.imported + (result.processed ?? result.imported), skipped: progress.skipped + result.skipped };
        completed = cursor === null; advanced = true;
        saveSyncCheckpoint(syncStorageKey, cursor, progress);
        if (!mounted.current) break;
        setSyncCursor(cursor); setSyncProgress(progress); setSyncRevision(value => value + 1);
        if (cursor && cursor === previousCursor) throw new Error("El canal no avanzó al siguiente lote. Puedes reanudar la consulta.");
      } while (cursor && !stopSync.current && mounted.current);
      if (mounted.current) {
        setNotice(completed ? `WhatsApp actualizado: ${progress.imported} conversaciones procesadas en ${progress.batches} ${progress.batches === 1 ? "lote" : "lotes"}.` : "Sincronización detenida. Puedes reanudar desde el último lote guardado.");
        if (advanced && selectionRef.current) await loadDetail(selectionRef.current);
      }
    } catch (err) { if (mounted.current) setSyncError(errorMessage(err)); }
    finally { syncingRef.current = false; if (mounted.current) { setSyncing(false); setStoppingSync(false); setSyncWaitSeconds(0); } }
  }
  const viewTitles = { dashboard: "Dashboard de atención", conversations: "Conversaciones", team: "Equipo de analistas", settings: "Configuración de atención" };
  const viewDescriptions = { dashboard: "Resumen del equipo", conversations: "Todos tus clientes, una sola bandeja", team: "Asignación y seguimiento del equipo de atención", settings: "Canal de WhatsApp y respuestas aprobadas" };
  function navButton(target: View, label: string, Icon: LucideIcon, count?: number) {
    return <button type="button" className={view === target ? styles.activeNav : undefined} aria-current={view === target ? "page" : undefined} onClick={() => navigate(target)}><Icon aria-hidden="true" size={21} strokeWidth={1.8} /><span>{label}</span>{typeof count === "number" && count > 0 && <small>{count}</small>}</button>;
  }
  return <div className={styles.shell}>
    <aside className={`${styles.sidebar} ${mobileMenu ? styles.sidebarOpen : ""}`}>
      <Link className={styles.brand} href="/dashboard" aria-label="FINSER PAY, plataforma"><FinserBrand accentFinser wordmarkOnly showTagline={false} /></Link>
      <nav aria-label="Navegación de atención" className={styles.sideNav}>
        {navButton("dashboard", "Dashboard", House)}
        {navButton("conversations", "Conversaciones", MessageCircle, inbox?.metrics.pending)}
        {currentActor.central && <Link href="/dashboard/clientes"><Users aria-hidden="true" size={21} strokeWidth={1.8} /><span>Clientes</span></Link>}
        <Link href={currentActor.central ? "/dashboard/solicitudes" : "/dashboard/aprobaciones/solicitudes"}><FileText aria-hidden="true" size={21} strokeWidth={1.8} /><span>Estudios de crédito</span></Link>
        {currentActor.central && <Link href="/dashboard/reportes"><BarChart3 aria-hidden="true" size={21} strokeWidth={1.8} /><span>Reportes</span></Link>}
        {navButton("team", "Equipo", Users)}
        {navButton("settings", "Configuración", Settings)}
      </nav>
      <div className={styles.sidebarBottom}><div className={styles.supportCard}><strong>¡Estamos<br />para ayudarte!</strong><p>Brinda la mejor<br />experiencia a<br />nuestros clientes.</p><Image src="/assets/clientes/mascot-welcome.webp" alt="" width={128} height={190} /></div><Link href={currentActor.central ? "/dashboard" : "/dashboard/aprobaciones"} className={styles.returnLink}><ArrowLeft aria-hidden="true" size={15} /> Volver a la plataforma</Link></div>
    </aside>
    <div className={styles.content}>
      <header className={styles.topbar}>
        <Button variant="ghost" className={styles.menuButton} onClick={() => setMobileMenu(value => !value)} aria-label={mobileMenu ? "Cerrar navegación" : "Abrir navegación"} aria-expanded={mobileMenu}><Menu aria-hidden="true" size={22} /></Button>
        <form className={styles.globalSearch} onSubmit={event => { event.preventDefault(); navigate("conversations"); }}><Search aria-hidden="true" size={21} /><label className={styles.srOnly} htmlFor="attention-global-search">Buscar clientes, conversaciones o teléfonos</label><Input id="attention-global-search" value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setPage(1); if (event.target.value) setView("conversations"); }} placeholder="Buscar clientes, conversaciones o teléfonos…" /></form>
        <button className={styles.notifications} type="button" aria-label="Ver conversaciones pendientes" onClick={() => { setFilter("pending"); setPage(1); navigate("conversations"); }}><Bell aria-hidden="true" size={23} />{Boolean(inbox?.metrics.pending) && <i />}</button>
        <details className={styles.profile}><summary><span className={styles.profileAvatar}>{initials(currentActor.name)}</span><span><strong>{currentActor.name}</strong><small>{role}</small></span><ChevronDown aria-hidden="true" size={16} /></summary><div className={styles.profileMenu}><p>{currentActor.name}<small>{role}</small></p><LogoutButton showIcon className={styles.logout} /></div></details>
      </header>
      <main className={styles.main}>
        <div className={`${styles.pageHeading} ${view === "dashboard" ? styles.dashboardHeading : ""}`}>
          <div><h1>{viewTitles[view]}</h1><p>{viewDescriptions[view]}</p></div>
          {view === "dashboard" ? <div className={styles.greeting}><div><h2><span>¡Hola,</span> {currentActor.name.trim().split(/\s+/)[0]}!</h2><p>Juntos hacemos que más<br />personas avancen.</p></div><Image src="/assets/clientes/mascot-welcome.webp" alt="Mascota FINSER PAY" width={154} height={228} /></div> : <div className={styles.headingActions}><Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || busy}><RefreshCw aria-hidden="true" size={16} /> Actualizar</Button>{view === "conversations" && currentActor.central && <Button onClick={() => { setShowNew(value => !value); newRequestKey.current = null; }} disabled={!contentReady || busy}><Plus aria-hidden="true" size={17} /> Nueva gestión</Button>}</div>}
        </div>
        {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || busy}>Reintentar</Button></div>}
        {notice && <div className={styles.notice} role="status"><Check aria-hidden="true" size={18} /><span>{notice}</span><Button variant="ghost" aria-label="Ocultar confirmación" onClick={() => setNotice("")}><X size={16} aria-hidden="true" /></Button></div>}
        {(syncing || syncCursor || syncError) && <div className={styles.syncProgress}><div role="status" aria-live="polite"><strong>{syncing ? stoppingSync ? syncWaitSeconds ? "Deteniendo sincronización…" : "Terminando el lote actual…" : syncWaitSeconds ? `Esperando a Dapta… ${syncWaitSeconds} s` : "Actualizando conversaciones de WhatsApp…" : syncError ? "La sincronización necesita reanudarse" : "Sincronización detenida"}</strong><span>{syncProgress.imported} conversaciones procesadas · {syncProgress.batches} {syncProgress.batches === 1 ? "lote" : "lotes"}{syncProgress.skipped > 0 ? ` · ${syncProgress.skipped} registros omitidos` : ""}</span><small>{syncError || "Puedes seguir consultando la bandeja mientras se actualiza el historial."}</small></div>{syncing ? <Button variant="secondary" disabled={stoppingSync} onClick={() => { stopSync.current = true; setStoppingSync(true); }}>{syncWaitSeconds ? "Detener sincronización" : "Detener después de este lote"}</Button> : <Button variant="secondary" onClick={() => void sync()}>Reanudar sincronización</Button>}</div>}
        {inbox && !inbox.schemaReady && <div className={styles.setupNotice}><ShieldCheck aria-hidden="true" size={18} /><p>La preparación del módulo está pendiente. Las conversaciones se mostrarán cuando finalice la configuración.</p></div>}

        {view === "dashboard" && <>
          <div className={styles.metrics} aria-label="Resumen de atención">
            <Metric label="Conversaciones activas" value={inbox?.metrics.open ?? "—"} detail="En atención por el equipo" icon={MessageCircle} />
            <Metric label="Pendientes de atención" value={inbox?.metrics.pending ?? "—"} detail="Requieren seguimiento" icon={Clock3} warning />
            <Metric label="Mis conversaciones" value={inbox?.metrics.mine ?? "—"} detail="Asignadas a tu perfil" icon={UserRound} />
            <Metric label="Gestiones finalizadas" value={inbox?.metrics.closed ?? "—"} detail="Conversaciones cerradas" icon={CheckCheck} />
          </div>
          <div className={styles.dashboardGrid}>
            <Card className={styles.chartCard}><div className={styles.cardHeading}><h2>Conversaciones por día</h2><span className={styles.period}>Últimos 7 días <ChevronDown aria-hidden="true" size={15} /></span></div><ConversationChart days={dashboard?.daily ?? []} loading={loading && !inbox} /><p className={styles.chartCaption}>Conversaciones con mensajes recibidos · hora de Colombia</p></Card>
            <Card className={styles.teamCard}><div className={styles.cardHeading}><h2>Atención del equipo</h2><button className={styles.linkButton} onClick={() => navigate("team")}>Ver equipo <ArrowRight aria-hidden="true" size={15} /></button></div><TeamRows team={team.slice(0, 4)} loading={loading && !inbox} compact /><p className={styles.teamCaption}>Carga de conversaciones abiertas por analista</p></Card>
            <Card className={styles.activityCard}><div className={styles.cardHeading}><h2>Actividad reciente</h2><button className={styles.linkButton} onClick={() => navigate("conversations")}>Ver conversaciones <ArrowRight aria-hidden="true" size={15} /></button></div>{dashboard?.activity.length ? <div className={styles.activityList}>{dashboard.activity.slice(0, 4).map(activity => <div key={activity.id}><span className={styles.activityIcon}><ClipboardList aria-hidden="true" size={18} /></span><div><strong>{activity.title}</strong><p>{activity.description}</p></div><time dateTime={activity.at}>{time(activity.at)}</time>{activity.conversationId && <button type="button" aria-label={`Abrir conversación: ${activity.title}`} className={styles.rowOpen} onClick={() => selectConversation(activity.conversationId)} />}</div>)}</div> : <DashboardEmpty icon={ClipboardList} title="Todo el seguimiento, en un lugar" text={loading ? "Consultando actividad…" : "Las asignaciones, notas y gestiones del equipo aparecerán aquí."} />}</Card>
            <Card className={styles.currentCard}><div className={styles.cardHeading}><h2>Conversaciones en curso</h2><button className={styles.linkButton} onClick={() => navigate("conversations")}>Ver todas <ArrowRight aria-hidden="true" size={15} /></button></div>{activeConversations.length ? <div className={styles.activeList}>{activeConversations.slice(0, 4).map(conversation => <button type="button" key={conversation.id} onClick={() => selectConversation(conversation.id)}><span className={styles.avatar}>{initials(conversation.name)}</span><span><strong>{conversation.name || "Contacto de WhatsApp"}</strong><small>{conversation.preview || conversation.phone || "Contacto de WhatsApp"}</small></span><time dateTime={conversation.lastContactAt || undefined}>{time(conversation.lastContactAt)}</time><span className={`${styles.statusDot} ${conversation.status === "pending" ? styles.pendingDot : ""}`} aria-label={statusNames[conversation.status]} /></button>)}</div> : <DashboardEmpty icon={MessageCircle} title={loading ? "Consultando conversaciones…" : "Tu bandeja de WhatsApp"} text={currentActor.central ? "Actualiza el canal para consultar las conversaciones reales de Meta." : "Aquí aparecerán los chats que te asigne administración."} action={<Button variant="secondary" onClick={() => navigate("conversations")}>Abrir bandeja <ArrowRight aria-hidden="true" size={15} /></Button>} />}</Card>
          </div>
          <div className={styles.dashboardFooter}><span><span className={`${styles.channelDot} ${inbox?.integration.configured ? styles.connectedDot : ""}`} /> WhatsApp {inbox?.integration.configured ? "· canal disponible" : "· configuración pendiente"}</span><button className={styles.linkButton} disabled={loading} onClick={() => void loadInbox()}><RefreshCw aria-hidden="true" size={14} /> Actualizar resumen</button></div>
        </>}

        {view === "conversations" && <>
          <div className={styles.crmToolbar}><div><span className={styles.whatsappIcon}><MessageCircle aria-hidden="true" size={18} /></span><strong>WhatsApp</strong><span>Conversaciones de Meta y seguimiento interno</span></div>{currentActor.central && <Button variant="secondary" disabled={!syncRestored || syncing || !contentReady || !inbox?.integration.canSync} onClick={() => void sync()}><RefreshCw aria-hidden="true" size={16} />{syncing ? "Actualizando…" : syncCursor ? "Continuar importación" : "Actualizar WhatsApp"}</Button>}</div>
          {showNew && <Card className={styles.formCard}><div className={styles.cardHeading}><div><h2>Nueva gestión interna</h2><p>No envía mensajes ni crea otro registro de cliente.</p></div><Button variant="ghost" aria-label="Cerrar nueva gestión" disabled={busy} onClick={() => setShowNew(false)}><X aria-hidden="true" size={18} /></Button></div><form className={styles.newForm} onSubmit={createCase} onChange={() => { if (!busy) newRequestKey.current = null; }}><label>Nombre del contacto<Input name="name" required maxLength={120} autoComplete="off" disabled={busy} /></label><label>Teléfono<Input name="phone" type="tel" required maxLength={24} placeholder="Con indicativo de país" autoComplete="off" disabled={busy} /></label><Button type="submit" disabled={busy}>{busy ? "Guardando…" : "Registrar gestión"}</Button></form></Card>}
          <section className={`${styles.workspace} ${selected ? styles.hasSelection : ""} ${showCustomer ? styles.showCustomer : ""}`} aria-label="Bandeja de atención">
            <aside className={styles.inbox} aria-label="Conversaciones"><div className={styles.inboxHeading}><h2>Bandeja de entrada</h2><Badge>{inbox?.total ?? "—"}</Badge></div><label className={styles.search}><Search aria-hidden="true" size={18} /><span className={styles.srOnly}>Buscar conversación</span><Input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Buscar conversación…" maxLength={100} /></label><div className={styles.filters} role="group" aria-label="Filtrar conversaciones">{filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}</div><div className={styles.conversationList} aria-busy={loading}>{loading && !inbox ? <LoadingState label="Cargando conversaciones…" /> : error ? <EmptyState title="No se pudo abrir la bandeja" description="Vuelve a intentar la consulta." /> : !inbox?.conversations.length ? <DashboardEmpty icon={Inbox} title={search ? "Sin coincidencias" : "No hay conversaciones en este filtro"} text={search ? "Prueba con otro nombre o teléfono." : currentActor.central ? "Actualiza WhatsApp para consultar los chats del canal conectado." : "Las conversaciones asignadas a tu perfil aparecerán aquí."} /> : inbox.conversations.map(conversation => <button type="button" key={conversation.id} className={`${styles.conversation} ${selected === conversation.id ? styles.selected : ""}`} aria-pressed={selected === conversation.id} onClick={() => selectConversation(conversation.id)}><span className={styles.avatar}>{initials(conversation.name)}</span><span className={styles.conversationBody}><span className={styles.conversationTitle}><strong>{conversation.name || conversation.phone || "Contacto de WhatsApp"}</strong><time dateTime={conversation.lastContactAt || undefined}>{time(conversation.lastContactAt)}</time></span><span className={styles.phone}>{conversation.phone || "Teléfono no disponible"} · {conversation.channel === "whatsapp" ? "WhatsApp" : "Interna"}</span><span className={styles.preview}>{conversation.preview || "Sin mensajes sincronizados"}</span><span className={styles.conversationFooter}><Status conversation={conversation} /><small>{conversation.assigneeName || "Sin analista"}</small></span></span></button>)}</div><div className={styles.pagination}><Button variant="ghost" aria-label="Página anterior" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden="true" size={18} /></Button><span>{page} / {Math.max(1, Math.ceil((inbox?.total ?? 0) / (inbox?.pageSize || 40)))}</span><Button variant="ghost" aria-label="Página siguiente" disabled={loading || !inbox || page * inbox.pageSize >= inbox.total} onClick={() => setPage(value => value + 1)}><ChevronRight aria-hidden="true" size={18} /></Button></div></aside>
            <section className={styles.chat} aria-label="Historial de la conversación">{!selected ? <div className={styles.selectPrompt}><span><MessageCircle aria-hidden="true" size={37} /></span><h2>Una conversación.<br />Todo su contexto.</h2><p>Elige un chat para ver los mensajes de WhatsApp, su ficha y las gestiones del equipo.</p><div><LockKeyhole aria-hidden="true" size={15} /> Acceso exclusivo de administración y analistas</div></div> : <>
              <div className={styles.chatHeader}><Button variant="ghost" className={styles.backButton} aria-label="Volver a conversaciones" onClick={() => selectConversation(null)}><ArrowLeft aria-hidden="true" size={18} /></Button><span className={styles.avatar}>{initials(detail?.conversation.name || "Contacto")}</span><div className={styles.chatIdentity}><h2 ref={chatHeading} tabIndex={-1}>{detail?.conversation.name || "Conversación"}</h2><span>{detail ? detail.conversation.phone || "Teléfono no disponible" : "Consultando historial…"}{detail && ` · ${detail.conversation.channel === "whatsapp" ? "WhatsApp" : "Gestión interna"}`}</span></div><Button variant="secondary" className={styles.customerToggle} aria-expanded={showCustomer} onClick={() => setShowCustomer(value => !value)}><UserRound aria-hidden="true" size={16} /> Ficha</Button></div>
              {detailError && <div className={styles.error} role="alert"><span>{detailError}</span><Button variant="secondary" disabled={busy || detailLoading} onClick={() => void loadDetail(selected)}>Actualizar</Button></div>}
              {detailLoading && !detail ? <LoadingState label="Consultando historial y ficha…" /> : detail && <><div className={styles.chatActions}><Status conversation={detail.conversation} /><span className={styles.assignee}><UserRound aria-hidden="true" size={14} />{detail.conversation.assigneeName || "Sin analista asignado"}</span>{detail.permissions.claim && detail.conversation.status !== "open" && <Button disabled={busy} onClick={() => void mutate({ action: "claim" })}>Atender</Button>}{detail.permissions.manage && <Button variant="secondary" disabled={busy} onClick={() => void mutate({ action: detail.conversation.status === "closed" ? "reopen" : "close" })}>{detail.conversation.status === "closed" ? "Reabrir" : "Finalizar"}</Button>}</div>
                {detail.permissions.assign && <div className={styles.assignment}><label className={styles.srOnly} htmlFor="attention-transfer">Asignar analista</label><Select id="attention-transfer" value="" disabled={busy || !analysts.length} onChange={event => { if (event.target.value) void mutate({ action: "transfer", assigneeKey: event.target.value }); }}><option value="">{detail.conversation.assigneeKey ? "Cambiar analista…" : "Asignar analista…"}</option>{analysts.filter(person => person.key !== detail.conversation.assigneeKey).map(person => <option key={person.key} value={person.key}>{person.name}</option>)}</Select><span>Solo analistas activos</span></div>}
                <div className={styles.historyViewport}><div ref={messageLog} className={styles.messages} role="log" aria-label="Mensajes sincronizados" onScroll={() => { const log = messageLog.current; if (log) { const away = log.scrollHeight - log.scrollTop - log.clientHeight > 100; followLatest.current = !away; setShowLatest(away); } }}>{detail.historyTruncated && <p className={styles.historyNotice}>Se muestra una parte del historial disponible. La siguiente sincronización incorpora más mensajes.</p>}{detail.messages.length ? detail.messages.map(message => <article key={message.id} className={`${styles.message} ${message.direction === "outbound" ? styles.outbound : ""}`}><span>{message.direction === "inbound" ? "Contacto" : message.author || "Dapta"}</span><MessageContent text={message.text} dapta={detail.conversation.channel === "whatsapp" && Boolean(detail.conversation.externalId)} /><time dateTime={message.sentAt}>{date(message.sentAt)}</time></article>) : <DashboardEmpty icon={MessageCircle} title={detail.conversation.channel === "internal" ? "Gestión interna" : "Historial pendiente de sincronización"} text={detail.conversation.channel === "internal" ? "Registra el seguimiento en notas y tareas de la ficha." : "Los mensajes aparecerán al actualizar el canal de WhatsApp."} />}</div>
                {showLatest && <Button variant="secondary" className={styles.latestButton} onClick={goToLatest}><ArrowDown aria-hidden="true" size={17} /> Último mensaje</Button>}</div>{detail.conversation.channel === "whatsapp" && detail.conversation.externalId ? <DaptaConversationActions key={detail.conversation.id} conversation={detail.conversation} /> : <footer className={styles.historyFooter}><MessageCircle aria-hidden="true" size={16} /><span>Gestión interna · asignación y seguimiento por analistas.</span></footer>}
              </>}
            </>}</section>
            <aside className={styles.customer} aria-label="Ficha y seguimiento del cliente"><div className={styles.customerHeader}><Button className={styles.backButton} variant="ghost" aria-label="Volver al chat" onClick={() => setShowCustomer(false)}><ArrowLeft aria-hidden="true" size={18} /></Button><h2 ref={customerHeading} tabIndex={-1}>Ficha del cliente</h2><ShieldCheck aria-hidden="true" size={18} /></div>{detail ? <CustomerPanel key={detail.conversation.id} detail={detail} busy={busy} mutate={mutate} canOpenRecord={canSupervise} /> : <DashboardEmpty icon={UserRound} title="El cliente, en contexto" text="Datos, estudios, notas y tareas vinculados a la conversación seleccionada." />}</aside>
          </section>
        </>}

        {view === "team" && <Card className={styles.fullTeam}><div className={styles.cardHeading}><div><h2>Analistas de atención</h2><p>Las conversaciones solo se asignan a perfiles de analista activos.</p></div><Badge>{analysts.length} analistas</Badge></div><TeamRows team={team} loading={loading && !inbox} /><div className={styles.teamNote}><ShieldCheck aria-hidden="true" size={17} /><p>Administración asigna los chats. Cada analista consulta y gestiona únicamente las conversaciones de su bandeja.</p></div></Card>}
        {view === "settings" && <div className={styles.settingsGrid}>
          <Card className={styles.settingsCard}><div className={styles.cardHeading}><h2><MessageCircle aria-hidden="true" size={20} /> Canal de WhatsApp</h2><Badge tone={inbox?.integration.configured ? "positive" : "warning"}>{inbox?.integration.configured ? "Disponible" : "Pendiente"}</Badge></div><p>{inbox?.integration.message || "Consultando estado del canal…"}</p><div className={styles.integrationFacts}><div><Check aria-hidden="true" size={17} /><span>Historial y conversaciones reales desde Dapta</span></div><div><Users aria-hidden="true" size={17} /><span>Asignación exclusiva a analistas FINSER PAY</span></div><div><LockKeyhole aria-hidden="true" size={17} /><span>Historial de WhatsApp de solo lectura</span></div></div>{currentActor.central && <Button disabled={!syncRestored || syncing || !contentReady || !inbox?.integration.canSync} onClick={() => void sync()}><RefreshCw aria-hidden="true" size={16} />{syncing ? "Actualizando…" : syncCursor ? "Continuar importación" : "Actualizar conversaciones"}</Button>}<p className={styles.settingFootnote}>La consulta no cambia el número, el proveedor ni la configuración de WhatsApp.</p></Card>
          <Card className={styles.repliesPanel}><div className={styles.cardHeading}><h2>Respuestas rápidas</h2>{currentActor.central && <Button variant="ghost" disabled={!contentReady || busy} onClick={() => setShowReplies(value => !value)}>{showReplies ? "Cerrar" : "Aprobar respuesta"}</Button>}</div><p className={styles.muted}>Contenido aprobado por administración de FINSER PAY.</p>{inbox?.quickReplies.length ? <ul className={styles.replyList}>{inbox.quickReplies.map(reply => <li key={reply.id}><strong>{reply.title}</strong><p>{reply.text}</p><small>Aprobada por {reply.approvedBy} · {date(reply.approvedAt, true)}</small></li>)}</ul> : <DashboardEmpty icon={FileText} title="Una voz para todo el equipo" text="El equipo puede consultar aquí las respuestas aprobadas por administración." />}{showReplies && currentActor.central && <QuickReplyForm disabled={busy} saved={() => { setShowReplies(false); setNotice("Respuesta aprobada y guardada."); void loadInbox(); }} />}</Card>
        </div>}
      </main>
    </div>
  </div>;
}

function DashboardEmpty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return <div className={styles.dashboardEmpty}><Icon aria-hidden="true" size={27} strokeWidth={1.6} /><strong>{title}</strong><p>{text}</p>{action}</div>;
}
function ConversationChart({ days, loading }: { days: { date: string; label: string; count: number }[]; loading: boolean }) {
  const max = Math.max(4, ...days.map(day => day.count));
  const top = Math.ceil(max / 4) * 4;
  return <div className={styles.chart} role="img" aria-label={days.length ? `Conversaciones recibidas: ${days.map(day => `${day.label}: ${day.count}`).join(", ")}` : "Sin conversaciones recibidas para graficar"}><div className={styles.chartY}>{[top, top * .75, top * .5, top * .25, 0].map(value => <span key={value}>{value}</span>)}</div><div className={styles.chartPlot}><div className={styles.chartGrid}>{[0, 1, 2, 3, 4].map(value => <i key={value} />)}</div><div className={styles.chartBars}>{days.map(day => <div key={day.date}><span className={styles.bar} style={{ height: `${day.count / top * 100}%` }} title={`${day.label}: ${day.count} conversaciones`} /><small>{day.label}</small></div>)}</div>{(!days.length || days.every(day => day.count === 0)) && <div className={styles.chartEmpty}>{loading ? "Cargando actividad…" : "Sin conversaciones recibidas en este período"}</div>}</div></div>;
}
function TeamRows({ team, loading, compact = false }: { team: { key: string; name: string; assigned: number; pending: number }[]; loading: boolean; compact?: boolean }) {
  const max = Math.max(1, ...team.map(person => person.assigned));
  return team.length ? <div className={`${styles.teamRows} ${compact ? styles.teamCompact : ""}`}>{team.map(person => <div key={person.key}><span className={styles.avatar}>{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.pending ? `${person.pending} pendientes` : "Sin pendientes"}</small></div><span className={styles.teamLoad}>{person.assigned}<small>activas</small></span><ProgressBar value={person.assigned / max * 100} label={`${person.name}: ${person.assigned} conversaciones abiertas`} /></div>)}</div> : <DashboardEmpty icon={Users} title={loading ? "Consultando equipo…" : "Equipo de analistas"} text="Aquí se muestra la carga de conversaciones de los analistas activos." />;
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
    <section className={styles.customerSection}><div className={styles.customerIdentity}><span className={styles.avatar}>{initials(customer.name || conversation.name)}</span><div><h3>{customer.name || conversation.name}</h3><span>{customer.documentMasked || conversation.phone || "Teléfono no disponible"}</span></div></div><p className={styles.matchMessage}>{matchMessages[customer.match]}</p>{customer.match === "none" && canOpenRecord && <Link href="/dashboard/creditos" className={styles.textLink}>Completar en el flujo de solicitudes <ArrowRight aria-hidden="true" size={14} /></Link>}
      {permissions.assign && customer.candidates.length > 0 && customer.match !== "linked" && <div className={styles.compactForm}><label>Ficha autorizada<Select value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)}><option value="">Seleccionar ficha</option>{customer.candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.documentMasked} · {item.folio}</option>)}</Select></label><Button variant="secondary" disabled={busy || !candidate} onClick={() => void mutate({ action: "link", creditId: Number(candidate) })}>Vincular ficha</Button></div>}
      {permissions.assign && conversation.linkedCreditId && <Button variant="ghost" disabled={busy} onClick={() => void mutate({ action: "unlink" })}>Quitar vínculo manual</Button>}
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
