export type FirmaSeguroFullNameIdentity = {
  source: "VERIFF";
  validationId: number;
  documentNumber: string;
  canonicalFullName: string;
  firstName: string;
  firstLastName: string;
  secondName: null;
  secondLastName: null;
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
    super("FirmaSeguro requiere nombres y apellidos estructurados de la validación Veriff aprobada, correspondientes al mismo documento y al nombre completo de DataCrédito. Revisa la identidad existente; no se realizó un envío a FirmaSeguro ni una nueva consulta a DataCrédito.");
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
  if (value.source !== "VERIFF" || value.canonicalFullName !== expected.fullName ||
      value.secondName !== null || value.secondLastName !== null) invalid();
  return resolveFirmaSeguroFullNameIdentity({ ...expected,
    validationId: typeof value.validationId === "number" ? value.validationId : 0,
    veriffDocumentNumber: value.documentNumber, firstName: value.firstName, lastName: value.firstLastName });
}
