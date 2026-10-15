import "server-only";

import { extractFirmaSeguroStatus, firmaSeguroGetProcessStatus, firmaSeguroGetSignaturesStatus,
  type FirmaSeguroSignatureEditInput } from "@/lib/firmaseguro";
import { isVerifiedPendingSignatureStatus } from "@/lib/approval-operations-core";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

type RecordValue = Record<string, unknown>;
export type FirmaSeguroKnownRecipient = {
  processUuid: string;
  signatureId: number;
  phone: string;
  email: string | null;
  confirmedAt: Date | string;
};
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
function validPhone(value: string) { return /^3\d{9}$/.test(value); }
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function hasOwn(value: RecordValue, key: string) { return Object.prototype.hasOwnProperty.call(value, key); }
function hasCompletedEvidence(payload: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (Array.isArray(payload)) return payload.some(item => hasCompletedEvidence(item, depth + 1));
  const value = record(payload);
  if (!value) return false;
  const flags = ["isSigned", "is_signed", "signed", "declined", "isDeclined", "is_declined"];
  const dates = ["signedAt", "signed_at", "signDate", "sign_date", "date_signed", "dateSigned",
    "date_signed_process", "completedAt", "completed_at", "date_completed", "dateCompleted",
    "declinedAt", "declined_at", "date_declined", "dateDeclined", "date_declined_process"];
  return flags.some(key => value[key] === true) || dates.some(key => value[key] !== undefined &&
    value[key] !== null && !(typeof value[key] === "string" && !text(value[key]))) ||
    ["data", "result", "processes", "signatures"].some(key => hasCompletedEvidence(value[key], depth + 1));
}
function knownRecipientBinding(value: FirmaSeguroKnownRecipient | undefined, processUuid: string, signatureId: number) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") rejectMetadata();
  const confirmedAt = value.confirmedAt instanceof Date ? value.confirmedAt.getTime()
    : typeof value.confirmedAt === "string" && value.confirmedAt.trim() ? Date.parse(value.confirmedAt) : NaN;
  if (value.processUuid !== processUuid || value.signatureId !== signatureId ||
    !Number.isFinite(confirmedAt) || confirmedAt <= 0 || confirmedAt > Date.now() ||
    !validPhone(text(value.phone)) || !validEmail(text(value.email))) rejectMetadata();
  return { phone: text(value.phone), email: text(value.email) };
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
  const phone = record(contact.phone);
  return { source, firstName, firstLastName, identification, identificationTypeId, auth,
    phone: text(field(contact, "mobile_number", "mobileNumber", "number")) || text(phone?.number),
    email: text(contact.email), indicative: text(contact.indicative) || text(phone?.indicative),
    secondName: text(field(person, "second_name", "secondName")) || null,
    secondLastName: text(field(person, "second_last_name", "secondLastName")) || null };
}

/** Full contacts are verified by readback. The observed production status-only
 * response is bound to one process and signer; its phone is a frozen snapshot or
 * an acknowledged edit, never a provider readback. */
