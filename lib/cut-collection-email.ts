import { CutCollectionError } from "./cut-collection-access";
import { AllyContactValidationError, normalizeAllyEmail } from "./ally-contact";

export class CutCollectionEmailError extends Error {
  constructor(message: string, public readonly status: 502 | 503) { super(message); }
}

export async function getCutCollectionRecipient(allyId: number) {
  const { default: prisma } = await import("./prisma");
  const ally = await prisma.aliado.findUnique({
    where: { id: allyId },
    select: { activo: true, email: true },
  });
  if (ally?.activo) {
    try {
      const recipient = normalizeAllyEmail(ally.email);
      if (recipient) return recipient;
    } catch (error) {
      if (!(error instanceof AllyContactValidationError)) throw error;
    }
  }
  throw new CutCollectionError("El aliado no tiene un correo válido registrado.", 422);
}

export async function sendCutCollectionEmail(input: {
  recipient: string; filename: string; pdf: Buffer; cutDate: string; idempotencyKey: string;
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new CutCollectionEmailError("El envío de informes por correo no está configurado.", 503);
  const uncertain = "No se pudo confirmar el envío. Verifica si el informe llegó antes de volver a enviarlo.";
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `cut-collection/${input.idempotencyKey}`,
      },
      body: JSON.stringify({
        from: "FINSER PAY <pagos@finserpay.com>",
        to: [input.recipient],
        subject: `Informe de recaudo por corte | ${input.cutDate}`,
        text: "Hola. Adjuntamos el informe de recaudo y riesgo temprano del corte consultado en FINSER PAY.",
        attachments: [{ filename: input.filename, content: input.pdf.toString("base64") }],
      }),
    });
  } catch {
    throw new CutCollectionEmailError(uncertain, 503);
  }
  if (response.status === 408 || response.status === 409 || response.status >= 500) {
    throw new CutCollectionEmailError(uncertain, 503);
  }
  if (!response.ok) {
    throw new CutCollectionEmailError("El proveedor de correo no aceptó el envío del informe.", 502);
  }
  const receipt = await response.json().catch(() => null);
  if (typeof receipt?.id !== "string" || !receipt.id) throw new CutCollectionEmailError(uncertain, 503);
}
