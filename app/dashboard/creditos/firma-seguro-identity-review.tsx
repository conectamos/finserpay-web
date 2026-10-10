"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";

type ReviewItem = {
  draftId: number; canReview: boolean; canSave: boolean; eligible: boolean;
  canonicalFullName: string; documentNumber: string; validationId: number;
  assessmentId: string; lockedFirstSurname: string;
  providerComponents: { names: string; firstSurname: string; secondSurname: string };
  review: null | { id: string; source: "AUTHORIZED_REVIEW"; firstNames: string; firstSurname: string;
    secondSurname: string; actorName: string; createdAt: string };
  reason: string | null;
};
type ReviewResponse = { ok?: boolean; item?: ReviewItem; error?: string; code?: string };
type ReviewValues = { firstNames: string; firstSurname: string; secondSurname: string; reason: string; attestation: boolean };
type Props = { canAdmin: boolean; draftId: number; fullName: string; documentNumber: string; validationId: number;
  veriffApproved: boolean; onSaved: (message: string) => void };
const emptyValues: ReviewValues = { firstNames: "", firstSurname: "", secondSurname: "", reason: "", attestation: false };
const comparableName = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleUpperCase("es-CO");
const documentDigits = (value: string) => value.replace(/[.\s]/g, "");

export function firmaSeguroReviewMatchesContext(item: ReviewItem, expected: Props) {
  return item.draftId === expected.draftId && item.validationId === expected.validationId &&
    item.canonicalFullName === expected.fullName && /^\d{3,13}$/.test(documentDigits(item.documentNumber)) &&
    documentDigits(item.documentNumber) === documentDigits(expected.documentNumber);
}
export function canSaveFirmaSeguroIdentityReview(item: ReviewItem | null, values: ReviewValues, expected: Props) {
  const nameValid = (value: string, optional = false) => (optional && !value.trim()) ||
    (value.trim().length >= 2 && value.trim().length <= 100 && /^[\p{L}\p{M} '’-]+$/u.test(value.trim()));
  if (!expected.canAdmin || !expected.veriffApproved || !item?.canReview || !item.canSave || !item.eligible ||
      !firmaSeguroReviewMatchesContext(item, expected) || !values.attestation || values.reason.trim().length < 5 || values.reason.trim().length > 500 ||
      !nameValid(values.firstNames) || !nameValid(values.firstSurname) || !nameValid(values.secondSurname, true)) return false;
  for (const [field, providerValue] of [["firstNames", item.providerComponents.names], ["firstSurname", item.lockedFirstSurname || item.providerComponents.firstSurname],
    ["secondSurname", item.providerComponents.secondSurname]] as const) {
    if (providerValue && comparableName(values[field]) !== comparableName(providerValue)) return false;
  }
  return comparableName([values.firstNames, values.firstSurname, values.secondSurname].filter(value => value.trim()).join(" ")) === comparableName(item.canonicalFullName);
}
function reviewFailure(result: ReviewResponse | null, fallback: string) {
  const code = typeof result?.code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(result.code) ? result.code : "";
  return (result?.error || fallback) + (code ? ` Código: ${code}.` : "");
}

class ReviewTimeoutError extends Error {}
async function requestReview(path: string, options: RequestInit, controller: AbortController, timeoutMessage: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("La revisión fue cancelada."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => { reject(new ReviewTimeoutError(timeoutMessage)); controller.abort(); }, 20_000);
    if (controller.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(path, { ...options, signal: controller.signal });
      const result = await response.json() as ReviewResponse;
      return { response, result };
    })(), interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export default function FirmaSeguroIdentityReview(props: Props) {
  const { canAdmin, draftId, fullName, documentNumber, validationId, veriffApproved, onSaved } = props;
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [values, setValues] = useState<ReviewValues>(emptyValues);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const operation = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    generation.current += 1;
    flight.current?.abort(); inFlight.current = false; operation.current = null;
    setOpen(false); setItem(null); setValues(emptyValues); setBusy(false); setError(""); setSaved(false);
    return () => { generation.current += 1; flight.current?.abort(); };
  }, [draftId, fullName, documentNumber, validationId, canAdmin, veriffApproved]);
  const path = `/api/creditos/borradores/${draftId}/identidad-firma`;
  const loadReview = async () => {
    if (!canAdmin || !veriffApproved || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const controller = new AbortController(); flight.current = controller;
    const token = generation.current;
    try {
      const { response, result } = await requestReview(path, { cache: "no-store" }, controller,
        "La consulta de la revisión superó 20 segundos. Puedes cerrar el panel o intentarlo de nuevo.");
      if (controller.signal.aborted || generation.current !== token) return;
      if (!response.ok || result.ok !== true || !result.item) throw new Error(reviewFailure(result, "No se pudo consultar la revisión autorizada."));
      if (!firmaSeguroReviewMatchesContext(result.item, props) || !result.item.canReview) throw new Error("La revisión no corresponde a esta solicitud o no tienes permiso para realizarla.");
      const next = result.item;
      setItem(next); setValues({ firstNames: next.review?.firstNames ?? next.providerComponents.names ?? "",
        firstSurname: next.lockedFirstSurname || next.review?.firstSurname || next.providerComponents.firstSurname || "",
        secondSurname: next.review?.secondSurname ?? next.providerComponents.secondSurname ?? "", reason: "", attestation: false });
      setOpen(true);
    } catch (failure) {
      if (generation.current === token && (!controller.signal.aborted || failure instanceof ReviewTimeoutError)) setError(failure instanceof Error ? failure.message : "No se pudo consultar la revisión.");
    } finally {
      if (generation.current === token) { inFlight.current = false; setBusy(false); }
    }
  };
  const saveReview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !canSaveFirmaSeguroIdentityReview(item, values, props)) return;
    const body = { firstNames: values.firstNames.normalize("NFC").trim(), firstSurname: values.firstSurname.normalize("NFC").trim(),
      secondSurname: values.secondSurname.normalize("NFC").trim(), reason: values.reason.trim(), attestation: true,
      expectedValidationId: validationId, expectedCanonicalFullName: fullName };
    const fingerprint = JSON.stringify(body);
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setError("");
    const controller = new AbortController(); flight.current = controller; const token = generation.current;
    try {
      const { response, result } = await requestReview(path, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, idempotencyKey: operation.current.key }) }, controller,
        "No se confirmó el guardado en 20 segundos. Tus datos se conservaron. Puedes cerrar el panel o reintentar el mismo guardado de forma segura.");
      if (controller.signal.aborted || generation.current !== token) return;
      if (!response.ok || result.ok !== true || !result.item) throw new Error(reviewFailure(result, "No se pudo guardar la revisión."));
      if (!firmaSeguroReviewMatchesContext(result.item, props) || !result.item.review) throw new Error("No se pudo confirmar la revisión de esta solicitud. Actualiza antes de continuar.");
      setItem(result.item); setSaved(true); setOpen(false); operation.current = null;
      onSaved("Revisión autorizada guardada. El nombre completo no cambió. Usa Enviar contrato a FirmaSeguro para continuar.");
    } catch (failure) {
      if (generation.current === token && (!controller.signal.aborted || failure instanceof ReviewTimeoutError)) setError(failure instanceof Error ? failure.message : "No se pudo guardar la revisión.");
    } finally {
      if (generation.current === token) { inFlight.current = false; setBusy(false); }
    }
  };
  const update = (field: keyof ReviewValues, value: string | boolean) => setValues(current => ({ ...current, [field]: value }));
  const close = () => { if (!inFlight.current) setOpen(false); };
  const nameMatches = comparableName([values.firstNames, values.firstSurname, values.secondSurname].filter(value => value.trim()).join(" ")) === comparableName(fullName);
  const ready = canSaveFirmaSeguroIdentityReview(item, values, props) && !busy;
  return <div className="mt-4 text-sm" role="region" aria-label="Revisión autorizada de datos para firma">
    <p className="fp-step3-firma-message is-pending" role="status">{saved ? "Revisión autorizada registrada. Puedes enviar el contrato con el botón de FirmaSeguro." : "FirmaSeguro requiere nombres y apellidos separados. El nombre completo de DataCrédito se conserva íntegro; solicita una revisión autorizada del documento."}</p>
    {canAdmin && veriffApproved ? <Button type="button" variant="secondary" onClick={() => void loadReview()} disabled={busy}>{busy ? "Consultando…" : saved ? "Ver revisión registrada" : "Revisar datos para firma"}</Button> : <p>El asesor no puede editar el primer apellido. Un administrador autorizado debe revisar este expediente.</p>}
    {error && !open ? <p role="alert" className="mt-3 text-[var(--fp-danger)]">{error}</p> : null}
    <FinserSidePanel open={open} title="Revisión autorizada para FirmaSeguro" closeLabel="Cerrar revisión para firma" busy={busy} onClose={close}>
      {item ? <form onSubmit={event => void saveReview(event)} className="space-y-4">
        <p>Escribe únicamente los componentes confirmados en el documento. No se separan automáticamente ni se atribuyen a DataCrédito. El responsable, motivo y fecha quedarán registrados.</p>
        <label className="block font-semibold">Nombres y apellidos de DataCrédito<Input value={item.canonicalFullName} readOnly autoComplete="off" /></label>
        <label className="block font-semibold">Cédula consultada<Input value={documentDigits(item.documentNumber)} readOnly autoComplete="off" /></label>
        {item.reason ? <p role="status">{item.reason}</p> : null}
        {item.review ? <p role="status">Revisión registrada por {item.review.actorName} el {new Date(item.review.createdAt).toLocaleString("es-CO")}. Procedencia: revisión autorizada.</p> : null}
        {([['firstNames', 'Nombre(s)', 'names'], ['firstSurname', 'Primer apellido', 'firstSurname'], ['secondSurname', 'Segundo apellido (si aplica)', 'secondSurname']] as const).map(([field, label, providerField]) => <label key={field} className="block font-semibold">{label}<Input value={values[field]} maxLength={100} autoComplete="off"
          required={field !== "secondSurname"} readOnly={Boolean(field === "firstSurname" ? item.lockedFirstSurname || item.providerComponents.firstSurname : item.providerComponents[providerField])} disabled={!item.canSave || !item.eligible || busy}
          onChange={event => update(field, event.target.value)} />{(field === "firstSurname" ? item.lockedFirstSurname || item.providerComponents.firstSurname : item.providerComponents[providerField]) ? <small className="font-normal">Dato ya registrado; permanece bloqueado.</small> : null}</label>)}
        {item.canSave && item.eligible ? <>
          <p role="status">{nameMatches ? "Los componentes coinciden con el nombre completo." : "Los componentes deben coincidir íntegramente con el nombre completo, conservando tildes y apellidos compuestos."}</p>
          <label className="block font-semibold">Motivo de la revisión<textarea className="fp-ui-input mt-2 w-full" minLength={5} maxLength={500} required value={values.reason} disabled={busy} onChange={event => update("reason", event.target.value)} /></label>
          <label className="flex items-start gap-3"><input type="checkbox" checked={values.attestation} disabled={busy} onChange={event => update("attestation", event.target.checked)} required /><span>Confirmo que contrasté estos componentes con el documento del cliente y que el nombre completo permanece sin cambios.</span></label>
        </> : null}
        {error ? <p role="alert" className="text-[var(--fp-danger)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="secondary" onClick={close} disabled={busy}>Cerrar</Button>{item.canSave && item.eligible ? <Button type="submit" disabled={!ready}>{busy ? "Guardando…" : "Guardar revisión autorizada"}</Button> : null}</div>
      </form> : null}
    </FinserSidePanel>
  </div>;
}
