"use client";

import {
  Check,
  Clipboard,
  ExternalLink,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  LoadingState,
  StatusPill,
} from "@/app/_components/finser-ui";

type ApiPayload = {
  ok?: boolean;
  error?: string;
  accessUrl?: string;
  reusable?: boolean;
};

async function readPayload(response: Response) {
  return (await response.json().catch(() => ({}))) as ApiPayload;
}

function maskedAccessUrl(value: string) {
  return value.replace(/#acceso=.*/, "#acceso=••••••••••••");
}

export default function IphoneEnrollmentAccessManager() {
  const [accessUrl, setAccessUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");

  const loadAccess = useCallback(async () => {
    setLoading(true);
    setMessage("");
    setCopied(false);
    try {
      const response = await fetch(
        "/api/creditos/iphone-enrollment/access-links",
        { credentials: "same-origin", cache: "no-store" }
      );
      const data = await readPayload(response);
      if (!response.ok || !data.accessUrl || !data.reusable) {
        throw new Error(
          data.error || "No se pudo cargar el acceso compartido."
        );
      }
      setAccessUrl(data.accessUrl);
    } catch (error) {
      setAccessUrl("");
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo cargar el acceso compartido."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  const copyAccess = async () => {
    if (!accessUrl) return;
    try {
      await navigator.clipboard.writeText(accessUrl);
      setCopied(true);
      setMessage(
        "Enlace copiado. Puede compartir este mismo acceso con todos los especialistas de enrolamiento."
      );
    } catch {
      setMessage("No se pudo copiar el enlace. Intente nuevamente.");
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr] xl:items-start">
      <Card className="p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-sm)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
              <Link2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-xl font-black">
                Acceso compartido de enrolamiento
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                Copie este enlace una sola vez y compártalo con el equipo
                especializado. Es reutilizable y no exige iniciar sesión.
              </p>
            </div>
          </div>
          <StatusPill tone={accessUrl ? "positive" : "neutral"}>
            {accessUrl ? "Activo" : "Sin configurar"}
          </StatusPill>
        </div>

        {loading ? (
          <div className="mt-8">
            <LoadingState label="Cargando acceso compartido..." />
          </div>
        ) : accessUrl ? (
          <div className="mt-6 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-lime-strong)]">
              Enlace único y reutilizable
            </p>
            <p className="mt-3 break-all font-mono text-sm leading-6 text-[var(--fp-graphite)]">
              {maskedAccessUrl(accessUrl)}
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                className="min-h-12 w-full"
                onClick={() => void copyAccess()}
              >
                {copied ? (
                  <Check className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Clipboard className="h-5 w-5" aria-hidden="true" />
                )}
                {copied ? "Enlace copiado" : "Copiar acceso"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="min-h-12 w-full"
                onClick={() =>
                  window.open(accessUrl, "_blank", "noopener,noreferrer")
                }
              >
                <ExternalLink className="h-5 w-5" aria-hidden="true" />
                Abrir portal
              </Button>
            </div>
          </div>
        ) : null}

        {message ? (
          <p
            className="mt-5 text-sm leading-6 text-[var(--fp-muted)]"
            role="status"
            aria-live="polite"
          >
            {message}
          </p>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          className="mt-5 min-h-11 border border-[var(--fp-border)]"
          onClick={() => void loadAccess()}
          disabled={loading}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Actualizar acceso
        </Button>
      </Card>

      <Card className="p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-lime-strong)]"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-xl font-black">Cómo funciona</h2>
            <ol className="mt-4 grid gap-3 text-sm leading-6 text-[var(--fp-muted)]">
              <li>
                <strong className="text-[var(--fp-graphite)]">1.</strong> El
                especialista abre el mismo enlace compartido.
              </li>
              <li>
                <strong className="text-[var(--fp-graphite)]">2.</strong> Ingresa
                la cédula y el IMEI del caso que llegó al paso 4.
              </li>
              <li>
                <strong className="text-[var(--fp-graphite)]">3.</strong> Realiza
                la prueba y pulsa ENROLADO CORRECTAMENTE.
              </li>
              <li>
                <strong className="text-[var(--fp-graphite)]">4.</strong> La
                fábrica del asesor habilita automáticamente las fotografías.
              </li>
            </ol>
          </div>
        </div>
      </Card>
    </div>
  );
}
