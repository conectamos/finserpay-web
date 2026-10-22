"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

type Props = {
  draftId: number;
  dispatchId: string;
  canRecover: boolean;
  onRecovered: () => void;
};
type RecoveryAction = "reconcile" | "prepare";
type RecoveryResponse = { ok?: boolean; status?: string; code?: string };
const dispatchPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function recoveryFailure(result: RecoveryResponse | null, action: RecoveryAction) {
  switch (result?.code) {
    case "DRAFT_ADMINISTRATIVE_STATE":
      return "El estado del envío cambió. Actualiza la solicitud y consulta o vincula el proceso existente.";
    case "DRAFT_ADMINISTRATIVE_DRAFT_CHANGED":
      return "La solicitud venció o sus datos cambiaron. Actualiza y revisa el contrato antes de recuperar el envío.";
    case "DRAFT_ADMINISTRATIVE_CONTRACT_INVALID":
      return "La integridad o la fecha del contrato requiere revisión. No se habilitó otro intento ni se cambiaron los valores. Solicita la revisión del contrato antes de continuar.";
    case "DRAFT_ADMINISTRATIVE_IDENTITY_CHANGED":
      return "La validación de identidad cambió o ya no está aprobada. Actualiza y revisa la identidad del cliente antes de recuperar el envío.";
    case "DRAFT_ADMINISTRATIVE_EVIDENCE_CHANGED":
      return "El expediente ya tiene un proceso, un comprobante u otra recuperación. Actualiza la solicitud y consulta el envío existente.";
    case "DRAFT_ADMINISTRATIVE_REPLAY_CONFLICT":
      return "Esta recuperación ya fue registrada con otra confirmación. Actualiza la solicitud y continúa con el responsable que la autorizó.";
  }
  return action === "reconcile"
    ? "No se pudo vincular ese proceso al contrato original. Revisa el identificador en FirmaSeguro y actualiza la solicitud."
    : "No se confirmó la recuperación. Actualiza la solicitud y revisa su estado antes de volver a intentarlo.";
}

