export class DocumentBlacklistError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DocumentBlacklistError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeBlacklistedDocument(value: unknown): string {
  if (typeof value !== "string" || !/^[\d.\s-]+$/.test(value.trim())) {
    throw new DocumentBlacklistError("INVALID_DOCUMENT", "Ingresa una cédula válida de 3 a 13 dígitos.");
  }
  const document = value.replace(/[.\s-]/g, "").replace(/^0+/, "");
  if (!/^\d{3,13}$/.test(document)) {
    throw new DocumentBlacklistError("INVALID_DOCUMENT", "Ingresa una cédula válida de 3 a 13 dígitos.");
  }
  return document;
}

export function blacklistReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    throw new DocumentBlacklistError("INVALID_REASON", "El motivo debe tener entre 5 y 500 caracteres.");
  }
  return reason;
}

export function blacklistUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DocumentBlacklistError("INVALID_REQUEST_ID", "La identificación de la operación no es válida. Actualiza la página.");
  }
  return value.toLowerCase();
}

export function blacklistVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DocumentBlacklistError("INVALID_VERSION", "Actualiza la lista antes de modificar el registro.");
  }
  return value;
}

export function blacklistUnavailable(): DocumentBlacklistError {
  return new DocumentBlacklistError("DOCUMENT_BLACKLIST_UNAVAILABLE", "No se pudo verificar la lista negra. Intenta nuevamente antes de continuar.", 503);
}
