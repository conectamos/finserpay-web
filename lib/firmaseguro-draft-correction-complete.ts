import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { recordFirmaSeguroImeiCorrectionReissue } from "@/lib/firmaseguro-imei-correction";
import { recordFirmaSeguroFinancialCorrectionReissue } from "@/lib/firmaseguro-financial-correction";
import { recordSignedDraftIdentityCorrectionReissue } from "@/lib/firmaseguro-draft-identity-correction";

/** Run after the callback's provider refresh. Browser polling remains read-only. */
export async function recordVerifiedDraftCorrectionReissues(process: FirmaSeguroProcessRow | null) {
  if (!process?.draftId || process.creditoId || process.supersededAt || !process.completedAt ||
      !process.signedDocumentBase64 || Buffer.from(process.signedDocumentBase64, "base64").subarray(0, 5).toString() !== "%PDF-") return;
  const payload = process.draftPayload && typeof process.draftPayload === "object" && !Array.isArray(process.draftPayload)
    ? process.draftPayload as Record<string, unknown> : {};
  // Each recorder rechecks the current version under its transaction lock.
  // A correction occurring between this refresh and recording cannot be
  // completed by an older callback, even when it carried the former UUID.
  if (payload.firmaSeguroCorrectionId) await recordFirmaSeguroImeiCorrectionReissue(process.draftId, process);
  if (payload.firmaSeguroFinancialCorrectionId) await recordFirmaSeguroFinancialCorrectionReissue(process.draftId, process);
  if (payload.firmaSeguroIdentityCorrectionId) await recordSignedDraftIdentityCorrectionReissue(process.draftId, process);
}
