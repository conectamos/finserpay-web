import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { SadminRegistration } from "@/lib/credit-sadmin-types";

const fields = ["codeudorCreado", "creditoCreado", "numeroCreditoConfirmado", "numeroCredito"] as const;
export type SadminChange = {
  version: number;
  field: typeof fields[number];
  value: boolean | string;
};
export type StoredSadminRegistration = {
  version: number;
  codeudorCreado: boolean;
  creditoCreado: boolean;
  numeroCreditoConfirmado: boolean;
  numeroCredito: string | null;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

function storedUtcIso(value: Date | string | null | undefined) {
  if (!value) return null;
  // PostgreSQL JSON renders timestamp-without-time-zone without a UTC suffix.
  const timestamp = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value) ? `${value}Z` : value;
  return new Date(timestamp).toISOString();
}

export function parseSadminChange(value: unknown): SadminChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreditApprovalError("INVALID_SADMIN_CHANGE", "Selecciona una verificación válida.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "field,value,version" ||
      !Number.isSafeInteger(input.version) || Number(input.version) < 0 || Number(input.version) > 2147483646 ||
      !fields.includes(input.field as typeof fields[number])) {
    throw new CreditApprovalError("INVALID_SADMIN_CHANGE", "Actualiza la tabla antes de guardar la verificación.");
  }
  if (input.field === "numeroCredito") {
    if (typeof input.value !== "string" || input.value.length > 80 || /[\u0000-\u001f\u007f]/.test(input.value)) {
      throw new CreditApprovalError("INVALID_SADMIN_NUMBER", "Escribe un número de SADMIN de hasta 80 caracteres.");
    }
    return { version: Number(input.version), field: input.field, value: input.value.trim() };
  }
  if (typeof input.value !== "boolean") {
    throw new CreditApprovalError("INVALID_SADMIN_CHANGE", "La verificación debe estar marcada o desmarcada.");
  }
  return { version: Number(input.version), field: input.field as SadminChange["field"], value: input.value };
}

export function sadminRegistration(row?: StoredSadminRegistration | null): SadminRegistration {
  const completed = Boolean(row?.codeudorCreado && row.creditoCreado && row.numeroCreditoConfirmado && row.numeroCredito?.trim());
  return {
    version: row?.version ?? 0,
    codeudorCreado: row?.codeudorCreado ?? false,
    creditoCreado: row?.creditoCreado ?? false,
    numeroCreditoConfirmado: row?.numeroCreditoConfirmado ?? false,
    numeroCredito: row?.numeroCredito ?? null,
    estado: completed ? "CREADO_SADMIN" : "PENDIENTE",
    updatedAt: storedUtcIso(row?.updatedAt),
    completedAt: completed ? storedUtcIso(row?.completedAt) : null,
  };
}

export function applySadminChange(current: SadminRegistration, change: SadminChange) {
  if (current.version !== change.version) {
    throw new CreditApprovalError("SADMIN_CHANGED", "Otra persona actualizó este crédito. Recarga la fila antes de continuar.", 409);
  }
  const next = { ...current };
  if (change.field === "numeroCredito") {
    next.numeroCredito = String(change.value).trim() || null;
    if (next.numeroCredito !== current.numeroCredito) next.numeroCreditoConfirmado = false;
  } else {
    next[change.field] = change.value as boolean;
  }
  if (next.numeroCreditoConfirmado && !next.numeroCredito) {
    throw new CreditApprovalError("SADMIN_NUMBER_REQUIRED", "Guarda primero el número asignado por SADMIN.");
  }
  next.estado = next.codeudorCreado && next.creditoCreado && next.numeroCreditoConfirmado && next.numeroCredito
    ? "CREADO_SADMIN" : "PENDIENTE";
  return next;
}
