"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Send } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import AttentionWorkQueues from "@/app/dashboard/atencion/attention-work-queues";
import { isAttentionNotificationWorkId } from "@/lib/atencion-notification-links";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";
import styles from "./credit-enrollment-request.module.css";

type Attempt = { requestId: string; kind: "enrollment"; target: string; text: string };

export default function CreditEnrollmentRequest({ draftId, contextKey, ready, disabled = false, approved, beforeCreate, onBusyChange, mode = "seller" }: {
  draftId: number | null;
  contextKey: string;
  ready: boolean;
  disabled?: boolean;
  approved: boolean;
  beforeCreate: () => Promise<number>;
  onBusyChange?: (busy: boolean) => void;
  mode?: "seller" | "attention";
}) {
  const bindingKey = `${mode}:${contextKey}`;
  const [workId, setWorkId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true), lock = useRef(false), controller = useRef<AbortController | null>(null);
  const currentContext = useRef(bindingKey), context = useRef(bindingKey), busyCallback = useRef(onBusyChange);
  currentContext.current = bindingKey;
  busyCallback.current = onBusyChange;
  const pending = busy || Boolean(attempt) || chatBusy;

  useEffect(() => { busyCallback.current?.(pending); }, [pending]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); busyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    if (context.current === bindingKey) return;
    context.current = bindingKey;
    controller.current?.abort();
    setWorkId(null); setAttempt(null); setOpen(false); setError(""); setChatBusy(false); setBusy(false);
  }, [bindingKey]);

  async function requestEnrollment() {
    if (lock.current || chatBusy || disabled || (!attempt && (!ready || approved || !draftId))) return;
    lock.current = true;
    busyCallback.current?.(true);
    setBusy(true); setError("");
    const binding = bindingKey, expectedDraftId = draftId;
    const active = () => alive.current && currentContext.current === binding;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      let next = attempt;
      if (!next) {
        const savedId = await beforeCreate();
        if (!active()) return;
        if (!expectedDraftId || savedId !== expectedDraftId) throw new Error("La solicitud cambió durante el guardado. Vuelve al crédito actual.");
        next = { requestId: crypto.randomUUID(), kind: "enrollment", target: `D-${savedId}`, text: "Solicito el enrolamiento del iPhone de esta solicitud." };
        setAttempt(next);
      }
      if (!active()) return;
      const request = new AbortController(); controller.current = request;
      timeout = setTimeout(() => request.abort(), 20_000);
      const response = await fetch(mode === "attention" ? "/api/atencion/solicitudes" : "/api/ventas/atencion", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: request.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
      });
      const body = await response.json().catch(() => null);
      if (!active()) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) setAttempt(null);
        throw new Error(`${body?.error || "No se pudo confirmar la solicitud."}${response.status >= 500 ? " Reintenta el mismo envío para comprobar el resultado." : ""}`);
      }
      const detail = body as AttentionWorkDetail | null;
      if (!detail?.item || !isAttentionNotificationWorkId(detail.item.id) || detail.item.kind !== "enrollment" || detail.item.target !== next.target) {
        throw new Error("No se confirmó el vínculo con este crédito. Reintenta el mismo envío para comprobar el resultado.");
      }
      setWorkId(detail.item.id); setAttempt(null); setOpen(true);
    } catch (failure) {
      if (active()) setError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "No se confirmó el envío. Reintenta para comprobar el mismo intento.");
    } finally {
      if (timeout) clearTimeout(timeout);
      lock.current = false;
      if (active()) setBusy(false);
    }
  }

  if (approved && !workId && !attempt) return null;
  return <div className={styles.request}>
    {workId ? <Button type="button" variant="secondary" disabled={busy || chatBusy} onClick={() => setOpen(true)}><MessageCircle size={18} aria-hidden="true" />Abrir chat de enrolamiento</Button>
      : <Button type="button" disabled={busy || disabled || (!attempt && (!ready || approved || !draftId))} aria-busy={busy} onClick={() => void requestEnrollment()}><Send size={17} aria-hidden="true" />{busy ? "Solicitando…" : attempt ? "Consultar / reintentar solicitud" : "Solicitar enrolamiento"}</Button>}
    {!workId && !attempt && !ready && <p>Completa la identidad, la firma y la confirmación del IMEI antes de solicitar el enrolamiento.</p>}
    {workId && <p>Solicitud vinculada a este crédito. Continúa con el analista desde el chat.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {workId && typeof document !== "undefined" && createPortal(<FinserSidePanel open={open} keepMounted title="Chat de enrolamiento" closeLabel="Volver al crédito" busy={pending} onClose={() => setOpen(false)}>
      <div className={styles.chat}><AttentionWorkQueues key={`${bindingKey}:${workId}`} kind="enrollment" mode={mode} initialId={workId} singleCase expectedTarget={`D-${draftId}`} allowCreate={false} active={open} onBusyChange={setChatBusy} /></div>
    </FinserSidePanel>, document.body)}
  </div>;
}
