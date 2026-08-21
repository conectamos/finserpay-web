"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  Copy,
  Plus,
  RotateCw,
  Save,
  Settings2,
  Smartphone,
  Trash2,
  Users,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  DATACREDITO_MAX_SCORE,
  DATACREDITO_MIN_SCORE,
  DATACREDITO_NO_INFORMATION_SCORE,
} from "@/lib/datacredito/policy";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
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
  maxFinancedAmount: number;
};

export type DataCreditoPolicyProfile = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  version: number;
  bands: DataCreditoPolicyBand[];
  createdAt: string | null;
  updatedAt: string | null;
  revisionCreatedAt: string | null;
  assignedAlliesCount: number;
};

export type DataCreditoPolicyAlly = {
  id: number;
  name: string;
  code: string | null;
  active: boolean;
  policyId: string;
  policyName: string;
};

type PolicyCatalogSnapshot = {
  defaultPolicyId: string | null;
  profiles: DataCreditoPolicyProfile[];
  allies: DataCreditoPolicyAlly[];
  provider: {
    enabled: boolean;
    configured: boolean;
    environment: string | null;
    productionReady: boolean;
  };
};

type EditableBand = {
  id: string;
  platform: DataCreditoPolicyPlatform;
  scoreMin: string;
  scoreMax: string;
  decision: DataCreditoPolicyDecision | "";
  initialPaymentPercentage: string;
  suretyPercentage: string;
  maxFinancedAmount: string;
};

type ValidationResult = {
  valid: boolean;
  rowErrors: Record<string, string[]>;
  platformErrors: Record<DataCreditoPolicyPlatform, string[]>;
  canonicalBands: DataCreditoPolicyBand[];
};

type AssignmentChange = {
  ally: DataCreditoPolicyAlly;
  policyId: string;
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
const MIN_NUMERIC_SCORE = DATACREDITO_MIN_SCORE;
const MAX_NUMERIC_SCORE = DATACREDITO_MAX_SCORE;
const MAX_FINANCED_AMOUNT_COP = 100_000_000;
let draftSequence = 0;

function isNoInformationBand(
  band: Pick<DataCreditoPolicyBand, "scoreMin" | "scoreMax"> | EditableBand
) {
  const scoreMin =
    typeof band.scoreMin === "number"
      ? band.scoreMin
      : parseInteger(band.scoreMin);
  const scoreMax =
    typeof band.scoreMax === "number"
      ? band.scoreMax
      : parseInteger(band.scoreMax);

  return (
    scoreMin === DATACREDITO_NO_INFORMATION_SCORE &&
    scoreMax === DATACREDITO_NO_INFORMATION_SCORE
  );
}

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
  const maxFinancedAmount = readFiniteNumber(value.maxFinancedAmount);

  if (
    !id ||
    !PLATFORMS.includes(platform as DataCreditoPolicyPlatform) ||
    !["APROBADO", "RECHAZADO"].includes(decision) ||
    scoreMin === null ||
    scoreMax === null ||
    initialPaymentPercentage === null ||
    suretyPercentage === null ||
    maxFinancedAmount === null
  ) {
    throw new PolicyRequestError(`Banda ${index + 1} incompleta.`);
  }

  if (
    !Number.isInteger(maxFinancedAmount) ||
    maxFinancedAmount <= 0 ||
    maxFinancedAmount > MAX_FINANCED_AMOUNT_COP
  ) {
    throw new PolicyRequestError(
      `Banda ${index + 1} con crédito máximo inválido.`
    );
  }

  return {
    id,
    platform: platform as DataCreditoPolicyPlatform,
    scoreMin,
    scoreMax,
    decision: decision as DataCreditoPolicyDecision,
    initialPaymentPercentage,
    suretyPercentage,
    maxFinancedAmount,
  };
}

function parsePolicyProfile(
  value: unknown,
  index: number
): DataCreditoPolicyProfile {
  if (!isRecord(value)) {
    throw new PolicyRequestError(`Política ${index + 1} inválida.`);
  }

  const id = readString(value.id);
  const name = readString(value.name);
  const version = readFiniteNumber(value.version);
  const assignedAlliesCount = readFiniteNumber(value.assignedAlliesCount);

  if (
    !id ||
    !name ||
    typeof value.active !== "boolean" ||
    version === null ||
    !Number.isInteger(version) ||
    version < 1 ||
    assignedAlliesCount === null ||
    !Number.isInteger(assignedAlliesCount) ||
    assignedAlliesCount < 0 ||
    !Array.isArray(value.bands)
  ) {
    throw new PolicyRequestError(`Política ${index + 1} incompleta.`);
  }

  return {
    id,
    name,
    description: readString(value.description),
    active: value.active,
    version,
    bands: value.bands.map(parseBand),
    createdAt: readString(value.createdAt),
    updatedAt: readString(value.updatedAt),
    revisionCreatedAt: readString(value.revisionCreatedAt),
    assignedAlliesCount,
  };
}

function parsePolicyAlly(value: unknown, index: number): DataCreditoPolicyAlly {
  if (!isRecord(value)) {
    throw new PolicyRequestError(`Aliado ${index + 1} inválido.`);
  }

  const id = readFiniteNumber(value.id);
  const name = readString(value.name);
  const code = readString(value.code);
  const policyId = readString(value.policyId);
  const policyName = readString(value.policyName);

  if (
    id === null ||
    !Number.isInteger(id) ||
    id < 1 ||
    !name ||
    !policyId ||
    !policyName ||
    typeof value.active !== "boolean"
  ) {
    throw new PolicyRequestError(`Aliado ${index + 1} incompleto.`);
  }

  return {
    id,
    name,
    code,
    active: value.active,
    policyId,
    policyName,
  };
}

