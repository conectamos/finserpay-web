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
