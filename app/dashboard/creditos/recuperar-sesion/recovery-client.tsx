"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { Button, Card, LoadingState, PageHeader } from "@/app/_components/finser-ui";
import SellerSessionRecoveryDialog, { type SellerSessionRecoveryContext } from "../seller-session-recovery-dialog";

function recoveryContext(value: unknown, draftId: number): SellerSessionRecoveryContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  for (const key of ["sellerId", "siteId", "userId", "draftId"]) {
    if (!Number.isSafeInteger(context[key]) || Number(context[key]) < 1 || Number(context[key]) > 2_147_483_647) return null;
  }
  if (context.draftId !== draftId) return null;
  for (const key of ["sellerName", "siteName"]) {
    if (typeof context[key] !== "string" || !context[key].trim() || context[key].length > 180) return null;
  }
  // Keep only the identity needed to authenticate this existing request.
  return {
    draftId, sellerId: context.sellerId as number, siteId: context.siteId as number, userId: context.userId as number,
    sellerName: (context.sellerName as string).trim(), siteName: (context.siteName as string).trim(),
  };
}

export default function SellerSessionRecoveryPage({ draftId }: { draftId: number | null }) {
  const [context, setContext] = useState<SellerSessionRecoveryContext | null>(null);
  const [loading, setLoading] = useState(draftId !== null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/vendedores/session?recoveryDraftId=${draftId}`, {
          cache: "no-store", signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as {
          ok?: boolean; error?: unknown; recoveryContext?: unknown;
        } | null;
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setNeedsLogin(response.status === 401);
          setError(response.status === 401
            ? "Ingresa con el usuario de ventas en otra pestaña y luego pulsa Reintentar aquí. Mantén abierta la pantalla de la solicitud."
            : typeof payload?.error === "string" ? payload.error : "No se pudo verificar el acceso a esta solicitud.");
          return;
        }
        const verified = payload?.ok === true ? recoveryContext(payload.recoveryContext, draftId) : null;
        if (!verified) {
          setError("No se pudo confirmar el perfil titular de esta solicitud. Reintenta la consulta.");
          return;
        }
        setContext(verified);
        setOpen(true);
      } catch {
        if (!controller.signal.aborted) setError("No fue posible comprobar la sesión. Revisa tu conexión y reintenta.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [draftId, attempt]);

  const retry = () => {
    setError("");
    setNeedsLogin(false);
    setContext(null);
    setOpen(false);
    setRecovered(false);
    setLoading(true);
    setAttempt(value => value + 1);
  };

  return <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
    <div><FinserBrand /></div>
    <PageHeader eyebrow="Fábrica de crédito" title="Recuperar sesión comercial"
      description="Mantén abierta la pestaña donde estás trabajando. Confirma tu perfil aquí y después vuelve a la solicitud para continuar." />
    <Card className="space-y-5 p-5 sm:p-6">
      {draftId === null ? <div role="alert">El enlace de recuperación no contiene una solicitud válida.</div>
        : loading ? <LoadingState label="Verificando el acceso a la solicitud..." />
          : error ? <div className="space-y-4">
            <p role="alert" className="text-[var(--fp-danger)]">{error}</p>
            <div className="flex flex-wrap items-center gap-3">
              {needsLogin ? <a href="/dashboard" target="_blank" rel="noopener noreferrer" className="fp-ui-button is-secondary">Abrir ingreso en otra pestaña</a> : null}
              <Button onClick={retry}>Reintentar</Button>
            </div>
          </div>
            : recovered && context ? <div role="status" className="space-y-3">
              <CheckCircle2 className="h-7 w-7 text-[var(--fp-graphite)]" aria-hidden="true" />
              <h2 className="text-xl font-bold">Sesión comercial recuperada</h2>
              <p>El perfil de <strong>{context.sellerName}</strong> está confirmado en <strong>{context.siteName}</strong>.</p>
              <p>Vuelve a la pestaña de la solicitud <strong>{draftId}</strong> y pulsa Continuar para guardar tus datos y seguir con el proceso.</p>
              <p className="text-sm text-[var(--fp-muted)]">Si cerraste la pantalla anterior, retoma el avance guardado desde Solicitudes.</p>
              <a href="/dashboard/solicitudes" target="_blank" rel="noopener noreferrer" className="fp-ui-button is-secondary">Abrir Solicitudes en otra pestaña</a>
            </div>
              : context ? <div className="space-y-4">
                <ShieldCheck className="h-7 w-7 text-[var(--fp-graphite)]" aria-hidden="true" />
                <h2 className="text-xl font-bold">Solicitud {context.draftId}</h2>
                <p>Confirma el perfil de <strong>{context.sellerName}</strong> en <strong>{context.siteName}</strong> con su PIN.</p>
                <Button onClick={() => setOpen(true)}>Confirmar mi perfil</Button>
              </div> : null}
    </Card>
    {context ? <SellerSessionRecoveryDialog open={open} context={context} formInAnotherTab
      onCancel={() => setOpen(false)} onRecovered={() => { setOpen(false); setRecovered(true); }} /> : null}
  </main>;
}
