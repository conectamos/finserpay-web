"use client";

import { Download, FileText, UserRound } from "lucide-react";
import { Button, Badge } from "@/app/_components/finser-ui";
import {attentionWorkKinds,attentionWorkStates} from "@/lib/atencion-work-types";
import type { AttentionDetail } from "@/lib/atencion-types";
import styles from "./attention-contact-summary.module.css";

export default function AttentionContactSummary({ detail, openManagement }: { detail: AttentionDetail | null; openManagement: () => void }) {
  const files = detail?.messages.filter(message => message.direction === "inbound" && message.attachment) || [];
  const name = detail?.conversation.name || "Contacto";
  return <aside className={styles.panel} aria-label="Ficha del contacto">
    <header><h2>Ficha del contacto</h2></header>
    {!detail ? <p className={styles.empty}>Selecciona una conversación para consultar su información y archivos recibidos.</p> : <div className={styles.body}>
      <section className={styles.identity}><span className={styles.avatar}>{name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("")}</span><h3>{name}</h3><p>{detail.conversation.phone || "Teléfono no disponible"}</p>{detail.conversation.autoTags.includes("FINSERPAY") && <Badge tone="positive">Cliente FINSERPAY</Badge>}</section>
      {detail.workRequest && <section><h3>{attentionWorkKinds[detail.workRequest.kind]}</h3><p>{detail.workRequest.ally} · {detail.workRequest.advisor}</p><p>{attentionWorkStates[detail.workRequest.state as keyof typeof attentionWorkStates]}</p></section>}<section><h3>Estado de la conversación</h3><Badge tone={detail.conversation.status === "closed" ? "neutral" : "positive"}>{({pending:"Pendiente",open:"En atención",closed:"Finalizada"} as const)[detail.conversation.status]}</Badge></section>
      <section><h3><UserRound size={18} aria-hidden="true" /> Analista asignado</h3><p>{detail.conversation.assigneeName || "Sin asignar"}</p><Button variant="secondary" onClick={openManagement}>Ver gestión y seguimiento</Button></section>
      <section><h3><FileText size={18} aria-hidden="true" /> Archivos recibidos ({files.length})</h3>{detail.historyTruncated && <p className={styles.help}>Archivos del historial disponible.</p>}{files.length ? <ul className={styles.files}>{files.map(message => {
        const file = message.attachment!, url = file.url && (/^\/api\/atencion\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/media$/i.test(file.url) || /^\/api\/atencion\/solicitudes\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/i.test(file.url)) ? file.url : null;
        const label = file.fileName || ({image:"Imagen",video:"Video",audio:"Audio",document:"Documento",sticker:"Sticker"} as const)[file.kind];
        return <li key={message.id}><FileText size={22} aria-hidden="true" /><div><strong>{label}</strong><small>{new Intl.DateTimeFormat("es-CO",{timeZone:"America/Bogota",day:"2-digit",month:"short"}).format(new Date(message.sentAt))}</small></div>{url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir archivo recibido: ${label}`}><Download size={18} aria-hidden="true" /></a> : <small>No disponible</small>}</li>;
      })}</ul> : <p className={styles.help}>No hay archivos recibidos en el historial disponible.</p>}</section>
    </div>}
  </aside>;
}
