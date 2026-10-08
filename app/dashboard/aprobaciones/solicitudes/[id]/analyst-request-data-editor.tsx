"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PencilLine, RefreshCw, Save, X } from "lucide-react";
import { Button, Card, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import { COLOMBIA_DEPARTMENT_OPTIONS, getColombiaCityOptions } from "@/lib/colombia-locations";

type CorrectionState = {
  values: Record<string, string>;
  revision: number;
  editableFields: string[];
  reason: string | null;
  identityReason?: string | null;
  canManageContract?: boolean;
};
type ApiResult = { ok?: boolean; item?: CorrectionState; error?: string };
const fields = [
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

export default function AnalystRequestDataEditor({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CorrectionState | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const apiPath = `/api/aprobaciones/solicitudes/${encodeURIComponent(requestId)}/datos`;

  useEffect(() => () => controller.current?.abort(), [requestId]);

  const load = useCallback(async () => {
    controller.current?.abort();
    const flight = new AbortController();
    controller.current = flight;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiPath, { cache: "no-store", signal: flight.signal });
      const result = await response.json() as ApiResult;
      if (flight.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudieron cargar los datos de la solicitud.");
      setState(result.item);
      setValues(result.item.values);
      setReason("");
    } catch (failure) {
      if (!flight.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudieron cargar los datos.");
    } finally {
      if (!flight.signal.aborted) setLoading(false);
    }
  }, [apiPath]);

  const changed = state?.editableFields.filter(field => (values[field] || "") !== (state.values[field] || "")) || [];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || savingRef.current || !changed.length || reason.trim().length < 5) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const flight = new AbortController();
    controller.current = flight;
    try {
      const response = await fetch(apiPath, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, signal: flight.signal,
        body: JSON.stringify({
          expectedRevision: state.revision,
          expectedValues: Object.fromEntries(changed.map(field => [field, state.values[field] || ""])),
          values: Object.fromEntries(changed.map(field => [field, values[field] || ""])), reason: reason.trim(),
        }),
      });
      const result = await response.json() as ApiResult;
      if (flight.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudo guardar la corrección.");
      setState(result.item);
      setValues(result.item.values);
      setReason("");
      setOpen(false);
      setNotice("Datos corregidos. El asesor recibirá la actualización automáticamente en su solicitud abierta.");
      router.refresh();
    } catch (failure) {
      if (!flight.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudo guardar la corrección.");
    } finally {
      savingRef.current = false;
      if (!flight.signal.aborted) setSaving(false);
    }
  };

  return <section aria-label="Corrección de datos de la solicitud" className="grid gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" aria-expanded={open} aria-controls="analyst-client-data" onClick={() => {
        if (open) { controller.current?.abort(); setOpen(false); } else { setOpen(true); setNotice(""); void load(); }
      }} disabled={saving}><PencilLine size={18} aria-hidden="true" />Corregir datos</Button>
      {notice && <p role="status" className="text-sm text-[var(--fp-graphite)]">{notice}</p>}
    </div>
    {open && <Card id="analyst-client-data" className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-bold">Corregir datos del cliente</h2><p className="mt-1 text-sm text-[var(--fp-muted)]">Los cambios se guardan en esta solicitud y se actualizan en la pantalla del asesor.</p></div>
        <Button variant="ghost" disabled={saving} onClick={() => { controller.current?.abort(); setOpen(false); }} aria-label="Cerrar corrección"><X size={18} /></Button>
      </div>
      {loading ? <LoadingState label="Consultando datos editables…" /> : <>
        {state?.reason && <p role="status" className="mb-4 text-sm text-[var(--fp-muted)]">{state.reason}</p>}
        {state?.identityReason && <p className="mb-4 text-sm text-[var(--fp-muted)]">{state.identityReason}</p>}
        {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-[var(--fp-danger)]"><span>{error}</span><Button variant="secondary" disabled={saving} onClick={() => void load()}><RefreshCw size={16} />Actualizar datos</Button></div>}
        {state && <form onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.filter(([field]) => field in state.values).map(([field, label, type]) => {
              const editable = state.editableFields.includes(field);
              return <label key={field} className="grid content-start gap-2 text-sm font-medium">{label}
                {field === "clienteDepartamento" ? <Select value={values[field] || ""} disabled={!editable || saving} onChange={event => setValues(current => ({ ...current, [field]: event.target.value, clienteCiudad: "" }))}>
                  <option value="">Selecciona un departamento</option>
                  {values[field] && !COLOMBIA_DEPARTMENT_OPTIONS.some(option => option.value === values[field]) && <option value={values[field]}>{values[field]}</option>}
                  {COLOMBIA_DEPARTMENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select> : field === "clienteCiudad" ? <Select value={values[field] || ""} disabled={!editable || saving} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))}>
                  <option value="">Selecciona una ciudad</option>
                  {values[field] && !getColombiaCityOptions(values.clienteDepartamento || "", values[field]).includes(values[field]) && <option value={values[field]}>{values[field]}</option>}
                  {getColombiaCityOptions(values.clienteDepartamento || "", values[field] || "").map(city => <option key={city} value={city}>{city}</option>)}
                </Select> : <Input type={type} value={values[field] || ""} disabled={!editable || saving} maxLength={field === "clienteTelefono" ? 12 : field === "clienteDireccion" ? 240 : 180} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} />}
                {!editable && <span className="text-xs font-normal text-[var(--fp-muted)]">Protegido por la validación o el contrato.</span>}
              </label>;
            })}
          </div>
          {state.editableFields.length > 0 ? <>
            <label className="mt-5 grid gap-2 text-sm font-medium">Motivo de la corrección<Input required minLength={5} maxLength={500} value={reason} disabled={saving} onChange={event => setReason(event.target.value)} placeholder="Describe qué dato se está corrigiendo" /></label>
            <div className="mt-5 flex flex-wrap gap-3"><Button type="submit" disabled={saving || !changed.length || reason.trim().length < 5}><Save size={18} aria-hidden="true" />{saving ? "Guardando…" : "Guardar corrección"}</Button><Button variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button></div>
          </> : state.canManageContract ? <Link href={`/dashboard/aprobaciones/firma-seguro?caso=${encodeURIComponent(requestId)}`} prefetch={false} className="fp-ui-button is-secondary mt-5">Gestionar la corrección del contrato</Link> : null}
        </form>}
      </>}
    </Card>}
  </section>;
}
