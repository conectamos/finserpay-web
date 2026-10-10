"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCreditProcessStatusPoller,
  type CreditProcessConnection,
  type CreditProcessStatusSnapshot,
} from "@/lib/credit-process-status-polling";

export function useCreditProcessLiveStatus<Validation, Process>(options: {
  draftId: number | null;
  validationId?: number | null;
  processUuid?: string | null;
  enabled: boolean;
  pending: boolean;
  onSnapshot: (snapshot: CreditProcessStatusSnapshot<Validation, Process>) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const poller = useRef<ReturnType<typeof createCreditProcessStatusPoller> | null>(null);
  const [connection, setConnection] = useState<CreditProcessConnection>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!options.enabled || !options.draftId) return;
    const canRead = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
    const isCurrentBinding = () => latest.current.enabled &&
      latest.current.draftId === options.draftId &&
      latest.current.validationId === options.validationId &&
      latest.current.processUuid === options.processUuid;
    const current = createCreditProcessStatusPoller<CreditProcessStatusSnapshot<Validation, Process>>({
      binding: { draftId: options.draftId, validationId: options.validationId, processUuid: options.processUuid },
      canRead,
      isPending: () => latest.current.pending,
      onConnection: (state, message) => { if (isCurrentBinding()) { setConnection(state); setError(message); } },
      onSnapshot: (snapshot) => { if (isCurrentBinding()) latest.current.onSnapshot(snapshot); },
      read: async (binding, signal) => {
        // This endpoint only reads persisted webhook results. It never calls a provider.
        const timeoutController = new AbortController();
        const timeout = window.setTimeout(() => timeoutController.abort(), 12_000);
        const relayAbort = () => timeoutController.abort();
        signal.addEventListener("abort", relayAbort, { once: true });
        try {
          const response = await fetch(`/api/creditos/borradores/${binding.draftId}/estado-proceso`, {
            method: "GET", credentials: "same-origin", cache: "no-store", signal: timeoutController.signal,
          });
          const result = await response.json();
          if (!response.ok || result?.ok !== true) {
            throw new Error(typeof result?.error === "string" ? result.error : "No se pudo consultar el estado de la solicitud.");
          }
          return result as CreditProcessStatusSnapshot<Validation, Process>;
        } catch (failure) {
          if (!signal.aborted && timeoutController.signal.aborted) {
            throw new Error("La conexión tardó demasiado. Puedes reintentar sin repetir el envío.");
          }
          throw failure;
        } finally {
          window.clearTimeout(timeout);
          signal.removeEventListener("abort", relayAbort);
        }
      },
    });
    poller.current = current;
    const revalidate = () => {
      if (document.visibilityState === "hidden") current.pause();
      else void current.retry();
    };
    const offline = () => { current.pause(); setConnection("reconnecting"); setError("Sin conexión. Reintentaremos al recuperar internet."); };
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("focus", revalidate);
    window.addEventListener("online", revalidate);
    window.addEventListener("offline", offline);
    if (document.visibilityState !== "hidden") void current.start();
    return () => {
      current.dispose();
      if (poller.current === current) poller.current = null;
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("online", revalidate);
      window.removeEventListener("offline", offline);
    };
  }, [options.enabled, options.draftId, options.validationId, options.processUuid]);

  const retry = useCallback(() => { void poller.current?.retry(); }, []);
  return { connection: options.enabled ? connection : "idle" as CreditProcessConnection, error: options.enabled ? error : null, retry };
}