export function parsePendingFirmaSeguroRecipient(process: FirmaSeguroProcessRow,
  processStatusPayload: unknown, signaturesPayload: unknown, knownRecipient?: FirmaSeguroKnownRecipient) {
  if (process.supersededAt || process.completedAt || process.signedDocumentBase64 ||
    !isVerifiedPendingSignatureStatus(process.status) ||
    !isVerifiedPendingSignatureStatus(extractFirmaSeguroStatus(processStatusPayload)) ||
    hasCompletedEvidence(processStatusPayload) || hasCompletedEvidence(signaturesPayload)) {
    throw new FirmaSeguroRecipientProviderError("FIRMASEGURO_SIGNATURE_NOT_PENDING",
      "La firma ya no está pendiente o el proceso no está activo. No se modificará el documento.");
  }
  const source = originalSigner(process);
  const [signer] = signerList(signaturesPayload);
  const ids = [signer.signature_id, signer.signatureId, signer.id].filter(value => value !== undefined && value !== null);
  if (!ids.length || ids.some(value => integer(value) === null) || new Set(ids).size !== 1) rejectMetadata();
  const signatureId = integer(ids[0]);
  const outer = record(signaturesPayload);
  for (const container of [signer, outer]) {
    if (!container) continue;
    const keys = container === signer ? ["processUuid", "process_uuid"] : ["uuid", "processUuid", "process_uuid"];
    if (keys.some(key => hasOwn(container, key) && text(container[key]) !== process.processUuid)) rejectMetadata();
  }
  if (!signatureId) rejectMetadata();
  const binding = knownRecipientBinding(knownRecipient, process.processUuid, signatureId);
  const status = field(signer, "status", "state", "signatureStatus", "signature_status");
  if (!isVerifiedPendingSignatureStatus(status)) {
    throw new FirmaSeguroRecipientProviderError("FIRMASEGURO_SIGNATURE_NOT_PENDING",
      "El firmante ya no está pendiente. Consulta el proceso antes de reenviar.");
  }
  // This is the exact status-only shape observed in production. Partial contact
  // data must not fall back to the frozen request and hide a contradiction.
  const metadataKeys = new Set(["id", "email", "status", "date_signed", "code_message", "message"]);
  const metadataOnly = Object.keys(signer).every(key => metadataKeys.has(key));
  if (metadataOnly) {
    if (!outer || outer.uuid !== process.processUuid || !Array.isArray(outer.signatures) ||
      [outer.processUuid, outer.process_uuid].some(value => value !== undefined && value !== null && value !== process.processUuid) ||
      outer.signatures.length !== 1 || outer.signatures[0] !== signer ||
      !isVerifiedPendingSignatureStatus(outer.status_process) ||
      !hasOwn(signer, "date_signed") || typeof signer.date_signed !== "string" || text(signer.date_signed) ||
      signer.code_message !== 1 || typeof signer.message !== "string" || integer(signer.id) !== signatureId ||
      !validPhone(source.phone) || !validEmail(source.email) ||
      (source.indicative && !["57", "+57"].includes(source.indicative))) rejectMetadata();
    const processStatus = record(processStatusPayload);
    if (processStatus && [processStatus.uuid, processStatus.processUuid, processStatus.process_uuid]
      .some(value => value !== undefined && value !== null && value !== process.processUuid)) rejectMetadata();
    if (processStatus && hasOwn(processStatus, "processes")) {
      const processes = processStatus.processes;
      if (!Array.isArray(processes) || processes.length !== 1 ||
        record(processes[0])?.uuid !== process.processUuid) rejectMetadata();
    }
    const email = text(signer.email);
    const expectedContact = binding ?? { phone: source.phone, email: source.email };
    if (!validEmail(email) || email !== expectedContact.email) rejectMetadata();
    const editPayload: FirmaSeguroSignatureEditInput = {
      uuid: process.processUuid, signature_id: signatureId, authentication_method_id: source.auth,
      contact_information: {
        email, first_name: source.firstName, second_name: source.secondName,
        first_last_name: source.firstLastName, second_last_name: source.secondLastName,
        identification: source.identification, identification_type_id: source.identificationTypeId,
        indicative: source.indicative || "57", mobile_number: expectedContact.phone,
      },
      signatory_type: text(source.source.signatory_type) || null,
      template_rol: text(source.source.rol) || null,
    };
    return { signatureId, phone: expectedContact.phone, email, editPayload,
      contactVerification: "BOUND_METADATA" as const,
      contactSource: binding ? "ACKNOWLEDGED_EDIT" as const : "FROZEN_REQUEST" as const };
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
  if (!validPhone(phone) || !validEmail(email)) rejectMetadata();
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
  return { signatureId, phone, email, editPayload, contactVerification: "PROVIDER_READBACK" as const,
    contactSource: "PROVIDER_READBACK" as const };
}

export async function inspectPendingFirmaSeguroRecipient(token: string, process: FirmaSeguroProcessRow,
  knownRecipient?: FirmaSeguroKnownRecipient) {
  const [status, signatures] = await Promise.all([
    firmaSeguroGetProcessStatus(token, process.processUuid, { timeoutMs: 30_000 }),
    firmaSeguroGetSignaturesStatus(token, process.processUuid, { timeoutMs: 30_000 }),
  ]);
  return parsePendingFirmaSeguroRecipient(process, status, signatures, knownRecipient);
}
