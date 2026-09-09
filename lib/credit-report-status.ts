type AnalystReview = {
  status: string;
  revision: number;
  approvedRevision: number | null;
};

// Presentation only: preserve terminal, blocked and unknown operational states.
const APPROVABLE_REPORT_STATES = new Set(["GENERADO", "INSCRITO", "ENTREGABLE"]);

export function resolveCreditReportState(estado: string, review?: AnalystReview | null) {
  const approved = review?.status === "APPROVED" &&
    Number.isInteger(review.revision) && review.revision > 0 &&
    review.approvedRevision === review.revision;

  return approved && APPROVABLE_REPORT_STATES.has(estado.trim().toUpperCase())
    ? "APROBADO"
    : estado;
}
