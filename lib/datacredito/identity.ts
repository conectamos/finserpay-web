export type DataCreditoIdentity = {
  names: string; firstSurname: string; secondSurname: string;
  documentType: string; documentNumber: string; fullName: string; missing: string[];
  nameMode?: "FULL_NAME_ONLY";
  manuallyCompleted?: string[];
};
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "";
const documentFieldText = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : text(v);
type DataCreditoQueryIdentity = { documentNumber: string; documentType: "CEDULA_DE_CIUDADANIA" };
// This binding must come from the encrypted server record of the approved CC
// query. Its values describe the query, never missing provider identity fields.
export function assertDataCreditoQueryIdentity(original: DataCreditoIdentity, input: Record<string, unknown>, query: DataCreditoQueryIdentity) {
  const documentNumber = text(input.clienteDocumento).replace(/[.\s]/g, "");
  if (!/^\d+$/.test(query.documentNumber) || documentNumber !== query.documentNumber ||
    (original.documentNumber && original.documentNumber !== query.documentNumber)) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
  const documentType = text(input.clienteTipoDocumento);
  if (query.documentType !== "CEDULA_DE_CIUDADANIA" ||
    (original.documentType && original.documentType !== query.documentType) ||
    (documentType && documentType !== query.documentType)) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
}
export function extractDataCreditoIdentity(payload: unknown, queriedDocument: string): DataCreditoIdentity {
  const content = record(record(payload).content);
  const basics = record(record(record(content.respuesta).validacion).datosBasicos);
  const available = [true, 1, "1", "true", "S", "SI", "si", "sí"].includes(basics.conInformacion as never);
  const returnedDocument = available ? documentFieldText(basics.numeroDocumento).replace(/[.\s]/g, "") : "";
  // A Colombian CC is numeric; fixed-width provider fields may pad it with zeros.
  // Compare strings without numeric conversion (and without losing precision).
  const documentNumber = returnedDocument.replace(/^0+(?=\d)/, "");
  const expectedDocument = queriedDocument.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (documentNumber && (!/^\d+$/.test(documentNumber) || documentNumber !== expectedDocument)) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
  const rawType = available ? documentFieldText(basics.tipoDocumento) : "";
  const documentTypeKey = rawType.normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase("es-CO");
  const documentType = ["1", "CC", "C.C.", "CEDULA_DE_CIUDADANIA", "CEDULA DE CIUDADANIA"].includes(documentTypeKey) ? "CEDULA_DE_CIUDADANIA" : rawType;
  const names = available ? [text(basics.primerNombre), text(basics.segundoNombre)].filter(Boolean).join(" ") : "";
  const firstSurname = available ? text(basics.primerApellido) : "";
  const secondSurname = available ? text(basics.segundoApellido) : "";
  const fullName = available && typeof basics.nombreCompleto === "string"
    ? basics.nombreCompleto.normalize("NFC").trim()
    : "";
  const fullNameOnly = Boolean(fullName) && (!names || !firstSurname);
  return { names, firstSurname, secondSurname, documentNumber, documentType,
    fullName,
    ...(fullNameOnly ? { nameMode: "FULL_NAME_ONLY" as const } : {}),
    missing: [!fullNameOnly && !names && "Nombre(s)", !fullNameOnly && !firstSurname && "Primer apellido", !documentNumber && "Número de documento", !documentType && "Tipo de documento"].filter(Boolean) as string[] };
}
function resolveDataCreditoNameCorrection(original: DataCreditoIdentity, input: Record<string, unknown>, incompleteDraft = false) {
  const names = incompleteDraft && !Object.hasOwn(input, "clientePrimerNombre") ? original.names : text(input.clientePrimerNombre);
  const secondSurname = incompleteDraft && !Object.hasOwn(input, "clienteSegundoApellido") ? original.secondSurname : text(input.clienteSegundoApellido);
  if ((!names && !incompleteDraft) || names.length > 180 || secondSurname.length > 90 ||
    (names && !/^[\p{L}\p{M} '’-]+$/u.test(names)) || (secondSurname && !/^[\p{L}\p{M} '’-]+$/u.test(secondSurname))) throw new Error("DATACREDITO_IDENTITY_INVALID_NAMES");
  return { ...original, names, secondSurname,
    missing: [!names && "Nombre(s)", !original.firstSurname && "Primer apellido", !original.documentNumber && "Número de documento", !original.documentType && "Tipo de documento"].filter(Boolean) as string[],
    fullName: [names, original.firstSurname, secondSurname].filter(Boolean).join(" ") };
}
export function resolveDataCreditoIncompleteDraftIdentity(original: DataCreditoIdentity, input: Record<string, unknown>, queryIdentity: DataCreditoQueryIdentity) {
  assertDataCreditoQueryIdentity(original, input, queryIdentity);
  if (original.firstSurname && original.firstSurname !== text(input.clientePrimerApellido)) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
  return resolveDataCreditoNameCorrection(original, input, true);
}
export function resolveDataCreditoIdentity(original: DataCreditoIdentity, input: Record<string, unknown>, queryIdentity?: DataCreditoQueryIdentity) {
  if (queryIdentity) assertDataCreditoQueryIdentity(original, input, queryIdentity);
  const documentNumber = original.documentNumber || queryIdentity?.documentNumber || "";
  const documentType = original.documentType || queryIdentity?.documentType || "";
  const incomingDocumentType = text(input.clienteTipoDocumento) || (!original.documentType ? queryIdentity?.documentType || "" : "");
  if (original.nameMode === "FULL_NAME_ONLY") {
    if (documentNumber !== text(input.clienteDocumento).replace(/[.\s]/g, "") || documentType !== incomingDocumentType) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
    if (!original.fullName || !documentNumber || !documentType) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
    if (input.clienteNombre && text(input.clienteNombre) !== text(original.fullName)) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
    // An unstructured legal name is authoritative as a whole. Never infer its
    // components from spaces or from the surname used to request the query.
    return { ...original };
  }
  if (original.firstSurname !== text(input.clientePrimerApellido) || documentNumber !== text(input.clienteDocumento).replace(/[.\s]/g, "") || documentType !== incomingDocumentType) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
  if (!original.firstSurname || !documentNumber || !documentType) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
  return resolveDataCreditoNameCorrection(original, input);
}

export function dataCreditoIdentityToFirmaSeguroNames(identity: DataCreditoIdentity) {
  if (!identity.names || !identity.firstSurname) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
  return { firstName: identity.names, secondName: null, firstLastName: identity.firstSurname, secondLastName: identity.secondSurname || null };
}
