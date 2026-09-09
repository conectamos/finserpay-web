import { ApprovalRequestError, type ApprovalDetail } from "../app/dashboard/aprobaciones/approval-client";

export type EvidenceCorrectionRequest = { key: string; dataUrl: string; revision: number; reviewHash: string };

export async function submitEvidenceCorrection(creditId: number, input: EvidenceCorrectionRequest) {
  const response = await fetch(`/api/aprobaciones/${creditId}/evidencias`, {
    method: "PATCH", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  let result: { ok?: boolean; item?: ApprovalDetail; unchanged?: boolean; error?: string };
  try { result = await response.json(); }
  catch { throw new ApprovalRequestError("No se pudo confirmar el reemplazo. Actualiza el expediente antes de intentarlo nuevamente.", response.status); }
  if (!response.ok || !result?.ok || result.item?.id !== creditId || typeof result.unchanged !== "boolean") {
    throw new ApprovalRequestError(result?.error || "No se recibió confirmación del reemplazo. Actualiza el expediente.", response.status);
  }
  return { item: result.item, unchanged: result.unchanged };
}
