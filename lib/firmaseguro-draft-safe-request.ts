import "server-only";

/**
 * The draft route remains the single owner of its existing Veriff, DataCredito
 * and financial contract checks. This narrow facade gives the operations API
 * the same durable dispatch path without copying those business rules.
 */
export async function requestSafeDraftSignature(input: {
  draftId: number; actor: { id: number; nombre: string }; reason: string;
  idempotencyKey: string; expectedProcessUuid: string | null;
}) {
  const { requestSafeDraftSignatureFromRoute } = await import(
    "@/app/api/creditos/borradores/[id]/firma-seguro/route"
  );
  return requestSafeDraftSignatureFromRoute(input);
}
