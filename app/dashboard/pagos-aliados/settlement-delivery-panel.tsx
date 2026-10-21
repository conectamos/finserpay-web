"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, MessageCircle, RefreshCw } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Card, LoadingState, StatusPill } from "@/app/_components/finser-ui";
import styles from "./settlement-delivery-panel.module.css";

export type SettlementDelivery = {
  channel: "EMAIL" | "WHATSAPP";
  status: "PENDING" | "SENT" | "FAILED";
  recipient: string | null;
  attemptedAt: string | null;
  sentAt: string | null;
  error: string | null;
  canRetry: boolean;
  attempts: number;
  uncertain: boolean;
};

type DeliveryResponse = { ok?: boolean; deliveries?: SettlementDelivery[]; error?: string };

const channelNames = { EMAIL: "Correo electrónico", WHATSAPP: "WhatsApp" } as const;
const statusNames = { PENDING: "Pendiente", SENT: "Enviado", FAILED: "Fallido" } as const;
const timestamp = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "America/Bogota",
});

function deliveryTimestamp(value: string | null) {
  if (!value) return "Sin registro";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sin registro" : timestamp.format(date);
}

export default function SettlementDeliveryPanel({ settlementId, adminCentral }: {
  settlementId: number | string;
  adminCentral: boolean;
}) {
  const [deliveries, setDeliveries] = useState<SettlementDelivery[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<SettlementDelivery | null>(null);
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  const readSequence = useRef(0);
  const requestIds = useRef<Partial<Record<SettlementDelivery["channel"], string>>>({});
  const endpoint = `/api/pagos-aliados/${encodeURIComponent(String(settlementId))}/envios`;

  const refresh = useCallback(async () => {
    // GET only reads local delivery state. Opening this panel never starts a send.
    const sequence = ++readSequence.current;
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await response.json().catch(() => null) as DeliveryResponse | null;
      if (!response.ok || !body?.ok || !Array.isArray(body.deliveries)) {
        throw new Error(body?.error || "No fue posible consultar los envíos. Puedes actualizar su estado.");
      }
      if (sequence !== readSequence.current) return;
      setDeliveries(body.deliveries);
      setError(null);
    } catch (cause) {
      if (sequence === readSequence.current) {
        setError(cause instanceof Error ? cause.message : "No fue posible consultar los envíos.");
      }
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => { window.clearTimeout(timer); readSequence.current += 1; };
  }, [refresh]);

  const waiting = deliveries?.some((item) => item.status === "PENDING" && !item.uncertain && !item.canRetry);
  useEffect(() => {
    if (!waiting || busy) return;
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [waiting, busy, refresh]);

  const resend = async () => {
    if (!confirmation || sendingRef.current || !adminCentral || !confirmation.canRetry) return;
    const channel = confirmation.channel;
    const key = `finserpay:settlement-delivery:${settlementId}:${channel}`;
    let requestId = requestIds.current[channel];
    if (!requestId) {
      try { requestId = sessionStorage.getItem(key) || undefined; } catch { /* Storage may be disabled. */ }
      requestId ||= crypto.randomUUID();
      requestIds.current[channel] = requestId;
      try { sessionStorage.setItem(key, requestId); } catch { /* The in-memory key still protects retries. */ }
    }
    sendingRef.current = true;
    readSequence.current += 1;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, requestId }),
      });
      const body = await response.json().catch(() => null) as DeliveryResponse | null;
      if (!response.ok || !body?.ok || !Array.isArray(body.deliveries)) {
        throw new Error(body?.error || "No se pudo confirmar la solicitud de envío. Actualiza el estado antes de reintentar.");
      }
      setDeliveries(body.deliveries);
      delete requestIds.current[channel];
      try { sessionStorage.removeItem(key); } catch { /* No persistence available. */ }
      setConfirmation(null);
    } catch (cause) {
      // Preserve the same operation key if the response was lost after acceptance.
      setConfirmation(null);
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar la solicitud de envío.");
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Card className={styles.panel} aria-label="Envíos de la liquidación">
      <div className={styles.header}>
        <div><h2>Envíos de la liquidación</h2><p className={styles.description}>El envío del documento no confirma un desembolso. Horarios de Colombia.</p></div>
        <Button variant="ghost" disabled={loading || busy} onClick={() => { setLoading(true); void refresh(); }}>
          <RefreshCw size={16} aria-hidden="true" /> Actualizar estados
        </Button>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {loading && !deliveries ? <LoadingState label="Consultando envíos…" /> : null}
      {deliveries && !deliveries.length ? <p className={styles.help}>Esta liquidación no tiene envíos registrados.</p> : null}
      <div className={styles.channels} aria-live="polite">
        {deliveries?.map((delivery) => {
          const sent = delivery.status === "SENT";
          const failed = delivery.status === "FAILED";
          return (
            <section key={delivery.channel} className={styles.channel} aria-label={channelNames[delivery.channel]}>
              <div className={styles.channelHeading}>
                {delivery.channel === "EMAIL" ? <Mail size={20} aria-hidden="true" /> : <MessageCircle size={20} aria-hidden="true" />}
                <h3>{channelNames[delivery.channel]}</h3>
                <StatusPill tone={sent ? "positive" : failed ? "danger" : "warning"}>{statusNames[delivery.status]}</StatusPill>
              </div>
              <dl className={styles.details}>
                <div><dt>Destinatario</dt><dd>{delivery.recipient || "Sin destinatario registrado"}</dd></div>
                <div><dt>Último intento</dt><dd>{deliveryTimestamp(delivery.attemptedAt)}</dd></div>
                <div><dt>Fecha de envío</dt><dd>{deliveryTimestamp(delivery.sentAt)}</dd></div>
                <div><dt>Intentos</dt><dd>{delivery.attempts}</dd></div>
              </dl>
              {delivery.error ? <p className={styles.error}>{delivery.error}</p> : null}
              {!delivery.recipient ? <p className={styles.help}>Falta {delivery.channel === "EMAIL" ? "el correo electrónico" : "el teléfono de WhatsApp"} del aliado. {adminCentral ? <a href="/dashboard/aliados">Actualizar datos del aliado</a> : "Solicita su actualización al administrador."}</p> : null}
              {delivery.uncertain ? <p className={styles.help}>El proveedor no confirmó el resultado. Revisa el envío antes de repetirlo para evitar duplicados.</p> : null}
              {adminCentral ? <Button variant="secondary" className={styles.action} disabled={busy || !delivery.canRetry} onClick={() => setConfirmation(delivery)}>
                {busy && confirmation?.channel === delivery.channel ? "Procesando…" : sent ? `Reenviar por ${delivery.channel === "EMAIL" ? "correo" : "WhatsApp"}` : `Reintentar ${delivery.channel === "EMAIL" ? "correo" : "WhatsApp"}`}
              </Button> : null}
              {adminCentral && !delivery.canRetry && !delivery.error && !delivery.uncertain ? <p className={styles.help}>El envío está en proceso. Espera a que se actualice su estado.</p> : null}
            </section>
          );
        })}
      </div>
      <ConfirmDialog open={Boolean(confirmation)} busy={busy} title={confirmation?.status === "SENT" ? "Reenviar liquidación" : "Reintentar envío de liquidación"}
        description={confirmation ? `Se enviará el PDF de esta liquidación por ${channelNames[confirmation.channel].toLowerCase()} al destinatario registrado del aliado. ${confirmation.status === "SENT" ? "Este canal ya registra un envío; confirmar solicitará una nueva copia." : "El otro canal conservará su estado."}` : ""}
        confirmLabel={confirmation?.status === "SENT" ? "Confirmar reenvío" : "Reintentar envío"}
        onCancel={() => { if (!sendingRef.current) setConfirmation(null); }} onConfirm={() => { void resend(); }} />
    </Card>
  );
}