export default function PendingSignatureRecovery({ draftId, dispatchId, canRecover, onRecovered }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<RecoveryAction>("reconcile");
  const [processUuid, setProcessUuid] = useState("");
  const [reason, setReason] = useState("");
  const [providerReviewConfirmed, setProviderReviewConfirmed] = useState(false);
  const [remoteOutcomeUnknownAccepted, setRemoteOutcomeUnknownAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState<RecoveryAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const context = `${draftId}:${dispatchId}:${canRecover}`;
  const currentContext = useRef(context);
  currentContext.current = context;

  useEffect(() => {
    generation.current += 1;
    flight.current?.abort();
    inFlight.current = false;
    setExpanded(false); setAction("reconcile"); setProcessUuid(""); setReason("");
    setProviderReviewConfirmed(false); setRemoteOutcomeUnknownAccepted(false);
    setConfirmation(null); setBusy(false); setError(""); setCompleted(false);
    return () => { generation.current += 1; flight.current?.abort(); };
  }, [draftId, dispatchId, canRecover]);

  const eligible = canRecover && Number.isSafeInteger(draftId) && draftId > 0 && dispatchPattern.test(dispatchId) && !completed;
  const readyFor = (selected: RecoveryAction) => eligible && !inFlight.current && (selected === "reconcile"
    ? processPattern.test(processUuid.trim())
    : reason.trim().length >= 20 && reason.trim().length <= 500 && providerReviewConfirmed && remoteOutcomeUnknownAccepted);
  const askConfirmation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readyFor(action)) { setError(""); setConfirmation(action); }
  };
  const submitRecovery = async () => {
    const selected = confirmation;
    if (!selected || !readyFor(selected)) return;
    inFlight.current = true; setBusy(true); setError("");
    const controller = new AbortController(); flight.current = controller;
    const token = generation.current;
    const submittedContext = context;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onAbort = () => {};
    const body = selected === "reconcile"
      ? { dispatchId, processUuid: processUuid.trim() }
      : { dispatchId, reason: reason.trim(), providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true };
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("RECOVERY_ABORTED"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => {
          timedOut = true; controller.abort(); reject(new Error("RECOVERY_TIMEOUT"));
        }, 35_000);
      });
      const { response, result } = await Promise.race([(async () => {
        const response = await fetch(`/api/creditos/borradores/${draftId}/firma-seguro/${selected === "reconcile" ? "conciliar" : "recuperar"}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify(body), signal: controller.signal,
        });
        const result = await response.json().catch(() => null) as RecoveryResponse | null;
        return { response, result };
      })(), interrupted]);
      if (controller.signal.aborted || token !== generation.current || currentContext.current !== submittedContext) return;
      const expectedStatus = selected === "reconcile" ? "AWAITING_SIGNATURE" : "PREPARING";
      if (!response.ok || result?.ok !== true || result.status !== expectedStatus) {
        setError(recoveryFailure(result, selected)); return;
      }
      setCompleted(true); setConfirmation(null); setExpanded(false);
      onRecovered();
    } catch {
      if (token === generation.current && currentContext.current === submittedContext && (!controller.signal.aborted || timedOut)) {
        setError("No se confirmó el resultado. Actualiza la solicitud antes de repetir la operación; no se enviará otra firma automáticamente.");
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (token === generation.current && currentContext.current === submittedContext) {
        inFlight.current = false; flight.current = null; setBusy(false); setConfirmation(null);
      }
    }
  };

  if (!eligible) return null;
  return <section className="mt-4 space-y-4 text-sm" aria-label="Recuperación administrativa del envío de firma">
    <Button variant="secondary" aria-expanded={expanded} disabled={busy} onClick={() => setExpanded(value => !value)}>
      Resolver envío por confirmar
    </Button>
    {expanded ? <div className="space-y-4 border-t border-[var(--fp-border)] pt-4">
      <div>
        <h3 className="font-semibold text-[var(--fp-graphite)]">Revisar el mismo contrato</h3>
        <p className="mt-2 text-[var(--fp-muted)]">Un error de conexión o 502 no demuestra que FirmaSeguro haya rechazado el documento. Revisa el proceso original antes de habilitar otro intento.</p>
        <a href="https://app.firmaseguro.co/Process/List" target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-10 items-center font-semibold underline">Abrir FirmaSeguro para revisar</a>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Forma de recuperación">
        <Button variant={action === "reconcile" ? "primary" : "secondary"} aria-pressed={action === "reconcile"} disabled={busy} onClick={() => { setAction("reconcile"); setError(""); }}>Encontré el proceso</Button>
        <Button variant={action === "prepare" ? "primary" : "secondary"} aria-pressed={action === "prepare"} disabled={busy} onClick={() => { setAction("prepare"); setError(""); }}>No pude localizarlo</Button>
      </div>
      <form onSubmit={askConfirmation} className="space-y-4">
        {action === "reconcile" ? <>
          <p>Vincula el proceso existente. FINSER PAY verificará que pertenece al contrato original; esta acción no crea ni reenvía una firma.</p>
          <label className="block font-semibold">Identificador del proceso en FirmaSeguro
            <Input value={processUuid} maxLength={36} autoComplete="off" spellCheck={false} disabled={busy} required
              onChange={event => setProcessUuid(event.target.value)} placeholder="UUID del proceso existente" />
          </label>
        </> : <>
          <p className="rounded-[var(--fp-radius-md)] bg-[var(--fp-amber-soft)] p-4 text-[var(--fp-graphite)]">La búsqueda sin resultados no garantiza que no exista un proceso. Esta recuperación conserva el intento anterior como incierto y prepara un único intento con el mismo folio y condiciones. No envía el documento.</p>
          <label className="block font-semibold">Motivo y revisión realizada
            <textarea className="fp-ui-input mt-2 w-full" value={reason} minLength={20} maxLength={500} required disabled={busy}
              onChange={event => setReason(event.target.value)} placeholder="Indica cómo revisaste el proceso original en FirmaSeguro" />
          </label>
          <label className="flex min-h-10 items-start gap-3"><input type="checkbox" checked={providerReviewConfirmed} disabled={busy} required
            onChange={event => setProviderReviewConfirmed(event.target.checked)} /><span>Revisé FirmaSeguro por cliente y folio y no pude localizar el proceso original.</span></label>
          <label className="flex min-h-10 items-start gap-3"><input type="checkbox" checked={remoteOutcomeUnknownAccepted} disabled={busy} required
            onChange={event => setRemoteOutcomeUnknownAccepted(event.target.checked)} /><span>Entiendo que el resultado anterior sigue siendo incierto y que un nuevo intento podría duplicar un proceso no localizado.</span></label>
        </>}
        {error ? <p role="alert" className="text-[var(--fp-danger)]">{error}</p> : null}
        <Button type="submit" disabled={busy || !readyFor(action)}>{busy ? "Procesando…" : action === "reconcile" ? "Verificar y vincular proceso" : "Revisar recuperación"}</Button>
      </form>
    </div> : null}
    <ConfirmDialog open={confirmation !== null} busy={busy} danger={confirmation === "prepare"}
      title={confirmation === "prepare" ? "Preparar un único intento" : "Vincular el proceso original"}
      description={confirmation === "prepare"
        ? "Se registrará tu revisión y se preparará un intento con el mismo folio y valores. El envío anterior seguirá registrado como incierto. El documento no se enviará hasta que pulses Continuar el mismo envío."
        : "Se consultará FirmaSeguro y se verificará que este proceso corresponde al contrato original. No se creará ni reenviará una firma."}
      confirmLabel={confirmation === "prepare" ? "Preparar intento" : "Verificar proceso"}
      onCancel={() => { if (!inFlight.current) setConfirmation(null); }} onConfirm={() => void submitRecovery()} />
  </section>;
}
