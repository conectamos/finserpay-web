"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

type LinkState = {
  active: boolean;
  hasLink: boolean;
  grantId: string | null;
  accessUrl: string | null;
  createdAt: string | null;
};

function readLinkState(data: unknown): LinkState {
  if (!data || typeof data !== "object" || !("ok" in data) || data.ok !== true) {
    throw new Error("invalid_response");
  }
  const value = data as Record<string, unknown>;
  if (typeof value.active !== "boolean" || typeof value.hasLink !== "boolean"
    || (value.hasLink && typeof value.grantId !== "string")) {
    throw new Error("invalid_response");
  }
  let accessUrl: string | null = null;
  if (value.active) {
    if (typeof value.accessUrl !== "string") throw new Error("invalid_response");
    const url = new URL(value.accessUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.pathname !== "/acceso-revision"
      || !new URLSearchParams(url.hash.slice(1)).get("acceso")) {
      throw new Error("invalid_response");
    }
    accessUrl = url.href;
  }
  return {
    active: value.active,
    hasLink: value.hasLink,
    grantId: typeof value.grantId === "string" ? value.grantId : null,
    accessUrl,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

async function copyLink(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Some browser permissions deny Clipboard API; use the local copy fallback.
  }
  const previousFocus = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-label", "Enlace compartido para copiar");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  document.body.appendChild(input);
  try {
    input.select();
    input.setSelectionRange(0, input.value.length);
    if (!document.execCommand("copy")) throw new Error("copy_failed");
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}

export default function SharedAccessControl() {
  const [link, setLink] = useState<LinkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<"rotate" | "revoke" | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const endpoint = "/api/aprobaciones/enlace-comun";

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("load_failed");
        const next = readLinkState(await response.json());
        if (!controller.signal.aborted) setLink(next);
      } catch {
        if (!controller.signal.aborted) setMessage("No se pudo consultar el enlace. Vuelve a intentarlo.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      mutationController.current?.abort();
    };
  }, [endpoint, reload]);

  function refresh() {
    setPending(null);
    setLink(null);
    setMessage("");
    setLoading(true);
    setReload((current) => current + 1);
  }

  async function change(method: "POST" | "DELETE") {
    if (!link || busy) return;
    if (method === "DELETE" && !link.grantId) return;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ expectedGrantId: link.grantId }),
      });
      if (response.status === 409) {
        refresh();
        return;
      }
      if (!response.ok) throw new Error("change_failed");
      const next = readLinkState(await response.json());
      if (controller.signal.aborted) return;
      setLink(next);
      setPending(null);
      setMessage(method === "DELETE" ? "Enlace revocado." : "Enlace compartido disponible.");
    } catch {
      if (!controller.signal.aborted) {
        setMessage("No se pudo actualizar el enlace. Consulta su estado antes de intentarlo de nuevo.");
        setPending(null);
        setLink(null);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function copy() {
    if (busy || !link?.active || !link.accessUrl) return;
    setMessage("");
    try {
      await copyLink(link.accessUrl);
      setMessage("Enlace copiado. Compártelo únicamente con el equipo autorizado.");
    } catch {
      setMessage("No se pudo copiar el enlace. Permite el acceso al portapapeles y vuelve a intentarlo.");
    }
  }

  const unavailable = busy || loading;
  const canUse = link?.active && Boolean(link.accessUrl);
  return (
    <Card className="mx-4 mt-4 space-y-4 p-4 sm:mx-6 sm:p-6 lg:mx-8">
      <div><h2 className="text-lg font-bold">Enlace común de revisión</h2>
      <p className="mt-1 text-sm text-[var(--fp-muted)]">Permite revisar pendientes, registrar novedades, corregir fotos y solicitar otra firma. Las acciones se registran como acceso compartido por enlace y sesión; no identifican a una persona.</p></div>
      <p className="text-xs text-[var(--fp-muted)]">
        {loading ? "Consultando enlace..." : link?.active ? "Enlace compartido reutilizable · acceso=••••••••"
            : link?.hasLink ? "El enlace anterior ya no permite el acceso." : "Sin enlace compartido activo."}
      </p>
      <div className="flex flex-wrap gap-2">
        {link ? <>
          <Button variant="secondary" disabled={unavailable}
            onClick={() => link.hasLink ? setPending("rotate") : void change("POST")}>
            {link.hasLink ? "Regenerar enlace" : "Generar enlace"}
          </Button>
          {canUse && <>
            <Button variant="secondary" disabled={unavailable} onClick={() => void copy()}>
              Copiar enlace
            </Button>
            {!unavailable && <a className="fp-ui-button is-secondary"
              href={link.accessUrl || undefined} target="_blank" rel="noopener noreferrer"
              referrerPolicy="no-referrer" aria-label="Abrir revisión compartida">
              Abrir
            </a>}
          </>}
          {link.hasLink && link.grantId && <Button variant="danger" disabled={unavailable}
            onClick={() => setPending("revoke")}>Revocar</Button>}
        </> : !loading && <Button variant="secondary" disabled={busy} onClick={refresh}>
          Consultar enlace
        </Button>}
      </div>
      {message && <p className="text-xs text-[var(--fp-muted)]" role="status">{message}</p>}
      <ConfirmDialog open={pending !== null} busy={busy}
        title={pending === "revoke" ? "Revocar enlace compartido" : "Regenerar enlace compartido"}
        description={pending === "revoke"
          ? "El enlace dejará de funcionar y todas las sesiones iniciadas con él perderán el acceso."
          : "El enlace anterior y sus sesiones dejarán de funcionar. Comparte el nuevo con el equipo autorizado."}
        confirmLabel={pending === "revoke" ? "Revocar enlace" : "Regenerar enlace"}
        danger={pending === "revoke"}
        onCancel={() => { if (!busy) setPending(null); }}
        onConfirm={() => void change(pending === "revoke" ? "DELETE" : "POST")} />
    </Card>
  );
}
