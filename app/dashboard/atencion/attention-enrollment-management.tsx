"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Button } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";
import { attentionEnrollmentChecks, type AttentionEnrollmentStatus } from "@/lib/atencion-work-enrollment-types";
import { readWorkManagement, useWorkAction } from "./attention-work-action";
import styles from "./attention-work-management.module.css";

type EnrollmentView = AttentionEnrollmentStatus;
const verifications = attentionEnrollmentChecks.map(({key,label}) => [key,label] as const);
type Checks = Record<(typeof verifications)[number][0], boolean>;
const emptyChecks = (): Checks => ({ activationLock: false, abm: false, deviceLock: false, deviceUnlock: false });
const date = (value: string) => new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function AttentionEnrollmentManagement({ detail, disabled, onUpdated, onBusyChange }: {
  detail: AttentionWorkDetail; disabled: boolean;
  onUpdated: (detail: AttentionWorkDetail) => void; onBusyChange: (busy: boolean) => void;
}) {
  const endpoint = `/api/atencion/solicitudes/${detail.item.id}/enrolamiento`;
  const [view, setView] = useState<EnrollmentView | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [checks, setChecks] = useState<Checks>(emptyChecks), [confirm, setConfirm] = useState(false);
  const action = useWorkAction({ onUpdated, onBusyChange });
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort(); const read = new AbortController(); controller.current = read;
    setLoading(true); setError(""); setView(null); setChecks(emptyChecks()); setConfirm(false);
    try { const result = await readWorkManagement<EnrollmentView>(endpoint, read.signal); if (!read.signal.aborted) setView(result); }
    catch (cause) { if (!read.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo consultar el enrolamiento."); }
    finally { if (!read.signal.aborted) setLoading(false); }
  }, [endpoint]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load, detail.item.version]);
  const locked = disabled || action.saving || Boolean(action.pending), closed = detail.item.state === "completed";
  const allChecked = verifications.every(([key]) => checks[key]);
  const existing = view?.status === "approved";
  const ready = !loading && !locked && !closed && view?.available && Boolean(view.caseToken) && (existing || allChecked);
  async function authorize() {
    if (!ready || !view?.caseToken) return;
    setConfirm(false);
    const result = await action.run(endpoint, { version: view.version, caseToken: view.caseToken,
      ...(existing ? { action: "record_existing" } : { action: "confirm", checks }) });
    if (result) await load();
  }
  return <>
    {loading ? <p role="status">Consultando el expediente y las validaciones de enrolamiento…</p> : null}
    {(error || action.error) && <p className={styles.error} role="alert">{error || action.error}</p>}
    {!action.pending && <div className={styles.actions}><Button variant="secondary" disabled={locked || loading} onClick={() => { action.clearError(); void load(); }}><RefreshCw size={17} aria-hidden="true"/>Actualizar validaciones</Button></div>}
    {view && <>
      <div className={`${styles.status} ${view.status === "approved" ? styles.success : view.status === "unavailable" ? styles.warning : ""}`} role="status">
        <strong>{view.status === "approved" ? "Enrolamiento autorizado" : view.status === "ready" ? "Expediente listo para validar" : "Enrolamiento no disponible"}</strong>
        {view.reason && <p>{view.reason}</p>}
        {view.review && <p><CheckCircle2 size={17} aria-hidden="true"/> {view.review.analystName} · {date(view.review.approvedAt)}</p>}
      </div>
      {!closed && view.available && !existing && <>
        <section className={styles.section}><h3><ShieldCheck size={19} aria-hidden="true"/> Checklist de autorización</h3><p>Realiza las pruebas del equipo antes de confirmar. Se registrarán con tu nombre y la fecha de autorización.</p><Badge tone="neutral">iPhone · {view.imei || detail.imei}</Badge></section>
        <fieldset className={styles.checklist} disabled={locked || loading}>
          <legend className={styles.muted}>Confirmaciones del analista</legend>
          {verifications.map(([key, label]) => <label key={key}><input type="checkbox" checked={checks[key]} onChange={event => setChecks(current => ({ ...current, [key]: event.target.checked }))}/><span>{label}</span></label>)}
        </fieldset>
      </>}
    </>}
    {detail.messages.some(message => message.direction === "inbound" && message.attachment) && <section className={styles.section}><h3>Soportes del asesor</h3><div className={styles.received}>{detail.messages.filter(message => message.direction === "inbound" && message.attachment).map(message => <a key={message.id} href={`/api/atencion/solicitudes/${detail.item.id}/files/${message.attachment!.id}`} target="_blank" rel="noopener noreferrer"><FileText size={18} aria-hidden="true"/>{message.attachment!.fileName || "Abrir soporte recibido"}</a>)}</div></section>}
    <footer className={styles.footer}>
      {action.pending ? <><p role="status">{action.saving ? "Guardando autorización…" : "La autorización está pendiente de confirmación. Consulta el mismo intento antes de continuar."}</p><Button disabled={action.saving} onClick={async () => { if (await action.retry()) await load(); }}>Consultar / reintentar mismo intento</Button></> : closed ? <p>La gestión está finalizada. El resultado permanece en el historial del chat.</p> : <>
        <Button disabled={!ready} onClick={() => setConfirm(true)}><ShieldCheck size={18} aria-hidden="true"/>{existing ? "Registrar autorización y finalizar" : "Autorizar y finalizar enrolamiento"}</Button>
        <p>{view?.available ? existing ? "Se conservarán el responsable y la fecha de la autorización existente, y se notificará al asesor." : allChecked ? "Se guardará la autorización y se notificará al asesor en esta solicitud." : "Completa las cuatro confirmaciones para habilitar la autorización." : "Corrige los pendientes del expediente y actualiza las validaciones."}</p>
      </>}
    </footer>
    <ConfirmDialog open={confirm} title={existing ? "Registrar autorización existente" : "Confirmar autorización de enrolamiento"} description={existing ? `Se vinculará la autorización existente del iPhone de ${detail.item.name}, IMEI ${view?.imei || detail.imei}, conservando su responsable y fecha. Se finalizará esta solicitud con aviso al asesor.` : `Autorizarás el iPhone de ${detail.item.name}, cédula ${view?.document || detail.document || "no registrada"}, IMEI ${view?.imei || detail.imei || "no registrado"}. Se registrarán las cuatro pruebas y se finalizará esta solicitud con aviso al asesor.`} confirmLabel={existing ? "Registrar y finalizar" : "Autorizar y finalizar"} busy={action.saving} onCancel={() => { if (!action.saving) setConfirm(false); }} onConfirm={() => void authorize()}/>
  </>;
}
