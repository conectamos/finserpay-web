"use client";

import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Link2,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldAlert,
  UnlockKeyhole,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  MetricCard,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";

type PadlockStatus =
  | "PENDING"
  | "PROCESSING"
  | "LOCKED"
  | "UNLOCKED"
  | "ERROR"
  | "REVIEW_REQUIRED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "NOT_ENROLLED"
  | "UNKNOWN";

type PadlockProviderState =
  | "LOCKED"
  | "UNLOCKED"
  | "LOCKING"
  | "UNLOCKING"
  | "NOT_ENROLLED"
  | "ERROR"
  | "UNKNOWN";

type PadlockPolicy = {
  id: string;
  scopeType: "GLOBAL" | "ALLY";
  allyId: number | null;
  allyName: string | null;
  productCode: "IPHONE";
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  version: number;
  reason: string | null;
  updatedAt: string;
};

type PadlockBinding = {
  id: string;
  creditId: number;
  folio: string;
  customerName: string;
  allyName: string | null;
  imeiMasked: string;
  verified: boolean;
  active: boolean;
  status: PadlockStatus;
  desiredState: "LOCKED" | "UNLOCKED" | null;
  paymentStatus: "MORA" | "AL_DIA" | "PAGADO" | "UNKNOWN";
  daysPastDue: number;
  reviewReason: string | null;
  lastUpdatedAt: string | null;
};

type PadlockCommand = {
  id: string;
  bindingId: string;
  creditId: number;
  folio: string;
  imeiMasked: string;
  action: "LOCK" | "UNLOCK";
  source: "AUTO_CUTOFF" | "AUTO_FINANCIAL" | "MANUAL";
  status: PadlockStatus;
  reason: string | null;
  requestedBy: string | null;
  attempts: number;
  errorCode: string | null;
  providerState: PadlockProviderState | null;
  createdAt: string;
};

type PadlockListWindow = {
  limit: number;
  shown: number;
  total: number;
  limited: boolean;
};

type OverviewPayload = {
  ok?: boolean;
  error?: string;
  integration?: {
    enabled: boolean;
    configured: boolean;
    providerCallsAllowed: boolean;
    environment: "sandbox" | "production" | "not-configured";
    scheduleLabel: string;
    automaticUnlockLabel: string;
  };
  counters?: {
    pending: number;
    processing: number;
    locked: number;
    unlocked: number;
    error: number;
    reviewRequired: number;
  };
  lists?: {
    bindings: PadlockListWindow;
    commands: PadlockListWindow;
  };
  allies?: Array<{ id: number; name: string }>;
  policies?: PadlockPolicy[];
  bindings?: PadlockBinding[];
  commands?: PadlockCommand[];
};

type PendingManualCommand = {
  binding: PadlockBinding;
  action: "LOCK" | "UNLOCK";
  reason: string;
};

type PendingPolicyChange = {
  scopeType: "GLOBAL" | "ALLY";
  allyId: number | null;
  allyName: string | null;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  reason: string;
};

type PendingBinding = {
  creditId: number;
  imei: string;
};

const EMPTY_COUNTERS = {
  pending: 0,
  processing: 0,
  locked: 0,
  unlocked: 0,
  error: 0,
  reviewRequired: 0,
};

