"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, RefreshCw, Send } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Input, Select } from "@/app/_components/finser-ui";
import type { AttentionDetail, AttentionMessage } from "@/lib/atencion-types";
import { renderAttentionTemplatePreview, type AttentionTemplateCatalogue, type AttentionTemplateIntent } from "@/lib/atencion-template-types";
import styles from "./attention-template-composer.module.css";

type Props = { detail: AttentionDetail; actorKey: string; disabled: boolean; onSent: () => void | Promise<void>; onBusyChange?: (busy: boolean) => void };
const accepted = new Set(["accepted", "sent", "delivered", "read"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class TemplateApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new TemplateApiError(typeof body?.error === "string" ? body.error : "No fue posible completar la solicitud.", response.status);
  return body as T;
}

export default function AttentionTemplateComposer({ detail, actorKey, disabled, onSent, onBusyChange }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<AttentionTemplateCatalogue | null>(null);
  const [selected, setSelected] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [confirmedRecipient, setConfirmedRecipient] = useState(false);
  const [review, setReview] = useState<AttentionTemplateIntent | null>(null);
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
  const permitted = detail.permissions.manage && detail.conversation.channel === "whatsapp";
  const valid = Boolean(template?.available && catalogue?.canSend && confirmedRecipient && !pending && template.parameters.every(item => parameters[item.key]?.trim() && parameters[item.key].length <= item.maxLength));
  const preview = template ? renderAttentionTemplatePreview(template, parameters) : "";

  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); onBusyChange?.(true);
    try { await action(); }
    catch (caught) {
      if (alive.current) {
        if (caught instanceof TemplateApiError && [401,403,404].includes(caught.status)) {
          setOpen(false); setCatalogue(null); setReview(null); setSelected(""); setParameters({}); setConfirmedRecipient(false);
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
    if (!alive.current) return;
    setCatalogue(next);
    if (selected && !next.templates.some(item => item.key === selected && item.revision === template?.revision)) {
      setSelected(""); setParameters({}); setReview(null);
    }
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
  function prepare() {
    if (!valid || busy || disabled || !template) return;
    setError(""); setNotice("");
    setReview({ requestId: crypto.randomUUID(), version: detail.conversation.version, templateKey: template.key, revision: template.revision, parameters: { ...parameters }, confirmed: true });
  }
  async function send() {
    const intent = review;
    if (!intent || !valid || disabled || !permitted || busy) return;
    if (intent.version !== current.current.conversation.version) {
      setReview(null); setError("La conversación cambió. Revisa nuevamente el destinatario y el mensaje."); return;
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
    {open && createPortal(<FinserSidePanel open={open} title="Enviar plantilla" closeLabel="Cerrar plantillas" busy={busy} onClose={() => { setOpen(false); setReview(null); }}>
      <div className={styles.content}>
        <div className={styles.recipient}><span>Destinatario</span><strong>{detail.conversation.name}</strong><span>{detail.conversation.phone || "Teléfono no disponible"}</span></div>
        <p>Elige una plantilla aprobada, completa sus datos y revisa el mensaje antes de enviarlo.</p>
        {busy && !catalogue && <p role="status">Consultando plantillas aprobadas…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {pending && <div className={styles.actions}><Button variant="secondary" disabled={busy} onClick={queryAttempt}><RefreshCw aria-hidden="true" size={16} />Consultar estado</Button>{missing && <Button variant="ghost" disabled={busy} onClick={cancelAttempt}>Cancelar intento pendiente</Button>}</div>}
        {catalogue && <>
          {!catalogue.canSend && <p className={styles.notice}>{catalogue.reason || "El envío de plantillas aún no está disponible para este chat."}</p>}
          {!catalogue.templates.length ? <p className={styles.notice}>Esta cuenta no tiene plantillas aprobadas disponibles. Administración puede revisarlas en Meta.</p> : <label className={styles.field}>Plantilla aprobada<Select value={selected} disabled={busy || Boolean(pending)} onChange={event => { setSelected(event.target.value); setParameters({}); setReview(null); setConfirmedRecipient(false); setNotice(""); }}><option value="">Seleccionar plantilla…</option>{catalogue.templates.map(item => <option key={item.key} value={item.key}>{item.name} · {item.language}{item.available ? "" : " · No disponible"}</option>)}</Select></label>}
          {template && <>
            {!template.available && <p className={styles.notice}>{template.reason || "Esta plantilla todavía no es compatible con el envío manual."}</p>}
            {template.available && template.parameters.map(item => <label className={styles.field} key={item.key}>{item.label}<Input value={parameters[item.key] || ""} maxLength={item.maxLength} disabled={busy || Boolean(pending)} onChange={event => { setParameters(previous => ({ ...previous, [item.key]: event.target.value })); setReview(null); }} /></label>)}
            <section className={styles.preview} aria-label="Vista previa de la plantilla"><h3>Mensaje que recibirá el cliente</h3><p>{preview}</p></section>
            {catalogue.requiresBindingConfirmation && <p className={styles.notice}>Al confirmar se vinculará este chat con la línea empresarial de FINSER PAY. Verifica el teléfono del destinatario.</p>}
            {template.available && <label className={styles.confirmation}><input type="checkbox" checked={confirmedRecipient} disabled={busy || Boolean(pending)} onChange={event => { setConfirmedRecipient(event.target.checked); setReview(null); }} /><span>He revisado el destinatario y los datos del mensaje.</span></label>}
            <Button disabled={busy || disabled || !valid} onClick={prepare}><Send aria-hidden="true" size={17} />Revisar envío</Button>
          </>}
        </>}
        <Button variant="ghost" disabled={busy || Boolean(pending)} onClick={() => { setReview(null); void run(loadCatalogue); }}><RefreshCw aria-hidden="true" size={16} />Actualizar plantillas</Button>
        <ConfirmDialog open={Boolean(review)} title="Confirmar envío de plantilla" description={`Enviar ${template?.name || "la plantilla"} a ${detail.conversation.name} (${detail.conversation.phone || "sin teléfono"}).\n\n${preview}`} confirmLabel="Enviar plantilla" busy={busy} onCancel={() => setReview(null)} onConfirm={() => void send()} />
      </div>
    </FinserSidePanel>, document.body)}
  </>;
}
