"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { Button, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import ApprovalCallRecording from "@/app/dashboard/aprobaciones/approval-call-recording";
import CreditWelcomeVoiceResult from "@/app/dashboard/aprobaciones/credit-welcome-voice-result";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";
import { attentionWelcomeOutcomes, type AttentionWelcomeOutcome, type AttentionWelcomeView } from "@/lib/atencion-work-welcome-types";
import { readWorkManagement, useWorkAction } from "./attention-work-action";
import styles from "./attention-work-management.module.css";

type WelcomeView = AttentionWelcomeView;
const outcomes = attentionWelcomeOutcomes;
type Outcome = AttentionWelcomeOutcome;
const date = (value: string) => new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function AttentionWelcomeManagement({ detail, disabled, onUpdated, onBusyChange, onCallModeChange }: {
  detail: AttentionWorkDetail; disabled: boolean; onUpdated: (detail: AttentionWorkDetail) => void;
  onBusyChange: (busy: boolean) => void; onCallModeChange: (mode: string) => void;
}) {
  const endpoint = `/api/atencion/solicitudes/${detail.item.id}/bienvenida`;
  const [view, setView] = useState<WelcomeView | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | "">(""), [observation, setObservation] = useState(""), [voiceId, setVoiceId] = useState("");
  const [confirm, setConfirm] = useState(false), [mediaBusy, setMediaBusy] = useState(false), [actionBusy, setActionBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const action = useWorkAction({ onUpdated, onBusyChange: setActionBusy });
  useEffect(() => { onBusyChange(mediaBusy || actionBusy); }, [mediaBusy, actionBusy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const load = useCallback(async () => {
    controller.current?.abort(); const read = new AbortController(); controller.current = read;
    setLoading(true); setError(""); setConfirm(false);
    try {
      const next = await readWorkManagement<WelcomeView>(endpoint, read.signal);
      if (!read.signal.aborted) setView(previous => {
        if (previous && (previous.contextHash !== next.contextHash || previous.workVersion !== next.workVersion)) { setOutcome(""); setVoiceId(""); }
        return next;
      });
    } catch (cause) { if (!read.signal.aborted) { setView(null); setError(cause instanceof Error ? cause.message : "No se pudo consultar la bienvenida."); } }
    finally { if (!read.signal.aborted) setLoading(false); }
  }, [endpoint]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load, detail.item.version]);
  const closed = detail.item.state === "completed", locked = disabled || actionBusy || mediaBusy || loading;
  const mode = detail.item.callMode;
  const eligibleVoice = (view?.voiceItems || []).filter(call => call.status === "COMPLETED" && call.providerCallId && call.completedAt && call.source !== "CONTROLLED_TEST" && Object.hasOwn(outcomes, call.communicationOutcome || ""));
  const voice = eligibleVoice.find(call => call.id === voiceId);
  const selectedOutcome = mode === "dapta" ? voice?.communicationOutcome as Outcome | undefined : outcome;
  const final = selectedOutcome === "HUMAN_CONTACT" || selectedOutcome === "OPT_OUT";
  const needsRecording = mode === "human" && selectedOutcome === "HUMAN_CONTACT" && view?.detail.callRecording?.required !== false && !view?.detail.callRecording?.recording;
  const canRecord = !closed && !locked && view && mode !== "undecided" && Boolean(selectedOutcome) && observation.trim().length > 0 && !needsRecording && (mode !== "dapta" || Boolean(voice));
  async function finish() {
    if (!canRecord || !view) return;
    setConfirm(false);
    const result = await action.run(`${endpoint}/finalizar`, {
      version: view.workVersion, contextHash: view.contextHash, mode, outcome: selectedOutcome, observation,
      revision: view.detail.review.revision, reviewHash: view.detail.review.reviewHash,
      ...(mode === "human" && view.detail.callRecording?.recording ? { recordingId: view.detail.callRecording.recording.id } : {}),
      ...(mode === "dapta" && voice ? { voiceEventId: voice.id } : {}),
    });
    if (result) { setObservation(""); setOutcome(""); setVoiceId(""); await load(); }
  }
  return <>
    {(error || action.error) && <p className={styles.error} role="alert">{error || action.error}</p>}
    {!action.pending && <div className={styles.actions}><Button variant="secondary" disabled={locked} onClick={() => { action.clearError(); void load(); }}><RefreshCw size={17} aria-hidden="true"/>Actualizar gestión</Button></div>}
    {loading && <p role="status">Consultando bienvenida y grabaciones…</p>}
    {view && <>
      <section className={styles.section}><label>Responsable de la llamada<Select value={mode} disabled={locked || closed} onChange={event => onCallModeChange(event.target.value)}><option value="undecided">Selecciona la modalidad</option><option value="human">Analista</option><option value="dapta">Agente de voz Dapta</option></Select></label><small>Elegir la modalidad no inicia la llamada.</small></section>
      {mode === "human" && <ApprovalCallRecording detail={view.detail} compact disabled={disabled || actionBusy || loading || closed} readOnly={closed} context="welcome" uploadEndpoint={`${endpoint}/grabaciones`} workVersion={view.workVersion} contextHash={view.contextHash} onUpdated={load} onBusyChange={setMediaBusy}/>}
      {mode === "dapta" && <CreditWelcomeVoiceResult creditId={view.detail.id} endpoint={`${endpoint}/voz`} scopeVersion={view.workVersion} contextHash={view.contextHash} disabled={disabled || actionBusy || closed} readOnly={closed} onUpdated={load} onBusyChange={setMediaBusy}/>}
      {!closed && mode !== "undecided" && <section className={styles.section}>
        <h3>Resultado de la gestión</h3>
        {mode === "human" ? <label>Resultado de la llamada<Select value={outcome} disabled={locked} onChange={event => setOutcome(event.target.value as Outcome)}><option value="">Selecciona el resultado</option>{Object.entries(outcomes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></label> : <>
          <label>Llamada con resultado confirmado<Select value={voiceId} disabled={locked || !eligibleVoice.length} onChange={event => setVoiceId(event.target.value)}><option value="">Selecciona una llamada finalizada</option>{eligibleVoice.map(call => <option key={call.id} value={call.id}>{date(call.completedAt || call.createdAt)} · {outcomes[call.communicationOutcome as Outcome]}</option>)}</Select></label>
          {!eligibleVoice.length && <p className={styles.muted}>Aún no hay una llamada finalizada con resultado confirmado. Actualiza después de recibir el resultado de Dapta.</p>}
          {voice?.summary && <div className={styles.status}><strong>Resultado registrado por Dapta</strong><p>{voice.summary}</p></div>}
        </>}
        <label>Observación para el asesor<textarea value={observation} disabled={locked} maxLength={3000} rows={4} onChange={event => setObservation(event.target.value)} placeholder="Describe la gestión realizada y el siguiente paso."/></label>
        {needsRecording && <p className={styles.error}>Este expediente exige la grabación vigente. Guárdala antes de finalizar el contacto.</p>}
        {selectedOutcome === "NO_ANSWER" || selectedOutcome === "UNCERTAIN" ? <p className={styles.muted}>Se registrará el seguimiento y la solicitud continuará en revisión.</p> : selectedOutcome === "OPT_OUT" ? <p className={styles.muted}>La solicitud se cerrará sin bienvenida, indicando que el cliente no autoriza la llamada o la grabación.</p> : null}
      </section>}
    </>}
    <footer className={styles.footer}>
      {action.pending ? <><p role="status">{action.saving ? "Guardando gestión…" : "El resultado está pendiente de confirmación. Consulta el mismo intento antes de continuar."}</p><Button disabled={action.saving} onClick={async () => { if (await action.retry()) { setObservation(""); await load(); } }}>Consultar / reintentar mismo intento</Button></> : closed ? <p>La gestión finalizada permanece en el historial del chat.</p> : <>
        <Button disabled={!canRecord} onClick={() => setConfirm(true)}><CheckCircle2 size={18} aria-hidden="true"/>{selectedOutcome === "OPT_OUT" ? "Cerrar solicitud con resultado" : final ? "Finalizar bienvenida" : "Registrar seguimiento"}</Button>
        <p>El resultado se guarda en este chat y genera un aviso al asesor. El OK documental para liquidación conserva su proceso actual.</p>
      </>}
    </footer>
    <ConfirmDialog open={confirm} title={final ? "Confirmar resultado de bienvenida" : "Registrar seguimiento de bienvenida"} description={`${detail.item.name}: ${selectedOutcome ? outcomes[selectedOutcome] : ""}. ${final ? "Se finalizará esta solicitud" : "La solicitud continuará en revisión"} y se notificará al asesor con la observación registrada.`} confirmLabel={final ? "Guardar y finalizar" : "Guardar seguimiento"} busy={action.saving} onCancel={() => { if (!action.saving) setConfirm(false); }} onConfirm={() => void finish()}/>
  </>;
}
