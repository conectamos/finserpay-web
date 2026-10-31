"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, CalendarClock, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, Clock3, Download, ExternalLink, FileText, Image as ImageIcon, Inbox, LockKeyhole, MessageCircle, Mic, MoreVertical, Paperclip, Plus, RefreshCw, Search, Send, ShieldCheck, Tag, UserRound, Users, Video, Wallet, X, type LucideIcon } from "lucide-react";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import AnalystNavigation from "@/app/dashboard/aprobaciones/analyst-navigation";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, EmptyState, Input, LoadingState, ProgressBar, Select, StatusPill } from "@/app/_components/finser-ui";
import type { AttentionActor, AttentionConversation, AttentionCustomer, AttentionDetail, AttentionFilters, AttentionInbox, AttentionMessage, AttentionMutation, AttentionQuickReply } from "@/lib/atencion-types";
import type { AttentionExtensionInput, AttentionExtensionResult, AttentionFinancial, AttentionFinancialCredit, AttentionReceiptSendInput } from "@/lib/atencion-financial-types";
import AttentionComposerTools from "./attention-composer-tools";
import AttentionTemplateComposer from "./attention-template-composer";
import AttentionBoard from "./attention-board";
import AttentionCloseAll from "./attention-close-all";
import AttentionContactSummary from "./attention-contact-summary";
import AttentionWorkQueues from "./attention-work-queues";
import AttentionStickerPicker from "./attention-sticker-picker";
import { AttentionAgendaView, AttentionConversationIndicators, AttentionObservedRead, AttentionQuickReplies, AttentionWorkFilters } from "./attention-operational";
import styles from "./attention.module.css";

