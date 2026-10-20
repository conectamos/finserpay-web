const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMERCIAL_REASON = "Envío del contrato de la solicitud a FirmaSeguro";
const PENDING_STATUSES = ["PREPARING", "DISPATCHING", "UNCERTAIN"] as const;

export type DraftSignatureDispatchSummary = {
  id: string;
  status: typeof PENDING_STATUSES[number];
  pending: true;
  createdAt: string | null;
  updatedAt: string | null;
  hasReceipt: boolean;
  canResume: boolean;
  failureStage?: "provider_dispatch" | "receipt_persistence" | null;
  hasProviderLocator?: boolean;
};

function iso(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Expose status only; frozen payloads, provider data and actor details stay on the server. */
export function serializeDraftSignatureDispatch(
  value: unknown,
  viewer: { actorUserId: number },
): DraftSignatureDispatchSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !UUID.test(row.id) ||
    !PENDING_STATUSES.includes(row.status as typeof PENDING_STATUSES[number])) return null;
  const status = row.status as typeof PENDING_STATUSES[number];
  return {
    id: row.id,
    status,
    pending: true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    hasReceipt: row.hasReceipt === true,
    failureStage: row.failureStage === "provider_dispatch" || row.failureStage === "receipt_persistence"
      ? row.failureStage : null,
    hasProviderLocator: row.hasProviderLocator === true,
    // An accepted or ambiguous attempt is never permission to send again. Even
    // a never-dispatched preparation belongs to its original actor and purpose;
    // the dispatch POST repeats those checks before using the original ID.
    canResume: status === "PREPARING" && row.hasReceipt === false && row.hasProviderLocator === false &&
      Number.isSafeInteger(viewer.actorUserId) && viewer.actorUserId > 0 &&
      row.actorUserId === viewer.actorUserId && row.reason === COMMERCIAL_REASON &&
      row.expectedProcessUuid === null,
  };
}
