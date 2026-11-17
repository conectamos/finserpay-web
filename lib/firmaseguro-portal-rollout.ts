import "server-only";

/** Enable only after validating the portal runtime and an authorized pending case. */
export function isFirmaSeguroPortalResendEnabled(draftId: number): boolean {
  if (process.env.FIRMASEGURO_PORTAL_RESEND_ENABLED !== "true"
    || !Number.isSafeInteger(draftId) || draftId <= 0) return false;
  const scope = process.env.FIRMASEGURO_PORTAL_RESEND_DRAFT_IDS;
  if (scope === undefined) return true;
  const values = scope.split(",").map(value => value.trim());
  if (!values.length || values.some(value => !/^[1-9]\d*$/.test(value)
    || !Number.isSafeInteger(Number(value)))) return false;
  return values.some(value => Number(value) === draftId);
}
