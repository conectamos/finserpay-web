import "server-only";
import prisma from "@/lib/prisma";
import { extractVeriffIdentityData } from "@/lib/veriff";
import { getVeriffValidationById, isVeriffApproved, serializeVeriffValidation, type VeriffValidationRow } from "@/lib/veriff-storage";
import { compareStrictIdentityDocuments } from "@/lib/veriff-identity";
import { FirmaSeguroFullNameIdentityError, resolveFirmaSeguroFullNameIdentity } from "./firmaseguro-identity";

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
  const decisionIdentity = extractVeriffIdentityData(validation.decisionPayload);
  const webhookIdentity = extractVeriffIdentityData(validation.webhookPayload);
  const identity = decisionIdentity || webhookIdentity;
  return resolveFirmaSeguroFullNameIdentity({ fullName: input.fullName, documentNumber: input.documentNumber,
    validationId: validation.id, veriffDocumentNumber: serialized.identityDocumentNumber,
    firstName: identity?.firstName, lastName: identity?.lastName,
    additionalIdentities: [decisionIdentity, webhookIdentity].filter((value): value is NonNullable<typeof value> => Boolean(value)) });
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
  return firmaSeguroFullNameIdentityFromValidation({ ...input, validation, expectedDraftId: input.draftId });
}
