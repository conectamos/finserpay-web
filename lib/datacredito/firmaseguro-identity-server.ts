import { getStoredFirmaSeguroIdentityReview, FirmaSeguroIdentityReviewError } from "./firmaseguro-identity-review";
import "server-only";
import prisma from "@/lib/prisma";
import { extractVeriffIdentityDataEvidence } from "@/lib/veriff";
import { getVeriffValidationById, isVeriffApproved, serializeVeriffValidation, type VeriffValidationRow } from "@/lib/veriff-storage";
import { compareStrictIdentityDocuments } from "@/lib/veriff-identity";
import { FirmaSeguroFullNameIdentityError, resolveFirmaSeguroFullNameIdentityFromEvidence } from "./firmaseguro-identity";

export function firmaSeguroFullNameIdentityFromValidation(input: {
  fullName: string;
  documentNumber: string;
  validation: VeriffValidationRow | null;
  expectedDraftId: number;
}) {
  const validation = input.validation;
  if (!validation || validation.draftId !== input.expectedDraftId || validation.creditoId ||
      !isVeriffApproved(validation) || !compareStrictIdentityDocuments(validation.clienteDocumento, input.documentNumber).ok) {
    throw new FirmaSeguroFullNameIdentityError();
  }
  const serialized = serializeVeriffValidation(validation);
  if (!serialized || serialized.identityDocumentStatus !== "match") throw new FirmaSeguroFullNameIdentityError();
  return resolveFirmaSeguroFullNameIdentityFromEvidence({ fullName: input.fullName, documentNumber: input.documentNumber,
    validationId: validation.id, veriffDocumentNumber: serialized.identityDocumentNumber,
    identities: extractVeriffIdentityDataEvidence(validation.decisionPayload, validation.webhookPayload) });
}

export async function getFirmaSeguroFullNameIdentityForDraft(input: {
  fullName: string; documentNumber: string; validationId: number; draftId: number;
}) {
  if (!Number.isSafeInteger(input.validationId) || input.validationId <= 0) throw new FirmaSeguroFullNameIdentityError();
  const validation = await getVeriffValidationById(input.validationId);
  const latest = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    'SELECT "id" FROM "VeriffIdentityValidation" WHERE "draftId" = $1 AND "creditoId" IS NULL ORDER BY "id" DESC LIMIT 1', input.draftId
  );
  if (Number(latest[0]?.id) !== input.validationId) throw new FirmaSeguroFullNameIdentityError();
  try {
    return firmaSeguroFullNameIdentityFromValidation({ ...input, validation, expectedDraftId: input.draftId });
  } catch (error) {
    if (!(error instanceof FirmaSeguroFullNameIdentityError)) throw error;
    try {
      const reviewed = await getStoredFirmaSeguroIdentityReview(input);
      if (reviewed) return reviewed;
    } catch (reviewError) {
      if (!(reviewError instanceof FirmaSeguroIdentityReviewError)) throw reviewError;
    }
    throw error;
  }
}
