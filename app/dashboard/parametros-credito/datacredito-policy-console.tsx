"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  Plus,
  RotateCw,
  Save,
  Settings2,
  Smartphone,
  Trash2,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";

export type DataCreditoPolicyPlatform = "ANDROID" | "IPHONE";
export type DataCreditoPolicyDecision = "APROBADO" | "RECHAZADO";

export type DataCreditoPolicyBand = {
  id: string;
  platform: DataCreditoPolicyPlatform;
  scoreMin: number;
  scoreMax: number;
  decision: DataCreditoPolicyDecision;
  initialPaymentPercentage: number;
  suretyPercentage: number;
};

export type DataCreditoPolicy = {
  version: number;
  bands: DataCreditoPolicyBand[];
  createdAt?: string | null;
};

export type DataCreditoPolicyPatch = {
  expectedVersion?: number | null;
  bands: DataCreditoPolicyBand[];
};

export type DataCreditoPolicyApiResponse = {
  ok?: boolean;
  enabled: boolean;
  configured: boolean;
  hasPolicy: boolean;
  policy: DataCreditoPolicy | null;
  correlationId?: string;
};

type EditableBand = {
  id: string;
  platform: DataCreditoPolicyPlatform;
  scoreMin: string;
  scoreMax: string;
  decision: DataCreditoPolicyDecision | "";
  initialPaymentPercentage: string;
  suretyPercentage: string;
};

type PolicySnapshot = {
  enabled: boolean;
  configured: boolean;
  hasPolicy: boolean;
  version: number | null;
  createdAt: string | null;
  bands: DataCreditoPolicyBand[];
};

type ValidationResult = {
  valid: boolean;
  rowErrors: Record<string, string[]>;
  platformErrors: Record<DataCreditoPolicyPlatform, string[]>;
  canonicalBands: DataCreditoPolicyBand[];
};

type JsonRecord = Record<string, unknown>;

class PolicyRequestError extends Error {
  correlationId: string | null;

  constructor(message: string, correlationId: string | null = null) {
    super(message);
    this.name = "PolicyRequestError";
    this.correlationId = correlationId;
  }
}

const PLATFORMS: DataCreditoPolicyPlatform[] = ["ANDROID", "IPHONE"];
let draftSequence = 0;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;

  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function getCorrelationId(payload: unknown, response?: Response) {
  const body = isRecord(payload) ? payload : null;
  const nestedError = body && isRecord(body.error) ? body.error : null;

  return (
    readString(body?.correlationId) ||
    readString(nestedError?.correlationId) ||
    response?.headers.get("x-correlation-id") ||
    response?.headers.get("x-request-id") ||
    null
  );
}

async function readJson(response: Response): Promise<JsonRecord> {
  const payload = (await response.json().catch(() => null)) as unknown;
  return isRecord(payload) ? payload : {};
}

function parseBand(value: unknown, index: number): DataCreditoPolicyBand {
  if (!isRecord(value)) {
    throw new PolicyRequestError(`Banda ${index + 1} inválida.`);
  }

  const id = readString(value.id);
  const platform = String(value.platform || "").toUpperCase();
  const decision = String(value.decision || "").toUpperCase();
  const scoreMin = readFiniteNumber(value.scoreMin);
  const scoreMax = readFiniteNumber(value.scoreMax);
  const initialPaymentPercentage = readFiniteNumber(
    value.initialPaymentPercentage
  );
  const suretyPercentage = readFiniteNumber(value.suretyPercentage);

  if (
    !id ||
    !PLATFORMS.includes(platform as DataCreditoPolicyPlatform) ||
    !["APROBADO", "RECHAZADO"].includes(decision) ||
    scoreMin === null ||
    scoreMax === null ||
    initialPaymentPercentage === null ||
    suretyPercentage === null
  ) {
    throw new PolicyRequestError(`Banda ${index + 1} incompleta.`);
  }

  return {
    id,
    platform: platform as DataCreditoPolicyPlatform,
    scoreMin,
    scoreMax,
    decision: decision as DataCreditoPolicyDecision,
    initialPaymentPercentage,
    suretyPercentage,
  };
}

