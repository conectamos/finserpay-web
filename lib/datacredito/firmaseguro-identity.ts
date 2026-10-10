export type FirmaSeguroFullNameIdentity = {
  source: "VERIFF" | "AUTHORIZED_REVIEW";
  reviewId?: string;
  validationId: number;
  documentNumber: string;
  canonicalFullName: string;
  firstName: string;
  firstLastName: string;
  secondName: null;
  secondLastName: string | null;
};

type NameEvidence = { firstName?: unknown; lastName?: unknown; fullName?: unknown; documentNumber?: unknown };
const nameText = (value: unknown) => typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
const comparableReviewedName = (value: unknown) => nameText(value).toLocaleUpperCase("es-CO");
// Provider responses differ in vowel accents. Preserve consonants such as Ñ
// and never modify the canonical name or the returned signing components.
const comparableName = (value: unknown) => comparableReviewedName(value).normalize("NFD")
  .replace(/([AEIOU])\p{M}+/gu, "$1").normalize("NFC");
export const firmaSeguroProviderNamesMatch = (left: unknown, right: unknown) => comparableName(left) === comparableName(right);
function documentText(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:[ .-]\d+)*$/.test(raw)) return "";
  const digits = raw.replace(/[ .-]/g, "");
  return /^\d{3,13}$/.test(digits) ? digits : "";
}
export class FirmaSeguroFullNameIdentityError extends Error {
  readonly code = "FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED";
  readonly status = 409;
  constructor(readonly reason: "components-required" | "invalid-components" | "name-conflict" | "identity-binding" = "components-required") {
    super("FirmaSeguro requiere nombres y apellidos separados correspondientes al mismo documento y al nombre completo de DataCrédito. Si Veriff aprobó la cédula sin esos componentes, un administrador debe completarlos mediante revisión autorizada. No se realizó un envío ni una nueva consulta.");
    this.name = "FirmaSeguroFullNameIdentityError";
  }
}
function invalid(reason?: ConstructorParameters<typeof FirmaSeguroFullNameIdentityError>[0]): never { throw new FirmaSeguroFullNameIdentityError(reason); }

export function assertFirmaSeguroVeriffEvidenceDocuments(documentNumber: string, identities: readonly NameEvidence[]) {
  const expected = documentText(documentNumber);
  if (!expected) invalid("identity-binding");
  for (const identity of identities) {
    const received = identity.documentNumber;
    if (received !== undefined && received !== null && String(received).trim() && documentText(received) !== expected) invalid("identity-binding");
  }
}

