"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import AttentionWorkQueues from "@/app/dashboard/atencion/attention-work-queues";
import { useApprovalChatUnread } from "./use-approval-chat-unread";
import styles from "./approval-welcome-chat.module.css";

export default function ApprovalWelcomeChat({ workId, creditId, disabled = false, onBusyChange }: {
  workId: string; creditId: number; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [started, setStarted] = useState(false), [busy, setBusy] = useState(false);
  const unread = useApprovalChatUnread(workId, creditId);
  const busyCallback = useRef(onBusyChange), busyRef = useRef(false);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => () => { busyCallback.current?.(false); }, []);

  function updateBusy(value: boolean) {
    busyRef.current = value; setBusy(value); busyCallback.current?.(value);
  }

  return <>
    <button type="button" className={styles.bubble} data-unread={Boolean(unread.count) || undefined} disabled={disabled || busy || unread.denied}
      aria-label={unread.denied ? "Chat de bienvenida no disponible" : `Abrir chat de bienvenida${unread.count !== null ? `, ${unread.count} ${unread.count === 1 ? "mensaje sin leer" : "mensajes sin leer"}` : ""}`}
      aria-haspopup="dialog" aria-expanded={open && !unread.denied} onClick={() => { if (!disabled && !busyRef.current && !unread.denied) { setStarted(true); setOpen(true); unread.refresh(); } }}>
      <MessageCircle size={25} aria-hidden="true"/><span className={styles.label}><span>Chat con asesor</span>
        {unread.denied ? <small>Acceso no disponible</small> : unread.unavailable ? <small>Contador no disponible</small> : unread.hasNew ? <small>Nuevo mensaje del asesor</small> : Boolean(unread.count) && <small>{unread.count} sin leer</small>}</span>
      {Boolean(unread.count) && <span className={styles.count} aria-hidden="true">{unread.count! > 99 ? "99+" : unread.count}</span>}
    </button>
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true"><span key={unread.arrival}>{unread.hasNew && unread.count ? "Nuevo mensaje del asesor." : ""}</span></span>
    {started && !unread.denied && createPortal(<FinserSidePanel open={open} keepMounted title="Chat de bienvenida" closeLabel="Minimizar chat"
      busy={disabled || busy} onClose={() => { if (!disabled && !busyRef.current) { setOpen(false); unread.refresh(); } }}>
      <div className={styles.chat}><AttentionWorkQueues key={`${creditId}:${workId}`} kind="welcome" mode="attention" initialId={workId}
        singleCase expectedTarget={`C-${creditId}`} allowCreate={false} active={open} welcomeWallOpen onBusyChange={updateBusy}/></div>
    </FinserSidePanel>, document.body)}
  </>;
}
