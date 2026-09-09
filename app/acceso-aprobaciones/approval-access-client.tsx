"use client";

import { useEffect, useRef, useState } from "react";
import FinserBrand from "@/app/_components/finser-brand";
import { Card, LoadingState } from "@/app/_components/finser-ui";

type AccessResult = "ready" | "missing" | "unavailable";

export default function ApprovalAccessClient() {
  const [result, setResult] = useState<AccessResult | null>(null);
  const request = useRef<Promise<AccessResult> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    let subscribed = true;
    if (!request.current) {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("acceso")?.trim();
      // The fragment is never sent to the server or kept in browser history.
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      const abortController = new AbortController();
      controller.current = abortController;
      request.current = (async (): Promise<AccessResult> => {
        if (!token) return "missing";
        try {
          const response = await fetch("/api/public/approval-access", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: abortController.signal,
            body: JSON.stringify({ token }),
          });
          if (!response.ok) return "unavailable";
          const data = await response.json();
          return data?.ok === true ? "ready" : "unavailable";
        } catch {
          return "unavailable";
        }
      })();
    }
    void request.current.then((next) => {
      if (!subscribed || controller.current?.signal.aborted) return;
      if (next === "ready") {
        window.location.replace("/dashboard/aprobaciones");
      } else {
        setResult(next);
      }
    });
    return () => {
      subscribed = false;
      active.current = false;
      // StrictMode immediately subscribes again; a real departure cancels the request.
      queueMicrotask(() => {
        if (!active.current) controller.current?.abort();
      });
    };
  }, []);

  return (
    <main className="fp-ui-shell flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg p-6 sm:p-8">
        <FinserBrand compact />
        <h1 className="mt-7 text-2xl font-bold text-[var(--fp-graphite)]">Acceso a aprobaciones</h1>
        <p className="mt-2 text-sm text-[var(--fp-muted)]">Acceso personal para analistas de FINSER PAY.</p>
        {result === null ? <div className="mt-6"><LoadingState label="Validando tu enlace personal..." /></div> : (
          <div className="mt-6 rounded-xl border border-[var(--fp-border)] p-4" role="alert">
            <p className="font-semibold">
              {result === "missing" ? "Necesitas tu enlace personal completo" : "Este enlace no permite el acceso"}
            </p>
            <p className="mt-2 text-sm text-[var(--fp-muted)]">
              {result === "missing"
                ? "Vuelve a abrir el enlace que recibiste. Si no lo tienes, solicítalo al administrador central."
                : "Solicita al administrador central que revise tu acceso y te comparta un enlace personal vigente."}
            </p>
          </div>
        )}
      </Card>
    </main>
  );
}
