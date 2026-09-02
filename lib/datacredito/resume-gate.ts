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

export function canRecoverAssessmentIdentityMismatch(input: {
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
}) {
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
    !normalizedDocument(input.imei) &&
    String(input.errorCode || "").trim().toUpperCase() ===
      "ASSESSMENT_IDENTITY_MISMATCH"
  );
}
