"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import AttentionWorkQueues from "@/app/dashboard/atencion/attention-work-queues";
import styles from "./approval-welcome-chat.module.css";

export default function ApprovalWelcomeChat({ workId, creditId, disabled = false, onBusyChange }: {
  workId: string; creditId: number; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [started, setStarted] = useState(false), [busy, setBusy] = useState(false);
  const busyCallback = useRef(onBusyChange), busyRef = useRef(false);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => () => { busyCallback.current?.(false); }, []);

  function updateBusy(value: boolean) {
    busyRef.current = value; setBusy(value); busyCallback.current?.(value);
  }

  return <>
    <button type="button" className={styles.bubble} disabled={disabled || busy} aria-label="Abrir chat de bienvenida"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { if (!disabled && !busyRef.current) { setStarted(true); setOpen(true); } }}>
      <MessageCircle size={25} aria-hidden="true"/><span>Chat con asesor</span>
    </button>
    {started && createPortal(<FinserSidePanel open={open} keepMounted title="Chat de bienvenida" closeLabel="Minimizar chat"
      busy={disabled || busy} onClose={() => { if (!disabled && !busyRef.current) setOpen(false); }}>
      <div className={styles.chat}><AttentionWorkQueues key={`${creditId}:${workId}`} kind="welcome" mode="attention" initialId={workId}
        singleCase expectedTarget={`C-${creditId}`} allowCreate={false} active={open} welcomeWallOpen onBusyChange={updateBusy}/></div>
    </FinserSidePanel>, document.body)}
  </>;
}