function parseSnapshot(
  payload: JsonRecord,
  response?: Response
): PolicySnapshot {
  if (payload.ok === false) {
    throw new PolicyRequestError(
      "La API rechazó la solicitud.",
      getCorrelationId(payload, response)
    );
  }

  const provider = isRecord(payload.provider) ? payload.provider : null;
  const configuredValue = provider?.configured ?? payload.configured;
  const policyValue = payload.policy;
  const policy = isRecord(policyValue) ? policyValue : null;
  const hasPolicy =
    typeof payload.hasPolicy === "boolean"
      ? payload.hasPolicy
      : policyValue !== null && policyValue !== undefined;

  if (typeof payload.enabled !== "boolean") {
    throw new PolicyRequestError(
      "La respuesta no incluye el estado de la integración.",
      getCorrelationId(payload, response)
    );
  }

  if (typeof configuredValue !== "boolean") {
    throw new PolicyRequestError(
      "La respuesta no incluye el estado del proveedor.",
      getCorrelationId(payload, response)
    );
  }

  if (!policy) {
    return {
      enabled: payload.enabled,
      configured: configuredValue,
      hasPolicy: false,
      version: null,
      createdAt: null,
      bands: [],
    };
  }

  const version = readFiniteNumber(policy.version);

  if (version === null || !Number.isInteger(version) || version < 0) {
    throw new PolicyRequestError(
      "La política no incluye una versión válida.",
      getCorrelationId(payload, response)
    );
  }

  if (!Array.isArray(policy.bands)) {
    throw new PolicyRequestError(
      "La política no incluye las bandas administrativas.",
      getCorrelationId(payload, response)
    );
  }

  return {
    enabled: payload.enabled,
    configured: configuredValue,
    hasPolicy,
    version,
    createdAt: readString(policy.createdAt),
    bands: policy.bands.map(parseBand),
  };
}

async function requestPolicy(signal?: AbortSignal) {
  const response = await fetch("/api/creditos/datacredito/politica", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new PolicyRequestError(
      "No se pudo cargar la política.",
      getCorrelationId(payload, response)
    );
  }

  return parseSnapshot(payload, response);
}

function toEditableBand(band: DataCreditoPolicyBand): EditableBand {
  return {
    id: band.id,
    platform: band.platform,
    scoreMin: String(band.scoreMin),
    scoreMax: String(band.scoreMax),
    decision: band.decision,
    initialPaymentPercentage: String(band.initialPaymentPercentage),
    suretyPercentage: String(band.suretyPercentage),
  };
}

function createDraftBand(platform: DataCreditoPolicyPlatform): EditableBand {
  draftSequence += 1;
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `draft-${Date.now()}-${draftSequence}`;

  return {
    id,
    platform,
    scoreMin: "",
    scoreMax: "",
    decision: "",
    initialPaymentPercentage: "",
    suretyPercentage: "",
  };
}

function addRowError(
  errors: Record<string, string[]>,
  bandId: string,
  message: string
) {
  errors[bandId] = [...(errors[bandId] || []), message];
}

