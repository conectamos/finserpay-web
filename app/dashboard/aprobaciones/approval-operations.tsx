"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, CheckCircle2, FileClock, Mail, Paperclip, Phone, RefreshCw, Search, ShieldCheck, Smartphone, UploadCloud } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import type { OperationalCaseDetail, OperationalCaseSummary } from "@/lib/approval-operations-types";
import styles from "./approval-operations.module.css";

type Operation = "imei" | "contact" | "signature";
type ApiResult = { ok: boolean; error?: string; message?: string; operation?: { id: string; status: string; message: string } };
type SearchResult = ApiResult & { items: OperationalCaseSummary[] };
type DetailResult = ApiResult & { item: OperationalCaseDetail };
type Confirmation = "imei-request" | "imei-confirm" | "signature" | null;

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

function creditTone(status: string | null): "positive" | "warning" | "danger" | "neutral" {
  const normalized = (status || "").toUpperCase();
  if (/MORA|VENCID|ATRAS/.test(normalized)) return "danger";
  if (/FINALIZ|PAGAD|APROB|ACTIV|VIGENTE/.test(normalized)) return "positive";
  if (/PEND|BORRADOR|FIRMA/.test(normalized)) return "warning";
  return "neutral";
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

async function jsonRequest<T extends ApiResult>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || fallback);
  return payload;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className={styles.field}><dt>{label}</dt><dd>{visible(value)}</dd></div>;
}

function CaseSummary({ detail }: { detail: OperationalCaseDetail }) {
  return <Card className={styles.summary}>
    <header className={styles.cardHeader}>
      <div>
        <p className={styles.eyebrow}>Crédito {visible(detail.number)}</p>
        <h2>{visible(detail.clientName)}</h2>
      </div>
      <Badge tone={creditTone(detail.status)}>{visible(detail.status)}</Badge>
    </header>
    <dl className={styles.customer}>
      <Field label="Cédula" value={detail.document} />
      <Field label="Celular" value={detail.phone} />
      <Field label="Correo" value={detail.email} />
    </dl>
    <div className={styles.equipment}>
      <div className={styles.equipmentIcon}><Smartphone aria-hidden="true" size={25} /></div>
      <div>
        <p className={styles.eyebrow}>Equipo financiado</p>
        <strong>{visible(detail.equipment)}</strong>
        <p>IMEI actual <span>{visible(detail.imei)}</span></p>
      </div>
    </div>
    <section className={styles.timeline} aria-labelledby="operations-timeline-title">
      <h3 id="operations-timeline-title">Historial del crédito</h3>
      {detail.timeline.length ? <ol>
        {detail.timeline.map(event => <li key={event.id}>
          <span className={styles.timelineMark} aria-hidden="true" />
          <div><strong>{event.label}</strong><time dateTime={event.at}>{dateLabel(event.at)}</time>
            {event.detail ? <p>{event.detail}</p> : null}
            {event.actor ? <small>Por {event.actor}</small> : null}
            {event.status ? <StatusPill tone={/ERROR|FAIL|REJECT/i.test(event.status) ? "danger" : /PENDING|WAIT/i.test(event.status) ? "warning" : "positive"}>{eventStatusLabel(event.status, event.label)}</StatusPill> : null}
            {event.evidenceHref?.startsWith("/api/") ? <a className={styles.evidenceLink} href={event.evidenceHref} target="_blank" rel="noopener noreferrer">Ver evidencia</a> : null}
          </div>
        </li>)}
      </ol> : <p className={styles.muted}>Aún no hay acciones registradas para este crédito.</p>}
    </section>
  </Card>;
}

