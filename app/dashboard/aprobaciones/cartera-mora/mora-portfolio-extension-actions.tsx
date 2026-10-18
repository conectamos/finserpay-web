"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil, XCircle } from "lucide-react";
import { Button, Input, LoadingState } from "@/app/_components/finser-ui";
import type { MoraActiveExtension } from "@/lib/analyst-mora-types";
import type { MoraExceptionRequestItem, MoraExtensionActions } from "@/lib/mora-exception-types";
import styles from "./mora-portfolio.module.css";

type Action = "EDIT" | "CANCEL";
type AmendmentDraft = {
  expiresOn: string; noExpiry: boolean; reason: string; observation: string;
  promiseDate: string; promiseAmount: string; auditReason: string;
};
type RequestDetail = { item: MoraExceptionRequestItem; amendmentActions: MoraExtensionActions };
export type ExtensionChange = { item: MoraExceptionRequestItem; message: string; warning: string | null };
type Props = {
  creditId: number;
  extension: MoraActiveExtension;
  capabilities: MoraExtensionActions;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: (result: ExtensionChange) => void | Promise<void>;
};
class ExtensionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new ExtensionRequestError(
    typeof payload?.error === "string" ? payload.error : "No fue posible gestionar la prórroga.", response.status);
  return payload as T;
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "long", timeZone: "America/Bogota" })
    .format(new Date(`${value}T12:00:00-05:00`));
}

