import { sanitizeText } from "@/lib/credit-factory";

const EFECTY_CONVENIO_FINSER_PAY = "113950";

export function buildMoraLockMessage(clienteDocumento: unknown) {
  const document = sanitizeText(clienteDocumento);
  const reference = document || "cedula registrada";

  return [
    "Tu equipo FINSER PAY esta bloqueado por una cuota vencida. Realiza el pago para desbloquearlo.",
    "",
    "EFECTY",
    `Convenio: ${EFECTY_CONVENIO_FINSER_PAY}`,
    `Referencia: ${reference}`,
  ].join("\n");
}
