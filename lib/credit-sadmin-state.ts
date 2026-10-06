import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { SadminCreationStatus, SadminRegistration } from "@/lib/credit-sadmin-types";

const fields = ["codeudorCreado", "creditoCreado", "numeroCreditoConfirmado", "numeroCredito", "estadoCreacion"] as const;
const creationStatuses = new Set<SadminCreationStatus>([
  "PENDIENTE_CREAR", "CREADO_CORRECTAMENTE", "ERROR_CREACION", "REQUIERE_REVISION",
]);
export type SadminChange = {
  version: number;
  field: typeof fields[number];
  value: boolean | string;
  reason?: string | null;
};
export type StoredSadminRegistration = {
  version: number;
  codeudorCreado: boolean;
  creditoCreado: boolean;
  numeroCreditoConfirmado: boolean;
  numeroCredito: string | null;
  estadoCreacion?: SadminCreationStatus | null;
  motivoEstado?: string | null;
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
  const validField = fields.includes(input.field as typeof fields[number]);
  const expectedKeys = input.field === "estadoCreacion" ? "field,reason,value,version" : "field,value,version";
  if (Object.keys(input).sort().join(",") !== expectedKeys || !validField ||
      !Number.isSafeInteger(input.version) || Number(input.version) < 0 || Number(input.version) > 2147483646) {
    throw new CreditApprovalError("INVALID_SADMIN_CHANGE", "Actualiza la tabla antes de guardar la verificación.");
  }
  if (input.field === "numeroCredito") {
    if (typeof input.value !== "string" || input.value.length > 80 || /[\u0000-\u001f\u007f]/.test(input.value)) {
      throw new CreditApprovalError("INVALID_SADMIN_NUMBER", "Escribe un número de SADMIN de hasta 80 caracteres.");
    }
    return { version: Number(input.version), field: input.field, value: input.value.trim() };
  }
  if (input.field === "estadoCreacion") {
    if (typeof input.value !== "string" || !creationStatuses.has(input.value as SadminCreationStatus)) {
      throw new CreditApprovalError("INVALID_SADMIN_RESULT", "Selecciona un resultado válido para la creación en SADMIN.");
    }
    const needsReason = input.value === "ERROR_CREACION" || input.value === "REQUIERE_REVISION";
    if (needsReason) {
      if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.reason)) {
        throw new CreditApprovalError("INVALID_SADMIN_REASON", "Escribe una razón de hasta 500 caracteres para este resultado.");
      }
      return { version: Number(input.version), field: input.field, value: input.value, reason: input.reason.trim() };
    }
    if (input.reason !== null) {
      throw new CreditApprovalError("INVALID_SADMIN_REASON", "Este resultado no admite una razón asociada.");
    }
    return { version: Number(input.version), field: input.field, value: input.value, reason: null };
  }
  if (typeof input.value !== "boolean") {
    throw new CreditApprovalError("INVALID_SADMIN_CHANGE", "La verificación debe estar marcada o desmarcada.");
  }
  return { version: Number(input.version), field: input.field as SadminChange["field"], value: input.value };
}

export function sadminRegistration(row?: StoredSadminRegistration | null): SadminRegistration {
  const completed = Boolean(row?.codeudorCreado && row.creditoCreado && row.numeroCreditoConfirmado && row.numeroCredito?.trim());
  const storedStatus = row?.estadoCreacion && creationStatuses.has(row.estadoCreacion)
    ? row.estadoCreacion : "PENDIENTE_CREAR";
  const estadoCreacion: SadminCreationStatus = completed ? "CREADO_CORRECTAMENTE"
    : storedStatus === "CREADO_CORRECTAMENTE" ? "PENDIENTE_CREAR" : storedStatus;
  const motivoEstado = estadoCreacion === "ERROR_CREACION" || estadoCreacion === "REQUIERE_REVISION"
    ? row?.motivoEstado?.trim() || null : null;
  return {
    version: row?.version ?? 0,
    codeudorCreado: row?.codeudorCreado ?? false,
    creditoCreado: row?.creditoCreado ?? false,
    numeroCreditoConfirmado: row?.numeroCreditoConfirmado ?? false,
    numeroCredito: row?.numeroCredito ?? null,
    estado: completed ? "CREADO_SADMIN" : "PENDIENTE",
    estadoCreacion,
    motivoEstado,
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
    if (next.numeroCredito !== current.numeroCredito) {
      next.numeroCreditoConfirmado = false;
      next.estadoCreacion = "PENDIENTE_CREAR";
      next.motivoEstado = null;
    }
  } else if (change.field === "estadoCreacion") {
    if (change.value === "CREADO_CORRECTAMENTE" && current.estado !== "CREADO_SADMIN") {
      throw new CreditApprovalError(
        "SADMIN_CREATION_INCOMPLETE",
        "Completa el flujo manual y confirma el número antes de marcar la creación como correcta.",
        409,
      );
    }
    if (current.estado === "CREADO_SADMIN" && change.value !== "CREADO_CORRECTAMENTE") {
      throw new CreditApprovalError("SADMIN_ALREADY_CREATED", "El crédito ya fue creado correctamente en SADMIN. Ajusta primero sus verificaciones.", 409);
    }
    next.estadoCreacion = change.value as SadminCreationStatus;
    next.motivoEstado = change.reason || null;
  } else {
    next[change.field] = change.value as boolean;
  }
  if (next.numeroCreditoConfirmado && !next.numeroCredito) {
    throw new CreditApprovalError("SADMIN_NUMBER_REQUIRED", "Guarda primero el número asignado por SADMIN.");
  }
  const completed = Boolean(next.codeudorCreado && next.creditoCreado && next.numeroCreditoConfirmado && next.numeroCredito);
  next.estado = completed ? "CREADO_SADMIN" : "PENDIENTE";
  if (completed) {
    next.estadoCreacion = "CREADO_CORRECTAMENTE";
    next.motivoEstado = null;
  } else if (next.estadoCreacion === "CREADO_CORRECTAMENTE") {
    next.estadoCreacion = "PENDIENTE_CREAR";
    next.motivoEstado = null;
  }
  return next;
}
