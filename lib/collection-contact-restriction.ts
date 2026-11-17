import "server-only";

export const COLLECTION_CONTACT_RESTRICTION_REASON = "Este cliente tiene restringidos los contactos de cobro por WhatsApp y llamadas.";

function normalizedDocument(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Never strip arbitrary characters: a malformed identifier must not become
  // another customer's document. Keep leading zeroes and reject signed values.
  if (!/^\d+(?:(?:[.-]|[ \t\u00a0]+)\d+)*$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[.\- \t\u00a0]/g, "");
  return /^\d{5,15}$/.test(digits) && !/^0+$/.test(digits) ? digits : null;
}

/** Server-managed contact restriction; independent of debt and mora protection. */
export function isCollectionContactRestricted(document: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = normalizedDocument(document);
  const configured = env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS;
  if (!normalized || !configured) return false;
  // Read every time so a current environment value also guards queued work.
  return configured.split(/[,;\r\n]+/).some(value => normalizedDocument(value) === normalized);
}
