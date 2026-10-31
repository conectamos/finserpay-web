"use client";

import { createPortal } from "react-dom";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";
import AttentionEnrollmentManagement from "./attention-enrollment-management";
import AttentionWelcomeManagement from "./attention-welcome-management";
import styles from "./attention-work-management.module.css";

export default function AttentionWorkManagement({ open, detail, disabled, busy, onClose, onUpdated, onBusyChange, onCallModeChange }: {
  open: boolean; detail: AttentionWorkDetail; disabled: boolean; busy: boolean; onClose: () => void;
  onUpdated: (detail: AttentionWorkDetail) => void; onBusyChange: (busy: boolean) => void; onCallModeChange: (mode: string) => void;
}) {
  if (!open || !detail.canManage) return null;
  const enrollment = detail.item.kind === "enrollment";
  return createPortal(<FinserSidePanel open={open} title={enrollment ? "Gestionar enrolamiento" : "Gestionar bienvenida"} busy={busy || disabled} onClose={onClose}>
    <div className={styles.body}>
      <header className={styles.identity}><h3>{detail.item.name}</h3><p>{detail.item.ally} · {detail.item.branch}</p><dl><dt>Cédula</dt><dd>{detail.document || "No registrada"}</dd>{enrollment && <><dt>IMEI del iPhone</dt><dd>{detail.imei || "No registrado"}</dd></>}<dt>Asesor</dt><dd>{detail.item.advisor}</dd><dt>Analista</dt><dd>{detail.item.assignee || "Sin asignar"}</dd></dl></header>
      {enrollment ? <AttentionEnrollmentManagement detail={detail} disabled={disabled} onUpdated={onUpdated} onBusyChange={onBusyChange}/> : <AttentionWelcomeManagement detail={detail} disabled={disabled} onUpdated={onUpdated} onBusyChange={onBusyChange} onCallModeChange={onCallModeChange}/>}
    </div>
  </FinserSidePanel>, document.body);
}
