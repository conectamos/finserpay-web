"use client";

import { useEffect, useRef, useState } from "react";
import type { AttentionWorkDetail } from "@/lib/atencion-work-types";

export type WorkActionResult = { detail: AttentionWorkDetail; result: Record<string, unknown>; alreadyApplied: boolean };
type Intent = { url: string; body: Record<string, unknown> };

export async function readWorkManagement<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || "No fue posible consultar la gestión."), { status: response.status });
  return data as T;
}

/** Retains the exact intent after an interrupted response; a retry cannot create another authorization. */
export function useWorkAction({ onUpdated, onBusyChange }: {
  onUpdated: (detail: AttentionWorkDetail) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<Intent | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const handlers = useRef({ onUpdated, onBusyChange });
  handlers.current = { onUpdated, onBusyChange };
  const alive = useRef(true), submitting = useRef(false), intent = useRef<Intent | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; handlers.current.onBusyChange(false); }; }, []);

  async function send(next: Intent): Promise<WorkActionResult | null> {
    if (submitting.current || (intent.current && intent.current !== next)) return null;
    submitting.current = true;
    intent.current = next;
    setPending(next); setSaving(true); setError(""); handlers.current.onBusyChange(true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(next.url, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body), signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(data?.error || "No se confirmó el resultado."), { status: response.status });
      if (!data?.detail?.item?.id) throw new Error("El servidor no confirmó el resultado. Consulta el mismo intento.");
      intent.current = null;
      if (alive.current) { setPending(null); handlers.current.onUpdated(data.detail); }
      return data as WorkActionResult;
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status && status >= 400 && status < 500) { intent.current = null; if (alive.current) setPending(null); }
      if (alive.current) setError(cause instanceof Error && cause.name === "AbortError"
        ? "La respuesta tardó demasiado. El cambio puede haberse guardado; consulta el mismo intento."
        : cause instanceof Error ? cause.message : "No se confirmó el resultado.");
      return null;
    } finally {
      clearTimeout(timer); submitting.current = false;
      if (alive.current) setSaving(false);
      handlers.current.onBusyChange(Boolean(intent.current));
    }
  }
  return { pending, saving, error, clearError: () => setError(""),
    run: (url: string, body: Record<string, unknown>) => send({ url, body: { ...body, requestId: crypto.randomUUID() } }),
    retry: () => intent.current ? send(intent.current) : Promise.resolve(null) };
}
