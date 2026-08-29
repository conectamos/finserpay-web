type SerializedVeriffValidation = Record<string, unknown> | null;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The seller only needs an attestation to continue the active workflow. Raw
 * identity attributes and provider/session identifiers stay on the server and
 * remain available to FINSER PAY central administrators.
 */
export function redactVeriffValidationForOperator(
  value: SerializedVeriffValidation
) {
  const validation = record(value);
  if (!validation) return null;

  return {
    id: validation.id,
    draftId: validation.draftId,
    status: validation.status,
    decision: validation.decision,
    approved: validation.approved === true,
    technicalApproved: validation.technicalApproved === true,
    trusted: validation.trusted === true,
    pending: validation.pending === true,
    identityDocumentStatus: validation.identityDocumentStatus,
    identityDataAvailable: Boolean(record(validation.identityData)),
    code: validation.code,
    createdAt: validation.createdAt,
    updatedAt: validation.updatedAt,
    submittedAt: validation.submittedAt,
    decidedAt: validation.decidedAt,
  };
}
