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

type NameEvidence = { firstName?: unknown; lastName?: unknown; fullName?: unknown };
const nameText = (value: unknown) => typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
const comparableName = (value: unknown) => nameText(value).toLocaleUpperCase("es-CO");
function documentText(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:[ .-]\d+)*$/.test(raw)) return "";
  const digits = raw.replace(/[ .-]/g, "");
  return /^\d{3,13}$/.test(digits) ? digits : "";
}
export class FirmaSeguroFullNameIdentityError extends Error {
  readonly code = "FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED";
  readonly status = 409;
  constructor() {
    super("FirmaSeguro requiere nombres y apellidos separados correspondientes al mismo documento y al nombre completo de DataCrédito. Si Veriff aprobó la cédula sin esos componentes, un administrador debe completarlos mediante revisión autorizada. No se realizó un envío ni una nueva consulta.");
    this.name = "FirmaSeguroFullNameIdentityError";
  }
}
function invalid(): never { throw new FirmaSeguroFullNameIdentityError(); }

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
      documentText(input.veriffDocumentNumber) !== documentNumber || !canonical ||
      !validName(firstName) || !validName(firstLastName) ||
      comparableName(`${firstName} ${firstLastName}`) !== canonical) invalid();
  for (const evidence of input.additionalIdentities || []) {
    const evidenceFirst = nameText(evidence.firstName);
    const evidenceLast = nameText(evidence.lastName);
    if ((evidenceFirst && comparableName(evidenceFirst) !== comparableName(firstName)) ||
        (evidenceLast && comparableName(evidenceLast) !== comparableName(firstLastName)) ||
        (nameText(evidence.fullName) && comparableName(evidence.fullName) !== canonical)) invalid();
  }
  return { source: "VERIFF", validationId: input.validationId, documentNumber,
    canonicalFullName: input.fullName, firstName, firstLastName, secondName: null, secondLastName: null };
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
      comparableName([firstName, firstLastName, secondLastName].filter(Boolean).join(" ")) !== comparableName(input.fullName)) invalid();
  return { source: "AUTHORIZED_REVIEW", reviewId: input.reviewId, validationId: input.validationId,
    documentNumber, canonicalFullName: input.fullName, firstName, firstLastName,
    secondName: null, secondLastName: secondLastName || null };
}