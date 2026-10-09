import "server-only";

import { extractFirmaSeguroStatus, firmaSeguroGetProcessStatus, firmaSeguroGetSignaturesStatus,
  type FirmaSeguroSignatureEditInput } from "@/lib/firmaseguro";
import { isVerifiedPendingSignatureStatus } from "@/lib/approval-operations-core";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

type RecordValue = Record<string, unknown>;
export class FirmaSeguroRecipientProviderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message); this.name = "FirmaSeguroRecipientProviderError";
    this.code = code; this.status = status;
  }
}
function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : null;
}
function field(value: RecordValue, ...keys: string[]) {
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return undefined;
}
function rejectMetadata(): never {
  throw new FirmaSeguroRecipientProviderError("FIRMASEGURO_RECIPIENT_UNVERIFIED",
    "FirmaSeguro no devolvió los datos verificables del firmante. Revisa el mismo proceso en su plataforma.");
}
function signerList(payload: unknown): RecordValue[] {
  let value = payload;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(value)) {
      if (value.length !== 1 || !record(value[0])) rejectMetadata();
      return [record(value[0])!];
    }
    const outer = record(value);
    if (!outer || field(outer, "success", "ok", "isSuccess") === false) rejectMetadata();
    value = field(outer, "signatures", "data");
  }
  return rejectMetadata();
}
function originalSigner(process: FirmaSeguroProcessRow) {
  const request = record(process.requestPayload);
  const payload = record(request?.payload ?? request);
  if (!payload) rejectMetadata();
  const lists = [payload.signatures, payload.signers].filter(value => value !== undefined && value !== null);
  if (lists.length !== 1 || !Array.isArray(lists[0]) || lists[0].length !== 1) rejectMetadata();
  const source = record(lists[0][0]);
  if (!source) rejectMetadata();
  const contact = record(field(source, "contact_information", "contactInformation")) ?? source;
  const person = record(contact.person) ?? contact;
  const firstName = text(field(person, "first_name", "firstName"));
  const firstLastName = text(field(person, "first_last_name", "firstLastName"));
  const identification = text(person.identification);
  const identificationTypeId = integer(field(person, "identification_type_id", "identificationTypeId"));
  const auth = integer(field(source, "authentication_method_id", "authenticationMethodId"));
  if (firstName.length < 2 || firstLastName.length < 2 || !identification || !identificationTypeId || !auth) rejectMetadata();
  return { source, firstName, firstLastName, identification, identificationTypeId, auth,
    secondName: text(field(person, "second_name", "secondName")) || null,
    secondLastName: text(field(person, "second_last_name", "secondLastName")) || null };
}

/** The provider leaves GET response schemas untyped. Accept only explicit signer
 * metadata with matching identity; unknown responses must never trigger a write. */
export function parsePendingFirmaSeguroRecipient(process: FirmaSeguroProcessRow,
  processStatusPayload: unknown, signaturesPayload: unknown) {
  if (process.supersededAt || process.completedAt || process.signedDocumentBase64 ||
    !isVerifiedPendingSignatureStatus(process.status) ||
    !isVerifiedPendingSignatureStatus(extractFirmaSeguroStatus(processStatusPayload))) {
    throw new FirmaSeguroRecipientProviderError("FIRMASEGURO_SIGNATURE_NOT_PENDING",
      "La firma ya no está pendiente o el proceso no está activo. No se modificará el documento.");
  }
  const source = originalSigner(process);
  const [signer] = signerList(signaturesPayload);
  const ids = [signer.signature_id, signer.signatureId, signer.id].filter(value => value !== undefined && value !== null);
  if (!ids.length || ids.some(value => integer(value) === null) || new Set(ids).size !== 1) rejectMetadata();
  const signatureId = integer(ids[0]);
  const signerUuid = text(field(signer, "processUuid", "process_uuid"));
  if (signerUuid && signerUuid !== process.processUuid) rejectMetadata();
  if (!signatureId) rejectMetadata();
  const status = field(signer, "status", "state", "signatureStatus", "signature_status");
  if (!isVerifiedPendingSignatureStatus(status) ||
    ["isSigned", "is_signed", "signed", "declined", "isDeclined", "is_declined"].some(key => signer[key] === true) ||
    ["signedAt", "signed_at", "signDate", "sign_date", "declinedAt", "declined_at"].some(key => signer[key])) {
    throw new FirmaSeguroRecipientProviderError("FIRMASEGURO_SIGNATURE_NOT_PENDING",
      "El firmante ya no está pendiente. Consulta el proceso antes de reenviar.");
  }
  const contact = record(field(signer, "contact_information", "contactInformation")) ?? signer;
  const person = record(contact.person) ?? contact;
  // A process ID, a different person, or an unrelated nested ID is not a signer.
  if (text(person.identification) !== source.identification ||
    text(field(person, "first_name", "firstName")) !== source.firstName ||
    text(field(person, "first_last_name", "firstLastName")) !== source.firstLastName) rejectMetadata();
  const phoneRecord = record(contact.phone);
  const phone = text(field(contact, "mobile_number", "mobileNumber")) || text(phoneRecord?.number);
  const email = text(contact.email);
  if (!/^3\d{9}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) rejectMetadata();
  const indicative = text(contact.indicative) || text(phoneRecord?.indicative);
  if (indicative && !["57", "+57"].includes(indicative)) rejectMetadata();
  const auth = integer(field(signer, "authentication_method_id", "authenticationMethodId")) ?? source.auth;
  const editPayload: FirmaSeguroSignatureEditInput = {
    uuid: process.processUuid, signature_id: signatureId, authentication_method_id: auth,
    contact_information: {
      email, first_name: source.firstName, second_name: source.secondName,
      first_last_name: source.firstLastName, second_last_name: source.secondLastName,
      identification: source.identification, identification_type_id: source.identificationTypeId,
      indicative: indicative || "57", mobile_number: phone,
    },
    signatory_type: text(signer.signatory_type) || text(source.source.signatory_type) || null,
    template_rol: text(signer.template_rol) || text(source.source.rol) || null,
  };
  return { signatureId, phone, email, editPayload };
}

export async function inspectPendingFirmaSeguroRecipient(token: string, process: FirmaSeguroProcessRow) {
  const [status, signatures] = await Promise.all([
    firmaSeguroGetProcessStatus(token, process.processUuid, { timeoutMs: 30_000 }),
    firmaSeguroGetSignaturesStatus(token, process.processUuid, { timeoutMs: 30_000 }),
  ]);
  return parsePendingFirmaSeguroRecipient(process, status, signatures);
}