// Veriff supplies these components. No part of DataCrédito's full name is split,
// inferred, duplicated or substituted, including compound surnames and ñ.
export function resolveFirmaSeguroFullNameIdentity(input: {
  fullName: string;
  documentNumber: string;
  validationId: number;
  veriffDocumentNumber: unknown;
  firstName: unknown;
  lastName: unknown;
  additionalIdentities?: readonly NameEvidence[];
}): FirmaSeguroFullNameIdentity {
  const documentNumber = documentText(input.documentNumber);
  const firstName = nameText(input.firstName);
  const firstLastName = nameText(input.lastName);
  const canonical = comparableName(input.fullName);
  const validName = (value: string) => value.length >= 2 && value.length <= 100 && /^[\p{L}\p{M} '’-]+$/u.test(value);
  if (!Number.isSafeInteger(input.validationId) || input.validationId <= 0 || !documentNumber ||
      documentText(input.veriffDocumentNumber) !== documentNumber || !canonical) invalid("identity-binding");
  assertFirmaSeguroVeriffEvidenceDocuments(documentNumber, input.additionalIdentities || []);
  if (!firstName || !firstLastName) invalid("components-required");
  if (!validName(firstName) || !validName(firstLastName)) invalid("invalid-components");
  if (comparableName(`${firstName} ${firstLastName}`) !== canonical) invalid("name-conflict");
  for (const evidence of input.additionalIdentities || []) {
    const evidenceFirst = nameText(evidence.firstName);
    const evidenceLast = nameText(evidence.lastName);
    if ((evidenceFirst && comparableName(evidenceFirst) !== comparableName(firstName)) ||
        (evidenceLast && comparableName(evidenceLast) !== comparableName(firstLastName)) ||
        (nameText(evidence.fullName) && comparableName(evidence.fullName) !== canonical)) invalid("name-conflict");
  }
  return { source: "VERIFF", validationId: input.validationId, documentNumber,
    canonicalFullName: input.fullName, firstName, firstLastName, secondName: null, secondLastName: null };
}

/** Select a complete pair from one payload; partial evidence corroborates but never supplies another field. */
export function resolveFirmaSeguroFullNameIdentityFromEvidence(input: {
  fullName: string; documentNumber: string; validationId: number;
  veriffDocumentNumber: unknown; identities: readonly NameEvidence[];
}): FirmaSeguroFullNameIdentity {
  const complete = input.identities.find(identity => nameText(identity.firstName) && nameText(identity.lastName));
  return resolveFirmaSeguroFullNameIdentity({ ...input, firstName: complete?.firstName,
    lastName: complete?.lastName, additionalIdentities: input.identities });
}

// Metadata is created on the server and sealed with the PDF snapshot. Validate
// its binding again before adapting either FirmaSeguro create endpoint.
export function readFirmaSeguroFullNameIdentity(metadata: unknown, expected: { fullName: string; documentNumber: string }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid();
  const value = metadata as Record<string, unknown>;
  if (value.source === "AUTHORIZED_REVIEW") {
    if (value.canonicalFullName !== expected.fullName || value.secondName !== null) invalid();
    return resolveReviewedFirmaSeguroFullNameIdentity({ ...expected,
      reviewId: value.reviewId, validationId: value.validationId, firstNames: value.firstName,
      firstSurname: value.firstLastName, secondSurname: value.secondLastName,
      reviewedDocumentNumber: value.documentNumber });
  }
  if (value.source !== "VERIFF" || value.canonicalFullName !== expected.fullName ||
      value.secondName !== null || value.secondLastName !== null) invalid();
  return resolveFirmaSeguroFullNameIdentity({ ...expected,
    validationId: typeof value.validationId === "number" ? value.validationId : 0,
    veriffDocumentNumber: value.documentNumber, firstName: value.firstName, lastName: value.firstLastName });
}

/** Explicit administrative transcription from the CC, never provider-derived components. */
export function resolveReviewedFirmaSeguroFullNameIdentity(input: {
  fullName: string; documentNumber: string; reviewId: unknown; validationId: unknown;
  reviewedDocumentNumber: unknown; firstNames: unknown; firstSurname: unknown; secondSurname: unknown;
}): FirmaSeguroFullNameIdentity {
  const firstName = nameText(input.firstNames), firstLastName = nameText(input.firstSurname);
  const secondLastName = nameText(input.secondSurname);
  const validName = (value: string) => value.length >= 2 && value.length <= 100 && /^[\p{L}\p{M} '’-]+$/u.test(value);
  const documentNumber = documentText(input.documentNumber);
  if (typeof input.reviewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.reviewId) ||
      typeof input.validationId !== "number" || !Number.isSafeInteger(input.validationId) || input.validationId <= 0 ||
      !documentNumber || documentText(input.reviewedDocumentNumber) !== documentNumber ||
      !validName(firstName) || !validName(firstLastName) || (secondLastName && !validName(secondLastName)) ||
      comparableReviewedName([firstName, firstLastName, secondLastName].filter(Boolean).join(" ")) !== comparableReviewedName(input.fullName)) invalid();
  return { source: "AUTHORIZED_REVIEW", reviewId: input.reviewId, validationId: input.validationId,
    documentNumber, canonicalFullName: input.fullName, firstName, firstLastName,
    secondName: null, secondLastName: secondLastName || null };
}
