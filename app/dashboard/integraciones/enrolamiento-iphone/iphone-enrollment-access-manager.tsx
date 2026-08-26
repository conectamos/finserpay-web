"use client";

import {
  Check,
  Clipboard,
  Clock3,
  Link2,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";

type EnrollmentAccessGrant = {
  id: string;
  analyst: {
    name: string;
    externalId: string;
  };
  issuedBy: {
    userId: number;
    name: string;
  };
  status: "PENDING" | "ACTIVE" | "EXPIRED" | "REVOKED";
  expiresAt: string;
  consumedAt: string | null;
  sessionExpiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type ApiPayload = {
  ok?: boolean;
  error?: string;
  items?: EnrollmentAccessGrant[];
  item?: EnrollmentAccessGrant;
  accessUrl?: string;
};

const durationOptions = [
  { value: "60", label: "1 hora" },
  { value: "240", label: "4 horas" },
  { value: "480", label: "8 horas" },
];

async function readPayload(response: Response) {
  return (await response.json().catch(() => ({}))) as ApiPayload;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function grantStatus(item: EnrollmentAccessGrant) {
  if (item.status === "REVOKED") {
    return { label: "Revocado", tone: "danger" as const };
  }
  if (item.status === "EXPIRED") {
    return { label: "Vencido", tone: "neutral" as const };
  }
  if (item.status === "ACTIVE") {
    return { label: "Sesión activa", tone: "positive" as const };
  }
  return { label: "Sin utilizar", tone: "warning" as const };
}

export default function IphoneEnrollmentAccessManager() {
  const [items, setItems] = useState<EnrollmentAccessGrant[]>([]);
  const [analystName, setAnalystName] = useState("");
  const [analystExternalId, setAnalystExternalId] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState("480");
  const [accessUrl, setAccessUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(
        "/api/creditos/iphone-enrollment/access-links",
        { credentials: "same-origin", cache: "no-store" }
      );
      const data = await readPayload(response);
      if (!response.ok) throw new Error(data.error || "No se pudieron cargar los accesos.");
      setItems(data.items || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron cargar los accesos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const createAccess = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setAccessUrl("");
    setCopied(false);
    setMessage("");
    try {
      const response = await fetch(
        "/api/creditos/iphone-enrollment/access-links",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            analystName,
            analystExternalId,
            expiresInMinutes: Number(expiresInMinutes),
          }),
        }
      );
      const data = await readPayload(response);
      if (!response.ok || !data.item || !data.accessUrl) {
        throw new Error(data.error || "No se pudo generar el acceso.");
      }
      setItems((current) => [data.item as EnrollmentAccessGrant, ...current]);
      setAccessUrl(data.accessUrl);
      setAnalystName("");
      setAnalystExternalId("");
      setMessage("Acceso temporal generado. Cópialo ahora: el token no volverá a mostrarse.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo generar el acceso.");
    } finally {
      setSubmitting(false);
    }
  };

  const copyAccess = async () => {
    if (!accessUrl) return;
    await navigator.clipboard.writeText(accessUrl);
    setCopied(true);
    setMessage("Enlace copiado.");
  };

  const revokeAccess = async (id: string) => {
    setRevokingId(id);
    setMessage("");
    try {
      const response = await fetch(
        "/api/creditos/iphone-enrollment/access-links",
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      const data = await readPayload(response);
      if (!response.ok || !data.item) {
        throw new Error(data.error || "No se pudo revocar el acceso.");
      }
      setItems((current) =>
        current.map((item) => (item.id === data.item?.id ? data.item : item))
      );
      setMessage("Acceso revocado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo revocar el acceso.");
    } finally {
      setRevokingId("");
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[0.82fr_1.18fr] xl:items-start">
      <Card className="p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-sm)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
            <Link2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-black">Generar acceso temporal</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
              El enlace funciona una sola vez y no requiere la sesión general de FINSER PAY.
            </p>
          </div>
        </div>

        <form className="mt-6 grid gap-5" onSubmit={createAccess}>
          <label className="grid gap-2 text-sm font-bold">
            Nombre completo del analista
            <Input
              value={analystName}
              onChange={(event) => setAnalystName(event.target.value.slice(0, 100))}
              minLength={3}
              maxLength={100}
              autoComplete="off"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-bold">
            Identificador del analista
            <Input
              value={analystExternalId}
              onChange={(event) =>
                setAnalystExternalId(event.target.value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60))
              }
              placeholder="Ej. ENR-024"
              minLength={3}
              maxLength={60}
              autoComplete="off"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-bold">
            Vigencia máxima
            <Select
              value={expiresInMinutes}
              onChange={(event) => setExpiresInMinutes(event.target.value)}
            >
              {durationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <Button
            type="submit"
            className="min-h-12 w-full"
            disabled={
              submitting ||
              analystName.trim().length < 3 ||
              analystExternalId.trim().length < 3
            }
          >
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            {submitting ? "Generando..." : "Generar enlace"}
          </Button>
        </form>

        {accessUrl ? (
          <div className="mt-6 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] p-4">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-lime-strong)]">
              Enlace visible una sola vez
            </p>
            <p className="mt-2 break-all text-sm leading-6 text-[var(--fp-graphite)]">
              {accessUrl}
            </p>
            <Button
              type="button"
              variant="secondary"
              className="mt-4 min-h-11 w-full"
              onClick={() => void copyAccess()}
            >
              {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              {copied ? "Copiado" : "Copiar enlace"}
            </Button>
          </div>
        ) : null}

        {message ? (
          <p className="mt-5 text-sm leading-6 text-[var(--fp-muted)]" role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
      </Card>

      <Card className="p-5 sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-black">Accesos recientes</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
              El token nunca se guarda ni se vuelve a mostrar.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            onClick={() => void loadItems()}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualizar
          </Button>
        </div>

        {loading ? (
          <div className="mt-8">
            <LoadingState label="Cargando accesos..." />
          </div>
        ) : !items.length ? (
          <EmptyState
            className="mt-8"
            title="No hay accesos generados"
            description="Crea el primer enlace para un analista especializado."
          />
        ) : (
          <div className="mt-6 grid gap-3">
            {items.map((item) => {
              const status = grantStatus(item);
              const canRevoke = item.status === "PENDING" || item.status === "ACTIVE";
              return (
                <article
                  key={item.id}
                  className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-white p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <UserRoundCheck className="h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                        <h3 className="truncate font-black">{item.analyst.name}</h3>
                      </div>
                      <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                        {item.analyst.externalId}
                      </p>
                    </div>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </div>
                  <dl className="mt-4 grid gap-2 text-sm text-[var(--fp-muted)] sm:grid-cols-2">
                    <div className="flex items-start gap-2">
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <div>
                        <dt className="font-bold text-[var(--fp-graphite)]">Vence</dt>
                        <dd>{formatDateTime(item.expiresAt)}</dd>
                      </div>
                    </div>
                    <div>
                      <dt className="font-bold text-[var(--fp-graphite)]">Uso</dt>
                      <dd>{item.consumedAt ? formatDateTime(item.consumedAt) : "Sin utilizar"}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="font-bold text-[var(--fp-graphite)]">Emitido por</dt>
                      <dd>{item.issuedBy.name}</dd>
                    </div>
                  </dl>
                  {canRevoke ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-4 min-h-11 border border-[var(--fp-border)]"
                      disabled={revokingId === item.id}
                      onClick={() => void revokeAccess(item.id)}
                    >
                      <XCircle className="h-4 w-4" aria-hidden="true" />
                      {revokingId === item.id ? "Revocando..." : "Revocar acceso"}
                    </Button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
