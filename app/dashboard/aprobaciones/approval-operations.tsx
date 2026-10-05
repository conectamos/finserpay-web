"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, CalendarClock, CheckCircle2, FileClock, FilePenLine, Mail, Paperclip, Phone, Search, Smartphone, UserRound } from "lucide-react";
import { Badge, Button, Card, Input, LoadingState, Select, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import type { OperationalCaseDetail, OperationalCaseSummary } from "@/lib/approval-operations-types";
import styles from "./approval-operations.module.css";

type Operation = "imei" | "contact" | "signature" | "remission";
type ActivePanel = "imei" | "signature" | null;
type ApiResult = { ok: boolean; code?: string; error?: string; message?: string; operation?: { id: string; status: string; message: string } };
type SearchResult = ApiResult & { items: OperationalCaseSummary[] };
type DetailResult = ApiResult & { item: OperationalCaseDetail };
type ApprovalReviewResult = ApiResult & { item: { review: { revision: number; reviewHash: string | null } } };
type Confirmation = "imei-request" | "imei-confirm" | "signature" | "signature-redirection" | "remission-verify" | "remission-reject" | null;

const casePath = (item: Pick<OperationalCaseSummary, "kind" | "id">) =>
  "/api/aprobaciones/operativo/" + item.kind.toLowerCase() + "/" + item.id;

const dateFormat = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function dateLabel(value: string | null) {
  if (!value) return "Sin registro";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sin registro" : dateFormat.format(date);
}

function visible(value: string | null | undefined) {
  return value?.trim() || "No disponible";
}

function colombianPhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("57") ? digits.slice(2) : digits;
}

function creditTone(status: string | null): "positive" | "warning" | "danger" | "neutral" {
  const normalized = (status || "").toUpperCase();
  if (/MORA|VENCID|ATRAS/.test(normalized)) return "danger";
  if (/FINALIZ|PAGAD|APROB|ACTIV|VIGENTE/.test(normalized)) return "positive";
  if (/PEND|BORRADOR|FIRMA/.test(normalized)) return "warning";
  return "neutral";
}

function creditStatusLabel(status: string) {
  const normalized = status.trim().toUpperCase();
  if (/FINALIZ|PAGAD|CERRAD/.test(normalized)) return "Crédito finalizado";
  if (/MORA|VENCID|ATRAS/.test(normalized)) return "Crédito en mora";
  if (/ACTIV|VIGENTE/.test(normalized)) return "Crédito activo";
  return status;
}

function signatureLabel(status: OperationalCaseDetail["signature"]["status"]) {
  switch (status) {
    case "SIGNED": return "Firmada";
    case "PENDING": return "Pendiente de firma";
    case "TECHNICAL_ERROR": return "Error técnico: requiere revisión";
    default: return "Sin enviar";
  }
}

function replacementLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING_ENROLLMENT: "Pendiente de enrolamiento",
    ENROLLMENT_APPROVED: "Enrolamiento aprobado",
    COMPLETED: "Cambio aplicado",
    CANCELLED: "Solicitud cancelada",
  };
  return labels[status] || status.replace(/_/g, " ").toLowerCase();
}

function remissionLabel(status: string) {
  switch (status) {
    case "PENDING_UPLOAD": return "Foto solicitada";
    case "PENDING_REVIEW": return "Por verificar";
    case "VERIFIED": return "Verificada";
    case "REJECTED": return "Corrección solicitada";
    default: return "En revisión";
  }
}

function eventStatusLabel(status: string, label: string) {
  const normalized = status.toUpperCase();
  if (/FIRMA/i.test(label) && /ERROR|FAIL|REJECT|DECLIN/.test(normalized)) return "Error técnico: requiere revisión";
  const labels: Record<string, string> = {
    PENDING_ENROLLMENT: "Pendiente de enrolamiento",
    ENROLLMENT_APPROVED: "Enrolamiento aprobado",
    PENDING_REAPPROVAL: "Pendiente de nueva aprobación",
    COMPLETED: "Completado",
    PENDING: "Pendiente",
    REQUESTED: "Solicitado",
    SIGNED: "Firmado",
    TECHNICAL_ERROR: "Error técnico: requiere revisión",
  };
  return labels[normalized] || status.replace(/_/g, " ");
}

function technicalOperation(status: string | undefined) {
  return status === "FAILED_SAFE" || status === "UNCERTAIN" || status === "TECHNICAL_ERROR";
}

class ApiRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function jsonRequest<T extends ApiResult>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload?.ok) throw new ApiRequestError(payload?.error || fallback, payload?.code);
  return payload;
}

async function reviewGuard(detail: OperationalCaseDetail) {
  const approvalCreditId = detail.kind === "CREDIT" ? detail.capabilities.preSettlementApprovalCreditId : null;
  if (approvalCreditId == null) return {};
  const result = await jsonRequest<ApprovalReviewResult>(`/api/aprobaciones/${approvalCreditId}/datos`, {},
    "No fue posible verificar la versión actual del expediente. Actualiza el crédito e intenta de nuevo.");
  const revision = result.item?.review?.revision;
  const reviewHash = result.item?.review?.reviewHash;
  if (!Number.isSafeInteger(revision) || revision < 1 || !reviewHash || !/^[a-f0-9]{64}$/i.test(reviewHash)) {
    throw new Error("El expediente necesita una revisión actual antes de modificar el contacto o la firma.");
  }
  return { expectedRevision: revision, expectedReviewHash: reviewHash };
}

function Field({ label, value, icon: Icon }: { label: string; value: string | null | undefined; icon: typeof UserRound }) {
  return <div className={styles.field}><dt className="sr-only">{label}</dt><dd><Icon size={17} strokeWidth={1.8} aria-hidden="true" />{value?.trim() || `${label} no disponible`}</dd></div>;
}