const EMPTY_LIST_WINDOW: PadlockListWindow = {
  limit: 100,
  shown: 0,
  total: 0,
  limited: false,
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";

  try {
    return new Intl.DateTimeFormat("es-CO", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Bogota",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function statusPresentation(status: PadlockStatus) {
  switch (status) {
    case "PENDING":
      return { label: "Pendiente", tone: "warning" as const };
    case "PROCESSING":
      return { label: "Procesando", tone: "warning" as const };
    case "LOCKED":
      return { label: "Bloqueado", tone: "danger" as const };
    case "UNLOCKED":
      return { label: "Desbloqueado", tone: "positive" as const };
    case "ERROR":
      return { label: "Error", tone: "danger" as const };
    case "REVIEW_REQUIRED":
      return { label: "Requiere revisión", tone: "warning" as const };
    case "NOT_ENROLLED":
      return { label: "No enrolado", tone: "warning" as const };
    case "CANCELLED":
      return { label: "Cancelado", tone: "neutral" as const };
    case "SUPERSEDED":
      return { label: "Reemplazado", tone: "neutral" as const };
    default:
      return { label: "Sin confirmar", tone: "neutral" as const };
  }
}

function Status({ value }: { value: PadlockStatus }) {
  const presentation = statusPresentation(value);
  return <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>;
}

function providerStateLabel(value: PadlockProviderState) {
  switch (value) {
    case "LOCKED":
      return "Bloqueado";
    case "UNLOCKED":
      return "Desbloqueado";
    case "LOCKING":
      return "Bloqueando";
    case "UNLOCKING":
      return "Desbloqueando";
    case "NOT_ENROLLED":
      return "No enrolado";
    case "ERROR":
      return "Error";
    default:
      return "Sin confirmar";
  }
}

async function readPayload(response: Response) {
  return (await response.json().catch(() => ({}))) as OverviewPayload;
}

function parsePositiveInteger(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export default function PadlockAdminConsole() {
  const [payload, setPayload] = useState<OverviewPayload>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [policyScope, setPolicyScope] = useState<"GLOBAL" | "ALLY">("GLOBAL");
  const [policyAllyId, setPolicyAllyId] = useState("");
  const [policyEnabled, setPolicyEnabled] = useState(false);
  const [graceDays, setGraceDays] = useState("0");
  const [lockAfterDays, setLockAfterDays] = useState("0");
  const [unlockCondition, setUnlockCondition] =
    useState<"CURRENT" | "SETTLED">("CURRENT");
  const [policyReason, setPolicyReason] = useState("");
  const [pendingPolicy, setPendingPolicy] =
    useState<PendingPolicyChange | null>(null);

  const [creditId, setCreditId] = useState("");
  const [imei, setImei] = useState("");
  const [pendingBinding, setPendingBinding] =
    useState<PendingBinding | null>(null);
  const [selectedBindingId, setSelectedBindingId] = useState("");
  const [manualAction, setManualAction] = useState<"LOCK" | "UNLOCK">("LOCK");
  const [manualReason, setManualReason] = useState("");
  const [pendingManual, setPendingManual] =
    useState<PendingManualCommand | null>(null);

  const integration = payload.integration;
  const counters = payload.counters ?? EMPTY_COUNTERS;
  const allies = payload.allies ?? [];
  const policies = payload.policies ?? [];
  const bindings = useMemo(() => payload.bindings ?? [], [payload.bindings]);
  const commands = payload.commands ?? [];
  const bindingList = payload.lists?.bindings ?? EMPTY_LIST_WINDOW;
  const commandList = payload.lists?.commands ?? EMPTY_LIST_WINDOW;
  const selectedBinding = useMemo(
    () => bindings.find((item) => item.id === selectedBindingId) ?? null,
    [bindings, selectedBindingId]
  );

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/padlock", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const nextPayload = await readPayload(response);
      if (!response.ok || !nextPayload.ok) {
        throw new Error(nextPayload.error || "No se pudo cargar Padlock.");
      }
      setPayload(nextPayload);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudo cargar Padlock."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedBindingId && bindings[0]) {
      setSelectedBindingId(bindings[0].id);
    }
  }, [bindings, selectedBindingId]);

  const mutate = useCallback(
    async (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => {
      setBusy(true);
      setMessage("");
      setError("");

      try {
        const response = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const nextPayload = await readPayload(response);
        if (!response.ok || !nextPayload.ok) {
          throw new Error(nextPayload.error || "No se pudo completar la operación.");
        }
        setMessage(
          typeof (nextPayload as Record<string, unknown>).message === "string"
            ? String((nextPayload as Record<string, unknown>).message)
            : "Operación registrada correctamente."
        );
        await loadOverview();
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "No se pudo completar la operación."
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadOverview]
  );

  const submitPolicy = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedGrace = parsePositiveInteger(graceDays);
    const parsedLockDays = parsePositiveInteger(lockAfterDays);
    const allyId = Number(policyAllyId);

    if (parsedGrace === null || parsedLockDays === null) {
      setError("Los días deben ser números enteros iguales o mayores que cero.");
      return;
    }
    if (policyScope === "ALLY" && (!Number.isInteger(allyId) || allyId <= 0)) {
      setError("Seleccione el aliado al que aplicará la regla.");
      return;
    }
    if (policyReason.trim().length < 10) {
      setError("Explique el cambio de regla en al menos 10 caracteres.");
      return;
    }

    const ally =
      policyScope === "ALLY"
        ? allies.find((item) => item.id === allyId) ?? null
        : null;
    if (policyScope === "ALLY" && !ally) {
      setError("El aliado seleccionado ya no está disponible.");
      return;
    }

    setError("");
    setPendingPolicy({
      scopeType: policyScope,
      allyId: policyScope === "ALLY" ? allyId : null,
      allyName: ally?.name ?? null,
      enabled: policyEnabled,
      graceDays: parsedGrace,
      lockAfterDaysPastDue: parsedLockDays,
      unlockCondition,
      reason: policyReason.trim(),
    });
  };

  const confirmPolicyChange = async () => {
    if (!pendingPolicy) return;
    const saved = await mutate("/api/padlock/policies", "PUT", {
      scopeType: pendingPolicy.scopeType,
      allyId: pendingPolicy.allyId,
      productCode: "IPHONE",
      enabled: pendingPolicy.enabled,
      graceDays: pendingPolicy.graceDays,
      lockAfterDaysPastDue: pendingPolicy.lockAfterDaysPastDue,
      unlockCondition: pendingPolicy.unlockCondition,
      reason: pendingPolicy.reason,
    });

    if (saved) {
      setPolicyReason("");
      setPendingPolicy(null);
    }
  };

  const submitBinding = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedCreditId = Number(creditId);
    const normalizedImei = imei.replace(/\D/g, "");

    if (!Number.isInteger(parsedCreditId) || parsedCreditId <= 0) {
      setError("Ingrese un ID de crédito válido.");
      return;
    }
    if (!/^\d{15}$/.test(normalizedImei)) {
      setError("El IMEI debe contener exactamente 15 dígitos.");
      return;
    }

    setError("");
    setPendingBinding({
      creditId: parsedCreditId,
      imei: normalizedImei,
    });
  };

  const confirmBinding = async () => {
    if (!pendingBinding) return;
    const saved = await mutate("/api/padlock/bindings", "POST", {
      creditId: pendingBinding.creditId,
      imei: pendingBinding.imei,
    });

    if (saved) {
      setCreditId("");
      setImei("");
      setPendingBinding(null);
    }
  };

  const requestManualConfirmation = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedBinding) {
      setError("Seleccione un dispositivo vinculado.");
      return;
    }
    if (manualReason.trim().length < 10) {
      setError("El motivo manual debe tener al menos 10 caracteres.");
      return;
    }

    setPendingManual({
      binding: selectedBinding,
      action: manualAction,
      reason: manualReason.trim(),
    });
  };

  const confirmManualCommand = async () => {
    if (!pendingManual) return;
    const saved = await mutate("/api/padlock/commands", "POST", {
      bindingId: pendingManual.binding.id,
      action: pendingManual.action,
      reason: pendingManual.reason,
    });

    if (saved) {
      setManualReason("");
      setPendingManual(null);
    }
  };

  if (loading && !payload.ok) {
    return <LoadingState label="Cargando control Padlock..." />;
  }

  return (
    <div className="grid gap-6 pb-10">
      <Card
        className={[
          "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6",
          integration?.providerCallsAllowed
            ? "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)]"
            : "border-[var(--fp-amber)] bg-[var(--fp-amber-soft)]",
        ].join(" ")}
      >
        <div className="flex items-start gap-3">
          {integration?.providerCallsAllowed ? (
            <CheckCircle2
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-lime-strong)]"
              aria-hidden="true"
            />
          ) : (
            <ShieldAlert
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-amber)]"
              aria-hidden="true"
            />
          )}
          <div>
            <h2 className="text-lg font-black text-[var(--fp-graphite)]">
              {integration?.enabled
                ? integration.providerCallsAllowed
                  ? "Integración habilitada"
                  : "Integración retenida por configuración"
                : "Integración apagada para certificación"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
              {integration?.providerCallsAllowed
                ? "Los comandos siguen pasando por cola, validación financiera e idempotencia antes de contactar a Padlock."
                : integration?.enabled
                  ? "El interruptor está encendido, pero faltan controles de configuración. Ningún comando saldrá al proveedor."
                  : "PADLOCK_INTEGRATION_ENABLED está desactivado. Puede preparar reglas y revisar la operación, pero ningún comando saldrá al proveedor."}
            </p>
            {integration && !integration.configured ? (
              <p className="mt-2 text-sm font-semibold text-[var(--fp-danger)]">
                Faltan credenciales o URL del ambiente; no se permiten llamadas al proveedor.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusPill tone={integration?.providerCallsAllowed ? "positive" : "warning"}>
            {integration?.environment === "production"
              ? "Producción"
              : integration?.environment === "sandbox"
                ? "Sandbox"
                : "Sin configurar"}
            {integration?.providerCallsAllowed ? " listo" : " retenido"}
          </StatusPill>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadOverview()}
            disabled={loading || busy}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualizar
          </Button>
        </div>
      </Card>

      {error ? (
        <div
          className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] p-4 text-sm text-[var(--fp-danger)]"
          role="alert"
        >
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {message ? (
        <div
          className="rounded-[var(--fp-radius-md)] border border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] p-4 text-sm font-semibold text-[var(--fp-graphite)]"
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6" aria-label="Resumen de estados">
        <MetricCard label="Pendientes" value={counters.pending} detail="En cola" />
        <MetricCard label="Procesando" value={counters.processing} detail="En conciliación" />
        <MetricCard label="Bloqueados" value={counters.locked} detail="Confirmados" />
        <MetricCard label="Desbloqueados" value={counters.unlocked} detail="Confirmados" />
        <MetricCard label="Errores" value={counters.error} detail="Reintento agotado" />
        <MetricCard
          label="Revisión"
          value={counters.reviewRequired}
          detail="Intervención humana"
        />
      </section>
      <p className="text-xs leading-5 text-[var(--fp-muted)]">
        Los contadores resumen el último estado persistido. La tabla puede elevar
        un dispositivo a “Requiere revisión” al recalcular en vivo su política,
        posición financiera o protección por robo.
      </p>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <CalendarClock
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-amber)]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-lg font-black">Ventana fija de bloqueo</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
                {integration?.scheduleLabel ||
                  "Días 5 y 20 de cada mes, a las 8:00 p. m. (America/Bogota)."}
                {" "}En ese momento se vuelve a calcular el saldo oficial; si el crédito ya está al día, no se bloquea.
              </p>
            </div>
          </div>
        </Card>
        <Card className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <UnlockKeyhole
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-lime-strong)]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-lg font-black">Desbloqueo por pago</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
                {integration?.automaticUnlockLabel ||
                  "Se programa después de confirmar el pago y verificar que el crédito quedó al día."}
                {" "}Un bloqueo manual con una causa independiente no se revierte automáticamente.
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr] xl:items-start">
        <Card className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Settings2
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-graphite)]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-lg font-black">Nueva versión de regla</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                Producto fijo: iPhone. La regla del aliado prevalece sobre la global.
              </p>
            </div>
          </div>

          <form className="mt-5 grid gap-4" onSubmit={submitPolicy}>
            <label className="grid gap-2 text-sm font-bold">
              Alcance
              <Select
                value={policyScope}
                onChange={(event) =>
                  setPolicyScope(event.target.value === "ALLY" ? "ALLY" : "GLOBAL")
                }
                disabled={busy}
              >
                <option value="GLOBAL">Global iPhone</option>
                <option value="ALLY">Aliado específico</option>
              </Select>
            </label>
            {policyScope === "ALLY" ? (
              <label className="grid gap-2 text-sm font-bold">
                Aliado
                <Select
                  value={policyAllyId}
                  onChange={(event) => setPolicyAllyId(event.target.value)}
                  disabled={busy}
                  required
                >
                  <option value="">Seleccione un aliado</option>
                  {allies.map((ally) => (
                    <option key={ally.id} value={ally.id}>
                      {ally.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-bold">
                Días de gracia
                <Input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={graceDays}
                  onChange={(event) => setGraceDays(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <label className="grid gap-2 text-sm font-bold">
                Días de mora para bloquear
                <Input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={lockAfterDays}
                  onChange={(event) => setLockAfterDays(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-bold">
              Condición de desbloqueo
              <Select
                value={unlockCondition}
                onChange={(event) =>
                  setUnlockCondition(
                    event.target.value === "SETTLED" ? "SETTLED" : "CURRENT"
                  )
                }
                disabled={busy}
              >
                <option value="CURRENT">Crédito al día</option>
                <option value="SETTLED">Crédito pagado por completo</option>
              </Select>
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] px-4 text-sm font-bold">
              <input
                type="checkbox"
                checked={policyEnabled}
                onChange={(event) => setPolicyEnabled(event.target.checked)}
                disabled={busy}
                className="h-4 w-4 accent-[var(--fp-graphite)]"
              />
              Activar esta versión de la regla
            </label>
            <label className="grid gap-2 text-sm font-bold">
              Motivo del cambio
              <textarea
                className="fp-ui-input min-h-24 resize-y py-3"
                value={policyReason}
                onChange={(event) => setPolicyReason(event.target.value)}
                maxLength={500}
                placeholder="Explique por qué se crea o cambia esta regla"
                disabled={busy}
                required
              />
            </label>
            <Button type="submit" className="min-h-11" disabled={busy}>
              Guardar nueva versión
            </Button>
          </form>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-black">Reglas vigentes</h2>
          <p className="mt-1 text-sm text-[var(--fp-muted)]">
            El umbral efectivo es días de gracia + días de mora configurados.
          </p>
          <div className="mt-5">
            {policies.length ? (
              <DataTable>
                <table>
                  <thead>
                    <tr>
                      <th>Alcance</th>
                      <th>Estado</th>
                      <th>Gracia</th>
                      <th>Mora</th>
                      <th>Desbloqueo</th>
                      <th>Versión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((policy) => (
                      <tr key={policy.id}>
                        <td>
                          <strong>{policy.allyName || "Global"}</strong>
                          <small className="mt-1 block text-[var(--fp-muted)]">
                            iPhone · {formatDateTime(policy.updatedAt)}
                          </small>
                          {policy.reason ? (
                            <small className="mt-1 block max-w-xs break-words text-[var(--fp-muted)]">
                              {policy.reason}
                            </small>
                          ) : null}
                        </td>
                        <td>
                          <StatusPill tone={policy.enabled ? "positive" : "neutral"}>
                            {policy.enabled ? "Activa" : "Inactiva"}
                          </StatusPill>
                        </td>
                        <td>{policy.graceDays} días</td>
                        <td>{policy.lockAfterDaysPastDue} días</td>
                        <td>
                          {policy.unlockCondition === "SETTLED"
                            ? "Pago total"
                            : "Al día"}
                        </td>
                        <td>v{policy.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            ) : (
              <EmptyState
                title="No hay reglas Padlock"
                description="Cree una regla global inactiva para preparar la certificación en sandbox."
              />
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-2 xl:items-start">
        <Card className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Link2
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-graphite)]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-lg font-black">Vincular iPhone</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                El crédito debe ser iPhone, tener el mismo IMEI y aparecer
                desbloqueado como coincidencia exacta en Padlock. Durante la
                certificación no se vinculan dispositivos con un bloqueo previo
                por robo o mora en la cartera existente.
              </p>
            </div>
          </div>
          <form className="mt-5 grid gap-4" onSubmit={submitBinding}>
            <label className="grid gap-2 text-sm font-bold">
              ID del crédito
              <Input
                type="number"
                min={1}
                step={1}
                value={creditId}
                onChange={(event) => setCreditId(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-bold">
              IMEI (15 dígitos)
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={15}
                pattern="[0-9]{15}"
                value={imei}
                onChange={(event) => setImei(event.target.value.replace(/\D/g, ""))}
                disabled={busy}
                required
              />
            </label>
            <Button
              type="submit"
              disabled={busy || !integration?.providerCallsAllowed}
            >
              Verificar y vincular
            </Button>
            {!integration?.providerCallsAllowed ? (
              <p className="text-sm leading-6 text-[var(--fp-muted)]">
                Habilite y configure primero el ambiente sandbox de Padlock. El IMEI no se guardará como verificado sin consultar al proveedor.
              </p>
            ) : null}
          </form>
        </Card>

        <Card className="border-[var(--fp-danger)] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <LockKeyhole
              className="mt-0.5 h-6 w-6 shrink-0 text-[var(--fp-danger)]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-lg font-black">Comando manual</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                Solo encola una intención. El worker verifica otra vez la vinculación, el estado deseado y la idempotencia antes de contactar a Padlock.
              </p>
            </div>
          </div>
          <form className="mt-5 grid gap-4" onSubmit={requestManualConfirmation}>
            <label className="grid gap-2 text-sm font-bold">
              Dispositivo vinculado
              <Select
                value={selectedBindingId}
                onChange={(event) => setSelectedBindingId(event.target.value)}
                disabled={busy || !bindings.length}
                required
              >
                {!bindings.length ? <option value="">Sin dispositivos</option> : null}
                {bindings.map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {binding.folio} · {binding.imeiMasked}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid gap-2 text-sm font-bold">
              Acción
              <Select
                value={manualAction}
                onChange={(event) =>
                  setManualAction(event.target.value === "UNLOCK" ? "UNLOCK" : "LOCK")
                }
                disabled={busy}
              >
                <option value="LOCK">Bloquear</option>
                <option value="UNLOCK">Desbloquear</option>
              </Select>
            </label>
            <label className="grid gap-2 text-sm font-bold">
              Motivo obligatorio
              <textarea
                className="fp-ui-input min-h-24 resize-y py-3"
                value={manualReason}
                onChange={(event) => setManualReason(event.target.value)}
                maxLength={500}
                placeholder="Describa la razón operativa y la evidencia revisada"
                disabled={busy}
                required
              />
            </label>
            <Button
              type="submit"
              variant={manualAction === "LOCK" ? "danger" : "primary"}
              disabled={
                busy || !selectedBinding || !integration?.providerCallsAllowed
              }
            >
              Revisar comando
            </Button>
            {!integration?.providerCallsAllowed ? (
              <p className="text-sm leading-6 text-[var(--fp-muted)]">
                Los comandos manuales permanecen deshabilitados mientras el interruptor general o la configuración impidan llamadas a Padlock.
              </p>
            ) : null}
          </form>
        </Card>
      </section>

      <Card className="p-5 sm:p-6">
        <h2 className="text-lg font-black">Dispositivos vinculados</h2>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">
          Los IMEI se muestran enmascarados; el valor completo permanece únicamente en la capa operativa protegida.
        </p>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">
          Se muestran {bindingList.shown} de {bindingList.total} vínculos activos,
          hasta los {bindingList.limit} actualizados más recientemente.
          {bindingList.limited
            ? " Los totales superiores incluyen toda la operación."
            : ""}
        </p>
        <div className="mt-5">
          {bindings.length ? (
            <DataTable>
              <table>
                <thead>
                  <tr>
                    <th>Crédito</th>
                    <th>Cliente / aliado</th>
                    <th>IMEI</th>
                    <th>Cartera</th>
                    <th>Padlock</th>
                    <th>Actualización</th>
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((binding) => (
                    <tr key={binding.id}>
                      <td>
                        <strong>{binding.folio}</strong>
                        <small className="mt-1 block text-[var(--fp-muted)]">
                          Crédito #{binding.creditId}
                        </small>
                      </td>
                      <td>
                        <span>{binding.customerName}</span>
                        <small className="mt-1 block text-[var(--fp-muted)]">
                          {binding.allyName || "Sin aliado"}
                        </small>
                      </td>
                      <td className="font-mono">{binding.imeiMasked}</td>
                      <td>
                        <StatusPill
                          tone={
                            binding.paymentStatus === "MORA"
                              ? "danger"
                              : binding.paymentStatus === "UNKNOWN"
                                ? "neutral"
                                : "positive"
                          }
                        >
                          {binding.paymentStatus === "AL_DIA"
                            ? "Al día"
                            : binding.paymentStatus === "PAGADO"
                              ? "Pagado"
                              : binding.paymentStatus === "MORA"
                                ? `Mora · ${binding.daysPastDue} d`
                                : "Sin cálculo"}
                        </StatusPill>
                      </td>
                      <td>
                        <Status value={binding.status} />
                        {binding.reviewReason ? (
                          <small className="mt-1 block max-w-xs break-words font-mono text-[var(--fp-muted)]">
                            {binding.reviewReason}
                          </small>
                        ) : null}
                      </td>
                      <td>{formatDateTime(binding.lastUpdatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <EmptyState
              title="No hay iPhone vinculados"
              description="La automatización nunca actuará sobre un crédito sin vinculación explícita y verificada."
            />
          )}
        </div>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-lg font-black">Actividad reciente</h2>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">
          Intenciones y conciliaciones recientes, sin tokens ni respuestas sensibles del proveedor.
        </p>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">
          Se muestran {commandList.shown} de {commandList.total} comandos, hasta los{" "}
          {commandList.limit} creados más recientemente.
        </p>
        <div className="mt-5">
          {commands.length ? (
            <DataTable>
              <table>
                <thead>
                  <tr>
                    <th>Creado</th>
                    <th>Crédito / IMEI</th>
                    <th>Acción</th>
                    <th>Origen</th>
                    <th>Estado</th>
                    <th>Intentos</th>
                    <th>Responsable / motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((command) => (
                    <tr key={command.id}>
                      <td>{formatDateTime(command.createdAt)}</td>
                      <td>
                        <strong>{command.folio}</strong>
                        <small className="mt-1 block font-mono text-[var(--fp-muted)]">
                          {command.imeiMasked}
                        </small>
                      </td>
                      <td>
                        {command.action === "LOCK" ? "Bloquear" : "Desbloquear"}
                      </td>
                      <td>
                        {command.source === "MANUAL"
                          ? "Manual"
                          : command.source === "AUTO_FINANCIAL"
                            ? "Evaluación financiera"
                            : "Corte de mora"}
                      </td>
                      <td>
                        <Status value={command.status} />
                        {command.errorCode ? (
                          <small className="mt-1 block max-w-xs break-words font-mono text-[var(--fp-danger)]">
                            {command.errorCode}
                          </small>
                        ) : null}
                        {command.providerState ? (
                          <small className="mt-1 block text-[var(--fp-muted)]">
                            Proveedor: {providerStateLabel(command.providerState)}
                          </small>
                        ) : null}
                      </td>
                      <td>{command.attempts}</td>
                      <td>
                        <span>{command.requestedBy || "Sistema"}</span>
                        {command.reason ? (
                          <small className="mt-1 block max-w-xs break-words text-[var(--fp-muted)]">
                            {command.reason}
                          </small>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <EmptyState
              title="Sin comandos registrados"
              description="Los comandos aparecerán aquí cuando una regla o un administrador genere una intención."
            />
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={Boolean(pendingPolicy)}
        title="Confirmar nueva versión de regla"
        description={
          pendingPolicy
            ? `Alcance: ${
                pendingPolicy.scopeType === "GLOBAL"
                  ? "global iPhone"
                  : `aliado ${pendingPolicy.allyName || "seleccionado"}`
              }. Estado: ${pendingPolicy.enabled ? "activa" : "inactiva"}. Gracia: ${pendingPolicy.graceDays} días. Bloqueo desde: ${pendingPolicy.lockAfterDaysPastDue} días de mora. Desbloqueo: ${
                pendingPolicy.unlockCondition === "CURRENT"
                  ? "crédito al día"
                  : "crédito pagado por completo"
              }.`
            : ""
        }
        confirmLabel="Guardar nueva versión"
        danger={Boolean(pendingPolicy?.enabled)}
        busy={busy}
        onCancel={() => {
          if (!busy) setPendingPolicy(null);
        }}
        onConfirm={() => void confirmPolicyChange()}
      />

      <ConfirmDialog
        open={Boolean(pendingBinding)}
        title="Confirmar vinculación Padlock"
        description={
          pendingBinding
            ? `Vincular el crédito ${pendingBinding.creditId} al IMEI •••••••••••${pendingBinding.imei.slice(-4)}. Padlock asumirá la gestión remota de este iPhone y Equality quedará excluido mientras el vínculo esté activo.`
            : ""
        }
        confirmLabel="Verificar y vincular"
        busy={busy}
        onCancel={() => {
          if (!busy) setPendingBinding(null);
        }}
        onConfirm={() => void confirmBinding()}
      />

      <ConfirmDialog
        open={Boolean(pendingManual)}
        title={
          pendingManual?.action === "LOCK"
            ? "Confirmar bloqueo manual"
            : "Confirmar desbloqueo manual"
        }
        description={
          pendingManual
            ? `${pendingManual.action === "LOCK" ? "Bloquear" : "Desbloquear"} ${pendingManual.binding.imeiMasked}, crédito ${pendingManual.binding.folio}. La solicitud quedará auditada y será revalidada antes de salir por la cola.`
            : ""
        }
        confirmLabel="Confirmar y encolar"
        danger={pendingManual?.action === "LOCK"}
        busy={busy}
        onCancel={() => {
          if (!busy) setPendingManual(null);
        }}
        onConfirm={() => void confirmManualCommand()}
      />
    </div>
  );
}