export default function ApprovalOperations() {
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
  const [newImei, setNewImei] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);
  const [editingContact, setEditingContact] = useState(false);
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactReason, setContactReason] = useState("");
  const [signatureReason, setSignatureReason] = useState("");
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const evidenceInput = useRef<HTMLInputElement | null>(null);
  const submitting = useRef(false);
  const operationKeys = useRef<{ contact: string | null; signature: string | null }>({ contact: null, signature: null });
  const imeiKeys = useRef<{ request: string | null; confirm: string | null }>({ request: null, confirm: null });

  useEffect(() => () => {
    searchController.current?.abort();
    detailController.current?.abort();
  }, []);

  useEffect(() => {
    setContactPhone(detail?.phone || detail?.signature.sentPhone || "");
    setContactEmail(detail?.email || detail?.signature.sentEmail || "");
    setEditingContact(false);
    setContactReason("");
  }, [detail?.id, detail?.kind, detail?.signature.sentPhone, detail?.signature.sentEmail, detail?.phone, detail?.email]);

  async function loadDetail(item: OperationalCaseSummary) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setSelected(item);
    setDetail(null);
    setDetailError("");
    setActionError("");
    setNotice("");
    setNewImei("");
    setReason("");
    setEvidence(null);
    setSignatureReason("");
    operationKeys.current = { contact: null, signature: null };
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
    setDetail(result.item);
    return result.item;
  }

  async function searchCases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const q = query.trim();
    setSearched(true);
    setSelected(null);
    setDetail(null);
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
        : target.pendingVersion?.status === "PREPARING"
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
    try {
      const result = await jsonRequest<ApiResult>(casePath(target) + "/contacto", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(phoneChanged ? { phone: nextPhone } : {}),
          ...(emailChanged ? { email: nextEmail } : {}),
          reason: contactReason.trim(), idempotencyKey: operationKeys.current.contact ||= crypto.randomUUID(),
          expectedProcessUuid: target.signature.processUuid }),
      }, "No fue posible actualizar el contacto.");
      setNotice(result.operation?.message || result.message || "Contacto actualizado para el próximo envío.");
      operationKeys.current.contact = null;
      setEditingContact(false);
      setContactReason("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible actualizar el contacto.");
    } finally {
      try { await refreshDetail(target); }
      catch { setActionError("Actualiza el crédito para comprobar los datos antes de reenviar la firma."); }
      submitting.current = false;
      setBusy(null);
    }
  }

  async function resendSignature() {
    if (!detail || busy || submitting.current || !detail.capabilities.canResendSignature) return;
    if (signatureReason.trim().length < 5) {
      setActionError("Describe el motivo del reenvío en al menos 5 caracteres.");
      return;
    }
    submitting.current = true;
    setBusy("signature");
    setActionError("");
    setNotice("");
    const target = detail;
    try {
      const result = await jsonRequest<ApiResult>(casePath(target) + "/firma", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: signatureReason.trim(), idempotencyKey: operationKeys.current.signature ||= crypto.randomUUID(),
          expectedProcessUuid: target.signature.processUuid, confirmed: true }),
      }, "No fue posible confirmar el reenvío de firma.");
      const message = result.operation?.message || result.message || "Solicitud de firma enviada. Consulta el estado actualizado.";
      if (technicalOperation(result.operation?.status)) setActionError(message);
      else setNotice(message);
      operationKeys.current.signature = null;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No fue posible confirmar el reenvío de firma.");
    } finally {
      setConfirmation(null);
      try { await refreshDetail(target); }
      catch { setActionError("Actualiza el crédito para comprobar si la firma se envió antes de intentar otra vez."); }
      submitting.current = false;
      setBusy(null);
    }
  }

  const signature = detail?.signature;
  const signatureTone = signature?.status === "SIGNED" ? "positive" : signature?.status === "TECHNICAL_ERROR" ? "danger" : "warning";
  const canSubmitImei = Boolean(detail?.capabilities.canChangeImei && !busy && /^\d{15}$/.test(newImei) && newImei !== detail?.imei && reason.trim().length >= 5);
  const imeiRequestLabel = detail?.kind === "CREDIT" ? "Solicitar cambio por garantía" :
    detail?.capabilities.canDispatchSignatureWithImei ? "Guardar cambio y enviar nueva firma" : "Guardar cambio de IMEI";

  return <main className={styles.root}>
    <PageHeader eyebrow="Operación · Aprobaciones" title="Detalle del crédito"
      description="Busca un crédito y gestiona el cambio de equipo y la firma desde un mismo lugar." />
    <form className={styles.search} onSubmit={searchCases} role="search">
      <label htmlFor="approval-operations-search" className="sr-only">Buscar por cédula, número de crédito o IMEI</label>
      <Search size={20} aria-hidden="true" />
      <Input id="approval-operations-search" type="search" autoComplete="off" maxLength={100}
        placeholder="Buscar por cédula, crédito o IMEI" value={query} onChange={event => setQuery(event.target.value)}
        disabled={Boolean(busy)} />
      <Button variant="secondary" type="submit" disabled={Boolean(busy) || searching}>{searching ? "Buscando..." : "Buscar"}</Button>
    </form>
    {searchError ? <p className={styles.error} role="alert">{searchError}</p> : null}
    {searching ? <LoadingState label="Buscando créditos..." /> : null}
    {searched && !searching && !searchError && !results.length ? <Card><EmptyState title="No se encontraron créditos" description="Comprueba la cédula, el número del crédito o los 15 dígitos del IMEI." /></Card> : null}
    {results.length > 1 ? <section className={styles.results} aria-label="Resultados de búsqueda">
      <h2>Selecciona un crédito</h2>
      <ul>{results.map(item => <li key={item.kind + ":" + item.id}>
        <button type="button" className={styles.result} onClick={() => void loadDetail(item)} disabled={Boolean(busy)}
          aria-current={selected?.id === item.id && selected.kind === item.kind ? "true" : undefined}>
          <span><strong>{visible(item.clientName)}</strong><small>{visible(item.document)} · {visible(item.equipment)}</small></span>
          <span>Crédito {visible(item.number)} <Badge tone={creditTone(item.status)}>{visible(item.status)}</Badge></span>
        </button>
      </li>)}</ul>
    </section> : null}
    {loadingDetail ? <LoadingState label="Cargando detalle del crédito..." /> : null}
    {detailError ? <div className={styles.error} role="alert">{detailError}{selected ? <Button variant="secondary" onClick={() => void loadDetail(selected)}>Reintentar</Button> : null}</div> : null}
    {!searched && !searching ? <Card><EmptyState title="Consulta un crédito" description="Ingresa la cédula, el número de crédito o el IMEI para abrir el detalle operativo." /></Card> : null}
    {detail ? <>
      {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={19} aria-hidden="true" />{notice}</p> : null}
      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      <div className={styles.columns}>
        <CaseSummary detail={detail} />
        <Card className={styles.change}>
          <header className={styles.sectionHeading}>
            <span className={styles.sectionIcon}><Smartphone size={22} aria-hidden="true" /></span>
            <div><h2>Cambio de IMEI</h2><p>Registra el equipo actualizado y solicita una nueva firma del contrato.</p></div>
          </header>
          {detail.replacement ? <div className={`${styles.replacement} ${detail.replacement.status === "PENDING_ENROLLMENT" ? styles.replacementPending : ""}`} role="status">
            <FileClock size={18} aria-hidden="true" />
            <div><strong>Último cambio: {replacementLabel(detail.replacement.status)}</strong>
              <p>{visible(detail.replacement.reason)} · {dateLabel(detail.replacement.createdAt)}</p>
              {detail.replacement.status === "PENDING_ENROLLMENT" ? <p>Espera la aprobación del enrolamiento del nuevo equipo antes de enviar el contrato.</p> : null}
            </div>
          </div> : null}
          <form onSubmit={requestImeiChange} className={styles.changeForm}>
            <div className={styles.imeiFields}>
              <div><label htmlFor="approval-old-imei">IMEI anterior</label><Input id="approval-old-imei" value={detail.imei || ""} readOnly /></div>
              <div><label htmlFor="approval-new-imei">Nuevo IMEI</label><Input id="approval-new-imei" inputMode="numeric" pattern="[0-9]{15}" maxLength={15}
                placeholder="15 dígitos" value={detail.capabilities.canConfirmReplacement && detail.replacement ? detail.replacement.newImei : newImei} onChange={event => setNewImei(event.target.value.replace(/\D/g, ""))}
                disabled={!detail.capabilities.canChangeImei || Boolean(busy)} required /></div>
            </div>
            <div><label htmlFor="approval-imei-reason">Motivo del cambio</label>
              <Input id="approval-imei-reason" placeholder="Ej. Garantía" minLength={5} maxLength={500}
                value={reason} onChange={event => setReason(event.target.value)} disabled={!detail.capabilities.canChangeImei || Boolean(busy)} required /></div>
            <div><label htmlFor="approval-imei-evidence">Evidencia <span className={styles.muted}>(opcional)</span></label>
              <label className={styles.upload} htmlFor="approval-imei-evidence"><UploadCloud size={20} aria-hidden="true" />
                <span>{evidence ? evidence.name : "Adjuntar evidencia del cambio de IMEI"}<small>JPG, PNG o PDF · máximo 10 MB</small></span></label>
              <input id="approval-imei-evidence" ref={evidenceInput} type="file" accept="image/jpeg,image/png,application/pdf"
                onChange={event => setEvidence(event.target.files?.[0] || null)}
                disabled={!detail.capabilities.canChangeImei || Boolean(busy)} className={styles.fileInput} />
            </div>
            {detail.capabilities.canChangeImei ? <Button type="submit" className={styles.primary} disabled={!canSubmitImei}>
              <Paperclip size={18} aria-hidden="true" />{busy === "imei" ? "Guardando cambio..." : imeiRequestLabel}
            </Button> : null}
            {detail.capabilities.canConfirmReplacement && detail.replacement ? <Button className={styles.primary}
              onClick={() => { setActionError(""); setConfirmation("imei-confirm"); }} disabled={Boolean(busy)}>
              <ShieldCheck size={18} aria-hidden="true" />Guardar cambio y enviar nueva firma
            </Button> : null}
            {detail.capabilities.reason && !detail.capabilities.canChangeImei && !detail.capabilities.canConfirmReplacement ? <p className={styles.muted}>{detail.capabilities.reason}</p> : null}
            {(detail.capabilities.canChangeImei || detail.capabilities.canConfirmReplacement ||
              detail.replacement?.status === "PENDING_ENROLLMENT" || detail.requiresEnrollmentReapproval) ?
              <p className={styles.explanation}>El contrato anterior se conserva en el historial. La nueva versión se enviará tras completar las aprobaciones y controles que correspondan.</p> : null}
          </form>
        </Card>
      </div>
      <Card className={styles.signature}>
        <div className={styles.signatureHead}>
          <span className={styles.sectionIcon}><ShieldCheck size={23} aria-hidden="true" /></span>
          <div><div className={styles.signatureTitle}><h2>FirmaSeguro</h2><StatusPill tone={signatureTone}>{signatureLabel(signature!.status)}</StatusPill></div>
            <p>{signature?.status === "TECHNICAL_ERROR" ? "El envío necesita revisión técnica antes de continuar." :
              signature?.status === "SIGNED" ? "Contrato firmado. Puedes actualizar el contacto o solicitar una nueva firma cuando corresponda." :
              signature?.status === "PENDING" ? "Solicitud enviada. Espera la confirmación real de FirmaSeguro." :
              "No hay una solicitud de firma activa. Las versiones anteriores permanecen en el historial."}</p></div>
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
          <div className={styles.signatureActions}>
            {editingContact ? <>
              <Button variant="secondary" onClick={() => { setEditingContact(false); setContactReason(""); setContactPhone(detail.phone || signature?.sentPhone || ""); setContactEmail(detail.email || signature?.sentEmail || ""); }} disabled={Boolean(busy)}>Cancelar</Button>
              <Button variant="secondary" onClick={() => void updateContact()} disabled={Boolean(busy) || contactReason.trim().length < 5}>Guardar contacto</Button>
            </> : <Button variant="secondary" onClick={() => { setActionError(""); setEditingContact(true); }} disabled={Boolean(busy) || !detail.capabilities.canUpdateContact}>Actualizar contacto</Button>}
            <Button onClick={() => { setActionError(""); setConfirmation("signature"); }} disabled={Boolean(busy) || editingContact || !detail.capabilities.canResendSignature || signatureReason.trim().length < 5}>
              <RefreshCw size={17} aria-hidden="true" />{busy === "signature" ? "Enviando..." : "Reenviar firma"}
            </Button>
          </div>
        </div>
        {editingContact ? <div className={styles.reasonField}><label htmlFor="approval-contact-reason">Motivo de actualización del contacto</label>
          <Input id="approval-contact-reason" minLength={5} maxLength={500} value={contactReason}
            onChange={event => setContactReason(event.target.value)} disabled={Boolean(busy)} placeholder="Describe el motivo del cambio" /></div> : null}
        {detail.capabilities.canResendSignature ? <div className={styles.reasonField}><label htmlFor="approval-signature-reason">Motivo del reenvío</label>
          <Input id="approval-signature-reason" minLength={5} maxLength={500} value={signatureReason}
            onChange={event => setSignatureReason(event.target.value)} disabled={Boolean(busy) || editingContact} placeholder="Describe por qué se reenvía la firma" /></div> : null}
        {detail.capabilities.reason && !detail.capabilities.canResendSignature ? <p className={styles.muted}>{detail.capabilities.reason}</p> : null}
        {signature?.sentAt ? <p className={styles.sentAt}><CalendarClock size={15} aria-hidden="true" />Último envío: {dateLabel(signature.sentAt)}</p> : null}
      </Card>
    </> : null}
    <ConfirmDialog open={confirmation === "imei-request"} title="Confirmar solicitud de cambio de IMEI"
      description={"Se registrará el nuevo IMEI del crédito " + visible(detail?.number) + ". " +
        (detail?.kind === "CREDIT" ? "El cambio quedará pendiente de aprobación del enrolamiento. Solo después se regenerará el contrato y se enviará para firma." :
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
    <ConfirmDialog open={confirmation === "signature"} title="Reenviar firma"
      description={"Se enviará una nueva solicitud de firma para el crédito " + visible(detail?.number) + " al contacto registrado. Verifica que el celular y correo de envío sean correctos."}
      confirmLabel="Reenviar firma" busy={busy === "signature"}
      onCancel={() => { if (!submitting.current) setConfirmation(null); }} onConfirm={() => void resendSignature()} />
  </main>;
}