function parseCatalog(
  payload: JsonRecord,
  response?: Response
): PolicyCatalogSnapshot {
  if (payload.ok === false) {
    throw new PolicyRequestError(
      readString(payload.error) || "La API rechazó la solicitud.",
      getCorrelationId(payload, response)
    );
  }

  const provider = isRecord(payload.provider) ? payload.provider : null;
  if (
    !provider ||
    typeof provider.enabled !== "boolean" ||
    typeof provider.configured !== "boolean" ||
    typeof provider.productionReady !== "boolean" ||
    !Array.isArray(payload.profiles) ||
    !Array.isArray(payload.allies)
  ) {
    throw new PolicyRequestError(
      "La respuesta no incluye el catálogo administrativo completo.",
      getCorrelationId(payload, response)
    );
  }

  return {
    defaultPolicyId: readString(payload.defaultPolicyId),
    profiles: payload.profiles.map(parsePolicyProfile),
    allies: payload.allies.map(parsePolicyAlly),
    provider: {
      enabled: provider.enabled,
      configured: provider.configured,
      environment: readString(provider.environment),
      productionReady: provider.productionReady,
    },
  };
}

async function requestCatalog(signal?: AbortSignal) {
  const response = await fetch("/api/creditos/datacredito/politicas", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new PolicyRequestError(
      readString(payload.error) || "No se pudo cargar el catálogo de políticas.",
      getCorrelationId(payload, response)
    );
  }

  return parseCatalog(payload, response);
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
    maxFinancedAmount: String(band.maxFinancedAmount),
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
    maxFinancedAmount: "",
  };
}