export default function MoraPortfolioExtensionActions({ creditId, extension, capabilities, disabled = false, onBusyChange, onChanged }: Props) {
  const [action, setAction] = useState<Action | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [draft, setDraft] = useState<AmendmentDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const changeKey = useRef<{ intent: string; key: string } | null>(null);
  const editor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flight.current?.abort(); };
  }, []);
  useEffect(() => { if (detail && action) editor.current?.focus(); }, [detail, action, reviewing]);

  async function open(nextAction: Action) {
    if (disabled || submitting.current || loading || (nextAction === "EDIT" ? !capabilities.canEdit : !capabilities.canCancel)) return;
    flight.current?.abort();
    const controller = new AbortController(); flight.current = controller;
    setAction(nextAction); setDetail(null); setDraft(null); setLoading(true);
    setReviewing(false); setError(""); setConflict(false); changeKey.current = null;
    onBusyChange(true);
    try {
      const result = await request<RequestDetail>(`/api/aprobaciones/excepciones-mora/${extension.id}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      if (result.item.id !== extension.id || result.item.creditoId !== creditId || result.item.type !== "PRORROGA" ||
        result.item.status !== "APPROVED" || !Number.isSafeInteger(result.item.version) || result.item.version < 1 || !result.amendmentActions ||
        !(nextAction === "EDIT" ? result.amendmentActions.canEdit : result.amendmentActions.canCancel)) {
        throw new Error(result.amendmentActions?.editBlockedReason || "La prórroga cambió o ya no está vigente. Actualiza el crédito antes de continuar.");
      }
      setDetail(result);
      setDraft({ expiresOn: result.item.expiresOn || "", noExpiry: result.item.expiresOn === null,
        reason: result.item.reason, observation: result.item.observation, promiseDate: result.item.promiseDate || "",
        promiseAmount: result.item.promiseAmount === null ? "" : String(result.item.promiseAmount), auditReason: "" });
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : "No fue posible consultar la prórroga.");
    } finally {
      if (!controller.signal.aborted && mounted.current) { setLoading(false); onBusyChange(false); }
    }
  }
  function close() {
    if (submitting.current) return;
    flight.current?.abort(); setAction(null); setDetail(null); setDraft(null);
    setReviewing(false); setConflict(false); setError(""); changeKey.current = null;
  }
  function update(patch: Partial<AmendmentDraft>) {
    if (submitting.current || conflict) return;
    setDraft(current => current ? { ...current, ...patch,
      ...(patch.expiresOn && current.promiseDate && current.promiseDate > patch.expiresOn ? { promiseDate: patch.expiresOn } : {}) } : null);
    setReviewing(false); setError("");
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (disabled || !detail || !draft || !action || submitting.current || conflict) return;
    const rights = detail.amendmentActions;
    if (!rights.centralAdmin && draft.auditReason.trim().length < 5) {
      setError("Explica el motivo del cambio o la cancelación (mínimo 5 caracteres)."); return;
    }
    if (action === "EDIT") {
      if (!rights.centralAdmin && draft.reason.trim().length < 5) {
        setError("Describe el motivo de la prórroga (mínimo 5 caracteres)."); return;
      }
      const noExpiry = rights.centralAdmin && detail.item.centralDirect && draft.noExpiry;
      if (!noExpiry && (!validDate(draft.expiresOn) ||
        (rights.minExpiresOn && draft.expiresOn < rights.minExpiresOn) ||
        (rights.maxExpiresOn && draft.expiresOn > rights.maxExpiresOn))) {
        setError("Selecciona un vencimiento dentro del plazo permitido."); return;
      }
      if (!detail.item.centralDirect && (!validDate(draft.promiseDate) ||
        (!noExpiry && draft.promiseDate > draft.expiresOn) ||
        (rights.minExpiresOn && draft.promiseDate < rights.minExpiresOn))) {
        setError("Revisa la fecha del compromiso de pago y el vencimiento de la prórroga."); return;
      }
      if (rights.centralAdmin && !detail.item.centralDirect &&
        (!Number.isFinite(Number(draft.promiseAmount)) || Number(draft.promiseAmount) <= 0)) {
        setError("Indica un valor válido para el compromiso de pago."); return;
      }
    }
    setError(""); setReviewing(true);
  }
  async function confirm() {
    if (disabled || !detail || !draft || !action || !reviewing || conflict || submitting.current) return;
    const rights = detail.amendmentActions;
    const payload = { action, version: detail.item.version,
      auditReason: draft.auditReason.trim() || (action === "EDIT" ? "Prórroga editada por administrador central" : "Prórroga cancelada por administrador central"),
      ...(action === "EDIT" ? {
        expiresOn: rights.centralAdmin && detail.item.centralDirect && draft.noExpiry ? null : draft.expiresOn,
        reason: draft.reason, observation: draft.observation,
        ...(!detail.item.centralDirect ? { promiseDate: draft.promiseDate,
          ...(rights.centralAdmin ? { promiseAmount: Number(draft.promiseAmount) } : {}) } : {}),
      } : {}),
    };
    const intent = JSON.stringify({ id: detail.item.id, creditId, ...payload });
    if (changeKey.current?.intent !== intent) changeKey.current = { intent, key: crypto.randomUUID() };
    submitting.current = true; setSaving(true); setError(""); onBusyChange(true);
    try {
      const result = await request<{ item: MoraExceptionRequestItem; moraSync?: { ok: boolean; message: string } }>(
        `/api/aprobaciones/excepciones-mora/${detail.item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey: changeKey.current.key }) });
      if (!mounted.current) return;
      if (result.item.id !== extension.id || result.item.creditoId !== creditId || result.item.type !== "PRORROGA")
        throw new Error("No se pudo verificar el resultado para este crédito. Actualiza antes de continuar.");
      changeKey.current = null;
      await onChanged({ item: result.item,
        message: action === "EDIT" ? "Prórroga actualizada. El cambio quedó registrado en el historial." : "Prórroga cancelada. Su historial se conserva.",
        warning: result.moraSync && !result.moraSync.ok ? result.moraSync.message : null });
      if (mounted.current) { setAction(null); setDetail(null); setDraft(null); setReviewing(false); }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "No fue posible guardar el cambio.");
        setReviewing(false);
        if (cause instanceof ExtensionRequestError && cause.status === 409) setConflict(true);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
      onBusyChange(false);
    }
  }

  const rights = detail?.amendmentActions || capabilities;
  return <div className={styles.extensionManager}>
    {!action ? <>
      <div className={styles.extensionButtons}>
        {capabilities.canEdit && <Button variant="secondary" disabled={disabled} onClick={() => void open("EDIT")}><Pencil size={16} aria-hidden="true" />Editar prórroga</Button>}
        {capabilities.canCancel && <Button variant="ghost" disabled={disabled} className={styles.cancelExtension} onClick={() => void open("CANCEL")}><XCircle size={16} aria-hidden="true" />Cancelar prórroga</Button>}
      </div>
      {!capabilities.canEdit && capabilities.editBlockedReason && <p className={styles.extensionHelp}>{capabilities.editBlockedReason}</p>}
    </> : <section ref={editor} tabIndex={-1} className={styles.extensionEditor} aria-label={action === "EDIT" ? "Editar prórroga" : "Cancelar prórroga"}>
      <h4>{action === "EDIT" ? "Editar prórroga" : "Cancelar prórroga"}</h4>
      {loading && <LoadingState label="Consultando la prórroga vigente..." />}
      {error && <p role="alert" className={styles.extensionError}>{error}</p>}
      {!loading && !detail && <div className={styles.extensionButtons}><Button variant="secondary" onClick={() => void open(action)}>Reintentar</Button><Button variant="ghost" onClick={close}>Volver</Button></div>}
      {detail && draft && !reviewing && <form onSubmit={review} aria-label={action === "EDIT" ? "Editar prórroga" : "Cancelar prórroga"}>
        <fieldset disabled={saving || conflict || disabled}>
          {action === "EDIT" ? <>
            {rights.centralAdmin && detail.item.centralDirect && <label className={styles.extensionCheckbox}><input type="checkbox" checked={draft.noExpiry} onChange={event => update({ noExpiry: event.target.checked })} />Sin vencimiento</label>}
            {!(rights.centralAdmin && detail.item.centralDirect && draft.noExpiry) && <label><span>Vencimiento</span><Input id="mora-extension-expires-on" type="date" required value={draft.expiresOn} min={rights.minExpiresOn || undefined} max={rights.maxExpiresOn || undefined} onChange={event => update({ expiresOn: event.target.value, noExpiry: false })} /></label>}
            {!rights.centralAdmin && rights.maxExpiresOn && <p className={styles.extensionHelp}>Fecha máxima permitida: <strong>{dateLabel(rights.maxExpiresOn)}</strong>. Hasta 4 días calendario desde la fecha regular de pago.</p>}
            {!detail.item.centralDirect && <div className={styles.extensionCommitment}>
              <label><span>Fecha del compromiso</span><Input id="mora-extension-promise-date" type="date" required value={draft.promiseDate} min={rights.minExpiresOn || undefined} max={draft.expiresOn || rights.maxExpiresOn || undefined} onChange={event => update({ promiseDate: event.target.value })} /></label>
              <label><span>Valor del compromiso (COP)</span><Input id="mora-extension-promise-amount" type="number" min="0.01" step="0.01" required readOnly={!rights.centralAdmin} value={draft.promiseAmount} onChange={event => update({ promiseAmount: event.target.value })} /></label>
            </div>}
            <label><span>Motivo de la prórroga</span><textarea id="mora-extension-reason" required={!rights.centralAdmin} minLength={rights.centralAdmin ? undefined : 5} value={draft.reason} maxLength={500} rows={2} className="fp-ui-input" onChange={event => update({ reason: event.target.value })} /></label>
            <label><span>Observación</span><textarea id="mora-extension-observation" value={draft.observation} maxLength={2000} rows={2} className="fp-ui-input" onChange={event => update({ observation: event.target.value })} /></label>
          </> : <p>La prórroga dejará de estar vigente. El crédito volverá a mostrar el estado de gestión que corresponda.</p>}
          <label><span>{action === "EDIT" ? "Motivo del cambio" : "Motivo de la cancelación"}</span><textarea id="mora-extension-audit-reason" required={!rights.centralAdmin} minLength={rights.centralAdmin ? undefined : 5} maxLength={1000} value={draft.auditReason} rows={2} className="fp-ui-input" onChange={event => update({ auditReason: event.target.value })} /></label>
          <div className={styles.extensionButtons}><Button type="submit">{action === "EDIT" ? "Revisar cambios" : "Revisar cancelación"}</Button><Button variant="ghost" onClick={close}>Volver</Button></div>
        </fieldset>
        {conflict && <Button variant="secondary" onClick={() => void open(action)}>Actualizar prórroga</Button>}
      </form>}
      {detail && draft && reviewing && <section className={styles.extensionConfirmation} role="group" aria-label={action === "EDIT" ? "Confirmar cambios de la prórroga" : "Confirmar cancelación de la prórroga"}>
        <strong>{action === "EDIT" ? "Revisa el cambio antes de guardar" : "¿Cancelar esta prórroga?"}</strong>
        <p>{action === "EDIT" ? `Nuevo vencimiento: ${rights.centralAdmin && detail.item.centralDirect && draft.noExpiry ? "sin vencimiento" : dateLabel(draft.expiresOn)}.` : "Se retirará la autorización de prórroga de este crédito."}</p>
        {draft.auditReason.trim() && <p>Motivo: {draft.auditReason.trim()}</p>}
        <p>El cambio quedará registrado con tu usuario, fecha y hora. El historial anterior se conserva.</p>
        <div className={styles.extensionButtons}><Button variant="secondary" disabled={saving || disabled} onClick={() => setReviewing(false)}>Volver</Button><Button variant={action === "CANCEL" ? "danger" : "primary"} disabled={saving || disabled} onClick={() => void confirm()}>{saving ? "Guardando..." : action === "EDIT" ? "Confirmar cambios" : "Confirmar cancelación"}</Button></div>
      </section>}
    </section>}
  </div>;
}