function CaseSummary({ detail }: { detail: OperationalCaseDetail }) {
  const recentEvents = detail.timeline.slice(0, 3).reverse();
  const olderEvents = detail.timeline.slice(3);
  const renderEvent = (event: OperationalCaseDetail["timeline"][number]) => <li key={event.id}>
    <span className={styles.timelineMark} aria-hidden="true" />
    <div className={styles.eventBody}>
      <div className={styles.eventTop}><strong>{event.label}</strong>
        {event.status ? <span className={`${styles.eventStatus} ${/ERROR|FAIL|REJECT/i.test(event.status) ? styles.eventStatusDanger : /PENDING|WAIT/i.test(event.status) ? styles.eventStatusWarning : ""}`}>{eventStatusLabel(event.status, event.label)}</span> : null}</div>
      <time dateTime={event.at}>{dateLabel(event.at)}</time>
      {event.detail ? <p>{event.detail}</p> : null}
      {event.actor ? <small>Por {event.actor}</small> : null}
      {event.evidenceHref?.startsWith("/api/") ? <a className={styles.evidenceLink} href={event.evidenceHref} target="_blank" rel="noopener noreferrer">Ver evidencia</a> : null}
    </div>
  </li>;
  return <Card className={styles.summary}>
    <header className={styles.cardHeader}>
      <div>
        <h2>{visible(detail.clientName)}</h2>
        <p className={styles.creditNumber}>Crédito {visible(detail.number)}</p>
      </div>
      <Badge tone={creditTone(detail.status)}>{creditStatusLabel(visible(detail.status))}</Badge>
    </header>
    <dl className={styles.customer}>
      <Field label="Cédula" value={detail.document} icon={UserRound} />
      <Field label="Celular" value={detail.phone} icon={Phone} />
      <Field label="Correo" value={detail.email} icon={Mail} />
    </dl>
    <div className={styles.equipment}>
      <div className={styles.equipmentIcon}><Smartphone aria-hidden="true" size={48} strokeWidth={1.35} /></div>
      <div className={styles.equipmentDetails}>
        <strong>{visible(detail.equipment)}</strong>
        <p>Equipo financiado</p>
        <dl><dt>IMEI actual</dt><dd>{visible(detail.imei)}</dd></dl>
      </div>
    </div>
    <section className={styles.timeline} aria-labelledby="operations-timeline-title">
      <h3 id="operations-timeline-title">Historial del crédito</h3>
      {recentEvents.length ? <ol>{recentEvents.map(renderEvent)}</ol> : <p className={styles.muted}>Aún no hay acciones registradas para este crédito.</p>}
      {olderEvents.length ? <details className={styles.olderEvents}><summary>Ver {olderEvents.length} acciones anteriores</summary>
        <ol>{olderEvents.map(renderEvent)}</ol></details> : null}
    </section>
  </Card>;
}

function EmptyCreditWorkspace({ notFound = false }: { notFound?: boolean }) {
  return <Card className={styles.emptyWorkspace} aria-label="Detalle del crédito sin seleccionar">
    <div className={styles.emptySummary}>
      <Search size={22} aria-hidden="true" />
      <h2>{notFound ? "No se encontraron créditos" : "Selecciona un crédito"}</h2>
      <p>{notFound ? "Comprueba la cédula, el número del crédito o los 15 dígitos del IMEI." :
        "Busca por cédula, crédito o IMEI para ver los datos reales del cliente y gestionar el caso."}</p>
    </div>
  </Card>;
}