function parseInteger(value: string) {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateDraftBands(bands: EditableBand[]): ValidationResult {
  const rowErrors: Record<string, string[]> = {};
  const platformErrors: Record<DataCreditoPolicyPlatform, string[]> = {
    ANDROID: [],
    IPHONE: [],
  };
  const canonicalBands: DataCreditoPolicyBand[] = [];
  const ids = new Set<string>();

  for (const band of bands) {
    const scoreMin = parseInteger(band.scoreMin);
    const scoreMax = parseInteger(band.scoreMax);
    const initialPaymentPercentage = readFiniteNumber(
      band.initialPaymentPercentage
    );
    const suretyPercentage = readFiniteNumber(band.suretyPercentage);

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(band.id)) {
      addRowError(
        rowErrors,
        band.id,
        "La banda no tiene un identificador estable válido."
      );
    } else if (ids.has(band.id)) {
      addRowError(rowErrors, band.id, "El identificador de la banda está repetido.");
    }
    ids.add(band.id);

    if (scoreMin === null || scoreMin < 0 || scoreMin > 950) {
      addRowError(
        rowErrors,
        band.id,
        "El puntaje mínimo debe ser un entero entre 0 y 950."
      );
    }

    if (scoreMax === null || scoreMax < 0 || scoreMax > 950) {
      addRowError(
        rowErrors,
        band.id,
        "El puntaje máximo debe ser un entero entre 0 y 950."
      );
    }

    if (scoreMin !== null && scoreMax !== null && scoreMin > scoreMax) {
      addRowError(
        rowErrors,
        band.id,
        "El puntaje mínimo no puede superar el máximo."
      );
    }

    if (!band.decision) {
      addRowError(rowErrors, band.id, "Selecciona una decisión.");
    }

    if (
      initialPaymentPercentage === null ||
      initialPaymentPercentage < 0 ||
      initialPaymentPercentage > 100
    ) {
      addRowError(
        rowErrors,
        band.id,
        "La inicial debe estar entre 0 % y 100 %."
      );
    }

    if (
      suretyPercentage === null ||
      suretyPercentage < 0 ||
      suretyPercentage > 100
    ) {
      addRowError(
        rowErrors,
        band.id,
        "La fianza debe estar entre 0 % y 100 %."
      );
    }

    if (!rowErrors[band.id]?.length) {
      canonicalBands.push({
        id: band.id,
        platform: band.platform,
        scoreMin: scoreMin as number,
        scoreMax: scoreMax as number,
        decision: band.decision as DataCreditoPolicyDecision,
        initialPaymentPercentage: initialPaymentPercentage as number,
        suretyPercentage: suretyPercentage as number,
      });
    }
  }

  for (const platform of PLATFORMS) {
    const platformDrafts = bands.filter((band) => band.platform === platform);

    if (!platformDrafts.length) {
      platformErrors[platform].push(
        `Agrega al menos una banda para ${platform === "ANDROID" ? "Android" : "iPhone"}.`
      );
      continue;
    }

    if (platformDrafts.some((band) => rowErrors[band.id]?.length)) {
      platformErrors[platform].push(
        "Corrige las bandas incompletas antes de validar la cobertura."
      );
      continue;
    }

    const sorted = canonicalBands
      .filter((band) => band.platform === platform)
      .sort((left, right) => left.scoreMin - right.scoreMin);

    if (sorted[0]?.scoreMin !== 0) {
      platformErrors[platform].push("La cobertura debe comenzar en 0.");
    }

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];

      if (current.scoreMin <= previous.scoreMax) {
        const message = `Se solapa con la banda ${previous.scoreMin}–${previous.scoreMax}.`;
        addRowError(rowErrors, current.id, message);
        platformErrors[platform].push(
          `Hay un solapamiento desde el puntaje ${current.scoreMin}.`
        );
      } else if (current.scoreMin !== previous.scoreMax + 1) {
        platformErrors[platform].push(
          `Hay un hueco entre ${previous.scoreMax} y ${current.scoreMin}.`
        );
      }
    }

    if (sorted.at(-1)?.scoreMax !== 950) {
      platformErrors[platform].push("La cobertura debe terminar en 950.");
    }
  }

  const valid =
    Object.values(rowErrors).every((errors) => errors.length === 0) &&
    PLATFORMS.every((platform) => platformErrors[platform].length === 0);

  return {
    valid,
    rowErrors,
    platformErrors,
    canonicalBands: valid
      ? canonicalBands.sort((left, right) => {
          const platformOrder =
            PLATFORMS.indexOf(left.platform) - PLATFORMS.indexOf(right.platform);
          return platformOrder || left.scoreMin - right.scoreMin;
        })
      : [],
  };
}

