"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, Phone, RefreshCw, Send } from "lucide-react";
import { Badge, Button, LoadingState } from "@/app/_components/finser-ui";
import type { CreditCommunicationAction, CreditCommunicationState, CreditCommunicationStatus } from "@/lib/credit-collection-communication-types";
import styles from "./credit-communications.module.css";

type Props = {
  creditId: number; phone: string | null; disabled?: boolean;
  onBusyChange: (busy: boolean) => void; onChanged: () => void | Promise<void>;
};
const statusLabels: Record<CreditCommunicationStatus, string> = {
  REQUESTED: "Sin confirmación", ACCEPTED: "Aceptado por proveedor", FAILED: "Rechazado", UNKNOWN: "Por conciliar", SKIPPED: "Sin envío",
};
function date(value: string) {
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short", timeZone: "America/Bogota" }).format(new Date(value));
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw new Error(typeof value?.error === "string" ? value.error : "No se pudo consultar la comunicación.");
  return value as T;
}
export default function CreditCommunications({ creditId, phone, disabled = false, onBusyChange, onChanged }: Props) {
  const [data, setData] = useState<CreditCommunicationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<CreditCommunicationAction | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  const flight = useRef(false);
  const selected = useRef(creditId);
  const callbacks = useRef({ onBusyChange, onChanged });
  const intent = useRef<{ action: CreditCommunicationAction; key: string } | null>(null);
  useEffect(() => { callbacks.current = { onBusyChange, onChanged }; }, [onBusyChange, onChanged]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onBusyChange(false); };
  }, []);
  useEffect(() => {
    selected.current = creditId;
    const controller = new AbortController();
    setData(null); setLoading(true); setError(""); setConfirming(null); setUncertain(false); intent.current = null;
    request<CreditCommunicationState>(`/api/aprobaciones/gestion-cartera/${creditId}/comunicaciones`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted && mounted.current && selected.current === creditId) setData(value); })
      .catch(cause => { if (!controller.signal.aborted && mounted.current && selected.current === creditId) setError(cause instanceof Error ? cause.message : "No se pudieron consultar las comunicaciones."); })
      .finally(() => { if (!controller.signal.aborted && mounted.current && selected.current === creditId) setLoading(false); });
    return () => controller.abort();
  }, [creditId, phone]);

  async function refresh() {
    if (flight.current || disabled) return;
    const id = creditId;
    setLoading(true); setError("");
    try {
      const current = await request<CreditCommunicationState>(`/api/aprobaciones/gestion-cartera/${id}/comunicaciones`);
      if (mounted.current && selected.current === id) { setData(current); setUncertain(false); }
    } catch (cause) {
      if (mounted.current && selected.current === id) setError(cause instanceof Error ? cause.message : "No se pudieron consultar las comunicaciones.");
    } finally { if (mounted.current && selected.current === id) setLoading(false); }
  }
  function confirm(action: CreditCommunicationAction) {
    if (disabled || flight.current || loading || uncertain || !data) return;
    const capability = action === "REMINDER" ? data.capabilities.reminder : data.capabilities.call;
    if (!capability.available || !data.capabilities.phone) return;
    intent.current = { action, key: crypto.randomUUID() };
    setError(""); setConfirming(action);
  }
  async function send() {
    const pending = intent.current;
    if (!pending || pending.action !== confirming || !data?.capabilities.phone || disabled || flight.current) return;
    const id = creditId;
    flight.current = true; setSaving(true); setError(""); callbacks.current.onBusyChange(true);
    try {
      const result = await request<{ state: CreditCommunicationState }>(`/api/aprobaciones/gestion-cartera/${id}/comunicaciones`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending.action, expectedPhone: data.capabilities.phone, idempotencyKey: pending.key }),
      });
      if (mounted.current && selected.current === id) { setData(result.state); setConfirming(null); intent.current = null; }
      // A refresh failure cannot turn an accepted send into permission to repeat it.
      try { await callbacks.current.onChanged(); } catch { /* The saved attempt is already visible in its own timeline. */ }
    } catch (cause) {
      if (mounted.current && selected.current === id) {
        setError(`${cause instanceof Error ? cause.message : "Operación sin confirmación."} Consulta el estado antes de realizar otro envío.`);
        setUncertain(true); setConfirming(null);
      }
    } finally {
      flight.current = false;
      if (mounted.current && selected.current === id) setSaving(false);
      callbacks.current.onBusyChange(false);
    }
  }
  const busy = disabled || saving || loading;
  const capabilities = data?.capabilities;
  return <section className={styles.section} aria-label="Comunicaciones del crédito">
    <header className={styles.header}><div><h3>Contactar al cliente</h3><p>Inicia el contacto y conserva sus intentos en este crédito.</p></div>
      <Button variant="ghost" onClick={() => void refresh()} disabled={busy} aria-label="Actualizar comunicaciones"><RefreshCw size={16} /></Button></header>
    {loading ? <LoadingState label="Consultando comunicaciones..." /> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {capabilities ? <>
      <div className={styles.manual}>
        {capabilities.phone ? <a className="fp-ui-button is-secondary" href={`tel:+${capabilities.phone}`} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}><Phone size={16} />Abrir marcador</a> : null}
        {capabilities.whatsappHref ? <a className="fp-ui-button is-secondary" href={capabilities.whatsappHref} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}><MessageCircle size={16} />Abrir WhatsApp</a> : null}
      </div>
      <p className={styles.help}>El marcador y WhatsApp se abren para que realices el contacto. Después registra el resultado en Registrar gestión realizada; abrirlos no confirma una llamada ni un mensaje enviado.</p>
      <details className={styles.automatic}><summary>Enviar desde FINSER PAY</summary>
        <div className={styles.action}><Button variant="secondary" onClick={() => confirm("REMINDER")} disabled={busy || uncertain || !capabilities.reminder.available}><Send size={16} />{capabilities.reminder.label}</Button>
          {capabilities.reminder.reason ? <p>{capabilities.reminder.reason}</p> : <p>Se envía la plantilla de pago correspondiente a la fecha de la cuota.</p>}</div>
        <div className={styles.action}><Button variant="secondary" onClick={() => confirm("CALL")} disabled={busy || uncertain || !capabilities.call.available}><Phone size={16} />Iniciar llamada automática</Button>
          {capabilities.call.reason ? <p>{capabilities.call.reason}</p> : <p>El agente de cobranza llamará al celular registrado.</p>}</div>
      </details>
      {confirming ? <section className={styles.confirmation} aria-label="Confirmar comunicación">
        <h4>{confirming === "REMINDER" ? "Confirmar recordatorio por WhatsApp" : "Confirmar llamada automática"}</h4>
        <p>Destino: <strong>+{capabilities.phone}</strong></p>
        <p>{confirming === "REMINDER" ? capabilities.reminder.label : "La llamada se iniciará con el agente de cobranza de FINSER PAY."}</p>
        <div className={styles.manual}><Button variant="ghost" disabled={saving} onClick={() => { setConfirming(null); intent.current = null; }}>Cancelar</Button><Button disabled={busy} onClick={() => void send()}>{saving ? "Procesando..." : confirming === "REMINDER" ? "Enviar recordatorio" : "Iniciar llamada"}</Button></div>
      </section> : null}
      <div className={styles.history}><h3>Historial de comunicaciones</h3><p className={styles.help}>Estos intentos se conservan aunque el crédito se ponga al día. La aceptación del proveedor no confirma entrega, lectura ni contacto.</p>
        {!data.history.length ? <p className={styles.empty}>Sin envíos automáticos registrados desde este módulo.</p> : <ol>{data.history.map(item => <li key={item.requestId}>
          <div className={styles.eventHeading}><strong>{item.action === "REMINDER" ? "Recordatorio por WhatsApp" : "Llamada automática"}</strong><Badge tone={item.status === "FAILED" ? "danger" : ["UNKNOWN", "REQUESTED"].includes(item.status) ? "warning" : "neutral"}>{statusLabels[item.status]}</Badge></div>
          <p>{item.message}</p><small>{date(item.requestedAt)} · {item.actorName} · +{item.phone}</small>
        </li>)}</ol>}
      </div>
    </> : null}
  </section>;
}
