export type DataCreditoIdentity = {
  names: string; firstSurname: string; secondSurname: string;
  documentType: string; documentNumber: string; fullName: string; missing: string[];
  manuallyCompleted?: string[];
};
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "";
export function extractDataCreditoIdentity(payload: unknown, queriedDocument: string): DataCreditoIdentity {
  const content = record(record(payload).content);
  const basics = record(record(record(content.respuesta).validacion).datosBasicos);
  const available = [true, 1, "1", "true", "S", "SI", "si", "sí"].includes(basics.conInformacion as never);
  const documentNumber = available ? text(basics.numeroDocumento).replace(/[.\s]/g, "") : "";
  if (documentNumber && (!/^\d+$/.test(documentNumber) || documentNumber !== queriedDocument.replace(/\D/g, ""))) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
  const rawType = available ? text(basics.tipoDocumento) : "";
  const documentType = ["1", "CC", "C.C.", "CEDULA_DE_CIUDADANIA", "Cédula de Ciudadanía"].includes(rawType) ? "CEDULA_DE_CIUDADANIA" : rawType;
  const names = available ? [text(basics.primerNombre), text(basics.segundoNombre)].filter(Boolean).join(" ") : "";
  const firstSurname = available ? text(basics.primerApellido) : "";
  const secondSurname = available ? text(basics.segundoApellido) : "";
  return { names, firstSurname, secondSurname, documentNumber, documentType,
    fullName: available ? text(basics.nombreCompleto) : "",
    missing: [!names && "Nombre(s)", !firstSurname && "Primer apellido", !documentNumber && "Número de documento", !documentType && "Tipo de documento"].filter(Boolean) as string[] };
}
export function resolveDataCreditoIdentity(original: DataCreditoIdentity, input: Record<string, unknown>) {
  if (original.firstSurname !== text(input.clientePrimerApellido) || original.documentNumber !== text(input.clienteDocumento).replace(/[.\s]/g, "") || original.documentType !== text(input.clienteTipoDocumento)) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
  if (!original.firstSurname || !original.documentNumber || !original.documentType) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
  const names = text(input.clientePrimerNombre);
  const secondSurname = text(input.clienteSegundoApellido);
  if (!names || names.length > 180 || secondSurname.length > 90 || !/^[\p{L}\p{M} '’-]+$/u.test(names) || (secondSurname && !/^[\p{L}\p{M} '’-]+$/u.test(secondSurname))) throw new Error("DATACREDITO_IDENTITY_INVALID_NAMES");
  return { ...original, names, secondSurname, missing: [], fullName: [names, original.firstSurname, secondSurname].filter(Boolean).join(" ") };
}

export function dataCreditoIdentityToFirmaSeguroNames(identity: DataCreditoIdentity) {
  if (!identity.names || !identity.firstSurname) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
  return { firstName: identity.names, secondName: null, firstLastName: identity.firstSurname, secondLastName: identity.secondSurname || null };
}