function formatDate(value: string | null) {
  if (!value) return "Sin fecha de publicación";
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : new Intl.DateTimeFormat("es-CO", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function platformLabel(platform: DataCreditoPolicyPlatform) {
  return platform === "ANDROID" ? "Android" : "iPhone";
}

function PolicyBandRow({
  band,
  index,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  band: EditableBand;
  index: number;
  errors: string[];
  disabled: boolean;
  onChange: (bandId: string, field: keyof EditableBand, value: string) => void;
  onRemove: (bandId: string) => void;
}) {
  const idPrefix = `datacredito-${band.platform.toLowerCase()}-${index}`;
  const errorId = `${idPrefix}-errors`;
  const invalid = errors.length > 0;

  return (
    <div
      className={`rounded-[var(--fp-radius-md)] border p-4 sm:p-5 ${
        invalid
          ? "border-[var(--fp-danger)] bg-[var(--fp-danger-soft)]"
          : "border-[var(--fp-border)] bg-[var(--fp-surface)]"
      }`}
      role="group"
      aria-label={`Banda ${index + 1} para ${platformLabel(band.platform)}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-[var(--fp-graphite)]">
            Banda {index + 1}
          </strong>
          {band.decision ? (
            <StatusPill tone={band.decision === "APROBADO" ? "positive" : "danger"}>
              {band.decision}
            </StatusPill>
          ) : (
            <StatusPill>Sin decisión</StatusPill>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={() => onRemove(band.id)}
          disabled={disabled}
          aria-label={`Quitar banda ${index + 1} de ${platformLabel(band.platform)}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Quitar</span>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Puntaje mínimo
          <Input
            id={`${idPrefix}-min`}
            type="number"
            inputMode="numeric"
            min={0}
            max={950}
            step={1}
            value={band.scoreMin}
            onChange={(event) =>
              onChange(band.id, "scoreMin", event.target.value)
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
          />
        </label>

        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Puntaje máximo
          <Input
            id={`${idPrefix}-max`}
            type="number"
            inputMode="numeric"
            min={0}
            max={950}
            step={1}
            value={band.scoreMax}
            onChange={(event) =>
              onChange(band.id, "scoreMax", event.target.value)
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
          />
        </label>

        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Decisión
          <Select
            id={`${idPrefix}-decision`}
            value={band.decision}
            onChange={(event) =>
              onChange(band.id, "decision", event.target.value)
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
          >
            <option value="">Seleccionar</option>
            <option value="APROBADO">Aprobado</option>
            <option value="RECHAZADO">Rechazado</option>
          </Select>
        </label>

        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Inicial (%)
          <Input
            id={`${idPrefix}-initial`}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.01"
            value={band.initialPaymentPercentage}
            onChange={(event) =>
              onChange(
                band.id,
                "initialPaymentPercentage",
                event.target.value
              )
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
          />
        </label>

        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Fianza (%)
          <Input
            id={`${idPrefix}-surety`}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.01"
            value={band.suretyPercentage}
            onChange={(event) =>
              onChange(band.id, "suretyPercentage", event.target.value)
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
          />
        </label>
      </div>

      {invalid ? (
        <ul
          id={errorId}
          className="mt-4 list-disc space-y-1 pl-5 text-sm font-semibold text-[var(--fp-danger)]"
          role="alert"
        >
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PlatformEditor({
  platform,
  bands,
  errors,
  rowErrors,
  disabled,
  onAdd,
  onChange,
  onRemove,
}: {
  platform: DataCreditoPolicyPlatform;
  bands: EditableBand[];
  errors: string[];
  rowErrors: Record<string, string[]>;
  disabled: boolean;
  onAdd: (platform: DataCreditoPolicyPlatform) => void;
  onChange: (bandId: string, field: keyof EditableBand, value: string) => void;
  onRemove: (bandId: string) => void;
}) {
  const titleId = `datacredito-${platform.toLowerCase()}-policy-title`;

  return (
    <Card className="p-5 sm:p-6" aria-labelledby={titleId}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-navy)] text-white"
            aria-hidden="true"
          >
            <Smartphone className="h-5 w-5" />
          </span>
          <div>
            <h2
              id={titleId}
              className="text-xl font-black text-[var(--fp-graphite)]"
            >
              Bandas {platformLabel(platform)}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
              Rangos inclusivos. La cobertura debe ser continua de 0 a 950.
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={() => onAdd(platform)}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Agregar banda
        </Button>
      </div>

      {errors.length ? (
        <ul
          className="mt-5 list-disc space-y-1 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-5 py-4 text-sm font-semibold text-[var(--fp-amber)]"
          role="alert"
        >
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 space-y-4">
        {bands.length ? (
          bands.map((band, index) => (
            <PolicyBandRow
              key={band.id}
              band={band}
              index={index}
              errors={rowErrors[band.id] || []}
              disabled={disabled}
              onChange={onChange}
              onRemove={onRemove}
            />
          ))
        ) : (
          <EmptyState
            title={`Sin bandas para ${platformLabel(platform)}`}
            description="Agrega los rangos manualmente. No se aplican umbrales ni porcentajes predeterminados."
            action={
              <Button
                variant="secondary"
                onClick={() => onAdd(platform)}
                disabled={disabled}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Crear primera banda
              </Button>
            }
          />
        )}
      </div>
    </Card>
  );
}

export default function DatacreditoPolicyConsole() {
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [hasPolicy, setHasPolicy] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [bands, setBands] = useState<EditableBand[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const validation = useMemo(() => validateDraftBands(bands), [bands]);

  const applySnapshot = useCallback((snapshot: PolicySnapshot) => {
    setEnabled(snapshot.enabled);
    setConfigured(snapshot.configured);
    setHasPolicy(snapshot.hasPolicy);
    setVersion(snapshot.version);
    setCreatedAt(snapshot.createdAt);
    setBands(snapshot.bands.map(toEditableBand));
    setHasUnsavedChanges(false);
  }, []);

  const loadPolicy = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      setCorrelationId(null);
      setNotice(null);

      try {
        const snapshot = await requestPolicy(signal);
        applySnapshot(snapshot);
      } catch (requestError) {
        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }

        setError("No se pudo cargar la política de DataCrédito.");
        setCorrelationId(
          requestError instanceof PolicyRequestError
            ? requestError.correlationId
            : null
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applySnapshot]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPolicy(controller.signal);
    return () => controller.abort();
  }, [loadPolicy]);

  const requestReload = () => {
    if (hasUnsavedChanges) {
      setReloadConfirmOpen(true);
      return;
    }

    void loadPolicy();
  };

  const addBand = (platform: DataCreditoPolicyPlatform) => {
    setNotice(null);
    setHasUnsavedChanges(true);
    setBands((current) => [...current, createDraftBand(platform)]);
  };

  const updateBand = (
    bandId: string,
    field: keyof EditableBand,
    value: string
  ) => {
    setNotice(null);
    setHasUnsavedChanges(true);
    setBands((current) =>
      current.map((band) =>
        band.id === bandId ? { ...band, [field]: value } : band
      )
    );
  };

  const removeBand = (bandId: string) => {
    setNotice(null);
    setHasUnsavedChanges(true);
    setBands((current) => current.filter((band) => band.id !== bandId));
  };

  const openSaveConfirmation = () => {
    setNotice(null);
    setError(null);

    if (!validation.valid) return;
    setConfirmOpen(true);
  };

  const savePolicy = async () => {
    if (!validation.valid || saving) return;

    setSaving(true);
    setError(null);
    setCorrelationId(null);

    const body: DataCreditoPolicyPatch = {
      expectedVersion: version,
      bands: validation.canonicalBands,
    };

    try {
      const response = await fetch("/api/creditos/datacredito/politica", {
        method: "PATCH",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);

      if (!response.ok || payload.ok === false) {
        const code = String(payload.code || "").trim().toUpperCase();
        if (code === "POLICY_VERSION_CONFLICT") {
          const currentVersion = readFiniteNumber(payload.currentVersion);
          throw new PolicyRequestError(
            currentVersion === null
              ? "Otra persona modificó la política. Recargar te pedirá confirmar antes de reemplazar tu borrador con la versión vigente."
              : "Otra persona ya publicó la versión " +
                  currentVersion +
                  ". Recargar te pedirá confirmar antes de reemplazar tu borrador con la política vigente.",
            getCorrelationId(payload, response)
          );
        }

        throw new PolicyRequestError(
          "No se pudo guardar la política.",
          getCorrelationId(payload, response)
        );
      }

      let snapshot: PolicySnapshot;

      try {
        snapshot = parseSnapshot(payload, response);
      } catch {
        snapshot = await requestPolicy();
      }

      applySnapshot(snapshot);
      setConfirmOpen(false);
      setNotice(`Política guardada en la versión ${snapshot.version ?? "nueva"}.`);
    } catch (requestError) {
      setConfirmOpen(false);
      if (requestError instanceof PolicyRequestError) {
        setError(requestError.message);
        setCorrelationId(requestError.correlationId);
        return;
      }

      setError("No se pudo guardar la política de DataCrédito.");
      setCorrelationId(
        requestError instanceof PolicyRequestError
          ? requestError.correlationId
          : null
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-5 sm:p-6" aria-busy="true">
        <LoadingState label="Cargando política de DataCrédito..." />
      </Card>
    );
  }

  if (error && !version && !bands.length) {
    return (
      <Card className="border-[var(--fp-danger)] p-6" role="alert">
        <div className="flex items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]"
            aria-hidden="true"
          >
            <CircleAlert className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-xl font-black text-[var(--fp-graphite)]">
              {error}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
              No se realizaron cambios en la configuración.
            </p>
            {correlationId ? (
              <p className="mt-2 break-all text-xs text-[var(--fp-muted)]">
                Código de seguimiento: <code>{correlationId}</code>
              </p>
            ) : null}
          </div>
        </div>
        <Button
          className="mt-6"
          variant="secondary"
          onClick={() => void loadPolicy()}
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Intentar de nuevo
        </Button>
      </Card>
    );
  }

  const androidBands = bands.filter((band) => band.platform === "ANDROID");
  const iphoneBands = bands.filter((band) => band.platform === "IPHONE");

  return (
    <section
      className="space-y-6 text-[var(--fp-graphite)]"
      aria-labelledby="datacredito-policy-title"
    >
      <header className="flex flex-col gap-5 border-b border-[var(--fp-border)] pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-[var(--fp-muted)]">
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            Riesgo crediticio
          </div>
          <h2
            id="datacredito-policy-title"
            className="mt-2 text-3xl font-black tracking-tight sm:text-4xl"
          >
            Política DataCrédito
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
            Define la decisión, la cuota inicial y la fianza por rango de puntaje
            para cada plataforma. El puntaje nunca se muestra en el flujo del
            asesor.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={requestReload}
          disabled={saving}
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Recargar
        </Button>
      </header>

      <Card className="p-5 sm:p-6">
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Integración
            </p>
            <div className="mt-2">
              <StatusPill tone={enabled ? "positive" : "warning"}>
                {enabled ? "Habilitada" : "Deshabilitada"}
              </StatusPill>
            </div>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Proveedor
            </p>
            <div className="mt-2">
              <StatusPill tone={configured ? "positive" : "warning"}>
                {configured ? "Configurado" : "Sin configurar"}
              </StatusPill>
            </div>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Política
            </p>
            <p className="mt-2 text-lg font-black">
              {hasPolicy && version !== null ? `Versión ${version}` : "Sin publicar"}
            </p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Publicación
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--fp-muted)]">
              {formatDate(createdAt)}
            </p>
          </div>
        </div>

        {!enabled ? (
          <p className="mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-3 text-sm leading-6 text-[var(--fp-amber)]">
            El feature flag está deshabilitado en este ambiente. Su estado es de
            solo lectura y se administra mediante configuración segura del
            servidor.
          </p>
        ) : null}
      </Card>

      {notice ? (
        <div
          className="rounded-[var(--fp-radius-md)] border border-[#c9df91] bg-[var(--fp-lime-soft)] px-4 py-3 text-sm font-bold text-[#4f6f0c]"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm text-[var(--fp-danger)]"
          role="alert"
        >
          <strong>{error}</strong>
          {correlationId ? (
            <span className="mt-1 block break-all text-xs">
              Código de seguimiento: <code>{correlationId}</code>
            </span>
          ) : null}
        </div>
      ) : null}

      <PlatformEditor
        platform="ANDROID"
        bands={androidBands}
        errors={validation.platformErrors.ANDROID}
        rowErrors={validation.rowErrors}
        disabled={saving}
        onAdd={addBand}
        onChange={updateBand}
        onRemove={removeBand}
      />

      <PlatformEditor
        platform="IPHONE"
        bands={iphoneBands}
        errors={validation.platformErrors.IPHONE}
        rowErrors={validation.rowErrors}
        disabled={saving}
        onAdd={addBand}
        onChange={updateBand}
        onRemove={removeBand}
      />

      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={validation.valid ? "positive" : "warning"}>
                {validation.valid ? "Cobertura completa" : "Política incompleta"}
              </Badge>
              <span className="text-sm font-semibold text-[var(--fp-muted)]">
                {bands.length} {bands.length === 1 ? "banda" : "bandas"}
              </span>
            </div>
            <p
              id="datacredito-policy-save-help"
              className="mt-3 max-w-2xl text-sm leading-6 text-[var(--fp-muted)]"
            >
              {validation.valid
                ? "La política cubre todos los puntajes enteros de 0 a 950 sin huecos ni solapamientos para Android e iPhone."
                : "Completa y corrige ambas plataformas. Guardar permanecerá deshabilitado mientras existan huecos, solapamientos o valores inválidos."}
            </p>
          </div>
          <Button
            onClick={openSaveConfirmation}
            disabled={saving || !validation.valid}
            aria-describedby="datacredito-policy-save-help"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {saving ? "Guardando..." : "Guardar política"}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        title="Publicar política de evaluación"
        description={`Se guardarán ${validation.canonicalBands.length} bandas para Android e iPhone. La API verificará la versión ${
          version ?? "inicial"
        } antes de aplicar los cambios.`}
        confirmLabel="Guardar política"
        busy={saving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void savePolicy()}
      />

      <ConfirmDialog
        open={reloadConfirmOpen}
        title="Descartar cambios y recargar"
        description="La versión vigente reemplazará todas las bandas editadas en este borrador. Esta acción no se puede deshacer."
        confirmLabel="Descartar y recargar"
        onCancel={() => setReloadConfirmOpen(false)}
        onConfirm={() => {
          setReloadConfirmOpen(false);
          void loadPolicy();
        }}
      />
    </section>
  );
}
