"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ArrowRightLeft,
  CalendarDays,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  UserRound,
  XCircle,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  StatusPill,
} from "@/app/_components/finser-ui";

type ReplacementStatus =
  | "PENDING_ENROLLMENT"
  | "ENROLLMENT_APPROVED"
  | "COMPLETED"
  | "CANCELLED";

type ReplacementSummary = {
  id: string;
  status: ReplacementStatus;
  newImeiMasked: string;
  reason: string;
  createdAt: string;
  completedAt: string | null;
  analystName: string | null;
};

type ReplacementResponse = {
  ok: true;
  credit: {
    id: number;
    folio: string;
    clienteNombre: string;
    clienteDocumentoMasked: string;
    equipment: string;
    platform: string;
    currentImeiMasked: string;
  };
  replacement: ReplacementSummary | null;
};

type MutationAction = "COMPLETE" | "CANCEL";

const STATUS_CONTENT: Record<
  ReplacementStatus,
  { label: string; title: string; description: string; tone: "warning" | "positive" | "danger" }
> = {
  PENDING_ENROLLMENT: {
    label: "Pendiente de enrolamiento",
    title: "El nuevo equipo debe ser enrolado",
    description:
      "Entrega al analista la cédula del cliente y el nuevo IMEI. El cambio no se aplicará al crédito hasta recibir su aprobación.",
    tone: "warning",
  },
  ENROLLMENT_APPROVED: {
    label: "Enrolamiento aprobado",
    title: "El nuevo equipo está listo para aplicar",
    description:
      "El analista confirmó el enrolamiento. Revisa la información y aplica el cambio para actualizar el equipo operativo del crédito.",
    tone: "positive",
  },
  COMPLETED: {
    label: "Cambio aplicado",
    title: "Reemplazo finalizado",
    description:
      "El nuevo IMEI ya es el equipo operativo de este crédito. El contrato y el enrolamiento anteriores permanecen como historial.",
    tone: "positive",
  },
  CANCELLED: {
    label: "Cambio cancelado",
    title: "La solicitud de reemplazo fue cancelada",
    description:
      "El IMEI original continúa vigente. Puedes iniciar otra solicitud si el cambio todavía es necesario.",
    tone: "danger",
  },
};

