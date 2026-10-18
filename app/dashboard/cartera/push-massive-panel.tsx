"use client";

import { useRef, useState } from "react";
import { Eye, Megaphone, Send, ShieldCheck } from "lucide-react";
import { Button, Card, Input, Select } from "@/app/_components/finser-ui";
import styles from "./push-massive-panel.module.css";

type BulkPushFilter = "MORA" | "TODOS_APP" | "VENCE_2_DIAS" | "VENCE_HOY" | "VENCE_MANANA";
type ManualPushPreset = "custom" | "efecty" | "internet" | "mora";
type PushSummary = {
  checked: number;
  failed: number;
  noToken: number;
  sent: number;
  targetCredits: number;
  wouldSend: number;
  excludedActiveMoraProtection?: number;
};
type PushResponse = { error?: string; ok?: boolean; summary?: PushSummary };

const FILTER_OPTIONS: Array<{ label: string; value: BulkPushFilter }> = [
  { label: "Clientes en mora", value: "MORA" },
  { label: "Vencen hoy", value: "VENCE_HOY" },
  { label: "Vencen mañana", value: "VENCE_MANANA" },
  { label: "Vencen en 2 días", value: "VENCE_2_DIAS" },
  { label: "Todos con app", value: "TODOS_APP" },
];
const PRESET_OPTIONS: Array<{ label: string; value: ManualPushPreset }> = [
  { label: "Cuota vencida", value: "mora" },
  { label: "Pago EFECTY", value: "efecty" },
  { label: "Mantener internet", value: "internet" },
  { label: "Personalizado", value: "custom" },
];

export default function PushMassivePanel() {
  const [filter, setFilter] = useState<BulkPushFilter>("MORA");
  const [preset, setPreset] = useState<ManualPushPreset>("mora");
  const [title, setTitle] = useState("FINSER PAY");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<PushSummary | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [running, setRunning] = useState<"preview" | "send" | null>(null);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const confirmedPreview = useRef<PushSummary | null>(null);

  const invalidatePreview = () => {
    revision.current += 1;
    confirmedPreview.current = null;
    setPreview(null);
    setPreviewReady(false);
    setFeedback(null);
  };

  const runPush = async (dryRun: boolean) => {
    if (inFlight.current || (!dryRun && !confirmedPreview.current?.wouldSend)) return;
    if (preset === "custom" && !body.trim()) {
      setFeedback({ error: true, text: "Escribe el mensaje personalizado antes de previsualizar." });
      return;
    }
    if (!dryRun && !window.confirm(
      `Vas a enviar notificaciones a ${confirmedPreview.current?.wouldSend || 0} dispositivo(s) registrados. ¿Deseas continuar?`
    )) return;

    inFlight.current = true;
    confirmedPreview.current = null;
    setPreviewReady(false);
    if (dryRun) setPreview(null);
    const requestRevision = revision.current;
    setRunning(dryRun ? "preview" : "send");
    setFeedback(null);
    try {
      const response = await fetch("/api/creditos/push-manual", {
        body: JSON.stringify({ body, dryRun, filter, mode: "bulk", preset, title }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as PushResponse | null;
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || "No se pudo procesar el envío de notificaciones.");
      }
      if (requestRevision !== revision.current) return;
      setPreview(data.summary);
      // A sent batch must be previewed again before another dispatch.
      confirmedPreview.current = dryRun ? data.summary : null;
      setPreviewReady(dryRun);
      setFeedback({
        error: !dryRun && data.summary.failed > 0,
        text: dryRun
          ? data.summary.wouldSend > 0
            ? `Previsualización lista: ${data.summary.wouldSend} dispositivo(s).`
            : "No hay dispositivos disponibles para este envío."
          : `Enviadas: ${data.summary.sent}. Fallidas: ${data.summary.failed}. Sin app: ${data.summary.noToken}.`,
      });
    } catch (error) {
      if (requestRevision === revision.current) {
        setFeedback({ error: true, text: error instanceof Error ? error.message : "No se pudo procesar el envío." });
      }
    } finally {
      inFlight.current = false;
      setRunning(null);
    }
  };

  const canSend = Boolean(previewReady && preview && preview.wouldSend > 0);

  return (
    <Card className={styles.panel} role="region" aria-labelledby="massive-push-title" aria-busy={running !== null}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon}><Megaphone aria-hidden="true" size={22} strokeWidth={1.8} /></span>
          <div><p>NOTIFICACIONES A CLIENTES</p><h2 id="massive-push-title">Gestión masiva</h2></div>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => void runPush(true)} disabled={running !== null}>
            <Eye size={17} aria-hidden="true" />{running === "preview" ? "Revisando…" : "Previsualizar"}
          </Button>
          <Button onClick={() => void runPush(false)} disabled={running !== null || !canSend}>
            <Send size={17} aria-hidden="true" />{running === "send" ? "Enviando…" : "Enviar masivo"}
          </Button>
        </div>
      </header>

      <div className={styles.fields}>
        <label>Grupo<Select value={filter} disabled={running !== null} onChange={event => { setFilter(event.target.value as BulkPushFilter); invalidatePreview(); }}>
          {FILTER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select></label>
        <label>Mensaje<Select value={preset} disabled={running !== null} onChange={event => { setPreset(event.target.value as ManualPushPreset); invalidatePreview(); }}>
          {PRESET_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select></label>
        <label>Título<Input value={title} disabled={running !== null} onChange={event => { setTitle(event.target.value); invalidatePreview(); }} /></label>
        <label>Personalizado<Input value={body} disabled={running !== null || preset !== "custom"} placeholder="Escribe tu mensaje" onChange={event => { setBody(event.target.value); invalidatePreview(); }} /></label>
      </div>

      {preview ? <>
        <dl className={styles.summary} aria-label="Resultado de la previsualización">
          {[["Créditos", preview.targetCredits], ["Dispositivos", preview.wouldSend || preview.sent], ["Sin app", preview.noToken], ["Fallidas", preview.failed]].map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          )}
        </dl>
        {Number(preview.excludedActiveMoraProtection || 0) > 0 ? <p className={styles.protection}>
          <ShieldCheck size={18} aria-hidden="true" />{preview.excludedActiveMoraProtection} crédito(s) con prórroga o excepción vigente excluidos.
        </p> : null}
      </> : null}
      {feedback ? <p className={`${styles.feedback} ${feedback.error ? styles.error : ""}`} role={feedback.error ? "alert" : "status"} aria-live="polite">{feedback.text}</p> : null}
      {!preview ? <p className={styles.hint}>Previsualiza los destinatarios antes de enviar.</p> : null}
    </Card>
  );
}