type View = "enrollment" | "welcome" | "dashboard" | "conversations" | "board" | "agenda" | "team" | "settings";
const DAPTA_INBOX_URL = "https://app.dapta.ai/agents-studio/inbox";
const statusNames = { pending: "Pendiente", open: "En atención", closed: "Finalizada" } as const;
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
function messageDay(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)) : "";
}
function contactName(conversation: AttentionConversation) { return conversation.customerIdentity?.name || conversation.name || conversation.phone || "Contacto de WhatsApp"; }
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
  const response = await fetch(url, { ...options, cache: "no-store", headers: { ...(typeof options?.body === "string" ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
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
function isReservedTag(value: string) { return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase() === "FINSERPAY"; }
function CustomerBadge({ conversation }: { conversation: AttentionConversation }) {
  return conversation.autoTags?.includes("FINSERPAY") ? <span className={styles.finserBadge} title="Cliente con crédito vigente o pagado; clasificación automática"><ShieldCheck aria-hidden="true" size={14} />FINSERPAY</span> : null;
}
function ConversationLabels({ conversation }: { conversation: AttentionConversation }) {
  const manual = conversation.tags.filter(tag => !isReservedTag(tag));
  if (!conversation.autoTags?.length && !manual.length) return null;
  return <span className={styles.conversationLabels}><CustomerBadge conversation={conversation} />{manual.slice(0, 2).map(tag => <span className={styles.manualTag} key={tag}>{tag}</span>)}{manual.length > 2 && <span className={styles.moreTags}>+{manual.length - 2}</span>}</span>;
}
function privateMediaUrl(value: string | null | undefined) {
  return typeof value === "string" && (/^\/api\/atencion\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/media$/i.test(value) || /^\/api\/atencion\/solicitudes\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/i.test(value)) ? value : null;
}
function MessageContent({ text, dapta, media, mediaReady }: { text: string; dapta: boolean; media?: AttentionMessage["attachment"]; mediaReady?: () => void }) {
  if (media) {
    const url = privateMediaUrl(media.url);
    const name = media.fileName || ({ image: "Imagen", sticker: "Sticker", audio: "Audio", video: "Video", document: "Documento" }[media.kind]);
    return <div className={styles.nativeMedia}>{url ? <>
      {(media.kind === "image" || media.kind === "sticker") && <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${name}`}><Image src={url} unoptimized width={640} height={480} alt={name} onLoad={mediaReady} className={styles.messageImage} /></a>}
      {media.kind === "audio" && <audio controls preload="none" src={url} onLoadedMetadata={mediaReady} aria-label={name}>Tu navegador no puede reproducir este audio.</audio>}
      {media.kind === "video" && <video controls preload="none" playsInline src={url} onLoadedMetadata={mediaReady} aria-label={name}>Tu navegador no puede reproducir este video.</video>}
      <a href={url} target="_blank" rel="noopener noreferrer" className={styles.mediaDownload}><Download aria-hidden="true" size={16} />{media.kind === "document" ? name : "Abrir o descargar archivo"}</a>
    </> : <div className={styles.mediaUnavailable}><FileText aria-hidden="true" size={20} /><span>{name}<small>El archivo todavía no está disponible.</small></span></div>}{text && <p>{text}</p>}</div>;
  }
  const attachment = dapta ? /^\[(Imagen|Audio|Video|Documento|Sticker) de WhatsApp(?: · [^\]]*)?\]$/.exec(text) : null;
  if (!attachment) return <p>{text}</p>;
  const kind = attachment[1];
  const Icon = kind === "Audio" ? Mic : kind === "Video" ? Video : kind === "Imagen" || kind === "Sticker" ? ImageIcon : FileText;
  return <div className={styles.mediaCard}><span className={styles.mediaIcon}><Icon aria-hidden="true" size={25} /></span><div><strong>{kind} de WhatsApp</strong><p>Consulta el archivo en la bandeja de Dapta.</p><a href={DAPTA_INBOX_URL} target="_blank" rel="noopener noreferrer">Ver en Dapta <ExternalLink aria-hidden="true" size={14} /></a></div></div>;
}
const deliveryNames = { pending: "Pendiente", queued: "En cola", sending: "En proceso", accepted: "Aceptado por WhatsApp", sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "No enviado", uncertain: "Envío por confirmar" } as const;
function MessageDelivery({ message }: { message: AttentionMessage }) {
  const status = message.deliveryStatus;
  if (message.direction !== "outbound" || !status) return null;
  const Icon = status === "read" || status === "delivered" ? CheckCheck : status === "sent" || status === "accepted" ? Check : status === "failed" || status === "uncertain" ? CircleAlert : Clock3;
  return <span className={`${styles.deliveryStatus} ${status === "failed" || status === "uncertain" ? styles.deliveryAttention : ""}`} title={message.deliveryError || undefined}><Icon aria-hidden="true" size={14} />{deliveryNames[status]}{message.deliveryError && <span>{message.deliveryError}</span>}</span>;
}
type ReplyDraft = { text: string; file: File | null; requestId: string | null; version: number | null; locked: boolean; error: string; result: "failed" | "missing" | null };
type ExtensionAttempt = { input: AttentionExtensionInput; phase: "pending" | "uncertain" | "failed" | "confirmed"; message: string; requiresReview?: boolean; management?: AttentionExtensionResult["management"] };
type ReceiptAttempt = { input: AttentionReceiptSendInput; phase: "pending" | "uncertain" | "missing" | "failed" | "confirmed"; message: string };
type FinancialAttempts = { extension?: ExtensionAttempt; receipt?: ReceiptAttempt };
type FinancialActions = {
  attempts: FinancialAttempts;
  disabled: boolean;
  accessDenied: (error: unknown) => boolean;
  grant: (input: AttentionExtensionInput) => Promise<AttentionExtensionResult | null>;
  sendReceipt: (input: AttentionReceiptSendInput, retrySame?: boolean) => Promise<void>;
  resolveReceipt: () => Promise<void>;
  discardReceipt: () => Promise<void>;
};
const emptyReply: ReplyDraft = { text: "", file: null, requestId: null, version: null, locked: false, error: "", result: null };
const replyMimeTypes = ["image/jpeg", "image/png", "image/webp", "audio/aac", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/mp3", "audio/mpeg", "audio/amr", "audio/ogg", "application/ogg", "video/mp4", "video/3gpp", "application/pdf"];
function isAudioFile(file: File | null) { return Boolean(file && (file.type.startsWith("audio/") || file.type === "application/ogg")); }
function separateText(file: File | null) { return isAudioFile(file) || file?.type === "image/webp"; }
function replyValidation(draft: ReplyDraft) {
  const text = draft.text.trim(); const file = draft.file;
  if (!text && !file) return "Escribe un mensaje o adjunta un archivo.";
  if (file) {
    if (!replyMimeTypes.includes(file.type)) return "Este formato no está permitido. Usa JPG, PNG, sticker WEBP, audio, video MP4 o PDF.";
    if (file.type === "image/webp" && file.size > 500 * 1024) return "El sticker admite hasta 100 KB si es estático o 500 KB si es animado, en 512 × 512 píxeles.";
    if (!file.size || file.size > (file.type.startsWith("image/") ? 5 : 16) * 1024 * 1024) return file.type.startsWith("image/") ? "La imagen debe pesar entre 1 byte y 5 MB." : "El archivo debe pesar entre 1 byte y 16 MB.";
  }
  if (text.length > (file && !separateText(file) ? 1024 : 4096)) return file && !separateText(file) ? "El texto del archivo admite hasta 1.024 caracteres." : "El mensaje admite hasta 4.096 caracteres.";
  return null;
}
function replyWindowOpen(detail: AttentionDetail, now = Date.now()) {
  const expires = Date.parse(detail.messaging?.windowExpiresAt || "");
  return Boolean(detail.permissions.canSend && detail.messaging?.canReply && Number.isFinite(expires) && expires > now);
}
function ReplyAudioPreview({ file }: { file: File }) {
  const player = useRef<HTMLAudioElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!/^(audio|video|image)\//.test(file.type) && file.type !== "application/ogg") return;
    const url = URL.createObjectURL(file); const media = player.current || video.current; const target = media || picture.current;
    if (target) target.src = url;
    return () => { media?.pause(); target?.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [file]);
  if (isAudioFile(file)) return <audio ref={player} controls preload="metadata" className={styles.replyAudioPreview} aria-label={`Escuchar antes de enviar: ${file.name}`} />;
  if (file.type.startsWith("video/")) return <video ref={video} controls playsInline preload="metadata" className={styles.replyMediaPreview} aria-label={`Vista previa: ${file.name}`} />;
  // Local object URLs are revoked on replacement; they are never sent to the image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return file.type.startsWith("image/") ? <img ref={picture} className={`${styles.replyMediaPreview} ${file.type === "image/webp" ? styles.stickerPreview : ""}`} alt={`Vista previa: ${file.name}`} /> : null;
}

function ChatDropSurface({ children, receive }: { children: ReactNode; receive: (files: File[]) => string | null }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const depth = useRef(0);
  return <section className={styles.chat} aria-label="Historial de la conversación"
    onDragEnter={event => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); depth.current++; setDragging(true); }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={event => { event.preventDefault(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
    onDrop={event => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); depth.current = 0; setDragging(false); setError(receive(Array.from(event.dataTransfer.files)) || ""); }}>
    {children}
    {dragging && <div className={styles.dropOverlay} role="status"><Paperclip size={30} /><strong>Suelta el archivo aquí</strong><span>Podrás revisarlo antes de enviarlo.</span></div>}
    {error && <div className={styles.dropError} role="alert"><span>{error}</span><Button variant="ghost" aria-label="Cerrar aviso de archivo" onClick={() => setError("")}><X size={16} /></Button></div>}
  </section>;
}
function ReplyComposer({ detail, draft, busy, change, send, resolve, restart, retry, discard, fallbackDapta, actorKey, quickReplies = [], templateSent, templateBusyChanged }: { detail: AttentionDetail; draft: ReplyDraft; busy: boolean; change: (patch: Partial<ReplyDraft>) => void; send: () => void; resolve: () => void; restart: () => void; retry: () => void; discard: () => void; fallbackDapta: boolean; actorKey: string; quickReplies?: AttentionQuickReply[]; templateSent: () => void | Promise<void>; templateBusyChanged: (value: boolean) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const expires = Date.parse(detail.messaging?.windowExpiresAt || "");
    const refresh = setTimeout(() => setNow(Date.now()), 0);
    const timer = Number.isFinite(expires) && expires > Date.now() ? setTimeout(() => setNow(Date.now()), Math.min(expires - Date.now() + 10, 86_400_010)) : undefined;
    return () => { clearTimeout(refresh); if (timer) clearTimeout(timer); };
  }, [detail.messaging?.windowExpiresAt]);
  const canReply = replyWindowOpen(detail, now);
  const blockedReason = !detail.permissions.canSend || !detail.messaging?.canReply
    ? detail.messaging?.reason || "La conexión de envío con Meta está pendiente de configuración."
    : "La ventana de 24 horas terminó. Se necesita una plantilla aprobada para volver a contactar al cliente.";
  const invalid = replyValidation(draft);
  return <form className={styles.replyComposer} aria-label="Responder por WhatsApp" onSubmit={event => { event.preventDefault(); if (canReply && !busy && !draft.locked && !invalid) send(); }}>
    <div className={styles.replyDraftBody}>
    <label className={styles.srOnly} htmlFor={`reply-${detail.conversation.id}`}>Responder al cliente</label>
    {!canReply && <p className={styles.replyUnavailable} role="status">{blockedReason}</p>}
    <textarea id={`reply-${detail.conversation.id}`} rows={1} value={draft.text} disabled={busy || draft.locked || !canReply} onChange={event => change({ text: event.target.value })} maxLength={draft.file && !separateText(draft.file) ? 1024 : 4096} placeholder={canReply ? "Escribe tu respuesta…" : "El envío aún no está disponible"} />
    {draft.file && <div className={styles.replyAttachment}><FileText aria-hidden="true" size={19} /><span><strong>{draft.file.name}</strong><small>{(draft.file.size / 1024 / 1024).toFixed(2)} MB</small></span><Button type="button" variant="ghost" aria-label="Quitar archivo" disabled={busy || draft.locked} onClick={() => change({ file: null })}><X aria-hidden="true" size={17} /></Button></div>}
    {draft.file && <ReplyAudioPreview file={draft.file} />}
    {separateText(draft.file) && draft.text.trim() && <p className={styles.replyLimit}>El texto quedará como borrador para enviarlo después.</p>}
    {draft.error && <p className={styles.replyError} role="alert">{draft.error}</p>}
    {!draft.error && invalid && (draft.text || draft.file) && <p className={styles.replyError} role="status">{invalid}</p>}
    </div>
    <div className={styles.replyActions}><AttentionComposerTools key={detail.conversation.id} conversationId={detail.conversation.id} disabled={busy || draft.locked || !canReply} audioDisabled={Boolean(draft.file)} onAudio={file => { if (!draft.file) change({ file }); }} onEmoji={emoji => { if (draft.text.length + emoji.length <= (draft.file && !separateText(draft.file) ? 1024 : 4096)) change({ text: `${draft.text}${emoji}` }); }} /><label title="Adjuntar archivo · JPG/PNG hasta 5 MB; otros formatos hasta 16 MB" className={`${styles.attachButton} ${busy || draft.locked || !canReply ? styles.attachDisabled : ""}`}><Paperclip aria-hidden="true" size={20} /><span className={styles.srOnly}>Adjuntar archivo</span><input type="file" aria-label="Adjuntar archivo" accept={replyMimeTypes.join(",")} disabled={busy || draft.locked || !canReply} onChange={event => { const file = event.target.files?.[0] || null; if (file) change({ file }); event.target.value = ""; }} /></label>

      <AttentionStickerPicker disabled={busy || draft.locked || !canReply} onSelect={file => change({ file })} />
      <AttentionQuickReplies replies={quickReplies} disabled={busy || draft.locked || !canReply} insert={text => { const next = `${draft.text}${draft.text ? "\n" : ""}${text}`; if (next.length <= (draft.file && !separateText(draft.file) ? 1024 : 4096)) change({ text: next }); else change({ error: "La respuesta rápida supera el espacio disponible. Acorta el borrador antes de insertarla." }); }} />
      <AttentionTemplateComposer key={`template:${detail.conversation.id}`} actorKey={actorKey} detail={detail} disabled={busy || draft.locked || !detail.permissions.manage} onSent={templateSent} onBusyChange={templateBusyChanged} />
      {draft.locked ? <><Button type="button" variant="secondary" disabled={busy} onClick={resolve}><RefreshCw aria-hidden="true" size={16} />{busy ? "Consultando…" : "Consultar estado"}</Button>{draft.result === "missing" && <><Button type="button" variant="secondary" disabled={busy} onClick={discard}>Descartar intento</Button><Button type="button" disabled={busy || !canReply} onClick={retry}>Reintentar misma solicitud</Button></>}{draft.result === "failed" && <Button type="button" disabled={busy || !canReply} onClick={restart}>Preparar nuevo intento</Button>}</> : <Button type="submit" disabled={busy || !canReply || Boolean(invalid)}><Send aria-hidden="true" size={16} />{busy ? "Enviando…" : draft.file?.type === "image/webp" ? "Enviar sticker" : isAudioFile(draft.file) ? "Enviar audio" : "Enviar"}</Button>}
    </div>
    {draft.locked && <p className={styles.replyLimit}>Comprueba el estado antes de otro envío.</p>}
    {fallbackDapta && <a className={styles.daptaFallback} href={DAPTA_INBOX_URL} target="_blank" rel="noopener noreferrer">Responder en Dapta <ExternalLink aria-hidden="true" size={14} /></a>}
  </form>;
}

export default function AttentionConsole({ actor, initialWorkKind = null, initialWorkId = null }: { actor: AttentionActor; initialWorkKind?: "welcome" | "enrollment" | null; initialWorkId?: string | null }) {
  const [view, setView] = useState<View>(initialWorkKind || "conversations");
  const [workSelection, setWorkSelection] = useState<string|null>(initialWorkId);
  const [boardOpened, setBoardOpened] = useState(false);
  const [boardRevision, setBoardRevision] = useState(0);
  const [inbox, setInbox] = useState<AttentionInbox | null>(null);
  const [detail, setDetail] = useState<AttentionDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AttentionFilters["filter"]>("all");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");
  const [liveStatus, setLiveStatus] = useState<"connecting" | "connected" | "reconnecting" | "offline" | "paused" | "polling">("connecting");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ReplyDraft>>({});
  const [financialAttempts, setFinancialAttempts] = useState<Record<string, FinancialAttempts>>({});
  const [notice, setNotice] = useState("");
  const [dismissedAgendaAlert, setDismissedAgendaAlert] = useState<string | null>(null);
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
  const inboxReadError = useRef(false);
  const detailReadError = useRef(false);
  const selectionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const syncingRef = useRef(false);
  const foregroundReads = useRef(0);
  const pollController = useRef<AbortController | null>(null);
  const liveAccessBlocked = useRef(false);
  const replyController = useRef<AbortController | null>(null);
  const replyDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const financialController = useRef<AbortController | null>(null);
  const financialDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopSync = useRef(false);
  const mounted = useRef(true);
  const newRequestKey = useRef<string | null>(null);
  const mutationKey = useRef<{ payload: string; id: string } | null>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
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

  const clearInaccessibleData = useCallback((message: string) => {
    ++listRequest.current; ++detailRequest.current; liveAccessBlocked.current = true;
    inboxReadError.current = true; detailReadError.current = false;
    selectionRef.current = null;
    setInbox(null); setDetail(null); setSelected(null); setShowCustomer(false); setBoardOpened(false);
    setReplyDrafts({}); setFinancialAttempts({});
    setLoading(false); setDetailLoading(false); setDetailError(""); setError(message);
  }, []);
  const quickReplyBusyChanged = useCallback((value: boolean) => {
    if (value) pollController.current?.abort();
    busyRef.current = value;
    if (mounted.current) setBusy(value);
  }, []);
  const loadInbox = useCallback(async (signal?: AbortSignal) => {
    pollController.current?.abort(); foregroundReads.current++;
    inboxReadError.current = false;
    const request = ++listRequest.current; setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ search, filter, page: String(page), ...(tag ? { tag } : {}) });
      const result = await api<AttentionInbox>(`/api/atencion?${query}`, { signal });
      if (mounted.current && !signal?.aborted && request === listRequest.current) { liveAccessBlocked.current = false; setInbox(result); setBoardRevision(value => value + 1); }
    } catch (err) {
      if (mounted.current && !signal?.aborted && request === listRequest.current) {
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
        else { inboxReadError.current = true; setError(errorMessage(err)); }
      }
    } finally { foregroundReads.current--; if (mounted.current && !signal?.aborted && request === listRequest.current) setLoading(false); }
  }, [filter, page, search, tag, clearInaccessibleData]);
  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    pollController.current?.abort(); foregroundReads.current++;
    detailReadError.current = false;
    const request = ++detailRequest.current; setDetailLoading(true); setDetailError("");
    try {
      const result = await api<AttentionDetail>(`/api/atencion/${encodeURIComponent(id)}`, { signal });
      if (mounted.current && !signal?.aborted && request === detailRequest.current && selectionRef.current === id) setDetail(result);
    } catch (err) {
      if (mounted.current && !signal?.aborted && request === detailRequest.current && selectionRef.current === id) {
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
        else { detailReadError.current = true; setDetail(null); setDetailError(errorMessage(err)); }
      }
    } finally { foregroundReads.current--; if (mounted.current && !signal?.aborted && request === detailRequest.current) setDetailLoading(false); }
  }, [clearInaccessibleData]);
  useEffect(() => {
    const controller = new AbortController(); const timeout = setTimeout(() => { void loadInbox(controller.signal); }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [loadInbox, syncRevision]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopSync.current = true; replyController.current?.abort(); if (replyDeadline.current) clearTimeout(replyDeadline.current); financialController.current?.abort(); if (financialDeadline.current) clearTimeout(financialDeadline.current); };
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
  useEffect(() => {
    let disposed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let source: EventSource | null = null;
    let streamReady = false;
    let retryCount = 0;
    let lastFrameAt = 0;
    let invalidated = false;
    let refreshing = false;
    let queued: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const supported = typeof EventSource !== "undefined";
    const readable = () => document.visibilityState === "visible" && navigator.onLine;
    const refresh = async () => {
      if (disposed || !mounted.current || liveAccessBlocked.current || !readable() || foregroundReads.current || busyRef.current || syncingRef.current || pollController.current) return false;
      const controller = new AbortController(); pollController.current = controller;
      const listVersion = listRequest.current; const detailVersion = detailRequest.current;
      const id = view === "conversations" ? selectionRef.current : null;
      let temporaryFailure = false; let timedOut = false;
      const current = () => !disposed && mounted.current && !controller.signal.aborted && readable()
        && !foregroundReads.current && !busyRef.current && !syncingRef.current
        && listVersion === listRequest.current && detailVersion === detailRequest.current;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
      deadline = timeout;
      const failed = (err: unknown, detailRead: boolean) => {
        if (!current()) return;
        if (err instanceof ApiError && [401, 403].includes(err.status)) {
          clearInaccessibleData(errorMessage(err)); closeStream(); controller.abort();
        } else if (detailRead && err instanceof ApiError && err.status === 404) {
          // Reassignment is deliberately reported as 404 by the scoped API.
          detailReadError.current = true;
          setDetail(null); setShowCustomer(false); setDetailError("Esta conversación ya no está disponible para tu cuenta.");
          if (id) { setReplyDrafts(value => { const next = { ...value }; delete next[id]; return next; }); setFinancialAttempts(value => { const next = { ...value }; delete next[id]; return next; }); }
        } else temporaryFailure = true;
      };
      try {
        const query = new URLSearchParams({ search, filter, page: String(page), ...(tag ? { tag } : {}) });
        await Promise.all([
          api<AttentionInbox>(`/api/atencion?${query}`, { signal: controller.signal })
            .then(result => { if (current()) {
              setInbox(result);
              setBoardRevision(value => value + 1);
              if (inboxReadError.current) { inboxReadError.current = false; setError(""); }
            } }).catch(err => failed(err, false)),
          id ? api<AttentionDetail>(`/api/atencion/${encodeURIComponent(id)}`, { signal: controller.signal })
            .then(result => { if (current() && selectionRef.current === id) {
              setDetail(result);
              if (detailReadError.current) { detailReadError.current = false; setDetailError(""); }
            } }).catch(err => failed(err, true)) : Promise.resolve(),
        ]);
        if (current() || timedOut && !disposed && mounted.current && listVersion === listRequest.current && detailVersion === detailRequest.current) {
          setRefreshNotice(temporaryFailure || timedOut ? "No se pudo actualizar la vista. Conservamos los últimos datos cargados y volveremos a intentarlo." : "");
        }
        return !temporaryFailure && !timedOut && current();
      } finally {
        clearTimeout(timeout);
        if (deadline === timeout) deadline = undefined;
        if (pollController.current === controller) pollController.current = null;
      }
    };
    function closeStream() {
      streamReady = false;
      if (source) { source.close(); source = null; }
      if (reconnect) { clearTimeout(reconnect); reconnect = undefined; }
    }
    function queueRefresh(delay = 250) {
      invalidated = true;
      if (disposed || queued || refreshing || liveAccessBlocked.current || !readable()) return;
      queued = setTimeout(async () => {
        queued = undefined;
        if (disposed || !invalidated || liveAccessBlocked.current || !readable()) return;
        invalidated = false; refreshing = true;
        const deferred = Boolean(foregroundReads.current || busyRef.current || syncingRef.current || pollController.current);
        const completed = await refresh();
        refreshing = false;
        if (!completed) invalidated = true;
        if (invalidated && !disposed) queueRefresh(completed ? 250 : deferred ? 1_000 : 5_000);
      }, delay);
    }
    function connect() {
      if (disposed || source || !readable() || liveAccessBlocked.current) return;
      if (!supported) { setLiveStatus("polling"); return; }
      setLiveStatus(retryCount ? "reconnecting" : "connecting");
      const connection = new EventSource("/api/atencion/events");
      source = connection; lastFrameAt = Date.now();
      const active = () => !disposed && source === connection && !liveAccessBlocked.current;
      connection.addEventListener("ready", () => {
        if (!active()) return;
        lastFrameAt = Date.now(); streamReady = true; retryCount = 0; setLiveStatus("connected");
      });
      connection.addEventListener("invalidate", () => { if (active()) { lastFrameAt = Date.now(); queueRefresh(); } });
      connection.addEventListener("degraded", () => {
        if (!active()) return;
        lastFrameAt = Date.now(); streamReady = false; setLiveStatus("reconnecting");
      });
      connection.addEventListener("heartbeat", event => {
        if (!active()) return;
        lastFrameAt = Date.now();
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as { connected?: boolean };
          if (typeof payload.connected === "boolean") { streamReady = payload.connected; setLiveStatus(streamReady ? "connected" : "reconnecting"); }
        } catch { /* A malformed heartbeat never claims a live connection. */ }
      });
      connection.addEventListener("unauthorized", () => {
        if (!active()) return;
        closeStream(); clearInaccessibleData("Tu acceso a Atención cambió. Actualiza la página para volver a consultar tus permisos.");
        setLiveStatus("paused");
      });
      connection.onerror = () => {
        if (!active()) return;
        closeStream(); setLiveStatus(navigator.onLine ? "reconnecting" : "offline");
        if (!readable()) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryCount++, 5)) + Math.floor(Math.random() * 1_000);
        reconnect = setTimeout(() => { reconnect = undefined; connect(); }, delay);
      };
    }
    const environmentChanged = () => {
      if (!readable()) {
        pollController.current?.abort(); closeStream();
        if (queued) { clearTimeout(queued); queued = undefined; }
        setLiveStatus(navigator.onLine ? "paused" : "offline");
      } else { connect(); queueRefresh(); }
    };
    const initial = setTimeout(() => { if (readable()) connect(); else setLiveStatus(navigator.onLine ? "paused" : "offline"); }, 0);
    const timer = setInterval(() => {
      if (source && Date.now() - lastFrameAt > 45_000) { closeStream(); retryCount++; setLiveStatus("reconnecting"); }
      if (!streamReady) void refresh();
      if (!source && !reconnect && !liveAccessBlocked.current) connect();
    }, 20_000);
    document.addEventListener("visibilitychange", environmentChanged);
    window.addEventListener("offline", environmentChanged);
    window.addEventListener("online", environmentChanged);
    return () => {
      disposed = true; clearInterval(timer); clearTimeout(initial); closeStream(); pollController.current?.abort();
      if (queued) clearTimeout(queued);
      if (deadline) clearTimeout(deadline);
      document.removeEventListener("visibilitychange", environmentChanged);
      window.removeEventListener("offline", environmentChanged);
      window.removeEventListener("online", environmentChanged);
    };
  }, [filter, page, search, tag, selected, view, clearInaccessibleData]);
  useEffect(() => { if (selected && !showCustomer) chatHeading.current?.focus({ preventScroll: true }); }, [selected, showCustomer, view]);
  const historyId = detail?.conversation.id;
  const historyLength = detail?.messages.length;
  const historyTail = detail?.messages[detail.messages.length - 1]?.id;
  const historyDelivery = detail?.messages[detail.messages.length - 1]?.deliveryStatus;
  const historyDeliveryError = detail?.messages[detail.messages.length - 1]?.deliveryError;
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
  }, [historyId, historyLength, historyTail, historyDelivery, historyDeliveryError, showCustomer, view]);
  function keepLatestAfterMedia() {
    const log = messageLog.current;
    if (mounted.current && log && followLatest.current) log.scrollTop = log.scrollHeight;
  }
  function goToLatest() {
    const log = messageLog.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    followLatest.current = true; setShowLatest(false);
  }
  function navigate(next: View) { setWorkSelection(null); if (next === "board") setBoardOpened(true); setView(next); setShowNew(false); setShowCustomer(false); }
  function refreshCurrentView() {
    void loadInbox();
    if (view === "conversations" && selectionRef.current) void loadDetail(selectionRef.current);
  }
  function selectConversation(id: string | null) {
    pollController.current?.abort();
    detailReadError.current = false;
    selectionRef.current = id; ++detailRequest.current; setSelected(id); setDetail(null); setDetailError("");
    setDetailLoading(Boolean(id)); setShowCustomer(false); setShowLatest(false); displayedHistory.current = null; followLatest.current = true; mutationKey.current = null;
    if (id) { setView("conversations"); }
  }
  async function mutate(input: Omit<AttentionMutation, "version" | "requestId">) {
    if (!detail || busyRef.current) return false;
    pollController.current?.abort();
    const id = detail.conversation.id; const payload = JSON.stringify({ ...input, version: detail.conversation.version });
    if (mutationKey.current?.payload !== payload) mutationKey.current = { payload, id: crypto.randomUUID() };
    detailReadError.current = false;
    busyRef.current = true; setBusy(true); setDetailError(""); setNotice("");
    try {
      await api(`/api/atencion/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...input, version: detail.conversation.version, requestId: mutationKey.current.id }) });
      mutationKey.current = null;
      setNotice(input.action === "human_request" ? "Solicitud interna guardada. Falta confirmar el traspaso en Dapta." : input.action === "transfer" ? "Conversación asignada al analista." : "Gestión guardada en FINSER PAY.");
      await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]); return true;
    } catch (err) {
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
      else if (selectionRef.current === id) {
        if (err instanceof ApiError && err.status === 404) { detailReadError.current = true; setDetail(null); }
        setDetailError(errorMessage(err));
      }
      return false;
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  function changeReply(id: string, patch: Partial<ReplyDraft>) {
    if (busyRef.current) return;
    setReplyDrafts(current => {
      const draft = current[id] || emptyReply;
      return draft.locked ? current : { ...current, [id]: { ...draft, ...patch, requestId: null, version: null, error: patch.error ?? "", result: null } };
    });
  }
  function recordReplyResult(id: string, draft: ReplyDraft, message: AttentionMessage | null) {
    if (!mounted.current) return;
    const status = message?.deliveryStatus;
    if (status && ["accepted", "sent", "delivered", "read"].includes(status)) {
      setReplyDrafts(current => ({ ...current, [id]: { ...emptyReply, text: separateText(draft.file) ? draft.text : "" } }));
    } else {
      const missing = message === null;
      setReplyDrafts(current => ({ ...current, [id]: { ...draft, locked: true,
        result: missing ? "missing" : status === "failed" ? "failed" : null,
        error: missing ? "La solicitud aún no aparece registrada. Solo se permite reintentar la misma solicitud, conservando su contenido."
          : status === "failed" ? message?.deliveryError || "WhatsApp confirmó que el mensaje no fue enviado. Puedes preparar un nuevo intento."
          : status === "queued" || status === "sending" ? "El mensaje está en proceso. Consulta su estado antes de volver a enviar."
          : "Todavía no se puede confirmar el envío. Consulta su estado para evitar duplicar el mensaje." } }));
    }
  }
  async function sendReply(retrySame = false) {
    if (!detail || busyRef.current || syncingRef.current || !replyWindowOpen(detail)) return;
    const id = detail.conversation.id; const previous = replyDrafts[id] || emptyReply;
    if ((previous.locked && !(retrySame && previous.result === "missing" && previous.requestId)) || replyValidation(previous)) return;
    const draft: ReplyDraft = { ...previous, requestId: previous.requestId || crypto.randomUUID(), version: previous.version ?? detail.conversation.version, locked: true, error: "", result: null };
    pollController.current?.abort(); busyRef.current = true; setBusy(true);
    setReplyDrafts(current => ({ ...current, [id]: draft }));
    const controller = new AbortController(); replyController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60_000);
    replyDeadline.current = timeout;
    try {
      const form = new FormData(); form.set("requestId", draft.requestId!); form.set("version", String(draft.version)); form.set("text", separateText(draft.file) ? "" : draft.text.trim());
      if (draft.file) form.set("file", draft.file);
      const result = await api<{ message: AttentionMessage; uncertain?: boolean }>(`/api/atencion/${encodeURIComponent(id)}/messages`, { method: "POST", body: form, signal: controller.signal });
      recordReplyResult(id, draft, result.uncertain ? { ...result.message, deliveryStatus: "uncertain" } : result.message);
      if (mounted.current) await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]);
    } catch (err) {
      if (mounted.current) {
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
        else setReplyDrafts(current => ({ ...current, [id]: { ...draft, error: `${errorMessage(err)} Consulta el estado antes de intentar otro envío.` } }));
      }
    } finally {
      clearTimeout(timeout); if (replyDeadline.current === timeout) replyDeadline.current = null; if (replyController.current === controller) replyController.current = null;
      busyRef.current = false; if (mounted.current) setBusy(false);
    }
  }
  async function resolveReply() {
    if (!detail || busyRef.current || syncingRef.current) return;
    const id = detail.conversation.id; const draft = replyDrafts[id];
    if (!draft?.requestId || !draft.locked) return;
    pollController.current?.abort(); busyRef.current = true; setBusy(true);
    const controller = new AbortController(); replyController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    replyDeadline.current = timeout;
    try {
      const result = await api<{ message: AttentionMessage | null }>(`/api/atencion/${encodeURIComponent(id)}/messages?requestId=${encodeURIComponent(draft.requestId)}`, { signal: controller.signal });
      recordReplyResult(id, draft, result.message);
      if (mounted.current) await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]);
    } catch (err) {
      if (mounted.current) {
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
        else setReplyDrafts(current => ({ ...current, [id]: { ...draft, error: `No se pudo comprobar el envío. ${errorMessage(err)}` } }));
      }
    } finally {
      clearTimeout(timeout); if (replyDeadline.current === timeout) replyDeadline.current = null; if (replyController.current === controller) replyController.current = null;
      busyRef.current = false; if (mounted.current) setBusy(false);
    }
  }
  function restartReply(id: string) {
    if (busyRef.current) return;
    setReplyDrafts(current => {
      const draft = current[id];
      return draft?.result === "failed" ? { ...current, [id]: { ...draft, requestId: null, version: null, locked: false, result: null, error: "" } } : current;
    });
  }
  async function discardReply() {
    if (!detail || busyRef.current || syncingRef.current) return;
    const id = detail.conversation.id; const draft = replyDrafts[id];
    if (!draft?.requestId || draft.result !== "missing" || !draft.locked) return;
    pollController.current?.abort(); busyRef.current = true; setBusy(true);
    const controller = new AbortController(); replyController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000); replyDeadline.current = timeout;
    try {
      const result = await api<{ cancelled: boolean }>(`/api/atencion/${encodeURIComponent(id)}/messages?requestId=${encodeURIComponent(draft.requestId)}`, { method: "DELETE", signal: controller.signal });
      if (result.cancelled !== true) throw new Error("No se confirmó la cancelación del intento. Consulta su estado.");
      if (mounted.current) {
        setReplyDrafts(current => ({ ...current, [id]: { ...draft, requestId: null, version: null, locked: false, error: "", result: null } }));
        await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]);
      }
    } catch (err) {
      if (mounted.current) {
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearInaccessibleData(errorMessage(err));
        else setReplyDrafts(current => ({ ...current, [id]: { ...draft, error: `${errorMessage(err)} El contenido sigue bloqueado hasta confirmar el estado.` } }));
      }
    } finally {
      clearTimeout(timeout); if (replyDeadline.current === timeout) replyDeadline.current = null; if (replyController.current === controller) replyController.current = null;
      busyRef.current = false; if (mounted.current) setBusy(false);
    }
  }
  function updateFinancialAttempt(id: string, patch: Partial<FinancialAttempts>) {
    if (mounted.current) setFinancialAttempts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  }
  function handleFinancialAccessError(id: string, error: unknown) {
    if (!(error instanceof ApiError)) return false;
    if ([401, 403].includes(error.status)) { clearInaccessibleData(errorMessage(error)); return true; }
    if (error.status !== 404) return false;
    if (selectionRef.current === id) {
      pollController.current?.abort(); ++detailRequest.current; detailReadError.current = true;
      setDetail(null); setDetailLoading(false); setShowCustomer(false); setDetailError("Esta conversación ya no está disponible para tu cuenta.");
      setReplyDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setFinancialAttempts(current => { const next = { ...current }; delete next[id]; return next; });
      void loadInbox();
    }
    return true;
  }
  async function withFinancialOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    pollController.current?.abort(); busyRef.current = true; setBusy(true);
    const controller = new AbortController(); financialController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60_000); financialDeadline.current = timeout;
    try { return await operation(controller.signal); }
    finally {
      clearTimeout(timeout); if (financialDeadline.current === timeout) financialDeadline.current = null;
      if (financialController.current === controller) financialController.current = null;
      busyRef.current = false; if (mounted.current) setBusy(false);
    }
  }
  async function refreshAfterFinancialAction(id: string) {
    if (mounted.current) await Promise.all([loadInbox(), selectionRef.current === id ? loadDetail(id) : Promise.resolve()]);
  }
  async function grantExtension(id: string, input: AttentionExtensionInput) {
    if (busyRef.current || syncingRef.current || selectionRef.current !== id) return null;
    const previous = financialAttempts[id]?.extension;
    if (previous && ["pending", "uncertain"].includes(previous.phase) && previous.input.requestId !== input.requestId) return null;
    const actual = previous && ["pending", "uncertain"].includes(previous.phase) ? previous.input : input;
    updateFinancialAttempt(id, { extension: { input: actual, phase: "pending", message: "Registrando la prórroga…" } });
    return withFinancialOperation(async signal => {
      try {
        const result = await api<AttentionExtensionResult>(`/api/atencion/${encodeURIComponent(id)}/extensions`, { method: "POST", body: JSON.stringify(actual), signal });
        if (!result.extension?.id || !result.extension.status) throw new Error("El servidor no confirmó la prórroga. Revisa la misma solicitud.");
        const stateNames = { APPROVED: "aprobada", EXPIRED: "vencida", CANCELLED: "cancelada", REPLACED: "reemplazada", REJECTED: "rechazada", PENDING: "pendiente" };
        const management = result.management?.creditId === actual.creditId ? result.management : undefined;
        const message = `${result.unchanged ? `Operación ya registrada: prórroga ${stateNames[result.extension.status]}` : result.extension.status === "APPROVED" ? "Prórroga concedida" : `Prórroga ${stateNames[result.extension.status]}`} · ${date(result.extension.expiresOn, true)}.${management ? " Gestión registrada en Gestión de cartera." : ""}${result.moraSync && !result.moraSync.ok ? ` ${result.moraSync.message}` : ""}`;
        updateFinancialAttempt(id, { extension: { input: actual, phase: "confirmed", message, management } });
        await refreshAfterFinancialAction(id); return result;
      } catch (err) {
        if (!handleFinancialAccessError(id, err)) {
          const rejected = err instanceof ApiError && [400, 404, 409, 422].includes(err.status);
          updateFinancialAttempt(id, { extension: { input: actual, phase: rejected ? "failed" : "uncertain", requiresReview: err instanceof ApiError && err.status === 409, message: `${errorMessage(err)}${rejected ? " Actualiza los datos antes de revisar otra solicitud." : " Conservamos la solicitud para comprobarla sin duplicar la prórroga."}` } });
        }
        return null;
      }
    });
  }
  function recordReceiptResult(id: string, input: AttentionReceiptSendInput, message: AttentionMessage | null, uncertain = false) {
    const status = uncertain ? "uncertain" : message?.deliveryStatus;
    const confirmed = status && ["accepted", "sent", "delivered", "read"].includes(status);
    updateFinancialAttempt(id, { receipt: { input,
      phase: confirmed ? "confirmed" : message === null ? "missing" : status === "failed" ? "failed" : "uncertain",
      message: confirmed ? `Recibo: ${deliveryNames[status as keyof typeof deliveryNames].toLowerCase()}.`
        : message === null ? "El envío no aparece registrado. Puedes repetir únicamente esta misma solicitud o descartarla tras confirmación del servidor."
        : status === "failed" ? message?.deliveryError || "WhatsApp confirmó que el recibo no fue enviado."
        : "El envío del recibo está pendiente de confirmación. Consulta su estado antes de volver a enviarlo.",
    } });
  }
  async function sendReceipt(id: string, input: AttentionReceiptSendInput, retrySame = false) {
    if (busyRef.current || syncingRef.current || selectionRef.current !== id || !detail || detail.conversation.id !== id || !replyWindowOpen(detail)) return;
    const previous = financialAttempts[id]?.receipt;
    const locked = previous && ["pending", "uncertain", "missing"].includes(previous.phase);
    if (locked && !(retrySame && previous.phase === "missing" && input.requestId === previous.input.requestId)) return;
    const actual = retrySame && previous ? previous.input : input;
    updateFinancialAttempt(id, { receipt: { input: actual, phase: "pending", message: "Enviando el recibo…" } });
    await withFinancialOperation(async signal => {
      try {
        const result = await api<{ message: AttentionMessage; uncertain?: boolean }>(`/api/atencion/${encodeURIComponent(id)}/receipts/latest/send`, { method: "POST", body: JSON.stringify(actual), signal });
        recordReceiptResult(id, actual, result.message, result.uncertain);
        await refreshAfterFinancialAction(id);
      } catch (err) {
        if (!handleFinancialAccessError(id, err)) updateFinancialAttempt(id, { receipt: { input: actual, phase: "uncertain", message: `${errorMessage(err)} Consulta el estado del recibo antes de otro envío.` } });
      }
    });
  }
  async function resolveReceipt(id: string) {
    const attempt = financialAttempts[id]?.receipt;
    if (!attempt || busyRef.current || syncingRef.current || selectionRef.current !== id) return;
    await withFinancialOperation(async signal => {
      try {
        const result = await api<{ message: AttentionMessage | null }>(`/api/atencion/${encodeURIComponent(id)}/messages?requestId=${encodeURIComponent(attempt.input.requestId)}`, { signal });
        recordReceiptResult(id, attempt.input, result.message); await refreshAfterFinancialAction(id);
      } catch (err) {
        if (!handleFinancialAccessError(id, err)) updateFinancialAttempt(id, { receipt: { ...attempt, message: `No se pudo comprobar el envío. ${errorMessage(err)}` } });
      }
    });
  }
  async function discardReceipt(id: string) {
    const attempt = financialAttempts[id]?.receipt;
    if (!attempt || attempt.phase !== "missing" || busyRef.current || syncingRef.current || selectionRef.current !== id) return;
    await withFinancialOperation(async signal => {
      try {
        const result = await api<{ cancelled: boolean }>(`/api/atencion/${encodeURIComponent(id)}/messages?requestId=${encodeURIComponent(attempt.input.requestId)}`, { method: "DELETE", signal });
        if (result.cancelled !== true) throw new Error("No se confirmó el descarte. El intento sigue pendiente.");
        updateFinancialAttempt(id, { receipt: undefined }); await refreshAfterFinancialAction(id);
      } catch (err) {
        if (!handleFinancialAccessError(id, err)) updateFinancialAttempt(id, { receipt: { ...attempt, message: errorMessage(err) } });
      }
    });
  }
  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current) return;
    pollController.current?.abort();
    inboxReadError.current = false;
    const data = new FormData(event.currentTarget); busyRef.current = true; setBusy(true); setError(""); setNotice(""); newRequestKey.current ||= crypto.randomUUID();
    try {
      const result = await api<{ id: string }>("/api/atencion", { method: "POST", body: JSON.stringify({ phone: data.get("phone"), name: data.get("name"), requestId: newRequestKey.current }) });
      newRequestKey.current = null; setShowNew(false); selectConversation(result.id); setNotice("Gestión interna registrada. No se envió ningún mensaje."); await loadInbox();
    } catch (err) { setError(errorMessage(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function sync() {
    if (syncingRef.current || !syncRestored || !currentActor.central) return;
    pollController.current?.abort();
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
  const viewTitles = { enrollment: "Enrolamientos", welcome: "Aprobaciones · bienvenida", dashboard: "Resumen del equipo", conversations: "Conversaciones", board: "Tablero de conversaciones", agenda: "Agenda", team: "Equipo de analistas", settings: "Configuración" };
  const agendaCount = (inbox?.agendaCounts?.today || 0) + (inbox?.agendaCounts?.overdue || 0);
  const agendaAlertKey = `${inbox?.agendaCounts?.today || 0}:${inbox?.agendaCounts?.overdue || 0}`;
  function navButton(target: View, label: string, count = 0) {
    return <button type="button" className={view === target ? styles.activeNav : undefined} aria-current={view === target ? "page" : undefined} onClick={() => navigate(target)}>{label}{count > 0 && <span className={styles.navCount} aria-label={`${count} seguimientos para hoy o vencidos`}>{count}</span>}</button>;
  }
  return <div className={`${styles.shell} ${(view === "conversations" || view === "board" || view === "enrollment" || view === "welcome") ? styles.crmShell : ""}`}>
    {currentActor.central
      ? <FinserNavigation plainBrand admin adminCentral nombreUsuario={currentActor.name} rolUsuario="ADMIN" variant="administration" activeSection="operation" />
      : <AnalystNavigation plainBrand userName={currentActor.name} userRole="ANALISTA_APROBACION" compact centralAdmin={false} />}
    <div className={styles.moduleBar}>
      <div className={styles.moduleIdentity}><h1>Atención</h1>{!currentActor.central && <Link href="/dashboard/aprobaciones/centro" aria-label="Volver al Centro del analista"><ArrowLeft aria-hidden="true" size={16} /> Centro</Link>}</div>
      <nav className={styles.moduleTabs} aria-label="Navegación de atención">{navButton("conversations", "Conversaciones")}{navButton("enrollment", "Enrolamientos")}{navButton("welcome", "Aprobaciones")}{navButton("board", "Tablero")}{navButton("agenda", "Agenda", agendaCount)}{navButton("dashboard", "Resumen")}{navButton("team", "Equipo")}{navButton("settings", "Configuración")}</nav>
      <div className={styles.moduleActions}><span className={`${styles.liveConnection} ${liveStatus === "connected" ? styles.liveConnected : ""}`} role="status"><i aria-hidden="true" />{{ connected: "Conectado", connecting: "Conectando…", reconnecting: "Reconectando…", offline: "Sin conexión", paused: "En pausa", polling: "Actualización periódica" }[liveStatus]}</span><Button variant="ghost" aria-label="Actualizar" title="Actualizar vista" onClick={refreshCurrentView} disabled={loading || detailLoading || busy}><RefreshCw aria-hidden="true" size={18} /></Button></div>
    </div>
    <main className={`${styles.main} ${(view === "conversations" || view === "board" || view === "enrollment" || view === "welcome") ? styles.crmMain : ""} ${view === "board" ? styles.boardMain : ""}`}>
      {view !== "conversations" && view !== "board" && view !== "enrollment" && view !== "welcome" && <div className={styles.pageHeading}><h2>{viewTitles[view]}</h2>{view === "dashboard" && <p>Actividad y seguimiento del equipo de atención</p>}</div>}
        {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || busy}>Reintentar</Button></div>}
        {notice && <div className={styles.notice} role="status"><Check aria-hidden="true" size={18} /><span>{notice}</span><Button variant="ghost" aria-label="Ocultar confirmación" onClick={() => setNotice("")}><X size={16} aria-hidden="true" /></Button></div>}
        {agendaCount > 0 && view === "dashboard" && dismissedAgendaAlert !== agendaAlertKey && <div className={styles.agendaAlert} role="status"><CalendarClock aria-hidden="true" size={17} /><span>{inbox?.agendaCounts?.overdue || 0} tareas vencidas · {inbox?.agendaCounts?.today || 0} para hoy</span><button type="button" onClick={() => navigate("agenda")}>Ver agenda</button><Button variant="ghost" aria-label="Ocultar aviso de agenda" onClick={() => setDismissedAgendaAlert(agendaAlertKey)}><X size={15} aria-hidden="true" /></Button></div>}
        {refreshNotice && <p className={styles.muted} role="status">{refreshNotice}</p>}
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
            <Card className={styles.currentCard}><div className={styles.cardHeading}><h2>Conversaciones en curso</h2><button className={styles.linkButton} onClick={() => navigate("conversations")}>Ver todas <ArrowRight aria-hidden="true" size={15} /></button></div>{activeConversations.length ? <div className={styles.activeList}>{activeConversations.slice(0, 4).map(conversation => <button type="button" key={conversation.id} onClick={() => selectConversation(conversation.id)}><span className={styles.avatar}>{initials(contactName(conversation))}</span><span><strong>{contactName(conversation)}</strong>{conversation.customerIdentity && <span className={styles.contactDocument}>{conversation.customerIdentity.documentLabel || "Cédula"} {conversation.customerIdentity.document}</span>}<small>{conversation.preview || conversation.phone || "Contacto de WhatsApp"}</small></span><time dateTime={conversation.lastContactAt || undefined}>{time(conversation.lastContactAt)}</time><span className={`${styles.statusDot} ${conversation.status === "pending" ? styles.pendingDot : ""}`} aria-label={statusNames[conversation.status]} /></button>)}</div> : <DashboardEmpty icon={MessageCircle} title={loading ? "Consultando conversaciones…" : "Tu bandeja de WhatsApp"} text={currentActor.central ? "Aquí aparecerán las conversaciones del canal conectado." : "Aquí aparecerán los chats que te asigne administración."} action={<Button variant="secondary" onClick={() => navigate("conversations")}>Abrir bandeja <ArrowRight aria-hidden="true" size={15} /></Button>} />}</Card>
          </div>
          <div className={styles.dashboardFooter}><span><span className={`${styles.channelDot} ${inbox?.integration.configured ? styles.connectedDot : ""}`} /> WhatsApp {inbox?.integration.configured ? "· canal disponible" : "· configuración pendiente"}</span><button className={styles.linkButton} disabled={loading} onClick={() => void loadInbox()}><RefreshCw aria-hidden="true" size={14} /> Actualizar resumen</button></div>
        </>}

        {view === "conversations" && <>

          {showNew && <Card className={styles.formCard}><div className={styles.cardHeading}><div><h2>Nueva gestión interna</h2><p>No envía mensajes ni crea otro registro de cliente.</p></div><Button variant="ghost" aria-label="Cerrar nueva gestión" disabled={busy} onClick={() => setShowNew(false)}><X aria-hidden="true" size={18} /></Button></div><form className={styles.newForm} onSubmit={createCase} onChange={() => { if (!busy) newRequestKey.current = null; }}><label>Nombre del contacto<Input name="name" required maxLength={120} autoComplete="off" disabled={busy} /></label><label>Teléfono<Input name="phone" type="tel" required maxLength={24} placeholder="Con indicativo de país" autoComplete="off" disabled={busy} /></label><Button type="submit" disabled={busy}>{busy ? "Guardando…" : "Registrar gestión"}</Button></form></Card>}
          <section className={`${styles.workspace} ${selected ? styles.hasSelection : ""}`} aria-label="Bandeja de atención">
            <aside className={styles.inbox} aria-label="Conversaciones"><div className={styles.inboxHeading}><h2>Conversaciones <span>{inbox?.total ?? "—"}</span></h2><div>{currentActor.central && <Button variant="ghost" aria-label="Nueva gestión" title="Nueva gestión interna" disabled={!contentReady || busy} onClick={() => { setShowNew(value => !value); newRequestKey.current = null; }}><Plus aria-hidden="true" size={20} /></Button>}</div></div><label className={styles.search}><Search aria-hidden="true" size={18} /><span className={styles.srOnly}>Buscar conversación</span><Input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Buscar nombre o teléfono…" maxLength={100} /></label><div className={styles.purposeFilters} role="group" aria-label="Tipo de atención"><button type="button" onClick={()=>navigate("enrollment")}>Enrolamientos</button><button type="button" onClick={()=>navigate("welcome")}>Aprobaciones</button><button type="button" onClick={()=>{setTag("FINSERPAY");setPage(1);}}>Clientes</button><button type="button" onClick={()=>{setFilter("unassigned");setTag("");setPage(1);}}>Sin asignar</button></div><AttentionWorkFilters filter={filter} tag={tag} central={currentActor.central} inbox={inbox} change={(nextFilter, nextTag) => { setFilter(nextFilter); setTag(nextTag); setPage(1); }} /><div className={styles.conversationList} aria-busy={loading}>{loading && !inbox ? <LoadingState label="Cargando conversaciones…" /> : error ? <EmptyState title="No se pudo abrir la bandeja" description="Vuelve a intentar la consulta." /> : !inbox?.conversations.length ? <DashboardEmpty icon={Inbox} title={search ? "Sin coincidencias" : "No hay conversaciones en este filtro"} text={search ? "Prueba con otro nombre o teléfono." : currentActor.central ? "Las conversaciones aparecerán al recibir mensajes en el canal conectado." : "Las conversaciones asignadas a tu perfil aparecerán aquí."} /> : inbox.conversations.map(conversation => <button type="button" key={conversation.id} className={`${styles.conversation} ${selected === conversation.id ? styles.selected : ""}`} aria-pressed={selected === conversation.id} onClick={() => selectConversation(conversation.id)}><span className={styles.avatar}>{initials(contactName(conversation))}</span><span className={styles.conversationBody}><span className={styles.conversationTitle}><strong>{contactName(conversation)}</strong><time dateTime={conversation.lastContactAt || undefined}>{time(conversation.lastContactAt)}</time></span>{conversation.customerIdentity && <span className={styles.contactDocument}>{conversation.customerIdentity.documentLabel || "Cédula"} {conversation.customerIdentity.document}</span>}<span className={styles.preview}>{conversation.preview || "Abre la conversación para consultar su historial"}</span><ConversationLabels conversation={conversation} /><span className={styles.conversationFooter}><small title={`${conversation.assigneeName || "Sin asignar"} · ${statusNames[conversation.status]}`}>{conversation.assigneeName || "Sin asignar"}</small><span className={styles.srOnly}>Estado: {statusNames[conversation.status]}</span><AttentionConversationIndicators conversation={conversation} /></span></span></button>)}</div><div className={styles.pagination}><Button variant="ghost" aria-label="Página anterior" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden="true" size={18} /></Button><span>{page} / {Math.max(1, Math.ceil((inbox?.total ?? 0) / (inbox?.pageSize || 40)))}</span><Button variant="ghost" aria-label="Página siguiente" disabled={loading || !inbox || page * inbox.pageSize >= inbox.total} onClick={() => setPage(value => value + 1)}><ChevronRight aria-hidden="true" size={18} /></Button></div></aside>
            <ChatDropSurface key={selected || "no-chat"} receive={files => {
              if (!detail || detail.conversation.channel !== "whatsapp") return "Selecciona un chat de WhatsApp para adjuntar el archivo.";
              if (!replyWindowOpen(detail)) return detail.messaging?.reason || "El envío no está disponible en este chat.";
              const draft = replyDrafts[detail.conversation.id] || emptyReply;
              if (busyRef.current || syncingRef.current || draft.locked) return "Espera a que termine el envío o consulta su estado antes de adjuntar otro archivo.";
              if (files.length !== 1) return "Arrastra un archivo a la vez.";
              if (draft.file) return "Ya tienes un archivo preparado. Envíalo o quítalo antes de adjuntar otro.";
              const invalid = replyValidation({ ...draft, file: files[0] });
              if (invalid) return invalid;
              changeReply(detail.conversation.id, { file: files[0] }); return null;
            }}>{!selected ? <div className={styles.selectPrompt}><span><MessageCircle aria-hidden="true" size={37} /></span><h2>Tu espacio de atención</h2><p>Selecciona una conversación para responder y consultar su seguimiento.</p></div> : <>
              <div className={styles.chatHeader}><Button variant="ghost" className={styles.backButton} aria-label="Volver a conversaciones" onClick={() => selectConversation(null)}><ArrowLeft aria-hidden="true" size={18} /></Button><span className={styles.avatar}>{initials(detail ? contactName(detail.conversation) : "Contacto")}</span><div className={styles.chatIdentity}><div className={styles.chatTitle}><h2 ref={chatHeading} tabIndex={-1}>{detail ? contactName(detail.conversation) : "Conversación"}</h2>{detail && <CustomerBadge conversation={detail.conversation} />}</div>{detail?.conversation.customerIdentity && <span className={styles.contactDocument}>{detail.conversation.customerIdentity.documentLabel || "Cédula"} {detail.conversation.customerIdentity.document}</span>}<span>{detail ? detail.conversation.phone || "Teléfono no disponible" : "Consultando historial…"}{detail && ` · ${detail.conversation.channel === "whatsapp" ? "WhatsApp" : "Gestión interna"}`}</span></div><Button variant="secondary" className={styles.customerToggle} aria-expanded={showCustomer} onClick={() => setShowCustomer(value => !value)}><UserRound aria-hidden="true" size={16} /> Ficha</Button>{detail && <details className={styles.chatMenu} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="Gestionar conversación" title="Gestionar conversación"><MoreVertical aria-hidden="true" size={21} /></summary><div className={styles.chatActions}><Status conversation={detail.conversation} /><span className={styles.assignee}><UserRound aria-hidden="true" size={14} />{detail.conversation.assigneeName || "Sin analista asignado"}</span>{detail.permissions.claim && detail.conversation.status !== "open" && <Button disabled={busy} onClick={() => void mutate({ action: "claim" })}>Atender</Button>}{detail.permissions.manage && <Button variant="secondary" disabled={busy} onClick={() => void mutate({ action: detail.conversation.status === "closed" ? "reopen" : "close" })}>{detail.conversation.status === "closed" ? "Reabrir" : "Finalizar"}</Button>}{detail.permissions.assign && <details className={styles.assignmentMenu}><summary><Users aria-hidden="true" size={17} /> Asignar</summary><div className={styles.assignment}><label className={styles.srOnly} htmlFor="attention-transfer">Asignar analista</label><Select id="attention-transfer" value="" disabled={busy || !analysts.length} onChange={event => { if (event.target.value) { event.currentTarget.closest("details")?.removeAttribute("open"); void mutate({ action: "transfer", assigneeKey: event.target.value }); } }}><option value="">{detail.conversation.assigneeKey ? "Cambiar analista…" : "Asignar analista…"}</option>{analysts.filter(person => person.key !== detail.conversation.assigneeKey).map(person => <option key={person.key} value={person.key}>{person.name}</option>)}</Select><span>Solo analistas activos</span></div></details>}</div></details>}</div>
              {detailError && <div className={styles.error} role="alert"><span>{detailError}</span><Button variant="secondary" disabled={busy || detailLoading} onClick={() => void loadDetail(selected)}>Actualizar</Button></div>}
              {detailLoading && !detail ? <LoadingState label="Consultando historial y ficha…" /> : detail && <>

                <AttentionObservedRead key={`read:${detail.conversation.id}`} detail={detail} active={!showCustomer && !busy && !syncing} log={messageLog} request={api} onRead={() => void loadInbox()} onError={error => { handleFinancialAccessError(detail.conversation.id, error); }} /><div className={styles.historyViewport}><div ref={messageLog} className={styles.messages} role="log" aria-label="Mensajes sincronizados" onScroll={() => { const log = messageLog.current; if (log) { const away = log.scrollHeight - log.scrollTop - log.clientHeight > 100; followLatest.current = !away; setShowLatest(away); } }}>{detail.historyTruncated && <p className={styles.historyNotice}>Se muestra una parte del historial disponible. La siguiente sincronización incorpora más mensajes.</p>}{detail.messages.length ? detail.messages.map((message, index) => <Fragment key={message.id}>{(index === 0 || messageDay(message.sentAt) !== messageDay(detail.messages[index - 1].sentAt)) && <p className={styles.daySeparator}>{date(message.sentAt, true)}</p>}<article className={`${styles.message} ${message.direction === "outbound" ? styles.outbound : ""}`}>{message.direction === "outbound" && (index === 0 || detail.messages[index - 1].direction !== "outbound" || detail.messages[index - 1].author !== message.author) && <span>{message.author || (message.deliveryStatus ? "Equipo FINSER PAY" : "Dapta")}</span>}<MessageContent text={message.text} media={message.attachment} mediaReady={keepLatestAfterMedia} dapta={detail.conversation.channel === "whatsapp" && Boolean(detail.conversation.externalId)} /><div className={styles.messageMeta}><time dateTime={message.sentAt} title={date(message.sentAt)}>{time(message.sentAt)}</time><MessageDelivery message={message} /></div></article></Fragment>) : <DashboardEmpty icon={MessageCircle} title={detail.conversation.channel === "internal" ? "Gestión interna" : "Historial pendiente de sincronización"} text={detail.conversation.channel === "internal" ? "Registra el seguimiento en notas y tareas de la ficha." : "Los mensajes aparecerán al actualizar el canal de WhatsApp."} />}</div>
                {showLatest && <Button variant="secondary" className={styles.latestButton} onClick={goToLatest}><ArrowDown aria-hidden="true" size={17} /> Último mensaje</Button>}</div>{detail.conversation.channel === "whatsapp" ? <ReplyComposer key={detail.conversation.id} detail={detail} actorKey={currentActor.key} quickReplies={inbox?.quickReplies || []} templateSent={() => refreshAfterFinancialAction(detail.conversation.id)} templateBusyChanged={quickReplyBusyChanged} draft={replyDrafts[detail.conversation.id] || emptyReply} busy={busy || syncing} fallbackDapta={!inbox?.integration.canSend && Boolean(detail.conversation.externalId)} change={patch => changeReply(detail.conversation.id, patch)} send={() => void sendReply()} resolve={() => void resolveReply()} restart={() => restartReply(detail.conversation.id)} retry={() => void sendReply(true)} discard={() => void discardReply()} /> : <footer className={styles.historyFooter}><MessageCircle aria-hidden="true" size={16} /><span>{detail.workRequest ? `${detail.workRequest.ally} · ${detail.workRequest.advisor}` : "Gestión interna · asignación y seguimiento por analistas."}</span>{detail.workRequest && <Button variant="secondary" onClick={()=>{setWorkSelection(detail.workRequest!.id);setView(detail.workRequest!.kind);}}>Continuar solicitud</Button>}</footer>}
              </>}
            </>}</ChatDropSurface>

            <AttentionContactSummary detail={detail} openManagement={() => setShowCustomer(true)} />
          </section>
          <FinserSidePanel open={showCustomer && Boolean(detail)} keepMounted title="Ficha del contacto" closeLabel="Volver al chat" busy={busy} onClose={() => setShowCustomer(false)}><div className={styles.customer}>{detail && <CustomerPanel key={detail.conversation.id} detail={detail} busy={busy} mutate={mutate} canOpenRecord={canSupervise} financial={{ attempts: financialAttempts[detail.conversation.id] || {}, disabled: busy || syncing, accessDenied: error => handleFinancialAccessError(detail.conversation.id, error), grant: input => grantExtension(detail.conversation.id, input), sendReceipt: (input, retry) => sendReceipt(detail.conversation.id, input, retry), resolveReceipt: () => resolveReceipt(detail.conversation.id), discardReceipt: () => discardReceipt(detail.conversation.id) }} />}</div></FinserSidePanel>
        </>}

        {boardOpened && contentReady && <div className={styles.boardPane} hidden={view !== "board"}><AttentionBoard key={currentActor.key} actor={currentActor} active={view === "board"} onRefresh={boardRevision} onOpenConversation={selectConversation} onAccessDenied={clearInaccessibleData} busyChanged={quickReplyBusyChanged} /></div>}

        {(view === "enrollment" || view === "welcome") && contentReady && <div className={styles.workPane}><AttentionWorkQueues key={`${view}:${workSelection}`} kind={view} initialId={workSelection} /></div>}
        {view === "agenda" && contentReady && <AttentionAgendaView request={api} revision={inbox} disabled={busy || syncing} openChat={selectConversation} busyChanged={quickReplyBusyChanged} saved={() => { void loadInbox(); if (selectionRef.current) void loadDetail(selectionRef.current); }} accessDenied={(error, id) => { if (id) return handleFinancialAccessError(id, error); if (error instanceof ApiError && [401, 403].includes(error.status)) { clearInaccessibleData(errorMessage(error)); return true; } return false; }} /> }

        {view === "team" && <Card className={styles.fullTeam}><div className={styles.cardHeading}><div><h2>Analistas de atención</h2><p>Las conversaciones solo se asignan a perfiles de analista activos.</p></div><Badge>{analysts.length} analistas</Badge></div><TeamRows team={team} loading={loading && !inbox} /><div className={styles.teamNote}><ShieldCheck aria-hidden="true" size={17} /><p>Administración asigna los chats. Cada analista consulta y gestiona únicamente las conversaciones de su bandeja.</p></div></Card>}
        {view === "settings" && <div className={styles.settingsGrid}>
          {currentActor.central && contentReady && <AttentionCloseAll key={currentActor.key} actorKey={currentActor.key} request={api} onDone={() => { void loadInbox(); if (selectionRef.current) void loadDetail(selectionRef.current); }} busyChanged={quickReplyBusyChanged} accessDenied={failure => { if (failure instanceof ApiError && [401, 403].includes(failure.status)) { clearInaccessibleData(errorMessage(failure)); return true; } return false; }} />}
          <Card className={styles.settingsCard}><div className={styles.cardHeading}><h2><MessageCircle aria-hidden="true" size={20} /> Canal de WhatsApp</h2><Badge tone={inbox?.integration.canSend ? "positive" : "warning"}>{inbox?.integration.canSend ? "Meta conectado" : "Envío pendiente"}</Badge></div><p>{inbox?.integration.message || "Consultando estado del canal…"}</p><div className={styles.integrationFacts}><div><Check aria-hidden="true" size={17} /><span>Historial importado y mensajes recibidos en FINSER PAY</span></div><div><Users aria-hidden="true" size={17} /><span>Asignación exclusiva a analistas FINSER PAY</span></div><div><LockKeyhole aria-hidden="true" size={17} /><span>{inbox?.integration.canSend ? "Respuestas por Meta según permisos y ventana de atención" : "La lectura está disponible; el envío requiere completar la conexión Meta"}</span></div></div>{currentActor.central && <Button disabled={!syncRestored || syncing || !contentReady || !inbox?.integration.canSync} onClick={() => void sync()}><RefreshCw aria-hidden="true" size={16} />{syncing ? "Actualizando…" : syncCursor ? "Continuar importación" : "Importar historial Dapta"}</Button>}<p className={styles.settingFootnote}>Las credenciales del canal se guardan únicamente en el servidor.</p></Card>
          <Card className={styles.repliesPanel}><div className={styles.cardHeading}><h2>Respuestas rápidas</h2>{currentActor.central && <Button variant="ghost" disabled={!contentReady || busy} onClick={() => setShowReplies(value => !value)}>{showReplies ? "Cerrar" : "Aprobar respuesta"}</Button>}</div><p className={styles.muted}>Contenido aprobado por administración de FINSER PAY.</p>{inbox?.quickReplies.length ? <ul className={styles.replyList}>{inbox.quickReplies.map(reply => <li key={reply.id}><strong>{reply.title}</strong><p>{reply.text}</p><small>Aprobada por {reply.approvedBy} · {date(reply.approvedAt, true)}</small></li>)}</ul> : <DashboardEmpty icon={FileText} title="Una voz para todo el equipo" text="El equipo puede consultar aquí las respuestas aprobadas por administración." />}{showReplies && currentActor.central && <QuickReplyForm disabled={busy} busyChanged={quickReplyBusyChanged} saved={() => { setShowReplies(false); setNotice("Respuesta aprobada y guardada."); void loadInbox(); }} />}</Card>
        </div>}
    </main>
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
function financialDay(value: string | null) {
  if (!value) return "No disponible";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-05:00` : value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "long", year: "numeric" }).format(parsed) : "No disponible";
}
function todayInColombia() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value || "").join("-");
}
const creditStateNames: Record<AttentionFinancialCredit["state"], string> = { AL_DIA: "Al día", EN_MORA: "En mora", PAGADO: "Pagado", ANULADO: "Anulado", NO_VERIFICADO: "Estado por verificar" };
type FinancialConfirmation = { kind: "extension"; input: AttentionExtensionInput; description: string } | { kind: "receipt"; input: AttentionReceiptSendInput; description: string };
function FinancialPanel({ detail, actions }: { detail: AttentionDetail; actions: FinancialActions }) {
  const [data, setData] = useState<AttentionFinancial | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creditId, setCreditId] = useState("");
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [observation, setObservation] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [promiseDate, setPromiseDate] = useState("");
  const [promiseConfirmed, setPromiseConfirmed] = useState(false);
  const [reviewedFailure, setReviewedFailure] = useState("");
  const [confirmation, setConfirmation] = useState<FinancialConfirmation | null>(null);
  const alive = useRef(true);
  const accessDenied = useRef(actions.accessDenied);
  const readController = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const id = detail.conversation.id;
  useEffect(() => { accessDenied.current = actions.accessDenied; }, [actions.accessDenied]);
  const load = useCallback(async () => {
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    const version = ++readVersion.current; setLoading(true); setError("");
    try {
      const result = await api<AttentionFinancial>(`/api/atencion/${encodeURIComponent(id)}/financial`, { signal: controller.signal });
      if (!alive.current || controller.signal.aborted || version !== readVersion.current) return null;
      setData(result); setCreditId(current => result.credits.some(credit => String(credit.id) === current) ? current : result.credits.length === 1 ? String(result.credits[0].id) : "");
      return result;
    } catch (err) {
      if (alive.current && !controller.signal.aborted && version === readVersion.current) {
        if (accessDenied.current(err)) return null;
        setData(null); setError(errorMessage(err));
      }
      return null;
    } finally { if (alive.current && !controller.signal.aborted && version === readVersion.current) setLoading(false); }
  }, [id]);
  useEffect(() => {
    alive.current = true; const timer = setTimeout(() => { void load(); }, 0);
    return () => { alive.current = false; clearTimeout(timer); readController.current?.abort(); };
  }, [load, detail.conversation.linkedCreditId, detail.conversation.creditClassification?.status]);
  const credit = data?.credits.find(item => String(item.id) === creditId);
  const choice = credit?.extension.choices.find(item => String(item.days) === days);
  const extensionAttempt = actions.attempts.extension;
  const receiptAttempt = actions.attempts.receipt;
  const extensionLocked = Boolean(extensionAttempt && ["pending", "uncertain"].includes(extensionAttempt.phase));
  const extensionNeedsReview = extensionAttempt?.phase === "failed" && extensionAttempt.requiresReview && extensionAttempt.input.requestId !== reviewedFailure && extensionAttempt.input.creditId === credit?.id;
  const receiptLocked = Boolean(receiptAttempt && ["pending", "uncertain", "missing"].includes(receiptAttempt.phase));
  const disabled = actions.disabled || loading;
  const canSend = replyWindowOpen(detail);
  const sendReason = detail.messaging?.reason || (!detail.permissions.canSend ? "El envío por WhatsApp no está autorizado para esta conversación." : "La ventana de atención de WhatsApp está cerrada.");
  function selectCredit(value: string) {
    setCreditId(value); setExtensionOpen(false); setDays(""); setReason(""); setObservation(""); setPromiseAmount(""); setPromiseDate(""); setPromiseConfirmed(false); setConfirmation(null); setError("");
  }
  async function refreshExtensionReview() {
    if (disabled || extensionLocked) return;
    setConfirmation(null); setPromiseConfirmed(false);
    const fresh = await load(); if (!fresh || !alive.current) return;
    setReviewedFailure(extensionAttempt?.input.requestId || "");
    if (extensionAttempt?.input.creditId === credit?.id) setExtensionOpen(true);
  }
  function openExtension() {
    if (!credit?.extension.canGrant || disabled || extensionLocked) return;
    if (!promiseAmount) setPromiseAmount(String(credit.extension.promise.amount));
    if (!promiseDate) setPromiseDate(credit.extension.promise.date);
    setExtensionOpen(value => !value);
  }
  async function prepareExtension(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!credit || disabled || extensionLocked || extensionNeedsReview || !promiseConfirmed) return;
    const selectedId = credit.id; const fresh = await load(); if (!fresh || !alive.current) return;
    const current = fresh.credits.find(item => item.id === selectedId);
    const selectedChoice = current?.extension.choices.find(item => String(item.days) === days);
    if (!current?.extension.canGrant || !selectedChoice || !current.extension.installmentNumber || !current.extension.dueDate) { setError(current?.extension.blockedReason || "La opción cambió. Revisa los días disponibles antes de continuar."); return; }
    if (current.extension.installmentNumber !== credit.extension.installmentNumber || current.extension.dueDate !== credit.extension.dueDate) {
      setPromiseConfirmed(false); setError("Cambió la cuota pendiente. Conservamos tus datos; revisa la cuota y su vencimiento y vuelve a confirmar el compromiso."); return;
    }
    const amount = Number(promiseAmount);
    if (reason.trim().length < 5 || observation.trim().length < 5 || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(promiseDate) || promiseDate < todayInColombia() || promiseDate > selectedChoice.expiresOn) {
      setError("Completa motivo y observación (mínimo 5 caracteres), un importe positivo y una fecha de compromiso vigente dentro de la prórroga."); return;
    }
    const input: AttentionExtensionInput = { creditId: selectedId, days: selectedChoice.days, version: fresh.version, requestId: crypto.randomUUID(), installmentNumber: current.extension.installmentNumber, installmentDueDate: current.extension.dueDate, reason: reason.trim(), observation: observation.trim(), promiseAmount: amount, promiseDate };
    setConfirmation({ kind: "extension", input, description: `Crédito ${current.number}. ${selectedChoice.days} ${selectedChoice.days === 1 ? "día" : "días"} de prórroga para la cuota ${current.extension.installmentNumber}, hasta el ${financialDay(selectedChoice.expiresOn)}. Compromiso confirmado: ${money(amount)} para el ${financialDay(promiseDate)}. Se registra una gestión de cartera como Acuerdo de pago, con motivo y observación. El próximo seguimiento será a las 08:00 (Bogotá) del día siguiente al compromiso.` });
  }
  async function prepareReceipt() {
    if (!credit?.lastPayment?.receiptAvailable || disabled || receiptLocked) return;
    if (!replyWindowOpen(detail)) { setError(sendReason); return; }
    const selectedId = credit.id; const observedPayment = credit.lastPayment.id;
    const fresh = await load(); if (!fresh || !alive.current) return;
    const current = fresh.credits.find(item => item.id === selectedId);
    if (!current?.lastPayment?.receiptAvailable) { setError("El último recibo ya no está disponible. Revisa el crédito seleccionado."); return; }
    if (current.lastPayment.id !== observedPayment) { setError("Cambió el último pago. Revisa el recibo actualizado antes de enviarlo."); return; }
    const input: AttentionReceiptSendInput = { creditId: selectedId, paymentId: current.lastPayment.id, version: fresh.version, requestId: crypto.randomUUID() };
    setConfirmation({ kind: "receipt", input, description: `Se enviará por WhatsApp a ${detail.conversation.phone || "este contacto"} el PDF del último recibo del crédito ${current.number}: pago de ${money(current.lastPayment.amount)} del ${financialDay(current.lastPayment.date)}. Revisa el documento y confirma el destinatario antes de enviarlo.` });
  }
  async function confirmAction() {
    if (!confirmation || disabled) return;
    const pending = confirmation; setConfirmation(null);
    if (pending.kind === "extension") {
      setPromiseConfirmed(false);
      const result = await actions.grant(pending.input);
      if (result && alive.current) { setExtensionOpen(false); setPromiseConfirmed(false); await load(); }
    } else await actions.sendReceipt(pending.input);
  }
  return <section className={styles.financialPanel} aria-label="Información financiera autorizada">
    <div className={styles.financialHeading}><h3><Wallet aria-hidden="true" size={18} /> Crédito y pagos</h3><Button variant="ghost" aria-label="Actualizar información financiera" disabled={disabled} onClick={() => void load()}><RefreshCw aria-hidden="true" size={17} /></Button></div>
    {error && <div className={styles.panelError} role="alert">{error}<Button variant="secondary" disabled={disabled} onClick={() => void load()}>Reintentar consulta</Button></div>}
    {loading && !data && <LoadingState label="Consultando créditos autorizados…" />}
    {data && !data.credits.length && <p className={styles.financialEmpty}>{data.blockedReason || "Este contacto no tiene créditos autorizados para consultar."}</p>}
    {data && data.credits.length > 1 && <label className={styles.creditSelector}>Selecciona el crédito<Select value={creditId} disabled={disabled} onChange={event => selectCredit(event.target.value)}><option value="">Elige un crédito para continuar</option>{data.credits.map(item => <option value={item.id} key={item.id}>{item.number} · {creditStateNames[item.state]}</option>)}</Select></label>}
    {credit && <>
      <div className={styles.financialSummary}><span>Crédito</span><div><strong>{credit.number}</strong><StatusPill tone={credit.state === "EN_MORA" ? "warning" : credit.state === "AL_DIA" || credit.state === "PAGADO" ? "positive" : "neutral"}>{creditStateNames[credit.state]}</StatusPill></div>{credit.extension.installmentNumber && <p>Cuota {credit.extension.installmentNumber} · vence {financialDay(credit.extension.dueDate)}</p>}<Link className={styles.textLink} href={`/dashboard/aprobaciones/gestion-cartera?creditId=${credit.id}`} target="_blank" rel="noopener noreferrer">Gestiones e historial <ExternalLink aria-hidden="true" size={15} /></Link></div>
      <div className={styles.financialSection}><h4><CalendarClock aria-hidden="true" size={18} /> Prórroga de pago</h4>{credit.extension.active && <p className={styles.extensionActive}>Prórroga vigente{credit.extension.active.expiresOn ? ` hasta el ${financialDay(credit.extension.active.expiresOn)}` : ""}.</p>}<p>Puede concederse antes de vencer la cuota pendiente. De 1 a 4 días desde su vencimiento, con límite en los días 06 y 21.</p><Button variant="secondary" disabled={disabled || !credit.extension.canGrant || extensionLocked} onClick={openExtension}>{extensionOpen ? "Cerrar formulario" : "Conceder prórroga"}</Button>{!credit.extension.canGrant && <p className={styles.actionReason}>{credit.extension.blockedReason || "Esta prórroga no está disponible para el crédito seleccionado."}</p>}
        {extensionOpen && <form className={styles.extensionForm} onSubmit={prepareExtension}><label>Días autorizados<Select required value={days} disabled={disabled || extensionLocked} onChange={event => { setDays(event.target.value); setPromiseConfirmed(false); }}><option value="">Selecciona los días</option>{credit.extension.choices.map(item => <option value={item.days} key={item.days}>{item.days} {item.days === 1 ? "día" : "días"} · hasta {financialDay(item.expiresOn)}</option>)}</Select></label><label>Motivo<textarea rows={2} required minLength={5} maxLength={500} value={reason} disabled={disabled || extensionLocked} onChange={event => setReason(event.target.value)} placeholder="Motivo de la prórroga" /></label><label>Observación de la gestión<textarea rows={2} required minLength={5} maxLength={2000} value={observation} disabled={disabled || extensionLocked} onChange={event => setObservation(event.target.value)} placeholder="Acuerdo y contexto de la atención" /></label><label>Compromiso de pago (COP)<Input type="number" min="0.01" step="0.01" required value={promiseAmount} disabled={disabled || extensionLocked} onChange={event => { setPromiseAmount(event.target.value); setPromiseConfirmed(false); }} /></label><label>Fecha del compromiso<Input type="date" required min={todayInColombia()} max={choice?.expiresOn} value={promiseDate} disabled={disabled || extensionLocked} onChange={event => { setPromiseDate(event.target.value); setPromiseConfirmed(false); }} /></label><label className={styles.commitmentCheck}><input type="checkbox" checked={promiseConfirmed} disabled={disabled || extensionLocked} onChange={event => setPromiseConfirmed(event.target.checked)} />He confirmado con el cliente el valor y la fecha del compromiso.</label><Button type="submit" disabled={disabled || extensionLocked || extensionNeedsReview || !choice || !promiseConfirmed}>Revisar y confirmar</Button></form>}
      </div>
      <div className={styles.financialSection}><h4><FileText aria-hidden="true" size={18} /> Último recibo de pago</h4>{credit.lastPayment ? <><div className={styles.lastPayment}><strong>{money(credit.lastPayment.amount)}</strong><span>{financialDay(credit.lastPayment.date)}</span><small>{credit.lastPayment.method}</small></div><div className={styles.receiptActions}>{credit.lastPayment.receiptAvailable ? <a className="fp-ui-button is-secondary" href={`/api/atencion/${encodeURIComponent(id)}/receipts/latest?creditId=${credit.id}`} target="_blank" rel="noopener noreferrer"><Download aria-hidden="true" size={17} /> Ver PDF</a> : <p className={styles.actionReason}>El PDF de este pago no está disponible.</p>}<Button disabled={disabled || receiptLocked || !credit.lastPayment.receiptAvailable || !canSend} onClick={() => void prepareReceipt()}><Send aria-hidden="true" size={17} /> Enviar recibo</Button></div>{!canSend && <p className={styles.actionReason}>{sendReason}</p>}</> : <p>Aún no hay pagos registrados para este crédito.</p>}</div>
    </>}
    {extensionAttempt && <div className={`${styles.operationResult} ${extensionAttempt.phase === "confirmed" ? styles.operationConfirmed : ""}`} role="status"><strong>Crédito {data?.credits.find(item => item.id === extensionAttempt.input.creditId)?.number || extensionAttempt.input.creditId}</strong><p>{extensionAttempt.phase === "failed" && extensionAttempt.input.requestId === reviewedFailure ? "Datos actualizados. Conservamos el motivo, la observación y el compromiso; revisa la cuota antes de una nueva confirmación." : extensionAttempt.message}</p>{extensionAttempt.phase === "confirmed" && extensionAttempt.management && <><p>Próximo seguimiento: {date(extensionAttempt.management.nextFollowUpAt)} (Bogotá).</p><Link className={styles.textLink} href={`/dashboard/aprobaciones/gestion-cartera?creditId=${extensionAttempt.management.creditId}`} target="_blank" rel="noopener noreferrer">Ver en Gestión de cartera <ExternalLink aria-hidden="true" size={15} /></Link></>}{extensionAttempt.phase === "failed" && <Button variant="secondary" disabled={disabled} onClick={() => void refreshExtensionReview()}><RefreshCw aria-hidden="true" size={16} /> Actualizar cuota y revisar</Button>}{extensionAttempt.phase === "uncertain" && <Button variant="secondary" disabled={disabled} onClick={async () => { const result = await actions.grant(extensionAttempt.input); if (result && alive.current) { setExtensionOpen(false); await load(); } }}>Reintentar misma solicitud</Button>}</div>}
    {receiptAttempt && <div className={`${styles.operationResult} ${receiptAttempt.phase === "confirmed" ? styles.operationConfirmed : ""}`} role="status"><strong>Crédito {data?.credits.find(item => item.id === receiptAttempt.input.creditId)?.number || receiptAttempt.input.creditId}</strong><p>{receiptAttempt.message}</p>{receiptLocked && <Button variant="secondary" disabled={disabled} onClick={() => void actions.resolveReceipt()}><RefreshCw aria-hidden="true" size={16} /> Consultar estado del recibo</Button>}{receiptAttempt.phase === "missing" && <><Button variant="secondary" disabled={disabled} onClick={() => void actions.discardReceipt()}>Descartar intento</Button><Button disabled={disabled || !canSend} onClick={() => void actions.sendReceipt(receiptAttempt.input, true)}>Reintentar misma solicitud</Button></>}</div>}
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.kind === "extension" ? "Confirmar prórroga" : "Enviar último recibo"} description={confirmation?.description || ""} confirmLabel={confirmation?.kind === "extension" ? "Conceder prórroga" : "Enviar PDF por WhatsApp"} busy={actions.disabled} onCancel={() => { if (!actions.disabled) setConfirmation(null); }} onConfirm={() => void confirmAction()} />
  </section>;
}
function CustomerPanel({ detail, busy, mutate, canOpenRecord, financial }: { detail: AttentionDetail; busy: boolean; mutate: Mutate; canOpenRecord: boolean; financial: FinancialActions }) {
  const [tab, setTab] = useState<"summary" | "followup">("summary");
  const [note, setNote] = useState(""); const [task, setTask] = useState(""); const [dueAt, setDueAt] = useState(""); const [tag, setTag] = useState(""); const [candidate, setCandidate] = useState("");
  const { customer, conversation, permissions } = detail;
  const matchMessages: Record<AttentionCustomer["match"], string> = { linked: "Vinculada a la ficha existente", none: "No hay una ficha vinculada a este contacto.", ambiguous: "Hay varias coincidencias. Confirma la identidad antes de vincular un crédito.", restricted: "La ficha requiere autorización dentro de esta conversación." };
  const classification = conversation.creditClassification?.status;
  const classificationText = classification === "finserpay" ? "Cliente con crédito vigente o pagado" : classification === "no_credit" ? "Contacto sin crédito identificado" : classification === "ambiguous" ? "Identidad por confirmar" : "Clasificación pendiente de verificar";
  const manualTags = conversation.tags.filter(value => !isReservedTag(value));
  return <div className={styles.customerContent}>
    <div className={styles.customerOverview}><div className={styles.customerIdentity}><span className={styles.avatar}>{initials(conversation.customerIdentity?.name || customer.name || conversation.name)}</span><div><h3>{conversation.customerIdentity?.name || customer.name || conversation.name}</h3>{conversation.customerIdentity ? <span className={styles.contactDocument}>{conversation.customerIdentity.documentLabel || "Cédula"} {conversation.customerIdentity.document}</span> : customer.documentMasked && <span>{customer.documentMasked}</span>}<span>{conversation.phone || "Teléfono no disponible"}</span></div></div><p>{classificationText}</p></div>
    <div className={styles.customerTabs} role="group" aria-label="Secciones de la ficha"><button type="button" aria-pressed={tab === "summary"} onClick={() => setTab("summary")}><Wallet aria-hidden="true" size={17} /> Resumen</button><button type="button" aria-pressed={tab === "followup"} onClick={() => setTab("followup")}><ClipboardList aria-hidden="true" size={17} /> Seguimiento</button></div>
    <div className={styles.customerTabBody}>
      <div hidden={tab !== "summary"}>
        {customer.match !== "linked" && <section className={styles.customerSection}><p className={styles.matchMessage}>{matchMessages[customer.match]}</p>{permissions.assign && customer.candidates.length > 0 && <div className={styles.compactForm}><label>Vincular ficha autorizada<Select value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)}><option value="">Selecciona la ficha correcta</option>{customer.candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.documentMasked} · {item.folio}</option>)}</Select></label><Button variant="secondary" disabled={busy || !candidate} onClick={() => void mutate({ action: "link", creditId: Number(candidate) })}>Vincular ficha</Button></div>}{customer.match === "none" && canOpenRecord && <Link href="/dashboard/creditos" className={styles.textLink}>Completar solicitud <ArrowRight aria-hidden="true" size={15} /></Link>}</section>}
        <FinancialPanel detail={detail} actions={financial} />
        {classification !== "finserpay" && permissions.manage && <div className={styles.contactFollowup}><Button variant="secondary" onClick={() => setTab("followup")}><Tag aria-hidden="true" size={17} /> Etiquetar y dar seguimiento</Button></div>}
        {customer.studies.length > 0 && <section className={styles.customerSection}><details><summary className={styles.panelDisclosure}>Estudios de crédito ({customer.studies.length})</summary>{customer.studies.map(study => <div className={styles.study} key={study.id}><Badge>{study.state}</Badge><time dateTime={study.createdAt}>{date(study.createdAt, true)}</time></div>)}</details></section>}
        {canOpenRecord && customer.financialAllowed && customer.credits.length > 0 && <section className={styles.customerSection}>{customer.credits.map(credit => <Link className={styles.textLink} key={credit.id} href={`/dashboard/clientes?selected=${credit.id}`}>Expediente {credit.folio} <ArrowRight aria-hidden="true" size={15} /></Link>)}</section>}
      </div>
      <div hidden={tab !== "followup"}>
        <section className={styles.customerSection}><h3><Tag aria-hidden="true" size={17} /> Etiquetas de seguimiento</h3><p className={styles.muted}>Las etiquetas manuales organizan el contacto. FINSERPAY se identifica automáticamente y no se puede editar.</p><div className={styles.tags}>{manualTags.length ? manualTags.map(value => <span key={value}><Badge>{value}</Badge>{permissions.manage && <button type="button" aria-label={`Quitar etiqueta ${value}`} disabled={busy} onClick={() => void mutate({ action: "tags", tags: manualTags.filter(item => item !== value) })}><X aria-hidden="true" size={15} /></button>}</span>) : <p className={styles.muted}>Sin etiquetas manuales</p>}</div>{permissions.manage && <form className={styles.tagForm} onSubmit={async event => { event.preventDefault(); const value = tag.trim(); if (value && !isReservedTag(value) && await mutate({ action: "tags", tags: [...manualTags, value] })) setTag(""); }}><Input aria-label="Nueva etiqueta manual" value={tag} disabled={busy} onChange={event => setTag(event.target.value)} maxLength={30} placeholder="Ej. Interesado, seguimiento" /><Button variant="secondary" type="submit" aria-label="Guardar etiqueta" disabled={busy || !tag.trim() || isReservedTag(tag) || manualTags.length >= 8}><Plus aria-hidden="true" size={18} /></Button></form>}{isReservedTag(tag) && <p className={styles.panelValidation} role="status">FINSERPAY es una etiqueta automática reservada.</p>}</section>
        <section className={styles.customerSection}><h3><MessageCircle aria-hidden="true" size={17} /> Notas internas</h3><p className={styles.muted}>Visibles para el equipo autorizado; no se envían al cliente.</p>{permissions.manage && <form className={styles.compactForm} onSubmit={async event => { event.preventDefault(); if (await mutate({ action: "note", text: note.trim() })) setNote(""); }}><label className={styles.srOnly} htmlFor="attention-note">Texto de la nota interna</label><textarea id="attention-note" rows={3} maxLength={2000} required value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Registra el resultado de la atención…" /><Button variant="secondary" type="submit" disabled={busy || !note.trim()}>Guardar nota</Button></form>}{detail.notesTruncated && <p className={styles.historyNotice}>Se muestran las 300 notas más recientes.</p>}{detail.notes.map(item => <article className={styles.note} key={item.id}><p>{item.text}</p><small>{item.author} · {date(item.createdAt)}</small></article>)}</section>
        <section className={styles.customerSection}><h3><Clock3 aria-hidden="true" size={17} /> Tareas y recordatorios</h3>{detail.tasksTruncated && <p className={styles.historyNotice}>Se muestran hasta 300 tareas, priorizando las pendientes.</p>}{detail.tasks.length ? detail.tasks.map(item => <div className={styles.task} key={item.id}><div><strong className={item.completedAt ? styles.completed : undefined}>{item.title}</strong><small>{item.completedAt ? `Completada · ${date(item.completedAt)}` : item.dueAt ? `Recordatorio · ${date(item.dueAt)}` : "Sin fecha"}</small></div>{permissions.manage && !item.completedAt && <Button variant="ghost" aria-label={`Completar tarea: ${item.title}`} disabled={busy} onClick={() => void mutate({ action: "complete_task", taskId: item.id })}><Check aria-hidden="true" size={18} /></Button>}</div>) : <p className={styles.muted}>Sin tareas registradas.</p>}{permissions.manage && <form className={styles.compactForm} onSubmit={async event => { event.preventDefault(); if (await mutate({ action: "task", text: task.trim(), dueAt: dueAt ? new Date(`${dueAt}:00-05:00`).toISOString() : null })) { setTask(""); setDueAt(""); } }}><label>Tarea<Input value={task} disabled={busy} maxLength={240} required onChange={event => setTask(event.target.value)} placeholder="Próxima gestión" /></label><label>Recordatorio (hora de Colombia)<Input type="datetime-local" value={dueAt} disabled={busy} onChange={event => setDueAt(event.target.value)} /></label><Button variant="secondary" type="submit" disabled={busy || !task.trim()}>Crear tarea</Button><small className={styles.muted}>El recordatorio queda en la ficha; no envía avisos externos.</small></form>}</section>
        <section className={styles.customerSection}><details><summary className={styles.panelDisclosure}>Datos y coordinación interna</summary><dl className={styles.keyValues}><div><dt>Último contacto</dt><dd>{date(conversation.lastContactAt)}</dd></div><div><dt>Analista</dt><dd>{conversation.assigneeName || "Sin asignar"}</dd></div></dl><p className={styles.muted}>{conversation.mode === "human_requested" ? "Hay una solicitud interna de atención humana; falta confirmar el traspaso en Dapta." : "Solicitar apoyo registra una gestión interna. No pausa la IA ni transfiere el chat en Dapta."}</p>{permissions.manage && <Button variant="secondary" disabled={busy || conversation.mode === "human_requested" || conversation.status === "closed"} onClick={() => void mutate({ action: "human_request" })}>Solicitar apoyo humano</Button>}{permissions.assign && conversation.linkedCreditId && <Button variant="ghost" disabled={busy} onClick={() => void mutate({ action: "unlink" })}>Quitar vínculo manual</Button>}</details></section>
      </div>
    </div>
  </div>;
}


function QuickReplyForm({ disabled, saved, busyChanged }: { disabled: boolean; saved: () => void; busyChanged: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    requestKey.current ||= crypto.randomUUID(); submitting.current = true; busyChanged(true); setBusy(true); setError("");
    try {
      await api("/api/atencion/quick-replies", { method: "POST", body: JSON.stringify({ title: data.get("title"), text: data.get("text"), requestId: requestKey.current }) });
      requestKey.current = null; saved();
    } catch (err) { setError(errorMessage(err)); }
    finally { submitting.current = false; busyChanged(false); setBusy(false); }
  }
  return <form className={styles.compactForm} onSubmit={submit} onChange={() => { if (!busy) requestKey.current = null; }}>{error && <p role="alert" className={styles.error}>{error}</p>}<label>Título<Input name="title" required maxLength={80} disabled={disabled || busy} /></label><label>Texto aprobado<textarea name="text" required rows={4} maxLength={2000} disabled={disabled || busy} /></label><label className={styles.approval}><input type="checkbox" required disabled={disabled || busy} /> Confirmo que este contenido está aprobado para atención en FINSER PAY.</label><Button type="submit" disabled={disabled || busy}>{busy ? "Guardando…" : "Aprobar y guardar"}</Button></form>;
}
