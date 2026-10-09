export type MissingAssessmentGateView = "ready" | "technical-error";

function positiveId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveMissingAssessmentGateView(input: {
  solicitudId: number | null | undefined;
  expiredRequerySolicitudId: number | null | undefined;
}): MissingAssessmentGateView {
  const solicitudId = positiveId(input.solicitudId);
  if (!solicitudId) return "ready";

  return solicitudId === positiveId(input.expiredRequerySolicitudId)
    ? "ready"
    : "technical-error";
}

function normalizedDocument(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function normalizedPlatform(value: unknown) {
  const platform = String(value || "").trim().toUpperCase();
  return platform === "ANDROID" || platform === "IPHONE" ? platform : "";
}

type AssessmentRecoveryInput = {
  reuseOnly: boolean;
  solicitudId: unknown;
  currentStep: unknown;
  storedDocument: unknown;
  submittedDocument: unknown;
  storedPlatform: unknown;
  submittedPlatform: unknown;
  assessmentId: unknown;
  imei: unknown;
  errorCode: unknown;
};

function isRecoverableUnlinkedAssessment(input: AssessmentRecoveryInput) {
  const storedDocument = normalizedDocument(input.storedDocument);
  const submittedDocument = normalizedDocument(input.submittedDocument);
  const storedPlatform = normalizedPlatform(input.storedPlatform);
  const submittedPlatform = normalizedPlatform(input.submittedPlatform);

  return (
    input.reuseOnly === true &&
    positiveId(input.solicitudId) !== null &&
    Number(input.currentStep) === 1 &&
    storedDocument.length >= 3 &&
    storedDocument === submittedDocument &&
    Boolean(storedPlatform) &&
    storedPlatform === submittedPlatform &&
    !String(input.assessmentId || "").trim() &&
    !normalizedDocument(input.imei)
  );
}

export function canRecoverAssessmentIdentityMismatch(input: AssessmentRecoveryInput) {
  return (
    isRecoverableUnlinkedAssessment(input) &&
    String(input.errorCode || "").trim().toUpperCase() ===
      "ASSESSMENT_IDENTITY_MISMATCH"
  );
}

// This only polls a retained result after a pending lookup. It never permits a
// new provider request or recovery of an ambiguous paid outcome.
export function canRecoverPendingAssessment(input: AssessmentRecoveryInput) {
  return (
    isRecoverableUnlinkedAssessment(input) &&
    String(input.errorCode || "").trim().toUpperCase() === "EVALUATION_IN_PROGRESS"
  );
}