export default function ApprovalOperations({ onOpenApproval, active = true }: {
  onOpenApproval?: (creditId: number) => void;
  active?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OperationalCaseSummary[]>([]);
  const [selected, setSelected] = useState<OperationalCaseSummary | null>(null);
  const [detail, setDetail] = useState<OperationalCaseDetail | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Operation | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [newImei, setNewImei] = useState("");
  const [reasonPreset, setReasonPreset] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);
  const [editingContact, setEditingContact] = useState(false);
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactReason, setContactReason] = useState("");
  const [signatureReason, setSignatureReason] = useState("");
  const [preparingSignature, setPreparingSignature] = useState(false);
  const [redirectingSignature, setRedirectingSignature] = useState(false);
  const [redirectPhone, setRedirectPhone] = useState("");
  const [redirectReason, setRedirectReason] = useState("");
  const [rejectingRemission, setRejectingRemission] = useState(false);
  const [remissionRejectNote, setRemissionRejectNote] = useState("");
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const evidenceInput = useRef<HTMLInputElement | null>(null);
  const signatureReasonInput = useRef<HTMLInputElement | null>(null);
  const redirectPhoneInput = useRef<HTMLInputElement | null>(null);
  const submitting = useRef(false);
  const wasActive = useRef(active);
  const operationKeys = useRef<{ contact: string | null; signature: string | null }>({ contact: null, signature: null });
  const redirectionRequest = useRef<{ intent: string; key: string } | null>(null);
  const imeiKeys = useRef<{ request: string | null; confirm: string | null }>({ request: null, confirm: null });

  useEffect(() => () => {
    searchController.current?.abort();
    detailController.current?.abort();
  }, []);

  useEffect(() => {
    const returnedToDetail = active && !wasActive.current;
    wasActive.current = active;
    if (!returnedToDetail || !selected || !detail) return;
    const target = selected;
    const controller = new AbortController();
    void jsonRequest<DetailResult>(casePath(target), { signal: controller.signal },
      "No fue posible actualizar el estado del crédito.")
      .then(result => setDetail(current => current?.id === target.id && current.kind === target.kind ? result.item : current))
      .catch(() => {
        if (!controller.signal.aborted) setActionError("No fue posible actualizar el estado. Busca nuevamente el crédito.");
      });
    return () => controller.abort();
  }, [active, selected, detail]);

  useEffect(() => {
    if (preparingSignature) signatureReasonInput.current?.focus();
  }, [preparingSignature]);

  useEffect(() => {
    if (redirectingSignature) redirectPhoneInput.current?.focus();
  }, [redirectingSignature]);

  useEffect(() => {
    setContactPhone(detail?.phone || detail?.signature.sentPhone || "");
    setContactEmail(detail?.email || detail?.signature.sentEmail || "");
    setEditingContact(false);
    setContactReason("");
    setRedirectingSignature(false);
    setRedirectPhone("");
    setRedirectReason("");
    redirectionRequest.current = null;
  }, [detail?.id, detail?.kind, detail?.signature.sentPhone, detail?.signature.sentEmail, detail?.phone, detail?.email]);

  useEffect(() => {
    if (!active || activePanel !== "signature" || detail?.signature.status !== "PENDING" || !selected ||
        selected.id !== detail.id || selected.kind !== detail.kind) return;
    const target = selected;
    let closed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (closed || inFlight || document.hidden || submitting.current) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const result = await jsonRequest<DetailResult>(casePath(target), { signal: controller.signal },
          "No fue posible actualizar el estado de la firma.");
        if (closed) return;
        setDetail(current => current?.id === target.id && current.kind === target.kind ? result.item : current);
        if (result.item.signature.status === "SIGNED") {
          setNotice("Firma aprobada. El estado del expediente se actualizó.");
        }
      } catch {
        // Un fallo transitorio de consulta no cambia el estado de la firma; el siguiente ciclo vuelve a intentarlo.
      } finally {
        inFlight = false;
        controller = null;
      }
    };
    const onVisible = () => { if (!document.hidden) void poll(); };
    const interval = window.setInterval(() => void poll(), 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, [active, activePanel, detail?.id, detail?.kind, detail?.signature.status, selected]);

  async function loadDetail(item: OperationalCaseSummary) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setSelected(item);
    setDetail(null);
    setActivePanel(null);
    setDetailError("");
    setActionError("");
    setNotice("");
    setNewImei("");
    setReasonPreset("");
    setReason("");
    setEvidence(null);
    setSignatureReason("");
    setPreparingSignature(false);
    setRedirectingSignature(false);
    setRedirectPhone("");
    setRedirectReason("");
    setRejectingRemission(false);
    setRemissionRejectNote("");
    operationKeys.current = { contact: null, signature: null };
    redirectionRequest.current = null;
    imeiKeys.current = { request: null, confirm: null };
    setLoadingDetail(true);
    try {
      const result = await jsonRequest<DetailResult>(casePath(item), { signal: controller.signal }, "No fue posible cargar el crédito.");
      if (!controller.signal.aborted) setDetail(result.item);
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "No fue posible cargar el crédito.");
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }

  async function refreshDetail(item: OperationalCaseSummary) {
    const result = await jsonRequest<DetailResult>(casePath(item), {}, "No fue posible actualizar el crédito.");
    setDetail(current => current?.id === item.id && current.kind === item.kind ? result.item : current);
    return result.item;
  }

  async function searchCases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const q = query.trim();
    setSearched(true);
    setSelected(null);
    setDetail(null);
    setActivePanel(null);
    setResults([]);
    setSearchError("");
    setDetailError("");
    setActionError("");
    setNotice("");
    searchController.current?.abort();
    detailController.current?.abort();
    if (!q) {
      setSearchError("Ingresa una cédula, un número de crédito o un IMEI.");
      return;
    }
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    try {
      const result = await jsonRequest<SearchResult>("/api/aprobaciones/operativo?q=" + encodeURIComponent(q),
        { signal: controller.signal }, "No fue posible buscar los créditos.");
      if (controller.signal.aborted) return;
      setResults(result.items);
      if (result.items.length === 1) void loadDetail(result.items[0]);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "No fue posible buscar los créditos.");
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function validateImei() {
    if (!detail || !detail.capabilities.canChangeImei) return false;
    if (!/^\d{15}$/.test(newImei)) {
      setActionError("El nuevo IMEI debe tener exactamente 15 dígitos.");
      return false;
    }
    if (newImei === detail.imei) {
      setActionError("El nuevo IMEI debe ser diferente al actual.");
      return false;
    }
    if (reason.trim().length < 5) {
      setActionError("Describe el motivo del cambio en al menos 5 caracteres.");
      return false;
    }
    if (evidence && (evidence.size > 10 * 1024 * 1024 || !["image/jpeg", "image/png", "application/pdf"].includes(evidence.type))) {
      setActionError("La evidencia debe ser JPG, PNG o PDF y pesar máximo 10 MB.");
      return false;
    }
    setActionError("");
    return true;
  }

  function requestImeiChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitting.current || !validateImei()) return;
    setConfirmation("imei-request");
  }

  async function submitImeiChange(action: "REQUEST" | "CONFIRM") {
    if (!detail || busy || submitting.current || (action === "REQUEST" && !validateImei()) ||
        (action === "CONFIRM" && (!detail.capabilities.canConfirmReplacement || !detail.replacement))) return;
    submitting.current = true;
    setBusy("imei");
    setActionError("");
    setNotice("");
    const target = detail;
    try {
      const body = new FormData();
      body.set("action", action);
      body.set("idempotencyKey", action === "REQUEST"
        ? (imeiKeys.current.request ||= crypto.randomUUID())
        : target.pendingVersion?.status === "PREPARING" || target.pendingVersion?.status === "FAILED_SAFE"
          ? target.pendingVersion.id : (imeiKeys.current.confirm ||= crypto.randomUUID()));
      body.set("confirmed", "true");
      if (action === "CONFIRM") {
        body.set("replacementId", target.replacement!.id);
        if (target.signature.processUuid) body.set("expectedProcessUuid", target.signature.processUuid);
      } else {
        body.set("newImei", newImei);
        body.set("reason", reason.trim());
        body.set("expectedImei", target.imei || "");
        if (target.signature.processUuid) body.set("expectedProcessUuid", target.signature.processUuid);
        if (target.kind === "DRAFT") body.set("expectedEnrollmentReviewId", target.enrollmentReviewId || "");
        if (evidence) body.set("evidence", evidence);
      }
      const result = await jsonRequest<ApiResult>(casePath(target) + "/imei", { method: "POST", body },
        "No fue posible confirmar el cambio de IMEI.");
      const message = result.operation?.message || result.message || (action === "REQUEST" && target.kind === "CREDIT"
        ? "Solicitud registrada. Espera la aprobación del enrolamiento antes de aplicar el IMEI."
        : action === "REQUEST" && target.kind === "DRAFT"
          ? "IMEI actualizado. Consulta el estado de la nueva firma y los controles pendientes."
          : "Cambio aplicado. Consulta el estado actualizado de la firma.");
      if (technicalOperation(result.operation?.status)) setActionError(message);
      else setNotice(message);
      if (action === "REQUEST") imeiKeys.current.request = null;
      else imeiKeys.current.confirm = null;
      setNewImei("");
      setReasonPreset("");
      setReason("");
      setEvidence(null);
      if (evidenceInput.current) evidenceInput.current.value = "";
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible confirmar el cambio de IMEI.");
    } finally {
      setConfirmation(null);
      try { await refreshDetail(target); }
      catch { setActionError("Actualiza el crédito para comprobar si el cambio quedó registrado antes de intentar otra vez."); }
      submitting.current = false;
      setBusy(null);
    }
  }

  async function updateContact() {
    if (!detail || busy || submitting.current || !detail.capabilities.canUpdateContact) return;
    const nextPhone = contactPhone.trim();
    const nextEmail = contactEmail.trim();
    const phoneChanged = nextPhone !== (detail.phone || detail.signature.sentPhone || "").trim();
    const emailChanged = nextEmail !== (detail.email || detail.signature.sentEmail || "").trim();
    if (!phoneChanged && !emailChanged) {
      setActionError("Cambia el celular o el correo antes de guardar.");
      return;
    }
    if (phoneChanged && !/^(?:\+?57)?\d{10}$/.test(nextPhone)) {
      setActionError("El celular debe tener 10 dígitos o el prefijo +57.");
      return;
    }
    if (emailChanged && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setActionError("Ingresa un correo válido.");
      return;
    }
    if (contactReason.trim().length < 5) {
      setActionError("Describe el motivo del cambio de contacto en al menos 5 caracteres.");
      return;
    }
    submitting.current = true;
    setBusy("contact");
    setActionError("");
    setNotice("");
    const target = detail;
    let saved = false;
    try {
      const approvalGuard = await reviewGuard(target);
      const result = await jsonRequest<ApiResult>(casePath(target) + "/contacto", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(phoneChanged ? { phone: nextPhone } : {}),
          ...(emailChanged ? { email: nextEmail } : {}),
          reason: contactReason.trim(), idempotencyKey: operationKeys.current.contact ||= crypto.randomUUID(),
          expectedProcessUuid: target.signature.processUuid, ...approvalGuard }),
      }, "No fue posible actualizar el contacto.");
      setNotice(result.operation?.message || result.message || "Contacto actualizado para el próximo envío.");
      saved = true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible actualizar el contacto.");
    } finally {
      try {
        await refreshDetail(target);
        if (saved) {
          operationKeys.current.contact = null;
          setEditingContact(false);
          setContactReason("");
        }
      } catch {
        setActionError("No fue posible verificar el contacto actualizado. Busca nuevamente el crédito antes de enviar la firma.");
      }
      submitting.current = false;
      setBusy(null);
    }
  }

  async function sendSignature() {
    if (!detail || busy || submitting.current ||
        !(detail.capabilities.canSendSignature || detail.capabilities.canResendSignature)) return;
    const firstSend = detail.capabilities.canSendSignature;
    if (signatureReason.trim().length < 5) {
      setActionError("Describe el motivo del envío en al menos 5 caracteres.");
      return;
    }
    submitting.current = true;
    setBusy("signature");
    setActionError("");
    setNotice("");
    const target = detail;
    let accepted = false;
    try {
      const approvalGuard = await reviewGuard(target);
      const result = await jsonRequest<ApiResult>(casePath(target) + "/firma", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: signatureReason.trim(), idempotencyKey: operationKeys.current.signature ||= crypto.randomUUID(),
          expectedProcessUuid: target.signature.processUuid, confirmed: true, ...approvalGuard }),
      }, firstSend ? "No fue posible enviar la firma." : "No fue posible confirmar el reenvío de firma.");
      const message = result.operation?.message || result.message || "Solicitud de firma registrada. Consulta el estado actualizado.";
      if (technicalOperation(result.operation?.status)) setActionError(message);
      else {
        setNotice(message);
        accepted = true;
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible enviar la firma.");
    } finally {
      setConfirmation(null);
      try {
        const updated = await refreshDetail(target);
        if (accepted && updated.signature.status !== "NOT_SENT") {
          operationKeys.current.signature = null;
          setPreparingSignature(false);
          setSignatureReason("");
        }
      } catch {
        setActionError("No fue posible verificar el envío. Busca nuevamente el crédito antes de intentar de nuevo.");
      }
      submitting.current = false;
      setBusy(null);
    }
  }

  async function redirectPendingSignature() {
    if (!detail || busy || submitting.current) return;
    if (!detail.capabilities.canRedirectPendingSignature) {
      setConfirmation(null);
      setRedirectingSignature(false);
      setActionError("La firma cambió de estado. Actualiza el caso antes de intentar otro reenvío.");
      return;
    }
    const nextPhone = colombianPhone(redirectPhone);
    const previousPhone = colombianPhone(detail.signature.sentPhone || detail.phone);
    const motive = redirectReason.trim();
    if (!/^3\d{9}$/.test(nextPhone)) {
      setActionError("Ingresa un celular colombiano válido de 10 dígitos.");
      return;
    }
    if (nextPhone === previousPhone) {
      setActionError("El nuevo celular debe ser diferente al usado en el envío anterior.");
      return;
    }
    if (motive.length < 5) {
      setActionError("Describe el motivo del reenvío en al menos 5 caracteres.");
      return;
    }
    const processUuid = detail.signature.processUuid;
    if (!processUuid) {
      setActionError("La firma pendiente cambió. Actualiza el caso antes de continuar.");
      return;
    }
    const intent = [detail.kind, detail.id, processUuid, nextPhone, motive].join(":");
    const request = redirectionRequest.current?.intent === intent
      ? redirectionRequest.current
      : { intent, key: crypto.randomUUID() };
    redirectionRequest.current = request;
    submitting.current = true;
    setBusy("signature");
    setActionError("");
    setNotice("");
    const target = detail;
    let accepted = false;
    let failedSafely = false;
    try {
      const result = await jsonRequest<ApiResult>(casePath(target) + "/firma/redireccion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: nextPhone, reason: motive, idempotencyKey: request.key,
          expectedProcessUuid: processUuid, confirmed: true }),
      }, "No fue posible cambiar el número y reenviar la firma.");
      const message = result.operation?.message || result.message ||
        "Firma reenviada al nuevo celular. Espera la confirmación real de FirmaSeguro.";
      failedSafely = result.operation?.status === "FAILED_SAFE";
      if (technicalOperation(result.operation?.status)) setActionError(message);
      else {
        setNotice(message);
        accepted = true;
      }
    } catch (error) {
      failedSafely = error instanceof ApiRequestError && [
        "DRAFT_DISPATCH_DOCUMENT_INVALID",
        "DRAFT_DISPATCH_PREPARATION_FAILED",
        "DRAFT_DISPATCH_TERMS_CHANGED",
        "DRAFT_DISPATCH_CHANGED",
      ].includes(error.code || "");
      setActionError(error instanceof Error ? error.message : "No fue posible cambiar el número y reenviar la firma.");
    } finally {
      setConfirmation(null);
      try {
        const updated = await refreshDetail(target);
        if (accepted && updated.signature.processUuid !== processUuid) {
          redirectionRequest.current = null;
          setRedirectingSignature(false);
          setRedirectPhone("");
          setRedirectReason("");
        } else if (accepted) {
          setNotice("");
          setActionError("No fue posible comprobar el nuevo envío. Actualiza el crédito antes de intentarlo otra vez.");
        } else if (failedSafely && updated.signature.processUuid === processUuid &&
            updated.capabilities.canRedirectPendingSignature) {
          redirectionRequest.current = null;
        }
      } catch {
        if (accepted) setNotice("");
        setActionError("No fue posible verificar el nuevo envío. Busca nuevamente el crédito antes de intentarlo otra vez.");
      }
      submitting.current = false;
      setBusy(null);
    }
  }

  async function reviewRemission(action: "VERIFY" | "REJECT") {
    const replacementId = detail?.replacement?.id;
    if (!detail || detail.kind !== "CREDIT" || !replacementId ||
        detail.remission?.status !== "PENDING_REVIEW" || busy || submitting.current) return;
    const note = remissionRejectNote.trim();
    if (action === "REJECT" && (note.length < 5 || note.length > 500)) {
      setActionError("Explica por qué se necesita otra foto de remisión en 5 a 500 caracteres.");
      return;
    }
    submitting.current = true;
    setBusy("remission");
    setActionError("");
    setNotice("");
    const target = detail;
    try {
      await jsonRequest<ApiResult>(casePath(target) + "/remision", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replacementId, action, ...(action === "REJECT" ? { note } : {}) }),
      }, "No fue posible revisar la remisión.");
      setNotice(action === "VERIFY" ? "Remisión verificada. Continúa cuando el enrolamiento del nuevo equipo esté aprobado." :
        "Se solicitó al aliado una nueva foto firmada de la remisión.");
      setRejectingRemission(false);
      setRemissionRejectNote("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible revisar la remisión.");
    } finally {
      setConfirmation(null);
      try { await refreshDetail(target); }
      catch { setActionError("Actualiza el crédito para comprobar el estado de la remisión antes de intentarlo otra vez."); }
      submitting.current = false;
      setBusy(null);
    }
  }

  function togglePanel(panel: Exclude<ActivePanel, null>) {
    const next = activePanel === panel ? null : panel;
    setActionError("");
    if (next === "signature" && selected && detail && selected.id === detail.id && selected.kind === detail.kind) {
      void refreshDetail(selected).catch(() => setActionError("No fue posible actualizar la firma. Busca nuevamente el crédito."));
    }
    if (next === "imei" && detail?.kind === "CREDIT" && !reasonPreset) {
      setReasonPreset("Garantía");
      setReason("Garantía");
    }
    if (next !== "signature") {
      setEditingContact(false);
      setPreparingSignature(false);
      setRedirectingSignature(false);
      setContactReason("");
      setSignatureReason("");
      setRedirectPhone("");
      setRedirectReason("");
      setContactPhone(detail?.phone || detail?.signature.sentPhone || "");
      setContactEmail(detail?.email || detail?.signature.sentEmail || "");
    }
    setActivePanel(next);
  }

  const signature = detail?.signature;
  const signatureTone = signature?.status === "SIGNED" ? "positive" : signature?.status === "TECHNICAL_ERROR" ? "danger" : "warning";
  const canSendSignature = Boolean(detail?.capabilities.canSendSignature);
  const canResendSignature = Boolean(detail?.capabilities.canResendSignature);
  const canManageSignature = canSendSignature || canResendSignature;
  const canRedirectPendingSignature = Boolean(detail?.capabilities.canRedirectPendingSignature);
  const pendingRedirectBlockReason = detail?.kind === "DRAFT" &&
    (signature?.status === "PENDING" || signature?.status === "TECHNICAL_ERROR") &&
    !canRedirectPendingSignature ? detail.capabilities.pendingSignatureRedirectReason : null;
  const signatureActionLabel = canSendSignature ? "Enviar firma" : "Reenviar firma";
  const signatureActionNoun = canSendSignature ? "envío" : "reenvío";
  const canSubmitImei = Boolean(detail?.capabilities.canChangeImei && !busy && /^\d{15}$/.test(newImei) && newImei !== detail?.imei && reason.trim().length >= 5);
  const normalizedRedirectPhone = colombianPhone(redirectPhone);
  const canSubmitRedirection = Boolean(canRedirectPendingSignature && !busy && /^3\d{9}$/.test(normalizedRedirectPhone) &&
    normalizedRedirectPhone !== colombianPhone(signature?.sentPhone || detail?.phone) && redirectReason.trim().length >= 5);
  const imeiRequestLabel = detail?.kind === "CREDIT" ? "Solicitar cambio y nueva remisión" :
    detail?.capabilities.canDispatchSignatureWithImei ? "Guardar cambio y enviar nueva firma" : "Guardar cambio de IMEI";

  return <main className={styles.root}>
    <form className={styles.search} onSubmit={searchCases} role="search">
      <label htmlFor="approval-operations-search" className="sr-only">Buscar por cédula, número de crédito o IMEI</label>
      <Search size={20} aria-hidden="true" />
      <Input id="approval-operations-search" type="search" autoComplete="off" maxLength={100}
        placeholder="Buscar por cédula, crédito o IMEI" value={query} onChange={event => setQuery(event.target.value)}
        disabled={Boolean(busy)} />
      <Button variant="ghost" type="submit" disabled={Boolean(busy) || searching}>{searching ? "Buscando..." : "Buscar"}</Button>
    </form>
    {searchError ? <p className={styles.error} role="alert">{searchError}</p> : null}
    {searching ? <LoadingState label="Buscando créditos..." /> : null}
    {searched && !searching && !searchError && !results.length ? <EmptyCreditWorkspace notFound /> : null}
    {results.length > 1 ? <section className={styles.results} aria-label="Resultados de búsqueda">
      <h2>Selecciona un crédito</h2>
      <ul>{results.map(item => <li key={item.kind + ":" + item.id}>
        <button type="button" className={styles.result} onClick={() => void loadDetail(item)} disabled={Boolean(busy)}
          aria-current={selected?.id === item.id && selected.kind === item.kind ? "true" : undefined}>
          <span><strong>{visible(item.clientName)}</strong><small>{visible(item.document)} · {visible(item.equipment)}</small></span>
          <span>Crédito {visible(item.number)} <Badge tone={creditTone(item.status)}>{creditStatusLabel(visible(item.status))}</Badge></span>
        </button>
      </li>)}</ul>
    </section> : null}
    {loadingDetail ? <LoadingState label="Cargando detalle del crédito..." /> : null}
    {detailError ? <div className={styles.error} role="alert">{detailError}{selected ? <Button variant="secondary" onClick={() => void loadDetail(selected)}>Reintentar</Button> : null}</div> : null}
    {!searched && !searching ? <EmptyCreditWorkspace /> : null}
    {detail ? <>
      {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={19} aria-hidden="true" />{notice}</p> : null}
      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      <div className={styles.columns}>
        <CaseSummary detail={detail} />
        <section className={styles.operationWorkspace} aria-label="Gestiones del crédito">
          <div className={styles.operationActions} role="group" aria-label="Gestiones disponibles">
            <Button variant="secondary" className={`${styles.operationAction} ${activePanel === "imei" ? styles.operationActionActive : ""}`}
              onClick={() => togglePanel("imei")} aria-expanded={activePanel === "imei"} aria-controls={activePanel === "imei" ? "approval-imei-panel" : undefined} disabled={Boolean(busy)}>
              <Smartphone size={20} aria-hidden="true" />Cambio de IMEI
            </Button>
            <Button variant="secondary" className={`${styles.operationAction} ${activePanel === "signature" ? styles.operationActionActive : ""}`}
              onClick={() => togglePanel("signature")} aria-expanded={activePanel === "signature"} aria-controls={activePanel === "signature" ? "approval-signature-panel" : undefined} disabled={Boolean(busy)}>
              <FilePenLine size={20} aria-hidden="true" />FirmaSeguro
            </Button>
          </div>
        {activePanel === "imei" ? <Card id="approval-imei-panel" className={styles.change}>
          <header className={styles.sectionHeading}>
            <span className={styles.sectionIcon}><Smartphone size={22} aria-hidden="true" /></span>
            <div><h2>Cambio de IMEI</h2><p>{detail.kind === "CREDIT"
              ? "Por garantía, se pedirá al aliado una nueva foto firmada de la remisión. El IMEI se aplicará después de verificarla y aprobar el nuevo equipo."
              : "Registra el nuevo IMEI del dispositivo y solicita una nueva firma del contrato."}</p></div>
          </header>
          {detail.replacement ? <div className={`${styles.replacement} ${detail.replacement.status === "PENDING_ENROLLMENT" ? styles.replacementPending : ""}`} role="status">
            <FileClock size={18} aria-hidden="true" />
            <div><strong>Último cambio: {replacementLabel(detail.replacement.status)}</strong>
              <p>{visible(detail.replacement.reason)} · {dateLabel(detail.replacement.createdAt)}</p>
              <p>Nuevo IMEI: {visible(detail.replacement.newImei)}</p>
              {detail.replacement.status === "PENDING_ENROLLMENT" ? <p>Espera la remisión verificada y la aprobación del enrolamiento antes de enviar el contrato.</p> : null}
            </div>
          </div> : null}
          {detail.kind === "CREDIT" && detail.remission ? <section className={styles.remission} aria-labelledby="approval-remission-title">
            <div className={styles.remissionHead}>
              <h3 id="approval-remission-title">Nueva remisión firmada</h3>
              <StatusPill tone={detail.remission.status === "VERIFIED" ? "positive" : detail.remission.status === "REJECTED" ? "danger" : "warning"}>
                {remissionLabel(detail.remission.status)}
              </StatusPill>
            </div>
            <p>{detail.remission.status === "PENDING_UPLOAD" ? "Se solicitó al aliado una nueva foto firmada de la remisión. Espera su carga." :
              detail.remission.status === "PENDING_REVIEW" ? "El aliado cargó una foto de la remisión. Revísala antes de aplicar el nuevo IMEI." :
              detail.remission.status === "VERIFIED" ? "La foto firmada fue verificada. El cambio continuará después de aprobar el enrolamiento del equipo." :
              "Se solicitó al aliado corregir la foto de la remisión."}</p>
            {detail.remission.photoSha256 ? <a className={styles.remissionPhoto}
              href={casePath(detail) + "/remision/foto?replacementId=" + encodeURIComponent(detail.remission.replacementId)}
              target="_blank" rel="noopener noreferrer">Ver foto de remisión firmada</a> : null}
            {detail.remission.status === "PENDING_REVIEW" ? <div className={styles.remissionActions}>
              <Button variant="secondary" onClick={() => { setActionError(""); setConfirmation("remission-verify"); }} disabled={Boolean(busy)}>
                Verificar remisión
              </Button>
              <Button variant="ghost" onClick={() => { setActionError(""); setRejectingRemission(true); }} disabled={Boolean(busy)}>
                Solicitar nueva foto
              </Button>
            </div> : null}
            {rejectingRemission && detail.remission.status === "PENDING_REVIEW" ? <div className={styles.remissionReject}>
              <label htmlFor="approval-remission-note">Motivo para solicitar otra foto</label>
              <Input id="approval-remission-note" maxLength={500} minLength={5} value={remissionRejectNote}
                onChange={event => setRemissionRejectNote(event.target.value)} disabled={Boolean(busy)}
                placeholder="Explica qué debe corregir el aliado" />
              <div className={styles.remissionActions}>
                <Button variant="ghost" onClick={() => { setRejectingRemission(false); setRemissionRejectNote(""); }} disabled={Boolean(busy)}>Cancelar</Button>
                <Button variant="secondary" onClick={() => { setActionError(""); setConfirmation("remission-reject"); }}
                  disabled={Boolean(busy) || remissionRejectNote.trim().length < 5}>Continuar</Button>
              </div>
            </div> : null}
          </section> : null}
          <form onSubmit={requestImeiChange} className={styles.changeForm}>
            {detail.capabilities.canChangeImei ? <>
            <div className={styles.imeiFields}>
              <div><label htmlFor="approval-old-imei">IMEI anterior</label><Input id="approval-old-imei" value={detail.imei || ""} readOnly /></div>
              <div><label htmlFor="approval-new-imei">Nuevo IMEI</label><Input id="approval-new-imei" inputMode="numeric" pattern="[0-9]{15}" maxLength={15}
                placeholder="15 dígitos" value={newImei} onChange={event => setNewImei(event.target.value.replace(/\D/g, ""))}
                disabled={Boolean(busy)} required /></div>
            </div>
            <div><label htmlFor="approval-imei-reason">Motivo del cambio</label>
              <Select id="approval-imei-reason" value={reasonPreset}
                onChange={event => { const next = event.target.value; setReasonPreset(next); setReason(next === "Otro" ? "" : next); }}
                disabled={Boolean(busy)} required>
                <option value="">Selecciona un motivo</option>
                <option value="Garantía">Garantía</option>
                <option value="Corrección de IMEI">Corrección de IMEI</option>
                <option value="Otro">Otro motivo</option>
              </Select>
              {reasonPreset === "Otro" ? <Input className={styles.otherReason} aria-label="Describe el motivo del cambio"
                placeholder="Describe el motivo del cambio" minLength={5} maxLength={500} value={reason}
                onChange={event => setReason(event.target.value)} disabled={Boolean(busy)} required /> : null}
            </div>
            <div><label htmlFor="approval-imei-evidence">Evidencia <span className={styles.muted}>(opcional)</span></label>
              <label className={styles.upload} htmlFor="approval-imei-evidence"><span className={styles.uploadIcon}><Paperclip size={20} aria-hidden="true" /></span>
                <span>{evidence ? evidence.name : "Adjuntar evidencia del cambio de IMEI"}<small>Puedes subir fotos, documentos o comprobantes. JPG, PNG o PDF · máximo 10 MB.</small></span></label>
              <input id="approval-imei-evidence" ref={evidenceInput} type="file" accept="image/jpeg,image/png,application/pdf"
                onChange={event => setEvidence(event.target.files?.[0] || null)}
                disabled={Boolean(busy)} className={styles.fileInput} />
            </div>
            </> : null}
            {detail.capabilities.canChangeImei ? <Button type="submit" className={styles.primary} disabled={!canSubmitImei}>
              {busy === "imei" ? "Guardando cambio..." : imeiRequestLabel}<ArrowRight size={20} aria-hidden="true" />
            </Button> : null}
            {detail.capabilities.canConfirmReplacement && detail.replacement ? <Button className={styles.primary}
              onClick={() => { setActionError(""); setConfirmation("imei-confirm"); }} disabled={Boolean(busy)}>
              Guardar cambio y enviar nueva firma<ArrowRight size={20} aria-hidden="true" />
            </Button> : null}
            {detail.capabilities.reason && !detail.capabilities.canChangeImei && !detail.capabilities.canConfirmReplacement ? <p className={styles.muted}>{detail.capabilities.reason}</p> : null}
            {(detail.capabilities.canChangeImei || detail.capabilities.canConfirmReplacement ||
              detail.replacement?.status === "PENDING_ENROLLMENT" || detail.requiresEnrollmentReapproval) ?
              <p className={styles.explanation}><CheckCircle2 size={20} aria-hidden="true" /><span>El contrato anterior se conserva. La nueva versión se enviará cuando terminen las aprobaciones y controles necesarios.</span></p> : null}
          </form>
        </Card> : null}
      {activePanel === "signature" ? <Card id="approval-signature-panel" className={styles.signature}>
        <div className={styles.signatureHead}>
          <span className={styles.sectionIcon}><FilePenLine size={23} aria-hidden="true" /></span>
          <div><div className={styles.signatureTitle}><h2>FirmaSeguro</h2><StatusPill tone={signatureTone}>{signatureLabel(signature!.status)}</StatusPill></div>
            <p>{signature?.status === "TECHNICAL_ERROR" && canRedirectPendingSignature
              ? "El envío anterior no se completó. Puedes cambiar el número y generar una nueva solicitud con el mismo contrato." :
              signature?.status === "TECHNICAL_ERROR" ? "El envío necesita revisión técnica antes de continuar." :
              signature?.status === "SIGNED" ? "Contrato firmado. Puedes actualizar el contacto o solicitar una nueva versión cuando corresponda." :
              signature?.status === "PENDING" && canRedirectPendingSignature
                ? "Solicitud enviada y aún sin firma. Si el celular no recibe WhatsApp, puedes cambiar el número y generar un enlace nuevo."
                : signature?.status === "PENDING" ? "Solicitud enviada. Espera la confirmación real de FirmaSeguro." :
              canSendSignature ? "Revisa el contacto y envía el contrato. El estado cambiará cuando FirmaSeguro confirme la firma." :
              "No hay una solicitud de firma activa."}</p></div>
        </div>
        <div className={styles.signatureBottom}>
          <div className={styles.contacts}>
            <div><label htmlFor="approval-signature-phone"><Phone size={16} aria-hidden="true" />Celular de envío</label>
              <Input id="approval-signature-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={20}
                value={contactPhone} onChange={event => setContactPhone(event.target.value)}
                readOnly={!editingContact} disabled={Boolean(busy)} /></div>
            <div><label htmlFor="approval-signature-email"><Mail size={16} aria-hidden="true" />Correo de envío</label>
              <Input id="approval-signature-email" type="email" autoComplete="email" maxLength={254}
                value={contactEmail} onChange={event => setContactEmail(event.target.value)}
                readOnly={!editingContact} disabled={Boolean(busy)} /></div>
          </div>
          {detail.capabilities.canUpdateContact || canManageSignature || canRedirectPendingSignature ? <div className={styles.signatureActions}>
            {editingContact ? <>
              <Button variant="secondary" onClick={() => { setEditingContact(false); setContactReason(""); setContactPhone(detail.phone || signature?.sentPhone || ""); setContactEmail(detail.email || signature?.sentEmail || ""); }} disabled={Boolean(busy)}>Cancelar</Button>
              <Button variant="secondary" onClick={() => void updateContact()} disabled={Boolean(busy) || contactReason.trim().length < 5}>Guardar contacto</Button>
            </> : detail.capabilities.canUpdateContact ? <Button variant="secondary" onClick={() => { setActionError(""); setEditingContact(true); }} disabled={Boolean(busy)}>Actualizar contacto</Button> : null}
            {canManageSignature ? <Button className={styles.resendButton} onClick={() => { setActionError(""); setPreparingSignature(true); }}
              disabled={Boolean(busy) || editingContact || redirectingSignature}>
              {busy === "signature" ? "Enviando..." : signatureActionLabel}<ArrowRight size={18} aria-hidden="true" />
            </Button> : null}
            {canRedirectPendingSignature && !redirectingSignature ? <Button className={styles.resendButton}
              onClick={() => { setActionError(""); setPreparingSignature(false); setEditingContact(false);
                setRedirectPhone(""); setRedirectReason(""); setRedirectingSignature(true); }} disabled={Boolean(busy)}>
              Cambiar número y reenviar firma<ArrowRight size={18} aria-hidden="true" />
            </Button> : null}
          </div> : null}
        </div>
        {editingContact ? <div className={styles.reasonField}><label htmlFor="approval-contact-reason">Motivo de actualización del contacto</label>
          <Input id="approval-contact-reason" minLength={5} maxLength={500} value={contactReason}
            onChange={event => setContactReason(event.target.value)} disabled={Boolean(busy)} placeholder="Describe el motivo del cambio" /></div> : null}
        {preparingSignature && canManageSignature ? <div className={styles.resendReason}>
          <div className={styles.reasonField}><label htmlFor="approval-signature-reason">Motivo del {signatureActionNoun}</label>
            <Input id="approval-signature-reason" ref={signatureReasonInput} minLength={5} maxLength={500} value={signatureReason}
              onChange={event => setSignatureReason(event.target.value)} disabled={Boolean(busy) || editingContact} placeholder={canSendSignature ? "Describe por qué se envía la firma" : "Describe por qué se reenvía la firma"} /></div>
          <div className={styles.resendReasonActions}><Button variant="ghost" onClick={() => { setPreparingSignature(false); setSignatureReason(""); }} disabled={Boolean(busy)}>Cancelar</Button>
            <Button onClick={() => { setActionError(""); setConfirmation("signature"); }}
              disabled={Boolean(busy) || signatureReason.trim().length < 5}>Continuar</Button></div>
        </div> : null}
        {redirectingSignature && canRedirectPendingSignature ? <div className={styles.signatureRedirection}>
          <p className={styles.redirectionWarning}><FileClock size={18} aria-hidden="true" /><span>
            El enlace anterior quedará archivado y ya no podrá cerrar este expediente en FINSER PAY. Se generará una nueva solicitud de FirmaSeguro para el nuevo celular; el contrato y sus valores no cambiarán.
          </span></p>
          <div className={styles.redirectionFields}>
            <div><label htmlFor="approval-signature-redirect-phone">Nuevo celular para la firma</label>
              <Input id="approval-signature-redirect-phone" ref={redirectPhoneInput} type="tel" inputMode="numeric" autoComplete="tel" maxLength={20}
                value={redirectPhone} onChange={event => setRedirectPhone(event.target.value)} disabled={Boolean(busy)}
                placeholder="Ej. 3101234567" aria-describedby="approval-signature-redirect-phone-help" />
              <small id="approval-signature-redirect-phone-help">Debe ser un celular colombiano de 10 dígitos y diferente al envío anterior.</small></div>
            <div><label htmlFor="approval-signature-redirect-reason">Motivo del reenvío</label>
              <Input id="approval-signature-redirect-reason" minLength={5} maxLength={500} value={redirectReason}
                onChange={event => setRedirectReason(event.target.value)} disabled={Boolean(busy)}
                placeholder="Ej. El número anterior no tiene WhatsApp" /></div>
          </div>
          <div className={styles.redirectionActions}>
            <Button variant="ghost" onClick={() => { setRedirectingSignature(false); setRedirectPhone(""); setRedirectReason(""); }} disabled={Boolean(busy)}>Cancelar</Button>
            <Button onClick={() => { setActionError(""); setConfirmation("signature-redirection"); }} disabled={!canSubmitRedirection}>
              Cambiar número y reenviar firma<ArrowRight size={18} aria-hidden="true" />
            </Button>
          </div>
        </div> : null}
        {!canManageSignature && !canRedirectPendingSignature && detail.capabilities.preSettlementApprovalCreditId != null ? <div className={styles.approvalHandoff}>
          <p>{signature?.status === "NOT_SENT"
            ? detail.capabilities.signatureReason || "No hay una firma verificable para este crédito. Solicita revisión del expediente antes de enviar."
            : detail.capabilities.signatureReason || "Revisa el expediente de aprobaciones para continuar con la firma de este crédito."}</p>
          <Button variant="secondary" onClick={() => onOpenApproval?.(detail.capabilities.preSettlementApprovalCreditId!)}
            disabled={!onOpenApproval || Boolean(busy)}>{signature?.status === "NOT_SENT" ? "Abrir revisión" : "Gestionar firma en aprobaciones"}<ArrowRight size={18} aria-hidden="true" /></Button>
        </div> : null}
        {!canManageSignature && !canRedirectPendingSignature && detail.capabilities.preSettlementApprovalCreditId == null &&
          (signature?.status === "NOT_SENT" || detail.capabilities.signatureReason || pendingRedirectBlockReason) ?
          <p className={styles.muted}>{pendingRedirectBlockReason || (detail.kind === "CREDIT" && signature?.status === "NOT_SENT"
            ? detail.capabilities.signatureReason || "No hay una firma verificable para este crédito. Solicita revisión del expediente antes de enviar."
            : detail.capabilities.signatureReason || "El envío de firma no está disponible para este caso.")}</p> : null}
        {signature?.sentAt ? <p className={styles.sentAt}><CalendarClock size={15} aria-hidden="true" />Último envío: {dateLabel(signature.sentAt)}</p> : null}
      </Card> : null}
        </section>
      </div>
    </> : null}
    <ConfirmDialog open={confirmation === "imei-request"} title="Confirmar solicitud de cambio de IMEI"
      description={"Se registrará el nuevo IMEI del crédito " + visible(detail?.number) + ". " +
        (detail?.kind === "CREDIT" ? "Se solicitará al aliado una nueva foto firmada de la remisión. El cambio quedará pendiente de verificarla y aprobar el enrolamiento. Solo después se regenerará el contrato y se enviará para firma." :
          detail?.capabilities.canDispatchSignatureWithImei
            ? "Se regenerará el contrato con el nuevo IMEI antes de enviar la nueva versión al cliente. El contrato anterior se conservará."
            : "El contrato anterior se conservará. Tras las revisiones técnicas que correspondan se regenerará el contrato con el nuevo equipo antes de enviarlo a firma.") +
        " No se modificarán valores, cuotas ni condiciones financieras."}
      confirmLabel={imeiRequestLabel} busy={busy === "imei"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void submitImeiChange("REQUEST")} />
    <ConfirmDialog open={confirmation === "imei-confirm"} title="Confirmar cambio de IMEI y nueva firma"
      description={"El enrolamiento del nuevo equipo fue aprobado. Se aplicará el IMEI aprobado al crédito " + visible(detail?.number) +
        ", se regenerará una nueva versión del contrato y se enviará al cliente para firma. El contrato firmado anterior y la auditoría permanecerán disponibles."}
      confirmLabel="Guardar cambio y enviar nueva firma" busy={busy === "imei"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void submitImeiChange("CONFIRM")} />
    <ConfirmDialog open={confirmation === "signature"} title={signatureActionLabel}
      description={"Se confirmará el " + signatureActionNoun + " para el crédito " + visible(detail?.number) +
        " al celular " + visible(detail?.phone || detail?.signature.sentPhone) +
        " y correo " + visible(detail?.email || detail?.signature.sentEmail) +
        ". El estado solo cambiará a firmado tras la confirmación real de FirmaSeguro."}
      confirmLabel={signatureActionLabel} busy={busy === "signature"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void sendSignature()} />
    <ConfirmDialog open={confirmation === "signature-redirection"} title="Cambiar número y reenviar firma"
      description={"La solicitud enviada al celular " + visible(detail?.signature.sentPhone || detail?.phone) +
        " será reemplazada por una nueva solicitud al celular " + visible(normalizedRedirectPhone) +
        ". El enlace anterior quedará archivado y ya no podrá cerrar este expediente en FINSER PAY; el contrato conservará las mismas condiciones y valores."}
      confirmLabel="Cambiar número y reenviar firma" busy={busy === "signature"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void redirectPendingSignature()} />
    <ConfirmDialog open={confirmation === "remission-verify"} title="Verificar nueva remisión"
      description="Confirma que la foto muestra la nueva remisión firmada y corresponde al equipo de este crédito. Después de verificarla aún se requerirá aprobar el enrolamiento antes de aplicar el IMEI."
      confirmLabel="Verificar remisión" busy={busy === "remission"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void reviewRemission("VERIFY")} />
    <ConfirmDialog open={confirmation === "remission-reject"} title="Solicitar otra foto de remisión"
      description="Se conservará la foto actual en el historial y se pedirá al aliado una nueva foto firmada con la corrección indicada."
      confirmLabel="Solicitar nueva foto" busy={busy === "remission"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void reviewRemission("REJECT")} />
  </main>;
}