function createNoInformationDraftBand(
  platform: DataCreditoPolicyPlatform
): EditableBand {
  return {
    ...createDraftBand(platform),
    scoreMin: String(DATACREDITO_NO_INFORMATION_SCORE),
    scoreMax: String(DATACREDITO_NO_INFORMATION_SCORE),
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
  if (!/^-?\d+$/.test(value.trim())) return null;
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
    const noInformation =
      scoreMin === DATACREDITO_NO_INFORMATION_SCORE &&
      scoreMax === DATACREDITO_NO_INFORMATION_SCORE;
    const initialPaymentPercentage = readFiniteNumber(
      band.initialPaymentPercentage
    );
    const suretyPercentage = readFiniteNumber(band.suretyPercentage);
    const maxFinancedAmount = parseInteger(band.maxFinancedAmount);

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

    if (!noInformation) {
      if (
        (scoreMin !== null && scoreMin < MIN_NUMERIC_SCORE) ||
        (scoreMax !== null && scoreMax < MIN_NUMERIC_SCORE)
      ) {
        addRowError(
          rowErrors,
          band.id,
          "Los rangos solo admiten puntajes de 0 a 950. La regla Sin información no sustituye un puntaje inválido."
        );
      } else {
        if (
          scoreMin === null ||
          scoreMin < MIN_NUMERIC_SCORE ||
          scoreMin > MAX_NUMERIC_SCORE
        ) {
          addRowError(
            rowErrors,
            band.id,
            "El puntaje mínimo debe ser un entero entre 0 y 950."
          );
        }

        if (
          scoreMax === null ||
          scoreMax < MIN_NUMERIC_SCORE ||
          scoreMax > MAX_NUMERIC_SCORE
        ) {
          addRowError(
            rowErrors,
            band.id,
            "El puntaje máximo debe ser un entero entre 0 y 950."
          );
        }
      }

      if (scoreMin !== null && scoreMax !== null && scoreMin > scoreMax) {
        addRowError(
          rowErrors,
          band.id,
          "El puntaje mínimo no puede superar el máximo."
        );
      }
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

    if (
      maxFinancedAmount === null ||
      maxFinancedAmount <= 0 ||
      maxFinancedAmount > MAX_FINANCED_AMOUNT_COP
    ) {
      addRowError(
        rowErrors,
        band.id,
        "El crédito máximo debe ser un entero entre $1 y $100.000.000 COP."
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
        maxFinancedAmount: maxFinancedAmount as number,
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

    const noInformationDrafts = platformDrafts.filter(isNoInformationBand);
    if (noInformationDrafts.length === 0) {
      platformErrors[platform].push(
        `Agrega la regla Sin información para ${platformLabel(platform)}.`
      );
    } else if (noInformationDrafts.length > 1) {
      const message = `Debe existir una sola regla Sin información para ${platformLabel(platform)}.`;
      platformErrors[platform].push(message);
      for (const band of noInformationDrafts) {
        addRowError(rowErrors, band.id, message);
      }
    }

    if (platformDrafts.some((band) => rowErrors[band.id]?.length)) {
      platformErrors[platform].push(
        "Corrige las bandas incompletas antes de validar la cobertura."
      );
      continue;
    }

    const sorted = canonicalBands
      .filter(
        (band) => band.platform === platform && !isNoInformationBand(band)
      )
      .sort((left, right) => left.scoreMin - right.scoreMin);

    if (sorted[0]?.scoreMin !== MIN_NUMERIC_SCORE) {
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

    if (sorted.at(-1)?.scoreMax !== MAX_NUMERIC_SCORE) {
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

function focusPolicyBandEditor(bandId: string) {
  window.requestAnimationFrame(() => {
    document.getElementById(`datacredito-policy-band-${bandId}`)?.focus();
  });
}

function PolicyBandRow({
  band,
  index,
  bandNumber,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  band: EditableBand;
  index: number;
  bandNumber: number | null;
  errors: string[];
  disabled: boolean;
  onChange: (bandId: string, field: keyof EditableBand, value: string) => void;
  onRemove: (bandId: string) => void;
}) {
  const idPrefix = `datacredito-${band.platform.toLowerCase()}-${index}`;
  const errorId = `${idPrefix}-errors`;
  const rangeDescriptionId = `${idPrefix}-range-description`;
  const maxFinancedDescriptionId = `${idPrefix}-max-financed-description`;
  const invalid = errors.length > 0;
  const noInformation = isNoInformationBand(band);
  const rowLabel = noInformation
    ? "Sin información"
    : `Banda ${bandNumber ?? index + 1}`;
  const rangeDescriptionIds = [
    noInformation ? rangeDescriptionId : null,
    invalid ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;
  const maxFinancedDescriptionIds = [
    maxFinancedDescriptionId,
    invalid ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      id={`datacredito-policy-band-${band.id}`}
      className={`rounded-[var(--fp-radius-md)] border p-4 focus:outline-none focus:ring-2 focus:ring-[var(--fp-lime)] focus:ring-offset-2 sm:p-5 ${
        invalid
          ? "border-[var(--fp-danger)] bg-[var(--fp-danger-soft)]"
          : "border-[var(--fp-border)] bg-[var(--fp-surface)]"
      }`}
      tabIndex={-1}
      role="group"
      aria-label={`${rowLabel} para ${platformLabel(band.platform)}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-[var(--fp-graphite)]">
            {rowLabel}
          </strong>
          {noInformation ? <Badge>Regla especial</Badge> : null}
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
          aria-label={`Quitar ${rowLabel.toLowerCase()} de ${platformLabel(band.platform)}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Quitar</span>
        </Button>
      </div>

      {noInformation ? (
        <p
          id={rangeDescriptionId}
          className="mb-4 text-sm leading-6 text-[var(--fp-muted)]"
        >
          Se aplica únicamente cuando Experian responde explícitamente que no
          hay información para el titular. No cubre puntajes inválidos ni
          respuestas técnicas incompletas.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {noInformation ? (
          <>
            <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
              Puntaje mínimo
              <Input
                id={`${idPrefix}-min`}
                type="text"
                value="No aplica"
                readOnly
                disabled={disabled}
                className="bg-[var(--fp-bg)] text-[var(--fp-muted)]"
                aria-readonly="true"
                aria-describedby={rangeDescriptionIds}
              />
            </label>

            <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
              Puntaje máximo
              <Input
                id={`${idPrefix}-max`}
                type="text"
                value="No aplica"
                readOnly
                disabled={disabled}
                className="bg-[var(--fp-bg)] text-[var(--fp-muted)]"
                aria-readonly="true"
                aria-describedby={rangeDescriptionIds}
              />
            </label>
          </>
        ) : (
          <>
            <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
              Puntaje mínimo
              <Input
                id={`${idPrefix}-min`}
                type="number"
                inputMode="numeric"
                min={MIN_NUMERIC_SCORE}
                max={MAX_NUMERIC_SCORE}
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
                min={MIN_NUMERIC_SCORE}
                max={MAX_NUMERIC_SCORE}
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
          </>
        )}

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

        <label className="grid gap-2 text-sm font-bold text-[var(--fp-graphite)]">
          Crédito máximo
          <Input
            id={`${idPrefix}-max-financed`}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_FINANCED_AMOUNT_COP}
            step={1}
            value={band.maxFinancedAmount}
            onChange={(event) =>
              onChange(band.id, "maxFinancedAmount", event.target.value)
            }
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={maxFinancedDescriptionIds}
          />
          <span
            id={maxFinancedDescriptionId}
            className="text-xs font-normal leading-5 text-[var(--fp-muted)]"
          >
            Valor entero en COP, hasta $100.000.000.
          </span>
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
  onAddNoInformation,
  onChange,
  onRemove,
}: {
  platform: DataCreditoPolicyPlatform;
  bands: EditableBand[];
  errors: string[];
  rowErrors: Record<string, string[]>;
  disabled: boolean;
  onAdd: (platform: DataCreditoPolicyPlatform) => void;
  onAddNoInformation: (platform: DataCreditoPolicyPlatform) => void;
  onChange: (bandId: string, field: keyof EditableBand, value: string) => void;
  onRemove: (bandId: string) => void;
}) {
  const titleId = `datacredito-${platform.toLowerCase()}-policy-title`;
  const noInformationBand = bands.find(isNoInformationBand);
  const hasNoInformation = Boolean(noInformationBand);
  const noInformationPending = Boolean(
    noInformationBand && rowErrors[noInformationBand.id]?.length
  );

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
              Rangos inclusivos con cobertura continua de 0 a 950. Debe existir
              una regla adicional para Sin información.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasNoInformation ? (
            <StatusPill tone={noInformationPending ? "neutral" : "positive"}>
              {noInformationPending
                ? "Sin información pendiente"
                : "Sin información configurada"}
            </StatusPill>
          ) : (
            <Button
              variant="secondary"
              onClick={() => onAddNoInformation(platform)}
              disabled={disabled}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Agregar Sin información
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onAdd(platform)}
            disabled={disabled}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Agregar banda
          </Button>
        </div>
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
              bandNumber={
                isNoInformationBand(band)
                  ? null
                  : bands
                      .slice(0, index + 1)
                      .filter((candidate) => !isNoInformationBand(candidate))
                      .length
              }
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

type PolicyConsoleTab = "POLICIES" | "ASSIGNMENTS";

function allyDraftKey(allyId: number) {
  return String(allyId);
}

export default function DatacreditoPolicyConsole() {
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [productionReady, setProductionReady] = useState(false);
  const [providerEnvironment, setProviderEnvironment] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<DataCreditoPolicyProfile[]>([]);
  const [allies, setAllies] = useState<DataCreditoPolicyAlly[]>([]);
  const [defaultPolicyId, setDefaultPolicyId] = useState<string | null>(null);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [bands, setBands] = useState<EditableBand[]>([]);
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<PolicyConsoleTab>("POLICIES");
  const [assignmentQuery, setAssignmentQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [assignmentConfirmOpen, setAssignmentConfirmOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const [pendingPolicyId, setPendingPolicyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPolicyName, setNewPolicyName] = useState("");
  const [newPolicyDescription, setNewPolicyDescription] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const validation = useMemo(() => validateDraftBands(bands), [bands]);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedPolicyId) || null,
    [profiles, selectedPolicyId]
  );
  const assignmentChanges = useMemo<AssignmentChange[]>(
    () =>
      allies.flatMap((ally) => {
        const policyId = assignmentDrafts[allyDraftKey(ally.id)];
        return policyId && policyId !== ally.policyId ? [{ ally, policyId }] : [];
      }),
    [allies, assignmentDrafts]
  );
  const hasPendingChanges = hasUnsavedChanges || assignmentChanges.length > 0;
  const filteredAllies = useMemo(() => {
    const query = assignmentQuery.trim().toLocaleLowerCase("es-CO");
    if (!query) return allies;

    return allies.filter((ally) =>
      [ally.name, ally.code || "", ally.policyName].some((value) =>
        value.toLocaleLowerCase("es-CO").includes(query)
      )
    );
  }, [allies, assignmentQuery]);

  const applyProfile = useCallback((profile: DataCreditoPolicyProfile | null) => {
    setSelectedPolicyId(profile?.id || null);
    setVersion(profile?.version ?? null);
    setUpdatedAt(profile?.revisionCreatedAt ?? profile?.updatedAt ?? null);
    setBands((profile?.bands || []).map(toEditableBand));
    setHasUnsavedChanges(false);
  }, []);

  const applyCatalog = useCallback(
    (
      catalog: PolicyCatalogSnapshot,
      preferredPolicyId?: string | null,
      preservePolicyDraft = false,
      preserveAssignmentDrafts = false,
      confirmedAllyIds: number[] = []
    ) => {
      setEnabled(catalog.provider.enabled);
      setConfigured(catalog.provider.configured);
      setProductionReady(catalog.provider.productionReady);
      setProviderEnvironment(catalog.provider.environment);
      setProfiles(catalog.profiles);
      setAllies(catalog.allies);
      setDefaultPolicyId(catalog.defaultPolicyId);
      const freshAssignmentDrafts = Object.fromEntries(
        catalog.allies.map((ally) => [allyDraftKey(ally.id), ally.policyId])
      );
      const availablePolicyIds = new Set(
        catalog.profiles.map((profile) => profile.id)
      );
      const confirmedAllyIdSet = new Set(confirmedAllyIds);
      setAssignmentDrafts((current) => {
        if (!preserveAssignmentDrafts) return freshAssignmentDrafts;

        const next = { ...freshAssignmentDrafts };
        for (const ally of catalog.allies) {
          if (confirmedAllyIdSet.has(ally.id)) continue;
          const key = allyDraftKey(ally.id);
          const pendingPolicyId = current[key];
          if (pendingPolicyId && availablePolicyIds.has(pendingPolicyId)) {
            next[key] = pendingPolicyId;
          }
        }
        return next;
      });

      const nextProfile =
        catalog.profiles.find((profile) => profile.id === preferredPolicyId) ||
        catalog.profiles.find((profile) => profile.id === catalog.defaultPolicyId) ||
        catalog.profiles[0] ||
        null;

      if (!preservePolicyDraft || !nextProfile) {
        applyProfile(nextProfile);
      }
    },
    [applyProfile]
  );

  const loadCatalog = useCallback(
    async (signal?: AbortSignal, preferredPolicyId?: string | null) => {
      setLoading(true);
      setError(null);
      setCorrelationId(null);
      setNotice(null);

      try {
        const catalog = await requestCatalog(signal);
        applyCatalog(catalog, preferredPolicyId);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          return;
        }

        setError(
          requestError instanceof PolicyRequestError
            ? requestError.message
            : "No se pudo cargar el catálogo de políticas de DataCrédito."
        );
        setCorrelationId(
          requestError instanceof PolicyRequestError ? requestError.correlationId : null
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applyCatalog]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [loadCatalog]);

  useEffect(() => {
    if (!hasPendingChanges) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingChanges]);

  const selectProfile = (policyId: string) => {
    const profile = profiles.find((candidate) => candidate.id === policyId);
    if (!profile) return;
    setNotice(null);
    setError(null);
    applyProfile(profile);
  };

  const requestProfileSelection = (policyId: string) => {
    if (policyId === selectedPolicyId) return;
    if (hasUnsavedChanges) {
      setPendingPolicyId(policyId);
      setSwitchConfirmOpen(true);
      return;
    }

    selectProfile(policyId);
  };

  const requestReload = () => {
    if (hasPendingChanges) {
      setReloadConfirmOpen(true);
      return;
    }

    void loadCatalog(undefined, selectedPolicyId);
  };

  const addBand = (platform: DataCreditoPolicyPlatform) => {
    const nextBand = createDraftBand(platform);
    setNotice(`Nueva banda agregada para ${platformLabel(platform)}.`);
    setHasUnsavedChanges(true);
    setBands((current) => [...current, nextBand]);
    focusPolicyBandEditor(nextBand.id);
  };

  const addNoInformationBand = (platform: DataCreditoPolicyPlatform) => {
    if (
      bands.some(
        (band) => band.platform === platform && isNoInformationBand(band)
      )
    ) {
      return;
    }

    const nextBand = createNoInformationDraftBand(platform);
    setNotice(
      `Regla Sin información agregada para ${platformLabel(platform)}. Completa la decisión y las condiciones financieras.`
    );
    setHasUnsavedChanges(true);
    setBands((current) => {
      if (
        current.some(
          (band) => band.platform === platform && isNoInformationBand(band)
        )
      ) {
        return current;
      }

      return [...current, nextBand];
    });
    focusPolicyBandEditor(nextBand.id);
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

    if (!validation.valid || !selectedProfile) return;
    if (!hasUnsavedChanges) {
      setNotice("No hay cambios pendientes por publicar.");
      return;
    }
    setConfirmOpen(true);
  };

  const savePolicy = async () => {
    if (
      !validation.valid ||
      !selectedProfile ||
      version === null ||
      saving
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    setCorrelationId(null);

    try {
      const response = await fetch("/api/creditos/datacredito/politicas", {
        method: "PATCH",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "SAVE_REVISION",
          policyId: selectedProfile.id,
          expectedVersion: version,
          bands: validation.canonicalBands,
        }),
      });
      const payload = await readJson(response);

      if (!response.ok || payload.ok === false) {
        const code = String(payload.code || "").trim().toUpperCase();
        if (code === "POLICY_VERSION_CONFLICT") {
          const currentVersion = readFiniteNumber(payload.currentVersion);
          throw new PolicyRequestError(
            currentVersion === null
              ? "Otra persona publicó una revisión. Recarga antes de volver a guardar."
              : `Otra persona ya publicó la versión ${currentVersion}. Recarga antes de volver a guardar.`,
            getCorrelationId(payload, response)
          );
        }

        throw new PolicyRequestError(
          readString(payload.error) || "No se pudo publicar la nueva versión.",
          getCorrelationId(payload, response)
        );
      }

      const catalog = parseCatalog(payload, response);
      const updatedProfile = catalog.profiles.find(
        (profile) => profile.id === selectedProfile.id
      );
      applyCatalog(catalog, selectedProfile.id, false, true);
      setConfirmOpen(false);
      setNotice(
        `Nueva revisión publicada${
          updatedProfile ? `: versión ${updatedProfile.version}` : ""
        }. Solo se aplicará a consultas futuras.`
      );
    } catch (requestError) {
      setConfirmOpen(false);
      setError(
        requestError instanceof PolicyRequestError
          ? requestError.message
          : "No se pudo publicar la política de DataCrédito."
      );
      setCorrelationId(
        requestError instanceof PolicyRequestError
          ? requestError.correlationId
          : null
      );
    } finally {
      setSaving(false);
    }
  };

  const openCreatePolicy = () => {
    if (!selectedProfile) return;
    if (hasUnsavedChanges) {
      setNotice(
        "Publica los cambios o recarga para descartarlos antes de duplicar la última versión publicada."
      );
      return;
    }
    setNewPolicyName(`Copia de ${selectedProfile.name}`.slice(0, 80));
    setNewPolicyDescription("");
    setCreateOpen(true);
    setError(null);
    setNotice(null);
  };

  const createPolicy = async () => {
    if (!selectedProfile || creating) return;
    if (hasUnsavedChanges) {
      setError(
        "Publica o descarta el borrador antes de duplicar la última versión publicada."
      );
      return;
    }

    const name = newPolicyName.trim();
    const description = newPolicyDescription.trim();
    if (name.length < 3) {
      setError("Escribe un nombre de al menos 3 caracteres para la política.");
      return;
    }

    setCreating(true);
    setError(null);
    setCorrelationId(null);

    try {
      const response = await fetch("/api/creditos/datacredito/politicas", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          description: description || undefined,
          bands: selectedProfile.bands,
        }),
      });
      const payload = await readJson(response);

      if (!response.ok || payload.ok === false) {
        throw new PolicyRequestError(
          readString(payload.error) || "No se pudo crear la política.",
          getCorrelationId(payload, response)
        );
      }

      const catalog = parseCatalog(payload, response);
      const createdPolicyId =
        readString(payload.createdPolicyId) ||
        catalog.profiles.find(
          (profile) =>
            profile.name.toLocaleLowerCase("es-CO") ===
            name.toLocaleLowerCase("es-CO")
        )?.id ||
        null;

      applyCatalog(catalog, createdPolicyId, false, true);
      setCreateOpen(false);
      setNewPolicyName("");
      setNewPolicyDescription("");
      setNotice(
        `Política “${name}” creada como versión 1 a partir de “${selectedProfile.name}”. Aún no cambia ningún aliado.`
      );
    } catch (requestError) {
      setError(
        requestError instanceof PolicyRequestError
          ? requestError.message
          : "No se pudo crear la política de DataCrédito."
      );
      setCorrelationId(
        requestError instanceof PolicyRequestError
          ? requestError.correlationId
          : null
      );
    } finally {
      setCreating(false);
    }
  };

  const openAssignmentConfirmation = () => {
    setNotice(null);
    setError(null);
    if (!assignmentChanges.length) {
      setNotice("No hay reasignaciones pendientes por guardar.");
      return;
    }
    setAssignmentConfirmOpen(true);
  };

  const saveAssignments = async () => {
    if (!assignmentChanges.length || savingAssignments) return;

    setSavingAssignments(true);
    setError(null);
    setCorrelationId(null);
    let completed = 0;
    const completedAllyIds: number[] = [];
    let latestCatalog: PolicyCatalogSnapshot | null = null;

    try {
      for (const change of assignmentChanges) {
        const response = await fetch("/api/creditos/datacredito/politicas", {
          method: "PATCH",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "ASSIGN_ALLY",
            allyId: change.ally.id,
            policyId: change.policyId,
            expectedPolicyId: change.ally.policyId,
          }),
        });
        const payload = await readJson(response);

        if (!response.ok || payload.ok === false) {
          const code = String(payload.code || "").trim().toUpperCase();
          if (code === "POLICY_ASSIGNMENT_CONFLICT") {
            throw new PolicyRequestError(
              `La asignación de ${change.ally.name} cambió en otra sesión. Recarga y revisa antes de intentarlo de nuevo.`,
              getCorrelationId(payload, response)
            );
          }

          throw new PolicyRequestError(
            readString(payload.error) ||
              `No se pudo reasignar a ${change.ally.name}.`,
            getCorrelationId(payload, response)
          );
        }

        latestCatalog = parseCatalog(payload, response);
        completed += 1;
        completedAllyIds.push(change.ally.id);
      }

      if (latestCatalog) {
        applyCatalog(
          latestCatalog,
          selectedPolicyId,
          hasUnsavedChanges,
          true,
          completedAllyIds
        );
      }
      setAssignmentConfirmOpen(false);
      setNotice(
        `${completed} ${completed === 1 ? "aliado reasignado" : "aliados reasignados"}. Las nuevas políticas solo se aplicarán a consultas futuras.`
      );
    } catch (requestError) {
      setAssignmentConfirmOpen(false);
      if (latestCatalog) {
        applyCatalog(
          latestCatalog,
          selectedPolicyId,
          hasUnsavedChanges,
          true,
          completedAllyIds
        );
      }
      setError(
        `${completed ? `${completed} cambio(s) sí se guardaron. ` : ""}${
          requestError instanceof PolicyRequestError
            ? requestError.message
            : "No se pudieron guardar las reasignaciones."
        }`
      );
      setCorrelationId(
        requestError instanceof PolicyRequestError
          ? requestError.correlationId
          : null
      );
    } finally {
      setSavingAssignments(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-5 sm:p-6" aria-busy="true">
        <LoadingState label="Cargando catálogo de políticas de DataCrédito..." />
      </Card>
    );
  }

  if (error && !profiles.length) {
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
          onClick={() => void loadCatalog()}
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Intentar de nuevo
        </Button>
      </Card>
    );
  }

  const androidBands = bands.filter((band) => band.platform === "ANDROID");
  const iphoneBands = bands.filter((band) => band.platform === "IPHONE");
  const selectedProfileVersion = selectedProfile?.version ?? version;

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
            Políticas DataCrédito
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
            Crea políticas independientes, publica nuevas revisiones y asigna
            exactamente una a cada aliado. Los cambios solo afectan consultas
            futuras; las evaluaciones y ofertas ya emitidas conservan sus
            condiciones.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={requestReload}
          disabled={saving || savingAssignments || creating}
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill tone={configured ? "positive" : "warning"}>
                {configured ? "Configurado" : "Sin configurar"}
              </StatusPill>
              {providerEnvironment ? <Badge>{providerEnvironment}</Badge> : null}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Catálogo
            </p>
            <p className="mt-2 text-lg font-black">
              {profiles.length} {profiles.length === 1 ? "política" : "políticas"}
            </p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
              Aliados asignados
            </p>
            <p className="mt-2 text-lg font-black">{allies.length}</p>
          </div>
        </div>

        {!enabled || !productionReady ? (
          <p className="mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-3 text-sm leading-6 text-[var(--fp-amber)]">
            {!enabled
              ? "La integración está deshabilitada. Puedes preparar políticas, pero no se usarán en ventas mientras continúe apagada."
              : "El proveedor aún no está listo para producción. Revisa la configuración antes de iniciar consultas reales."}
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

      <Tabs aria-label="Gestión de políticas DataCrédito">
        <button
          id="datacredito-policies-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "POLICIES"}
          aria-controls="datacredito-policies-panel"
          onClick={() => setActiveTab("POLICIES")}
        >
          <Copy className="mr-2 inline h-4 w-4" aria-hidden="true" />
          Políticas
        </button>
        <button
          id="datacredito-assignments-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "ASSIGNMENTS"}
          aria-controls="datacredito-assignments-panel"
          onClick={() => setActiveTab("ASSIGNMENTS")}
        >
          <Users className="mr-2 inline h-4 w-4" aria-hidden="true" />
          Asignación a aliados
          {assignmentChanges.length ? (
            <Badge tone="warning" className="ml-2">
              {assignmentChanges.length}
            </Badge>
          ) : null}
        </button>
      </Tabs>

      {activeTab === "POLICIES" ? (
        <div
          id="datacredito-policies-panel"
          role="tabpanel"
          aria-labelledby="datacredito-policies-tab"
          className="space-y-6"
        >
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-xl font-black">Catálogo de políticas</h3>
                <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                  Selecciona una política para revisar sus bandas o publicar una
                  revisión inmutable.
                </p>
                {profiles.length ? (
                  <label className="mt-4 grid max-w-2xl gap-2 text-sm font-bold">
                    Política seleccionada
                    <Select
                      value={selectedPolicyId || ""}
                      onChange={(event) =>
                        requestProfileSelection(event.target.value)
                      }
                      disabled={saving || creating}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} · v{profile.version} ·{" "}
                          {profile.assignedAlliesCount}{" "}
                          {profile.assignedAlliesCount === 1
                            ? "aliado"
                            : "aliados"}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
              </div>
              <div className="lg:max-w-xs">
                <Button
                  onClick={openCreatePolicy}
                  disabled={
                    !selectedProfile || saving || creating || hasUnsavedChanges
                  }
                  aria-describedby={
                    hasUnsavedChanges
                      ? "datacredito-create-policy-help"
                      : undefined
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Nueva política
                </Button>
                {hasUnsavedChanges ? (
                  <p
                    id="datacredito-create-policy-help"
                    className="mt-2 text-xs leading-5 text-[var(--fp-muted)]"
                  >
                    Publica los cambios o recarga para descartarlos antes de
                    duplicar la última versión publicada.
                  </p>
                ) : null}
              </div>
            </div>

            {selectedProfile ? (
              <div className="mt-5 grid gap-4 border-t border-[var(--fp-border)] pt-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Estado
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill
                      tone={selectedProfile.active ? "positive" : "warning"}
                    >
                      {selectedProfile.active ? "Activa" : "Inactiva"}
                    </StatusPill>
                    {selectedProfile.id === defaultPolicyId ? (
                      <Badge>Predeterminada</Badge>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Revisión vigente
                  </p>
                  <p className="mt-2 text-lg font-black">
                    Versión {selectedProfileVersion}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Aliados
                  </p>
                  <p className="mt-2 text-lg font-black">
                    {selectedProfile.assignedAlliesCount}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Última publicación
                  </p>
                  <p className="mt-2 text-sm font-semibold text-[var(--fp-muted)]">
                    {formatDate(updatedAt)}
                  </p>
                </div>
                {selectedProfile.description ? (
                  <p className="text-sm leading-6 text-[var(--fp-muted)] sm:col-span-2 xl:col-span-4">
                    {selectedProfile.description}
                  </p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                className="mt-5"
                title="No hay políticas publicadas"
                description="El catálogo debe tener al menos una política antes de asignar aliados."
              />
            )}
          </Card>

          {createOpen && selectedProfile ? (
            <Card className="p-5 sm:p-6" aria-labelledby="new-policy-title">
              <div className="flex items-start gap-3">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-navy)] text-white"
                  aria-hidden="true"
                >
                  <Copy className="h-5 w-5" />
                </span>
                <div>
                  <h3 id="new-policy-title" className="text-xl font-black">
                    Duplicar política
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                    Se copiará la versión {selectedProfile.version} publicada de
                    “{selectedProfile.name}”. El nuevo perfil no se asignará a
                    ningún aliado automáticamente.
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <label className="grid gap-2 text-sm font-bold">
                  Nombre de la nueva política
                  <Input
                    value={newPolicyName}
                    onChange={(event) => setNewPolicyName(event.target.value)}
                    maxLength={80}
                    disabled={creating}
                    autoFocus
                  />
                </label>
                <label className="grid gap-2 text-sm font-bold">
                  Descripción opcional
                  <Input
                    value={newPolicyDescription}
                    onChange={(event) =>
                      setNewPolicyDescription(event.target.value)
                    }
                    maxLength={240}
                    disabled={creating}
                    placeholder="Ej. Condiciones para aliados premium"
                  />
                </label>
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-3">
                <Button
                  variant="secondary"
                  onClick={() => setCreateOpen(false)}
                  disabled={creating}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => void createPolicy()}
                  disabled={
                    creating ||
                    hasUnsavedChanges ||
                    newPolicyName.trim().length < 3
                  }
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {creating ? "Creando..." : "Crear copia"}
                </Button>
              </div>
            </Card>
          ) : null}

          {selectedProfile ? (
            <>
              <PlatformEditor
                platform="ANDROID"
                bands={androidBands}
                errors={validation.platformErrors.ANDROID}
                rowErrors={validation.rowErrors}
                disabled={saving}
                onAdd={addBand}
                onAddNoInformation={addNoInformationBand}
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
                onAddNoInformation={addNoInformationBand}
                onChange={updateBand}
                onRemove={removeBand}
              />

              <Card className="p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={validation.valid ? "positive" : "warning"}>
                        {validation.valid
                          ? "Cobertura completa"
                          : "Política incompleta"}
                      </Badge>
                      <span className="text-sm font-semibold text-[var(--fp-muted)]">
                        {bands.length} {bands.length === 1 ? "regla" : "reglas"}
                      </span>
                    </div>
                    <p
                      id="datacredito-policy-save-help"
                      className="mt-3 max-w-2xl text-sm leading-6 text-[var(--fp-muted)]"
                    >
                      {!validation.valid
                        ? "Completa y corrige ambas plataformas. Publicar permanecerá deshabilitado mientras existan huecos, solapamientos, reglas Sin información ausentes o duplicadas, o valores inválidos."
                        : hasUnsavedChanges
                          ? `La próxima publicación creará la versión ${(version || 0) + 1}; no reemplazará ni modificará revisiones históricas.`
                          : "No hay cambios pendientes por publicar."}
                    </p>
                  </div>
                  <Button
                    onClick={openSaveConfirmation}
                    disabled={
                      saving ||
                      !selectedProfile.active ||
                      !validation.valid ||
                      !hasUnsavedChanges
                    }
                    aria-describedby="datacredito-policy-save-help"
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    {saving ? "Publicando..." : "Publicar nueva versión"}
                  </Button>
                </div>
              </Card>
            </>
          ) : null}
        </div>
      ) : (
        <div
          id="datacredito-assignments-panel"
          role="tabpanel"
          aria-labelledby="datacredito-assignments-tab"
          className="space-y-6"
        >
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="text-xl font-black">Asignación a aliados</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
                  Cada aliado debe conservar exactamente una política. Una
                  reasignación solo cambia las consultas que se creen después
                  de guardarla.
                </p>
              </div>
              <label className="grid w-full gap-2 text-sm font-bold lg:max-w-sm">
                Buscar aliado
                <Input
                  type="search"
                  value={assignmentQuery}
                  onChange={(event) => setAssignmentQuery(event.target.value)}
                  placeholder="Nombre, código o política"
                />
              </label>
            </div>

            {filteredAllies.length ? (
              <DataTable className="mt-5">
                <table className="min-w-[820px]">
                  <thead>
                    <tr>
                      <th scope="col">Aliado</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Política asignada</th>
                      <th scope="col">Versión vigente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAllies.map((ally) => {
                      const draftPolicyId =
                        assignmentDrafts[allyDraftKey(ally.id)] || ally.policyId;
                      const draftProfile = profiles.find(
                        (profile) => profile.id === draftPolicyId
                      );
                      const changed = draftPolicyId !== ally.policyId;

                      return (
                        <tr key={ally.id}>
                          <td>
                            <strong className="block text-[var(--fp-graphite)]">
                              {ally.name}
                            </strong>
                            <span className="mt-1 block text-xs text-[var(--fp-muted)]">
                              {ally.code || "Sin código"}
                            </span>
                          </td>
                          <td>
                            <StatusPill
                              tone={ally.active ? "positive" : "neutral"}
                            >
                              {ally.active ? "Activo" : "Inactivo"}
                            </StatusPill>
                          </td>
                          <td className="min-w-[300px]">
                            <Select
                              aria-label={`Política para ${ally.name}`}
                              value={draftPolicyId}
                              onChange={(event) => {
                                setNotice(null);
                                setAssignmentDrafts((current) => ({
                                  ...current,
                                  [allyDraftKey(ally.id)]: event.target.value,
                                }));
                              }}
                              disabled={savingAssignments}
                              className={
                                changed
                                  ? "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)]"
                                  : undefined
                              }
                            >
                              {profiles
                                .filter(
                                  (profile) =>
                                    profile.active ||
                                    profile.id === draftPolicyId
                                )
                                .map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                            </Select>
                            {changed ? (
                              <span className="mt-2 block text-xs font-bold text-[#4f6f0c]">
                                Cambio pendiente
                              </span>
                            ) : null}
                          </td>
                          <td>
                            <span className="font-black">
                              {draftProfile
                                ? `v${draftProfile.version}`
                                : "No disponible"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </DataTable>
            ) : (
              <EmptyState
                className="mt-5"
                title={allies.length ? "Sin coincidencias" : "No hay aliados"}
                description={
                  allies.length
                    ? "Prueba con otro nombre, código o política."
                    : "Cuando exista un aliado, su política obligatoria aparecerá aquí."
                }
              />
            )}

            <div className="mt-5 flex flex-col gap-4 border-t border-[var(--fp-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Badge
                  tone={assignmentChanges.length ? "warning" : "positive"}
                >
                  {assignmentChanges.length
                    ? `${assignmentChanges.length} cambio(s) pendiente(s)`
                    : "Asignaciones al día"}
                </Badge>
                <p
                  id="datacredito-assignment-save-help"
                  className="mt-2 text-sm leading-6 text-[var(--fp-muted)]"
                >
                  Las consultas anteriores y las ofertas vigentes no se
                  recalculan al reasignar una política.
                </p>
              </div>
              <Button
                onClick={openAssignmentConfirmation}
                disabled={savingAssignments || !assignmentChanges.length}
                aria-describedby="datacredito-assignment-save-help"
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                {savingAssignments
                  ? "Guardando..."
                  : `Guardar ${assignmentChanges.length || ""} ${
                      assignmentChanges.length === 1 ? "cambio" : "cambios"
                    }`}
              </Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Publicar nueva revisión"
        description={`Se publicará la versión ${(version || 0) + 1} de “${
          selectedProfile?.name || "la política"
        }” con ${validation.canonicalBands.length} reglas. La usarán ${
          selectedProfile?.assignedAlliesCount || 0
        } aliado(s) únicamente en consultas futuras.`}
        confirmLabel="Publicar versión"
        busy={saving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void savePolicy()}
      />

      <ConfirmDialog
        open={assignmentConfirmOpen}
        title="Guardar reasignaciones"
        description={`Se cambiará la política de ${assignmentChanges.length} ${
          assignmentChanges.length === 1 ? "aliado" : "aliados"
        }. Las consultas y ofertas ya emitidas conservarán la revisión con la que fueron evaluadas.`}
        confirmLabel="Guardar asignaciones"
        busy={savingAssignments}
        onCancel={() => setAssignmentConfirmOpen(false)}
        onConfirm={() => void saveAssignments()}
      />

      <ConfirmDialog
        open={switchConfirmOpen}
        title="Descartar borrador y cambiar de política"
        description="La política seleccionada reemplazará las bandas editadas en este borrador. Las revisiones ya publicadas no se modifican."
        confirmLabel="Descartar y cambiar"
        onCancel={() => {
          setSwitchConfirmOpen(false);
          setPendingPolicyId(null);
        }}
        onConfirm={() => {
          if (pendingPolicyId) selectProfile(pendingPolicyId);
          setSwitchConfirmOpen(false);
          setPendingPolicyId(null);
        }}
      />

      <ConfirmDialog
        open={reloadConfirmOpen}
        title="Descartar cambios y recargar"
        description="El catálogo vigente reemplazará el borrador de bandas y las reasignaciones pendientes. Esta acción no afecta cambios que ya se hayan publicado."
        confirmLabel="Descartar y recargar"
        onCancel={() => setReloadConfirmOpen(false)}
        onConfirm={() => {
          setReloadConfirmOpen(false);
          void loadCatalog(undefined, selectedPolicyId);
        }}
      />
    </section>
  );
}
