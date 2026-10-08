"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Calculator, PencilLine, RefreshCw, Save } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { Button, Input, LoadingState } from "@/app/_components/finser-ui";
import { calculateRequestFinancialTerms, type RequestFinancialConfig, type RequestFinancialPreview } from "@/lib/approval-request-financial-correction-core";
import styles from "./analyst-request-editor.module.css";

type FinancialState = {
  values: Record<string, string>; revision: number; editableFields: string[];
  reason: string | null; canManageContract: boolean; config: RequestFinancialConfig | null;
  configVersion: string; preview: RequestFinancialPreview | null; calculationError: string | null;
};
type Result = { ok?: boolean; item?: FinancialState; error?: string };
const inputs = [
  { key: "valorEquipoTotal", label: "Valor de venta", min: 1 },
  { key: "cuotaInicial", label: "Inicial", min: 0 },
  { key: "plazoMeses", label: "Número de cuotas", min: 1 },
] as const;
const money = (value: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);

export default function AnalystRequestFinancialEditor({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FinancialState | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const api = `/api/aprobaciones/solicitudes/${encodeURIComponent(requestId)}/condiciones`;
  useEffect(() => () => flight.current?.abort(), [requestId]);
  const load = async () => {
    flight.current?.abort();
    const controller = new AbortController(); flight.current = controller;
    setLoading(true); setError(""); setConfirming(false);
    try {
      const response = await fetch(api, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as Result;
      if (controller.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudieron consultar las condiciones.");
      setState(result.item); setValues(result.item.values); setReason("");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudieron consultar las condiciones.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const calculation = useMemo(() => {
    if (!state?.config) return { preview: state?.preview || null, error: state?.calculationError || "" };
    try { return { preview: calculateRequestFinancialTerms(values, state.config).preview, error: "" }; }
    catch (failure) { return { preview: null, error: failure instanceof Error ? failure.message : "Revisa las condiciones ingresadas." }; }
  }, [state, values]);
  const changed = state?.editableFields.filter(key => (values[key] || "") !== (state.values[key] || "")) || [];
  const canSave = changed.length > 0 && reason.trim().length >= 5 && !!calculation.preview && !calculation.error;
  const save = async () => {
    if (!state || !canSave || !confirming || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    const controller = new AbortController(); flight.current = controller;
    try {
      const response = await fetch(api, { method: "PATCH", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        values: Object.fromEntries(changed.map(key => [key, values[key] || ""])),
        expectedValues: Object.fromEntries(inputs.map(({ key }) => [key, state.values[key] || ""])),
        expectedRevision: state.revision, expectedConfigVersion: state.configVersion, reason: reason.trim(), confirmed: true,
      }) });
      const result = await response.json() as Result;
      if (controller.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudieron guardar las condiciones.");
      setState(result.item); setOpen(false); setConfirming(false);
      setNotice("Condiciones actualizadas. El asesor recibirá los nuevos valores automáticamente."); router.refresh();
    } catch (failure) {
      if (!controller.signal.aborted) { setConfirming(false); setError(failure instanceof Error ? failure.message : "No se pudieron guardar las condiciones."); }
    } finally { savingRef.current = false; if (!controller.signal.aborted) setSaving(false); }
  };
  const review = (event: FormEvent) => { event.preventDefault(); if (canSave) setConfirming(true); };
  const preview = calculation.preview;
  return <div>
    <Button variant="secondary" aria-haspopup="dialog" onClick={() => { setOpen(true); setNotice(""); void load(); }}><PencilLine size={17} aria-hidden="true" />Editar condiciones</Button>
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    <FinserSidePanel open={open} title="Condiciones del crédito" busy={saving} onClose={() => { flight.current?.abort(); setOpen(false); }}>
      <p className={styles.intro}>Ajusta el precio, la inicial y el plazo. La cuota y el monto financiado se calculan con la política vigente.</p>
      {loading ? <LoadingState label="Consultando condiciones…" /> : <>
        {error && <div role="alert" className={`${styles.feedback} ${styles.error}`}><p>{error}</p><Button variant="secondary" disabled={saving} onClick={() => void load()}><RefreshCw size={16} />Actualizar condiciones</Button></div>}
        {state?.reason && <p className={styles.feedback}>{state.reason}</p>}
        {state && <form className={styles.form} onSubmit={review}>
          <div className={styles.fields}>
            {inputs.map(({ key, label, min }) => <label className={styles.field} key={key}>{label}
              <Input type="number" inputMode="numeric" min={min} step="1" required value={values[key] || ""}
                disabled={saving || confirming || !state.editableFields.includes(key)}
                max={key === "plazoMeses" ? state.config?.maxInstallments : undefined}
                onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />
            </label>)}
          </div>
          {calculation.error && state.editableFields.length > 0 && <p role="status" className={styles.feedback}>{calculation.error}</p>}
          {preview && <dl className={styles.preview} aria-label="Resumen de condiciones calculadas">
            <div><dt>Monto financiado</dt><dd>{money(preview.valorFinanciado)}</dd></div>
            <div><dt>Valor de cuota</dt><dd>{money(preview.valorCuota)}</dd></div>
            <div><dt>Frecuencia</dt><dd>{preview.frecuenciaPago}</dd></div>
            <div><dt>Total del plan</dt><dd>{money(preview.totalPagar)}</dd></div>
          </dl>}
          <p className={styles.intro}>La primera fecha de pago se asigna al activar el crédito, según su calendario.</p>
          {state.editableFields.length > 0 ? <>
            <label className={styles.field}>Motivo de la corrección<textarea className={`fp-ui-input ${styles.reason}`} required minLength={5} maxLength={500} value={reason} disabled={saving || confirming} onChange={event => setReason(event.target.value)} placeholder="Explica qué condiciones necesitas corregir" /></label>
            {confirming && preview ? <div className={styles.confirmation} role="group" aria-label="Confirmar cambio de condiciones">
              <h3>Confirmar nuevas condiciones</h3>
              <p>Se guardará un monto financiado de <strong>{money(preview.valorFinanciado)}</strong> en <strong>{preview.numeroCuotas} cuotas de {money(preview.valorCuota)}</strong>. Estos valores se actualizarán en la solicitud del asesor.</p>
              <div className={styles.actions}><Button variant="secondary" disabled={saving} onClick={() => setConfirming(false)}>Volver</Button><Button disabled={saving} onClick={() => void save()}><Save size={17} />{saving ? "Guardando…" : "Confirmar y guardar"}</Button></div>
            </div> : <div className={styles.actions}><Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button><Button type="submit" disabled={!canSave}><Calculator size={18} aria-hidden="true" />Revisar cambio</Button></div>}
          </> : state.canManageContract ? <Link href={`/dashboard/aprobaciones/firma-seguro?caso=${encodeURIComponent(requestId)}`} className="fp-ui-button is-secondary" prefetch={false}>Gestionar la nueva versión del contrato</Link> : null}
        </form>}
      </>}
    </FinserSidePanel>
  </div>;
}
