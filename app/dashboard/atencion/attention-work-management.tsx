"use client";

import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { Button } from "@/app/_components/finser-ui";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";
import { attentionWelcomeCreditWallHref } from "@/lib/atencion-work-links";
import AttentionEnrollmentManagement from "./attention-enrollment-management";
import AttentionWelcomeManagement from "./attention-welcome-management";
import styles from "./attention-work-management.module.css";

export default function AttentionWorkManagement({ open, detail, disabled, busy, onClose, onUpdated, onBusyChange, onCallModeChange, chatTheme }: {
  open: boolean; detail: AttentionWorkDetail; disabled: boolean; busy: boolean; onClose: () => void;
  onUpdated: (detail: AttentionWorkDetail) => void; onBusyChange: (busy: boolean) => void; onCallModeChange: (mode: string) => void;
  chatTheme?: "dark";
}) {
  if (!open || !detail.canManage) return null;
  const enrollment = detail.item.kind === "enrollment";
  const creditWallHref = attentionWelcomeCreditWallHref(detail);
  const panel = <FinserSidePanel open={open} title={enrollment ? "Gestionar enrolamiento" : "Gestionar bienvenida"} busy={busy || disabled} onClose={onClose}>
    <div className={styles.body}>
      <header className={styles.identity}><h3>{detail.item.name}</h3><p>{detail.item.ally} · {detail.item.branch}</p><dl><dt>Cédula</dt><dd>{detail.document || "No registrada"}</dd>{enrollment && <><dt>IMEI del iPhone</dt><dd>{detail.imei || "No registrado"}</dd></>}<dt>Asesor</dt><dd>{detail.item.advisor}</dd><dt>Analista</dt><dd>{detail.item.assignee || "Sin asignar"}</dd></dl></header>
      {!enrollment && <section className={styles.section}>
        <h3>Expediente del crédito</h3>
        <p>Consulta los datos del cliente, equipo, montos, evidencias, contrato e historial en el muro del crédito vinculado.</p>
        {creditWallHref ? <>
          <div className={styles.actions}>{busy || disabled
            ? <Button variant="secondary" disabled><ExternalLink size={17} aria-hidden="true"/>Abrir muro del crédito</Button>
            : <a className="fp-ui-button is-secondary" href={creditWallHref} target="_blank" rel="noopener noreferrer"><ExternalLink size={17} aria-hidden="true"/>Abrir muro del crédito</a>}</div>
          <small>Se abre en otra pestaña. Vuelve a este chat para registrar el resultado de la bienvenida y avisar al asesor.</small>
        </> : <p className={styles.muted}>El muro no está disponible: actualiza la solicitud para comprobar el crédito vinculado.</p>}
      </section>}
      {enrollment ? <AttentionEnrollmentManagement detail={detail} disabled={disabled} onUpdated={onUpdated} onBusyChange={onBusyChange}/> : <AttentionWelcomeManagement detail={detail} disabled={disabled} onUpdated={onUpdated} onBusyChange={onBusyChange} onCallModeChange={onCallModeChange}/>}
    </div>
  </FinserSidePanel>;
  return createPortal(chatTheme === "dark" ? <div data-chat-theme="dark" className={styles.portalTheme}>{panel}</div> : panel, document.body);
}
