export class SecondCreditAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SecondCreditAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeSecondCreditDocument(value: unknown): string {
  if (typeof value !== "string" || !/^[\d.\s-]+$/.test(value.trim())) {
    throw new SecondCreditAuthorizationError("INVALID_DOCUMENT", "Ingresa una cédula válida de 3 a 13 dígitos.");
  }
  const document = value.replace(/[.\s-]/g, "").replace(/^0+/, "");
  if (!/^\d{3,13}$/.test(document)) {
    throw new SecondCreditAuthorizationError("INVALID_DOCUMENT", "Ingresa una cédula válida de 3 a 13 dígitos.");
  }
  return document;
}

export function secondCreditAuthorizationUnavailable() {
  return new SecondCreditAuthorizationError("SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE", "No se pudo verificar la autorización de segundo crédito. Intenta nuevamente antes de continuar.", 503);
}

export type SecondCreditMutation = {
  documento: string;
  action: "AUTHORIZE" | "REVOKE";
  reason: string;
  mutationId: string;
  expectedVersion: number;
};

export function parseSecondCreditMutation(input: unknown): SecondCreditMutation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SecondCreditAuthorizationError("INVALID_REQUEST", "La solicitud no es válida.");
  }
  const body = input as Record<string, unknown>;
  const documento = normalizeSecondCreditDocument(body.documentNumber);
  if (body.action !== "AUTHORIZE" && body.action !== "REVOKE") {
    throw new SecondCreditAuthorizationError("INVALID_ACTION", "La acción solicitada no es válida.");
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    throw new SecondCreditAuthorizationError("INVALID_REASON", "El motivo debe tener entre 5 y 500 caracteres.");
  }
  if (typeof body.mutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.mutationId)) {
    throw new SecondCreditAuthorizationError("INVALID_REQUEST_ID", "La identificación de la operación no es válida. Actualiza la página.");
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new SecondCreditAuthorizationError("INVALID_VERSION", "Consulta la cédula antes de modificar su autorización.");
  }
  return { documento, action: body.action, reason, mutationId: body.mutationId.toLowerCase(), expectedVersion: body.expectedVersion };
}