function displayDate(value: string | null | undefined) {
  if (!value) return "Sin registro";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin registro";

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function readResponseError(
  payload: ReplacementResponse | { error?: string } | null,
  fallback: string
) {
  return payload && "error" in payload && payload.error ? payload.error : fallback;
}

export function ApprovedCreditEquipmentReplacement({
  creditId,
}: {
  creditId: number;
}) {
  const [data, setData] = useState<ReplacementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newImei, setNewImei] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<MutationAction | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(
        `/api/creditos/${creditId}/device-replacement`,
        { cache: "no-store", signal }
      );
      const payload = (await response.json().catch(() => null)) as
        | ReplacementResponse
        | { error?: string }
        | null;

      if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
        throw new Error(
          readResponseError(payload, "No fue posible cargar el cambio de equipo.")
        );
      }

      setData(payload);
    } catch (error) {
      if (signal?.aborted) return;
      setData(null);
      setLoadError(
        error instanceof Error
          ? error.message
          : "No fue posible cargar el cambio de equipo."
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [creditId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, retryToken]);

  async function createReplacement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const normalizedImei = newImei.trim();
    const normalizedReason = reason.trim();
    if (!/^\d{15}$/.test(normalizedImei)) {
      setMutationError("Ingresa un IMEI válido de 15 dígitos.");
      return;
    }
    if (normalizedReason.length < 5) {
      setMutationError("Describe el motivo del cambio en al menos 5 caracteres.");
      return;
    }

    setBusy(true);
    setMutationError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/creditos/${creditId}/device-replacement`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newImei: normalizedImei, reason: normalizedReason }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | ReplacementResponse
        | { error?: string }
        | null;

      if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
        throw new Error(
          readResponseError(payload, "No fue posible iniciar el cambio de equipo.")
        );
      }

      setData(payload);
      setNewImei("");
      setReason("");
      setNotice(
        "Cambio registrado. El analista debe aprobar el nuevo IMEI en el portal de enrolamiento."
      );
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? error.message
          : "No fue posible iniciar el cambio de equipo."
      );
    } finally {
      setBusy(false);
    }
  }

  async function mutateReplacement(action: MutationAction) {
    if (busy) return;
    setBusy(true);
    setMutationError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/creditos/${creditId}/device-replacement`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "CANCEL"
              ? { action, reason: "Cambio por garantía cancelado por administrador central" }
              : { action }
          ),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | ReplacementResponse
        | { error?: string }
        | null;

      if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
        throw new Error(
          readResponseError(
            payload,
            action === "COMPLETE"
              ? "No fue posible aplicar el cambio de equipo."
              : "No fue posible cancelar el cambio de equipo."
          )
        );
      }

      setData(payload);
      setNotice(
        action === "COMPLETE"
          ? "El nuevo IMEI quedó aplicado al crédito y el cambio fue auditado."
          : "La solicitud de cambio fue cancelada; el IMEI original continúa vigente."
      );
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar el cambio de equipo."
      );
    } finally {
      setBusy(false);
      setConfirmAction(null);
    }
  }

  if (loading) {
    return (
      <Card className="flex min-h-52 items-center justify-center p-6">
        <LoadingState label="Cargando cambio de equipo..." />
      </Card>
    );
  }

  if (loadError || !data) {
    return (
      <Card className="p-5">
        <EmptyState
          title="No fue posible abrir el cambio de equipo"
          description={loadError || "No se encontró el crédito solicitado."}
          action={
            <Button
              variant="secondary"
              onClick={() => setRetryToken((value) => value + 1)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Reintentar
            </Button>
          }
        />
      </Card>
    );
  }

  const replacement = data.replacement;
  const statusContent = replacement ? STATUS_CONTENT[replacement.status] : null;
  const canStart = !replacement || replacement.status === "CANCELLED";
  const canCancel =
    replacement?.status === "PENDING_ENROLLMENT" ||
    replacement?.status === "ENROLLMENT_APPROVED";

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card className="p-4 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
              <Smartphone className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-lime-strong)]">
                Crédito aprobado
              </p>
              <h2 className="mt-1 break-words text-xl font-black text-[var(--fp-graphite)]">
                {data.credit.folio}
              </h2>
            </div>
          </div>

          <dl className="mt-5 divide-y divide-[var(--fp-border)] border-y border-[var(--fp-border)] text-sm">
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="flex items-center gap-2 font-bold text-[var(--fp-muted)]">
                <UserRound className="h-4 w-4" aria-hidden="true" /> Cliente
              </dt>
              <dd className="break-words font-black text-[var(--fp-graphite)]">
                {data.credit.clienteNombre}
              </dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="font-bold text-[var(--fp-muted)]">Documento</dt>
              <dd className="font-semibold text-[var(--fp-graphite)]">
                {data.credit.clienteDocumentoMasked}
              </dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="font-bold text-[var(--fp-muted)]">Equipo actual</dt>
              <dd className="break-words font-semibold text-[var(--fp-graphite)]">
                {data.credit.equipment}
              </dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="font-bold text-[var(--fp-muted)]">Plataforma</dt>
              <dd className="font-semibold uppercase text-[var(--fp-graphite)]">
                {data.credit.platform}
              </dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="font-bold text-[var(--fp-muted)]">IMEI vigente</dt>
              <dd className="font-mono font-semibold text-[var(--fp-graphite)]">
                {data.credit.currentImeiMasked}
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4 text-sm text-[var(--fp-muted)]">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
              aria-hidden="true"
            />
            <p>
              El reemplazo no repite DataCrédito ni Veriff y no modifica el contrato
              firmado. El IMEI anterior se conserva en el historial de auditoría.
            </p>
          </div>
        </Card>

        <Card className="p-4 sm:p-6">
          {mutationError ? (
            <p
              className="mb-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-danger)]"
              role="alert"
            >
              {mutationError}
            </p>
          ) : null}
          {notice ? (
            <p
              className="mb-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-graphite)]"
              role="status"
            >
              {notice}
            </p>
          ) : null}

          {canStart ? (
            <form onSubmit={createReplacement}>
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]">
                  <ArrowRightLeft className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-amber)]">
                    Cambio por garantía
                  </p>
                  <h2 className="mt-1 text-xl font-black text-[var(--fp-graphite)]">
                    Registrar equipo de reemplazo
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                    Confirma el IMEI físico del equipo nuevo antes de continuar.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-4">
                <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
                  IMEI del equipo nuevo
                  <Input
                    value={newImei}
                    onChange={(event) =>
                      setNewImei(event.target.value.replace(/\D/g, "").slice(0, 15))
                    }
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={15}
                    placeholder="15 dígitos del IMEI"
                    disabled={busy}
                    required
                  />
                  <span className="text-xs font-normal text-[var(--fp-muted)]">
                    Debe tener exactamente 15 dígitos y no estar asignado a otra venta.
                  </span>
                </label>

                <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
                  Motivo del cambio
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className="fp-ui-input min-h-28 resize-y py-3"
                    maxLength={500}
                    placeholder="Ejemplo: cambio por garantía debido a falla del dispositivo"
                    disabled={busy}
                    required
                  />
                </label>
              </div>

              <Button type="submit" className="mt-5 w-full sm:w-auto" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? "Registrando..." : "Iniciar cambio por garantía"}
              </Button>
            </form>
          ) : replacement && statusContent ? (
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-lime-strong)]">
                    Seguimiento del reemplazo
                  </p>
                  <h2 className="mt-1 text-xl font-black text-[var(--fp-graphite)]">
                    {statusContent.title}
                  </h2>
                </div>
                <StatusPill tone={statusContent.tone}>
                  {statusContent.label}
                </StatusPill>
              </div>

              <p className="mt-3 text-sm leading-6 text-[var(--fp-muted)]">
                {statusContent.description}
              </p>

              <dl className="mt-5 divide-y divide-[var(--fp-border)] rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] px-4 text-sm">
                <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                  <dt className="font-bold text-[var(--fp-muted)]">Nuevo IMEI</dt>
                  <dd className="font-mono font-black text-[var(--fp-graphite)]">
                    {replacement.newImeiMasked}
                  </dd>
                </div>
                <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                  <dt className="font-bold text-[var(--fp-muted)]">Motivo</dt>
                  <dd className="break-words font-semibold text-[var(--fp-graphite)]">
                    {replacement.reason}
                  </dd>
                </div>
                <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                  <dt className="flex items-center gap-2 font-bold text-[var(--fp-muted)]">
                    <CalendarDays className="h-4 w-4" aria-hidden="true" /> Registrado
                  </dt>
                  <dd className="font-semibold text-[var(--fp-graphite)]">
                    {displayDate(replacement.createdAt)}
                  </dd>
                </div>
                {replacement.analystName ? (
                  <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                    <dt className="font-bold text-[var(--fp-muted)]">Analista</dt>
                    <dd className="font-semibold text-[var(--fp-graphite)]">
                      {replacement.analystName}
                    </dd>
                  </div>
                ) : null}
                {replacement.completedAt ? (
                  <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                    <dt className="font-bold text-[var(--fp-muted)]">Finalizado</dt>
                    <dd className="font-semibold text-[var(--fp-graphite)]">
                      {displayDate(replacement.completedAt)}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {replacement.status === "PENDING_ENROLLMENT" ? (
                <div className="mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] p-4 text-sm text-[var(--fp-graphite)]">
                  <p className="font-black">Siguiente paso: aprobación del analista</p>
                  <p className="mt-1 leading-6 text-[var(--fp-muted)]">
                    El especialista debe consultar la cédula y el nuevo IMEI en el
                    portal de enrolamiento. Esta pantalla reflejará la aprobación al
                    actualizarla.
                  </p>
                  <Button
                    variant="secondary"
                    className="mt-3"
                    onClick={() => setRetryToken((value) => value + 1)}
                    disabled={busy}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Consultar estado
                  </Button>
                </div>
              ) : null}

              {replacement.status === "ENROLLMENT_APPROVED" ? (
                <div className="mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] p-4 text-sm text-[var(--fp-graphite)]">
                  <div className="flex items-start gap-3">
                    <CheckCircle2
                      className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="font-black">Enrolamiento confirmado</p>
                      <p className="mt-1 leading-6 text-[var(--fp-muted)]">
                        Aplicar el cambio hará que el nuevo IMEI sea el equipo vigente
                        en la operación del crédito.
                      </p>
                    </div>
                  </div>
                  <Button
                    className="mt-4 w-full sm:w-auto"
                    onClick={() => setConfirmAction("COMPLETE")}
                    disabled={busy}
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Aplicar cambio
                  </Button>
                </div>
              ) : null}

              {canCancel ? (
                <div className="mt-5 border-t border-[var(--fp-border)] pt-5">
                  <Button
                    variant="danger"
                    onClick={() => setConfirmAction("CANCEL")}
                    disabled={busy}
                  >
                    <XCircle className="h-4 w-4" aria-hidden="true" />
                    Cancelar solicitud de cambio
                  </Button>
                  <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">
                    El crédito conservará el IMEI actual y el intento quedará en el
                    historial.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmAction === "COMPLETE"}
        title="Aplicar el cambio de equipo"
        description={`El IMEI ${replacement?.newImeiMasked || "nuevo"} quedará como equipo operativo del crédito ${data.credit.folio}. El IMEI anterior permanecerá en el historial.`}
        confirmLabel="Sí, aplicar cambio"
        busy={busy}
        onCancel={() => {
          if (!busy) setConfirmAction(null);
        }}
        onConfirm={() => void mutateReplacement("COMPLETE")}
      />

      <ConfirmDialog
        open={confirmAction === "CANCEL"}
        title="Cancelar esta solicitud de cambio"
        description="El IMEI actual seguirá vigente y la cancelación quedará auditada."
        confirmLabel="Sí, cancelar solicitud"
        danger
        busy={busy}
        onCancel={() => {
          if (!busy) setConfirmAction(null);
        }}
        onConfirm={() => void mutateReplacement("CANCEL")}
      />
    </>
  );
}
