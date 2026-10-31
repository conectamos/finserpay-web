"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { FileText, RefreshCw, Send } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Input, Select } from "@/app/_components/finser-ui";
import type { AttentionDetail, AttentionMessage } from "@/lib/atencion-types";
import { renderAttentionTemplatePreview, type AttentionTemplate, type AttentionTemplateCatalogue, type AttentionTemplateIntent } from "@/lib/atencion-template-types";
import styles from "./attention-template-composer.module.css";

type Props = { detail: AttentionDetail; actorKey: string; disabled: boolean; chatTheme?: "dark"; onSent: () => void | Promise<void>; onBusyChange?: (busy: boolean) => void };
const accepted = new Set(["accepted", "sent", "delivered", "read"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type TemplateReview = { intent: AttentionTemplateIntent; phone: string | null; name: string; preview: string; templateName: string; financialSummary: string | null };
const calendarDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00-05:00`)) : "No disponible";
const amount = (value: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
const templateImage = (value: string | null | undefined) => value === "/whatsapp/templates/2dias.png" ? value : null;
class TemplateApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new TemplateApiError(typeof body?.error === "string" ? body.error : "No fue posible completar la solicitud.", response.status);
  return body as T;
}

export default function AttentionTemplateComposer({ detail, actorKey, disabled, chatTheme, onSent, onBusyChange }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<AttentionTemplateCatalogue | null>(null);
  const [selected, setSelected] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [creditId, setCreditId] = useState("");
  const [confirmedRecipient, setConfirmedRecipient] = useState(false);
  const [review, setReview] = useState<TemplateReview | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const working = useRef(false);
  const current = useRef(detail);
  current.current = detail;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const base = `/api/atencion/${detail.conversation.id}`;
  const storageKey = `finser-attention-template:${actorKey}:${detail.conversation.id}`;
  const template = catalogue?.templates.find(item => item.key === selected);
  const financial = template?.financial;
  const candidate = financial?.candidates.find(item => String(item.creditId) === creditId);
  const effectiveParameters = financial ? candidate?.parameters || {} : parameters;
  const permitted = detail.permissions.manage && detail.conversation.channel === "whatsapp";
  const completeParameters = template?.parameters.every(item => effectiveParameters[item.key]?.trim() && effectiveParameters[item.key].length <= item.maxLength);
  const financialPreviewReady = Boolean(candidate?.eligible && candidate.revision && completeParameters);
  const valid = Boolean(template?.available && catalogue?.canSend && confirmedRecipient && !pending && (!financial || financialPreviewReady) && completeParameters);
  const preview = template ? renderAttentionTemplatePreview(template, effectiveParameters) : "";

  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); onBusyChange?.(true);
    try { await action(); }
    catch (caught) {
      if (alive.current) {
        if (caught instanceof TemplateApiError && [401,403,404].includes(caught.status)) {
          setOpen(false); setCatalogue(null); setReview(null); setSelected(""); setParameters({}); setCreditId(""); setConfirmedRecipient(false);
          await Promise.resolve(onSent()).catch(() => undefined);
        }
        setError(caught instanceof Error ? caught.message : "No fue posible completar la solicitud.");
      }
    }
    finally { working.current = false; if (alive.current) setBusy(false); onBusyChange?.(false); }
  }
  function forgetAttempt() {
    sessionStorage.removeItem(storageKey);
    setPending(null); setMissing(false);
  }
  async function result(message: AttentionMessage | null) {
    if (!alive.current) return;
    if (message && accepted.has(message.deliveryStatus || "")) {
      forgetAttempt(); setReview(null); setNotice("Plantilla aceptada por WhatsApp. El estado de entrega se actualizará en el chat.");
      await onSent();
    } else if (message?.deliveryStatus === "failed") {
      forgetAttempt(); setReview(null); setNotice(""); setError(message.deliveryError || "La plantilla no se envió. Revisa los datos antes de preparar otro intento.");
      await onSent();
    } else {
      setMissing(message === null); setNotice(message ? "El envío sigue pendiente de confirmación. Consulta su estado antes de preparar otro." : "Aún no hay un envío registrado. Puedes volver a consultar o cancelar este intento antes de preparar otro.");
    }
  }
  async function loadCatalogue() {
    const next = await request<AttentionTemplateCatalogue>(`${base}/templates`);
    if (!alive.current || !current.current.permissions.manage || current.current.conversation.id !== detail.conversation.id) return null;
    setCatalogue(next);
    if (selected && !next.templates.some(item => item.key === selected && item.revision === template?.revision)) {
      setSelected(""); setParameters({}); setCreditId(""); setReview(null); setConfirmedRecipient(false);
    }
    return next;
  }
  function launch() {
    setOpen(true); setNotice(""); setConfirmedRecipient(false);
    void run(async () => {
      const saved = sessionStorage.getItem(storageKey);
      const attempt = saved && uuid.test(saved) ? saved : null;
      setPending(attempt); setMissing(false);
      await loadCatalogue();
      if (attempt) await result((await request<{ message: AttentionMessage | null }>(`${base}/messages?requestId=${attempt}`)).message);
    });
  }
  function createReview(next: AttentionTemplateCatalogue, selectedTemplate: AttentionTemplate) {
    const selectedCredit = selectedTemplate.financial?.candidates.find(item => String(item.creditId) === creditId);
    if (selectedTemplate.financial && !selectedCredit?.revision) return;
    const values = selectedCredit?.parameters || parameters;
    const financialSummary = selectedCredit ? `${selectedCredit.creditLabel} · cuota ${selectedCredit.installmentNumber ?? "no disponible"}\nVencimiento: ${calendarDate(selectedCredit.dueDate)}\nValidación: ${calendarDate(selectedCredit.checkedOn)} (Bogotá)${typeof selectedCredit.pendingAmount === "number" ? `\nValor pendiente: ${amount(selectedCredit.pendingAmount)}` : ""}${selectedCredit.coveredCredits?.length ? `\nCréditos incluidos: ${selectedCredit.coveredCredits.map(item => item.number).join(", ")}` : ""}` : null;
    setReview({ intent: { requestId: crypto.randomUUID(), version: next.conversationVersion, templateKey: selectedTemplate.key, revision: selectedTemplate.revision, parameters: selectedTemplate.financial ? {} : { ...parameters }, ...(selectedCredit?.revision ? { creditId: selectedCredit.creditId, financialRevision: selectedCredit.revision } : {}), confirmed: true }, phone: current.current.conversation.phone, name: current.current.conversation.name, preview: renderAttentionTemplatePreview(selectedTemplate, values), templateName: selectedTemplate.name, financialSummary });
  }
  async function prepare() {
    if (!valid || busy || disabled || !template || !catalogue) return;
    setError(""); setNotice("");
    if (financial) {
      await run(async () => {
        const next = await loadCatalogue();
        if (!next) return;
        const nextTemplate = next.templates.find(item => item.key === selected);
        const nextCredit = nextTemplate?.financial?.candidates.find(item => String(item.creditId) === creditId);
        if (next.conversationVersion !== current.current.conversation.version) {
          setConfirmedRecipient(false); setReview(null); await onSent();
          setError("La conversación cambió. Actualizamos el destinatario; revisa de nuevo el crédito y el mensaje."); return;
        }
        if (!next.canSend || !nextTemplate?.available || !nextCredit?.eligible || !nextCredit.revision || nextTemplate.revision !== template.revision || nextCredit.revision !== candidate?.revision || renderAttentionTemplatePreview(nextTemplate, nextCredit.parameters) !== preview) {
          setConfirmedRecipient(false); setReview(null);
          setError(nextCredit?.reason || nextTemplate?.financial?.blockedReason || nextTemplate?.reason || next.reason || "Los datos del crédito o de la plantilla cambiaron. Revisa la información actualizada y confirma nuevamente."); return;
        }
        createReview(next, nextTemplate);
      });
    } else if (catalogue.conversationVersion !== current.current.conversation.version) {
      setConfirmedRecipient(false); setReview(null);
      await run(async () => { await loadCatalogue(); await onSent(); setError("La conversación cambió. Revisa nuevamente el destinatario y el mensaje."); });
    } else createReview(catalogue, template);
  }
  async function send() {
    const snapshot = review;
    if (!snapshot || !valid || disabled || !permitted || busy) return;
    const intent = snapshot.intent;
    if (intent.version !== current.current.conversation.version || snapshot.phone !== current.current.conversation.phone || snapshot.name !== current.current.conversation.name) {
      setReview(null); setConfirmedRecipient(false); setError("La conversación cambió. Revisa nuevamente el destinatario y el mensaje."); return;
    }
    await run(async () => {
      // Persist only the UUID, before POST. A lost response or tab navigation must
      // never permit a second, unrelated intent without resolving the first one.
      try { sessionStorage.setItem(storageKey, intent.requestId); }
      catch { throw new Error("El navegador no permite guardar el estado del envío. Habilita el almacenamiento de esta sesión e intenta nuevamente."); }
      setPending(intent.requestId); setMissing(false); setReview(null);
      const sent = await request<{ message: AttentionMessage; uncertain?: boolean }>(`${base}/templates`, { method: "POST", body: JSON.stringify(intent) });
      await result(sent.message);
    });
  }
  function queryAttempt() {
    if (!pending) return;
    void run(async () => result((await request<{ message: AttentionMessage | null }>(`${base}/messages?requestId=${pending}`)).message));
  }
  function cancelAttempt() {
    if (!pending || !missing) return;
    void run(async () => {
      await request(`${base}/messages?requestId=${pending}`, { method: "DELETE" });
      if (!alive.current) return;
      forgetAttempt(); setReview(null); setNotice("Intento cancelado. Puedes revisar y preparar un nuevo envío.");
    });
  }
  if (!permitted) return null;
  return <>
    <Button type="button" variant="ghost" disabled={disabled || busy} onClick={launch} title="Enviar una plantilla aprobada por Meta"><FileText aria-hidden="true" size={18} /><span>Plantilla</span></Button>
    {open && createPortal(<div data-chat-theme={chatTheme} className={chatTheme === "dark" ? styles.portalTheme : undefined}><FinserSidePanel open={open} title="Enviar plantilla" closeLabel="Cerrar plantillas" busy={busy} onClose={() => { setOpen(false); setReview(null); }}>
      <div className={styles.content}>
        <div className={styles.recipient}><span>Destinatario</span><strong>{detail.conversation.name}</strong><span>{detail.conversation.phone || "Teléfono no disponible"}</span></div>
        <p>Elige una plantilla y revisa el mensaje. Los datos de cartera se validan automáticamente con el crédito seleccionado.</p>
        {busy && !catalogue && <p role="status">Consultando plantillas aprobadas…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {pending && <div className={styles.actions}><Button variant="secondary" disabled={busy} onClick={queryAttempt}><RefreshCw aria-hidden="true" size={16} />Consultar estado</Button>{missing && <Button variant="ghost" disabled={busy} onClick={cancelAttempt}>Cancelar intento pendiente</Button>}</div>}
        {catalogue && <>
          {!catalogue.canSend && <p className={styles.notice}>{catalogue.reason || "El envío de plantillas aún no está disponible para este chat."}</p>}
          {!catalogue.templates.length ? <p className={styles.notice}>Esta cuenta no tiene plantillas aprobadas disponibles. Administración puede revisarlas en Meta.</p> : <label className={styles.field}>Plantilla aprobada<Select aria-label="Plantilla aprobada" value={selected} disabled={busy || Boolean(pending)} onChange={event => { setSelected(event.target.value); setParameters({}); setCreditId(""); setReview(null); setConfirmedRecipient(false); setNotice(""); setError(""); }}><option value="">Seleccionar plantilla…</option>{catalogue.templates.map(item => <option key={item.key} value={item.key}>{item.name} · {item.language}{item.available ? "" : " · No disponible"}</option>)}</Select></label>}
          {template && <>
            {!template.available && <p className={styles.notice}>{template.reason || "Esta plantilla todavía no es compatible con el envío manual."}</p>}
            {financial && <>
              {financial.blockedReason && <p className={styles.notice}>{financial.blockedReason}</p>}
              {financial.candidates.length > 0 && <label className={styles.field}>Crédito para validar<Select aria-label="Crédito para validar" value={creditId} disabled={busy || Boolean(pending)} onChange={event => { setCreditId(event.target.value); setReview(null); setConfirmedRecipient(false); setError(""); setNotice(""); }}><option value="">Seleccionar crédito…</option>{financial.candidates.map(item => <option key={item.creditId} value={String(item.creditId)}>{item.creditLabel}{item.eligible ? "" : " · Revisar motivo"}</option>)}</Select></label>}
              {candidate && <>
                {!candidate.eligible && <p className={styles.notice} role="status">{candidate.reason || "Este crédito no cumple las condiciones de la plantilla seleccionada."}</p>}
                <section className={styles.financial} aria-label="Datos del crédito validados por el servidor"><h3>{candidate.creditLabel}</h3><dl><div><dt>Cuota</dt><dd>{candidate.installmentNumber ?? "No disponible"}</dd></div><div><dt>Vencimiento</dt><dd>{calendarDate(candidate.dueDate)}</dd></div><div><dt>Fecha de validación</dt><dd>{calendarDate(candidate.checkedOn)} · Bogotá</dd></div>{typeof candidate.pendingAmount === "number" && <div><dt>Valor pendiente</dt><dd>{amount(candidate.pendingAmount)}</dd></div>}</dl>{candidate.coveredCredits && candidate.coveredCredits.length > 1 && <div className={styles.coveredCredits}><strong>Créditos incluidos en este aviso</strong><ul>{candidate.coveredCredits.map(item => <li key={item.id}>{item.number}</li>)}</ul></div>}<p>Estos datos son de consulta. Se vuelven a comprobar antes del envío.</p></section>
              </>}
              {!financial.candidates.length && !financial.blockedReason && <p className={styles.notice}>No hay créditos autorizados para validar esta plantilla en el chat seleccionado.</p>}
            </>}
            {template.available && !financial && template.parameters.map(item => <label className={styles.field} key={item.key}>{item.label}<Input value={parameters[item.key] || ""} maxLength={item.maxLength} disabled={busy || Boolean(pending)} onChange={event => { setParameters(previous => ({ ...previous, [item.key]: event.target.value })); setReview(null); setConfirmedRecipient(false); }} /></label>)}
            {(!financial || financialPreviewReady) && <section className={styles.preview} aria-label="Vista previa de la plantilla"><h3>Mensaje que recibirá el cliente</h3>{templateImage(template.headerImageUrl) && <Image className={styles.headerImage} src={templateImage(template.headerImageUrl)!} width={640} height={360} alt={`Imagen de la plantilla ${template.name}`} />}<p>{preview}</p></section>}
            {financial && !candidate && financial.candidates.length > 0 && <p className={styles.hint}>Selecciona un crédito para generar el mensaje.</p>}
            {financial && candidate?.eligible && !financialPreviewReady && <p className={styles.notice}>Faltan datos confirmados para generar el mensaje. Actualiza las plantillas antes de continuar.</p>}
            {catalogue.requiresBindingConfirmation && <p className={styles.notice}>Al confirmar se vinculará este chat con la línea empresarial de FINSER PAY. Verifica el teléfono del destinatario.</p>}
            {template.available && <label className={styles.confirmation}><input type="checkbox" checked={confirmedRecipient} disabled={busy || Boolean(pending) || Boolean(financial && !candidate?.eligible)} onChange={event => { setConfirmedRecipient(event.target.checked); setReview(null); }} /><span>{financial ? `He verificado el teléfono ${detail.conversation.phone || "no disponible"}, ${candidate?.coveredCredits && candidate.coveredCredits.length > 1 ? `los créditos ${candidate.coveredCredits.map(item => item.number).join(", ")}` : candidate?.creditLabel || "el crédito"}, la cuota, el vencimiento y el mensaje.` : "He revisado el destinatario y los datos del mensaje."}</span></label>}
            <Button disabled={busy || disabled || !valid} onClick={() => void prepare()}><Send aria-hidden="true" size={17} />{busy && financial && !pending ? "Validando crédito…" : "Revisar envío"}</Button>
          </>}
        </>}
        <Button variant="ghost" disabled={busy || Boolean(pending)} onClick={() => { setReview(null); setConfirmedRecipient(false); void run(async () => { await loadCatalogue(); }); }}><RefreshCw aria-hidden="true" size={16} />Actualizar plantillas</Button>
        <ConfirmDialog open={Boolean(review)} title="Confirmar envío de plantilla" description={review ? `Enviar ${review.templateName} a ${review.name} (${review.phone || "sin teléfono"}).\n\n${review.financialSummary ? `${review.financialSummary}\n\n` : ""}${review.preview}` : ""} confirmLabel="Enviar plantilla" busy={busy} onCancel={() => setReview(null)} onConfirm={() => void send()} />
      </div>
    </FinserSidePanel></div>, document.body)}
  </>;
}
