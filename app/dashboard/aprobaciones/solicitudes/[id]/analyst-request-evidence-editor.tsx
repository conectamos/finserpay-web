"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, RefreshCw, Upload } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { Button, LoadingState } from "@/app/_components/finser-ui";
import styles from "./analyst-request-editor.module.css";

type Document = { key: string; label: string; available: boolean; sha256: string | null; editable: boolean; reason: string | null };
type EvidenceState = { revision: number; documents: Document[]; canManageContract: boolean };
type Result = { ok?: boolean; item?: EvidenceState; error?: string };

async function preparePhoto(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Selecciona una fotografía JPG o PNG.");
  if (file.size > 15 * 1024 * 1024) throw new Error("La fotografía debe pesar menos de 15 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No se pudo preparar la fotografía. Intenta con otra imagen.");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.92, 0.84, 0.74]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= 2_500_000) return dataUrl;
    }
    throw new Error("La fotografía es demasiado grande. Usa una imagen con menor resolución.");
  } finally { bitmap.close(); }
}

export default function AnalystRequestEvidenceEditor({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EvidenceState | null>(null);
  const [selected, setSelected] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const api = `/api/aprobaciones/solicitudes/${encodeURIComponent(requestId)}/evidencias`;
  useEffect(() => () => { controller.current?.abort(); generation.current += 1; }, [requestId]);
  const resetFile = () => { generation.current += 1; setPreparing(false); setDataUrl(""); setFileName(""); };
  const load = async () => {
    controller.current?.abort(); const flight = new AbortController(); controller.current = flight;
    resetFile(); setLoading(true); setError(""); setReason("");
    try {
      const response = await fetch(api, { cache: "no-store", signal: flight.signal });
      const result = await response.json() as Result;
      if (flight.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudieron consultar los documentos.");
      setState(result.item); setSelected(result.item.documents.find(item => item.editable)?.key || "");
    } catch (failure) { if (!flight.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudieron consultar los documentos."); }
    finally { if (!flight.signal.aborted) setLoading(false); }
  };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; const attempt = ++generation.current;
    setDataUrl(""); setFileName(""); setError("");
    if (!file) return;
    setPreparing(true);
    try {
      const photo = await preparePhoto(file);
      if (attempt === generation.current) { setDataUrl(photo); setFileName(file.name); }
    } catch (failure) {
      if (attempt === generation.current) setError(failure instanceof Error ? failure.message : "No se pudo preparar la fotografía.");
    } finally { if (attempt === generation.current) setPreparing(false); }
  };
  const document = state?.documents.find(item => item.key === selected);
  const canSave = !!document?.editable && !!dataUrl && reason.trim().length >= 5 && !preparing;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!state || !document || !canSave || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    const flight = new AbortController(); controller.current = flight;
    try {
      const response = await fetch(api, { method: "PATCH", signal: flight.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        key: selected, dataUrl, expectedSha256: document.sha256, expectedRevision: state.revision, reason: reason.trim(),
      }) });
      const result = await response.json() as Result;
      if (flight.signal.aborted) return;
      if (!response.ok || !result.item) throw new Error(result.error || "No se pudo guardar la fotografía.");
      setState(result.item); setOpen(false); resetFile();
      setNotice(`${document.label} actualizada. El asesor recibirá la evidencia automáticamente.`); router.refresh();
    } catch (failure) { if (!flight.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudo guardar la fotografía."); }
    finally { savingRef.current = false; if (!flight.signal.aborted) setSaving(false); }
  };
  const close = () => { controller.current?.abort(); resetFile(); setOpen(false); };
  return <div>
    <Button variant="secondary" aria-haspopup="dialog" onClick={() => { setOpen(true); setNotice(""); void load(); }}><Paperclip size={17} aria-hidden="true" />Gestionar documentos</Button>
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    <FinserSidePanel open={open} title="Documentos y evidencias" busy={saving} onClose={close}>
      <p className={styles.intro}>Adjunta o reemplaza una fotografía. Los cambios quedan en el historial y se reflejan en la solicitud del asesor.</p>
      {loading ? <LoadingState label="Consultando documentos…" /> : <>
        {error && <div role="alert" className={`${styles.feedback} ${styles.error}`}><p>{error}</p><Button variant="secondary" disabled={saving || preparing} onClick={() => void load()}><RefreshCw size={16} />Actualizar documentos</Button></div>}
        {state && <form onSubmit={submit} className={styles.form}>
          <fieldset disabled={saving}>
            <legend className={styles.intro}>Selecciona el documento</legend>
            <div className={styles.documentList}>{state.documents.map(item => <label className={styles.documentOption} key={item.key}>
              <input type="radio" name="evidence" value={item.key} checked={selected === item.key} disabled={!item.editable} onChange={() => { setSelected(item.key); resetFile(); setError(""); }} />
              <span><strong>{item.label}</strong><small>{item.reason || (item.available ? "Disponible · Puedes reemplazar la fotografía" : "Pendiente de adjuntar")}</small></span>
            </label>)}</div>
          </fieldset>
          {document?.editable && <>
            <label className={styles.upload}><strong>{document.available ? "Nueva fotografía" : "Adjuntar fotografía"}</strong><input key={selected} type="file" accept="image/jpeg,image/png" disabled={saving || preparing} onChange={event => void readFile(event)} /><small>JPG o PNG. La imagen se ajusta para su carga.</small></label>
            {preparing && <LoadingState label="Preparando fotografía…" />}
            {dataUrl && <><Image src={dataUrl} alt={`Vista previa: ${document.label}`} width={600} height={360} unoptimized className={styles.image} /><p className={styles.intro}>{fileName}</p></>}
            <label className={styles.field}>Motivo de la corrección<textarea className={`fp-ui-input ${styles.reason}`} required minLength={5} maxLength={500} disabled={saving} value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe por qué adjuntas o reemplazas esta evidencia" /></label>
            <div className={styles.actions}><Button variant="secondary" disabled={saving} onClick={close}>Cancelar</Button><Button type="submit" disabled={saving || !canSave}><Upload size={17} aria-hidden="true" />{saving ? "Guardando…" : "Guardar evidencia"}</Button></div>
          </>}
          <p className={styles.intro}>El documento firmado proviene de FirmaSeguro y se conserva como parte del contrato.</p>
        </form>}
      </>}
    </FinserSidePanel>
  </div>;
}
