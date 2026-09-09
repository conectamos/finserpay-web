import {
  DocumentBlacklistError,
  normalizeBlacklistedDocument,
} from "@/lib/document-blacklist-core";

export function collectSolicitudBlacklistDocuments(...values: unknown[]): string[] {
  const documents = values
    .filter((value) => value !== null && value !== undefined && !(typeof value === "string" && !value.trim()))
    .map(normalizeBlacklistedDocument);
  return [...new Set(documents)].sort();
}

/** No new document lock may be taken after the operation, identity or row locks. */
export function assertSolicitudBlacklistDocumentsLocked(
  lockedDocuments: ReadonlySet<string>,
  ...values: unknown[]
) {
  if (collectSolicitudBlacklistDocuments(...values).some((document) => !lockedDocuments.has(document))) {
    throw new DocumentBlacklistError(
      "DRAFT_IDENTITY_CHANGED",
      "La identidad cambió. Actualiza la solicitud.",
      409,
    );
  }
}
