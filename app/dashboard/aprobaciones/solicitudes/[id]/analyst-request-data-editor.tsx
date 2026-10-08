"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PencilLine, RefreshCw, Save } from "lucide-react";
import { Button, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { COLOMBIA_DEPARTMENT_OPTIONS, getColombiaCityOptions } from "@/lib/colombia-locations";
import styles from "./analyst-request-editor.module.css";

type SignatureOutcome = {
  status: string;
  id: string | number;
  message: string;
  processUuid?: string | null;
  saved: boolean;
};
type CorrectionState = {
  values: Record<string, string>;
  revision: number;
  editableFields: string[];
  reason: string | null;
  requiresNewSignature?: boolean;
  expectedProcessUuid?: string | null;
  signatureNotice?: string | null;
  canManageContract?: boolean;
  signature?: SignatureOutcome;
};
type ApiResult = { ok?: boolean; item?: CorrectionState; error?: string };
type EditorData = { requestId: string; state: CorrectionState; values: Record<string, string>; reason: string };
type ResultNotice = { requestId: string; message: string; signature?: SignatureOutcome; uncertain?: boolean };
const fields = [
  ["clienteDocumento", "Cédula", "text"],
  ["clientePrimerNombre", "Nombres", "text"],
  ["clientePrimerApellido", "Primer apellido", "text"],
  ["clienteSegundoApellido", "Segundo apellido", "text"],
  ["clienteFechaNacimiento", "Fecha de nacimiento", "date"],
  ["clienteTelefono", "Celular", "tel"],
  ["clienteCorreo", "Correo", "email"],
  ["clienteDireccion", "Dirección", "text"],
  ["clienteDepartamento", "Departamento", "select"],
  ["clienteCiudad", "Ciudad o municipio", "select"],
] as const;
const protectedFields = new Set(["clienteDocumento", "clientePrimerApellido"]);
const allowedFields = new Set<string>(fields.map(([field]) => field));

export default function AnalystRequestDataEditor({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [data, setData] = useState<EditorData | null>(null);
  const [loadingRequest, setLoadingRequest] = useState<string | null>(null);
  const [savingRequest, setSavingRequest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<ResultNotice | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const operation = useRef<{ fingerprint: string; key: string } | null>(null);
  const generation = useRef(0);
  const open = openRequest === requestId;
  const loading = loadingRequest === requestId;
  const saving = savingRequest === requestId;
  const state = data?.requestId === requestId ? data.state : null;
  const values = data?.requestId === requestId ? data.values : {};
  const reason = data?.requestId === requestId ? data.reason : "";
  const currentNotice = notice?.requestId === requestId ? notice : null;
  const unresolved = Boolean(currentNotice?.uncertain || currentNotice?.signature?.status === "UNCERTAIN");
  const apiPath = `/api/aprobaciones/solicitudes/${encodeURIComponent(requestId)}/datos`;
  const signatureHref = `/dashboard/aprobaciones/firma-seguro?caso=${encodeURIComponent(requestId)}`;

  useEffect(() => {
    const lifecycle = generation;
    const token = ++lifecycle.current;
    return () => {
      if (lifecycle.current === token) lifecycle.current++;
      controller.current?.abort();
      controller.current = null;
      savingRef.current = false;
      operation.current = null;
    };
  }, [requestId]);

  const load = useCallback(async () => {
    if (savingRef.current) return;
    controller.current?.abort();
    const flight = new AbortController();
    const token = generation.current;
    controller.current = flight;
    setLoadingRequest(requestId);
    setError("");
    try {
      const response = await fetch(apiPath, { cache: "no-store", signal: flight.signal });
      const result = await response.json() as ApiResult;
      if (flight.signal.aborted || generation.current !== token) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudieron cargar los datos de la solicitud.");
      setData({ requestId, state: result.item, values: result.item.values, reason: "" });
    } catch (failure) {
      if (!flight.signal.aborted && generation.current === token) setError(failure instanceof Error ? failure.message : "No se pudieron cargar los datos.");
    } finally {
      if (!flight.signal.aborted && generation.current === token) setLoadingRequest(null);
    }
  }, [apiPath, requestId]);

  const editableFields = state?.editableFields.filter(field => allowedFields.has(field) && !protectedFields.has(field)) || [];
  const changed = editableFields.filter(field => (values[field] || "") !== (state?.values[field] || ""));
  const ready = Boolean(state && changed.length && reason.trim().length >= 5 && !saving && !unresolved);
  const updateValue = (field: string, value: string) => {
    if (!editableFields.includes(field) || savingRef.current || unresolved) return;
    setData(current => current?.requestId === requestId ? {
      ...current, values: { ...current.values, [field]: value, ...(field === "clienteDepartamento" ? { clienteCiudad: "" } : {}) },
    } : current);
  };
  const close = () => {
    if (savingRef.current) return;
    controller.current?.abort();
    setOpenRequest(null);
    setConfirmRequest(null);
  };

  const save = async (confirmed = false) => {
    if (!state || savingRef.current || !ready || (state.requiresNewSignature && !confirmed)) return;
    const body = {
      expectedRevision: state.revision,
      expectedValues: Object.fromEntries(changed.map(field => [field, state.values[field] || ""])),
      values: Object.fromEntries(changed.map(field => [field, values[field] || ""])),
      reason: reason.trim(),
      ...(state.requiresNewSignature ? { expectedProcessUuid: state.expectedProcessUuid ?? null, confirmed: true } : {}),
    };
    const fingerprint = JSON.stringify(body);
    if (state.requiresNewSignature && operation.current?.fingerprint !== fingerprint) {
      operation.current = { fingerprint, key: crypto.randomUUID() };
    }
    savingRef.current = true;
    setSavingRequest(requestId);
    setError("");
    const flight = new AbortController();
    const token = generation.current;
    controller.current?.abort();
    controller.current = flight;
    let knownRejection = false;
    try {
      const response = await fetch(apiPath, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, signal: flight.signal,
        body: JSON.stringify({ ...body, ...(state.requiresNewSignature ? { idempotencyKey: operation.current!.key } : {}) }),
      });
      const result = await response.json() as ApiResult;
      if (flight.signal.aborted || generation.current !== token) return;
      if (!response.ok || !result.item) {
        knownRejection = response.status >= 400 && response.status < 500;
        throw new Error(result.error || "No se pudo guardar la corrección.");
      }
      const signature = result.item.signature;
      const saved = signature?.saved !== false;
      // A known safe failure preserves the edit, but its terminal ledger operation
      // needs a fresh key on the next explicit confirmation. Unknown outcomes never retry.
      setData({ requestId, state: result.item, values: saved ? result.item.values : values, reason: saved ? "" : reason });
      setNotice({ requestId, signature, message: signature
        ? `${saved ? "Datos corregidos. " : "Los datos aún no se guardaron. "}${signature.message}`
        : "Datos corregidos. El asesor recibirá la actualización automáticamente en su solicitud abierta." });
      setConfirmRequest(null);
      if (!signature) setOpenRequest(null);
      operation.current = null;
      router.refresh();
    } catch (failure) {
      if (!flight.signal.aborted && generation.current === token) {
        setError(failure instanceof Error ? failure.message : "No se pudo guardar la corrección.");
        setConfirmRequest(null);
        if (!knownRejection) setNotice({ requestId, uncertain: true,
          message: "No pudimos confirmar el resultado. Actualiza los datos y consulta Gestionar firma antes de intentar otro envío." });
      }
    } finally {
      if (generation.current === token) {
        savingRef.current = false;
        if (!flight.signal.aborted) setSavingRequest(null);
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || savingRef.current) return;
    if (state?.requiresNewSignature) setConfirmRequest(requestId);
    else void save();
  };
  const outcome = currentNotice && <div role="status" className={styles.feedback}>
    <p>{currentNotice.message}</p>
    {(currentNotice.signature || currentNotice.uncertain) && <Link href={signatureHref} prefetch={false} className="fp-ui-button is-secondary mt-3">Gestionar firma</Link>}
  </div>;

  return <div aria-label="Corrección de datos de la solicitud">
    <Button variant="secondary" aria-haspopup="dialog" onClick={() => {
      if (open) close(); else { setOpenRequest(requestId); setSavingRequest(null); setConfirmRequest(null); void load(); }
    }} disabled={saving}><PencilLine size={17} aria-hidden="true" />Editar datos</Button>
    {!open && outcome}
    <FinserSidePanel open={open} title="Corregir datos del cliente" busy={saving || confirmRequest === requestId} onClose={close}>
      <p className={styles.intro}>Puedes corregir los datos del cliente. El primer apellido y la cédula permanecen protegidos. El cambio y su motivo quedarán en el historial y se actualizarán en la solicitud del asesor.</p>
      {outcome}
      {loading ? <LoadingState label="Consultando datos editables…" /> : <>
        {state?.reason && <p role="status" className={styles.feedback}>{state.reason}</p>}
        {state?.signatureNotice && <p className={styles.feedback}>{state.signatureNotice}</p>}
        {state?.requiresNewSignature && !state.signatureNotice && <p className={styles.feedback}>Al guardar se archivará el contrato anterior y se enviará una nueva solicitud de FirmaSeguro con los datos corregidos. Las condiciones financieras se conservarán.</p>}
        {error && <div role="alert" className={`${styles.feedback} ${styles.error}`}><p>{error}</p><Button variant="secondary" disabled={saving} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />Actualizar datos</Button></div>}
        {unresolved && !error && <Button variant="secondary" disabled={saving} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />Actualizar datos</Button>}
        {state && <form onSubmit={submit} className={styles.form}>
          <div className={styles.fields}>
            {fields.filter(([field]) => field in state.values).map(([field, label, type]) => {
              const protectedField = protectedFields.has(field);
              const editable = editableFields.includes(field);
              return <label key={field} className={styles.field}>{label}
                {field === "clienteDepartamento" ? <Select value={values[field] || ""} disabled={!editable || saving || unresolved} onChange={event => updateValue(field, event.target.value)}>
                  <option value="">Selecciona un departamento</option>
                  {values[field] && !COLOMBIA_DEPARTMENT_OPTIONS.some(option => option.value === values[field]) && <option value={values[field]}>{values[field]}</option>}
                  {COLOMBIA_DEPARTMENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select> : field === "clienteCiudad" ? <Select value={values[field] || ""} disabled={!editable || saving || unresolved} onChange={event => updateValue(field, event.target.value)}>
                  <option value="">Selecciona una ciudad</option>
                  {values[field] && !getColombiaCityOptions(values.clienteDepartamento || "", values[field]).includes(values[field]) && <option value={values[field]}>{values[field]}</option>}
                  {getColombiaCityOptions(values.clienteDepartamento || "", values[field] || "").map(city => <option key={city} value={city}>{city}</option>)}
                </Select> : <Input type={type} value={values[field] || ""} readOnly={protectedField} disabled={(!editable && !protectedField) || saving || unresolved} maxLength={field === "clienteTelefono" ? 12 : field === "clienteDireccion" ? 240 : 180} onChange={event => updateValue(field, event.target.value)} />}
                {protectedField ? <small>No se puede modificar.</small> : !editable && <small>{state.reason || "Este dato no está disponible para edición en el estado actual."}</small>}
              </label>;
            })}
          </div>
          {editableFields.length > 0 ? <>
            <label className={styles.field}>Motivo de la corrección<textarea className={`fp-ui-input ${styles.reason}`} required minLength={5} maxLength={500} value={reason} disabled={saving || unresolved} onChange={event => setData(current => current?.requestId === requestId ? { ...current, reason: event.target.value } : current)} placeholder="Describe qué dato se está corrigiendo" /></label>
            <div className={styles.actions}><Button variant="secondary" disabled={saving} onClick={close}>Cerrar</Button><Button type="submit" disabled={!ready}><Save size={18} aria-hidden="true" />{saving ? "Guardando…" : state.requiresNewSignature ? "Guardar y enviar nueva firma" : "Guardar corrección"}</Button></div>
          </> : state.canManageContract ? <Link href={signatureHref} prefetch={false} className="fp-ui-button is-secondary mt-5">Gestionar la corrección del contrato</Link> : null}
        </form>}
      </>}
      <ConfirmDialog open={confirmRequest === requestId} title="Corregir datos y enviar nueva firma" description="Se guardarán los datos corregidos y el motivo en el historial. El contrato anterior quedará archivado y se generará una nueva firma de FirmaSeguro para el cliente. El valor de venta, inicial, monto, plazo, cuotas y primer pago se conservarán." confirmLabel="Guardar y enviar nueva firma" busy={saving} onCancel={() => { if (!savingRef.current) setConfirmRequest(null); }} onConfirm={() => void save(true)} />
    </FinserSidePanel>
  </div>;
}
