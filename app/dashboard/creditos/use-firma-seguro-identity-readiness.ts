"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type FirmaSeguroIdentityReadiness = {
  status: "idle" | "loading" | "ready" | "review" | "blocked" | "error";
  source: "VERIFF" | "AUTHORIZED_REVIEW" | null;
  message: string | null;
};
type Binding = { draftId: number | null; validationId: number | null; assessmentId: string | null;
  fullName: string; documentNumber: string; enabled: boolean };
type ReadinessItem = { draftId: number; validationId: number | null; assessmentId: string | null;
  canonicalFullName: string; documentNumber: string; signingReady: boolean;
  signingSource: "VERIFF" | "AUTHORIZED_REVIEW" | null; eligible: boolean; reason: string | null };
const initial: FirmaSeguroIdentityReadiness = { status: "idle", source: null, message: null };
const documentText = (value: string) => value.replace(/[.\s]/g, "");

/** Reads our persisted evidence and authorized reviews, never a provider or signing endpoint. */
export function useFirmaSeguroIdentityReadiness(binding: Binding) {
  const key = JSON.stringify([binding.draftId, binding.validationId, binding.assessmentId, binding.fullName, documentText(binding.documentNumber)]);
  const current = useRef({ key, enabled: binding.enabled });
  current.current = { key, enabled: binding.enabled };
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; value: FirmaSeguroIdentityReadiness }>({ key: "", value: initial });

  useEffect(() => {
    if (!binding.enabled || !binding.draftId || !binding.validationId || !binding.assessmentId) return;
    const controller = new AbortController();
    let expired = false;
    const timeout = window.setTimeout(() => { expired = true; controller.abort(); }, 20_000);
    const isCurrent = () => current.current.enabled && current.current.key === key;
    setResult(previous => previous.key === key && previous.value.status === "ready" ? previous :
      { key, value: { status: "loading", source: null, message: null } });
    void (async () => {
      try {
        const response = await fetch(`/api/creditos/borradores/${binding.draftId}/identidad-firma`, {
          method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        const data = await response.json() as { ok?: boolean; item?: ReadinessItem; error?: string };
        if (!isCurrent() || controller.signal.aborted) return;
        if (!response.ok || data.ok !== true || !data.item) throw new Error(data.error || "No se pudieron comprobar los datos para firma.");
        const item = data.item;
        if (item.draftId !== binding.draftId || typeof item.signingReady !== "boolean") {
          throw new Error("No se pudo confirmar el expediente vigente. Reintenta la comprobación.");
        }
        if (item.signingReady && (item.validationId !== binding.validationId || item.assessmentId !== binding.assessmentId ||
            item.canonicalFullName !== binding.fullName || documentText(item.documentNumber) !== documentText(binding.documentNumber) ||
            (item.signingSource !== "VERIFF" && item.signingSource !== "AUTHORIZED_REVIEW"))) {
          throw new Error("Los datos para firma cambiaron. Revisa la solicitud vigente.");
        }
        setResult({ key, value: { status: item.signingReady ? "ready" : item.eligible ? "review" : "blocked",
          source: item.signingReady ? item.signingSource : null,
          message: item.signingReady ? null : item.reason || "Completa la revisión autorizada de los nombres y apellidos para firma." } });
      } catch (failure) {
        if (!isCurrent() || (controller.signal.aborted && !expired)) return;
        setResult({ key, value: { status: "error", source: null,
          message: expired ? "La comprobación tardó demasiado. Reintenta sin repetir la validación de identidad." :
            failure instanceof Error ? failure.message : "No se pudieron comprobar los datos para firma." } });
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [key, binding.enabled, binding.draftId, binding.validationId, binding.assessmentId, binding.fullName, binding.documentNumber, revision]);

  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!binding.enabled) return;
    const revalidate = () => { if (document.visibilityState !== "hidden") retry(); };
    window.addEventListener("focus", revalidate);
    window.addEventListener("online", revalidate);
    return () => { window.removeEventListener("focus", revalidate); window.removeEventListener("online", revalidate); };
  }, [binding.enabled, retry]);

  const value = !binding.enabled ? initial : result.key === key ? result.value :
    { status: "loading" as const, source: null, message: null };
  return { ...value, retry };
}
