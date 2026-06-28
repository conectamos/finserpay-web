export const MASS_CREDIT_SOURCE = "IMPORTACION_MASIVA";
export const MASS_CREDIT_OBSERVATION_MARKER =
  "[IMPORTACION_MASIVA_SIN_BLOQUEO]";

export function isMassImportedCredit(value: {
  contratoSnapshot?: unknown;
  equalityService?: string | null;
  observacionAdmin?: string | null;
}) {
  const observation = String(value.observacionAdmin || "").toUpperCase();
  const service = String(value.equalityService || "").toUpperCase();

  if (
    observation.includes(MASS_CREDIT_OBSERVATION_MARKER) ||
    observation.includes(MASS_CREDIT_SOURCE) ||
    service.includes(MASS_CREDIT_SOURCE)
  ) {
    return true;
  }

  const snapshot = value.contratoSnapshot;

  if (typeof snapshot !== "object" || snapshot === null) {
    return false;
  }

  const root = snapshot as Record<string, unknown>;
  const origen =
    typeof root.origen === "object" && root.origen !== null
      ? (root.origen as Record<string, unknown>)
      : null;
  const tipo = String(origen?.tipo || root.origen || "").toUpperCase();

  return tipo === MASS_CREDIT_SOURCE;
}

export function buildMassCreditObservation(options: {
  batchId: string;
  createdBy: string;
  rowNumber: number;
}) {
  return [
    MASS_CREDIT_OBSERVATION_MARKER,
    `Lote ${options.batchId}`,
    `Fila ${options.rowNumber}`,
    `Creado por ${options.createdBy}`,
  ].join(" | ");
}
