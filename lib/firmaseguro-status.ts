const FIRMASEGURO_SUCCESS_STATUS_TOKENS = new Set([
  "APROBADA",
  "APROBADO",
  "COMPLETE",
  "COMPLETADA",
  "COMPLETADO",
  "COMPLETED",
  "EXITOSA",
  "EXITOSO",
  "FINALIZADA",
  "FINALIZADO",
  "FINALIZED",
  "FINISHED",
  "FIRMADA",
  "FIRMADO",
  "SIGNED",
  "SUCCESS",
  "SUCCESSFUL",
]);

const FIRMASEGURO_FAILURE_STATUS_TOKENS = new Set([
  "ABORTADA",
  "ABORTADO",
  "ABORTED",
  "ANULADA",
  "ANULADO",
  "CANCELADA",
  "CANCELADO",
  "CANCELED",
  "CANCELLED",
  "DECLINADA",
  "DECLINADO",
  "DECLINED",
  "ERROR",
  "EXPIRED",
  "EXPIRADA",
  "EXPIRADO",
  "FAILED",
  "FAILURE",
  "RECHAZADA",
  "RECHAZADO",
  "REJECTED",
  "REVOKED",
]);

function firmaSeguroStatusTokens(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function isFirmaSeguroSuccessfulStatus(status: unknown) {
  return firmaSeguroStatusTokens(status).some((token) =>
    FIRMASEGURO_SUCCESS_STATUS_TOKENS.has(token)
  );
}

export function isFirmaSeguroFailedStatus(status: unknown) {
  return firmaSeguroStatusTokens(status).some((token) =>
    FIRMASEGURO_FAILURE_STATUS_TOKENS.has(token)
  );
}
