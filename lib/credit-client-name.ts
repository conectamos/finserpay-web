function normalizedNamePart(value: string | null | undefined) {
  return (value || "").trim().replace(/\s+/g, " ");
}

/** The first surname remains independent for the DataCrédito identity check. */
export function composeCreditClientName(parts: {
  firstNames: string | null | undefined;
  firstSurname: string | null | undefined;
  secondSurname?: string | null | undefined;
}) {
  return [parts.firstNames, parts.firstSurname, parts.secondSurname]
    .map(normalizedNamePart)
    .filter(Boolean)
    .join(" ");
}

/** Recover all given names and an optional second surname from a stored full name. */
export function splitStoredCreditClientName(input: {
  fullName: string | null | undefined;
  firstSurname: string | null | undefined;
}) {
  const fullName = normalizedNamePart(input.fullName);
  const firstSurname = normalizedNamePart(input.firstSurname);
  if (!fullName || !firstSurname) return null;

  const fullUpper = fullName.toLocaleUpperCase("es-CO");
  const surnameUpper = firstSurname.toLocaleUpperCase("es-CO");
  const withSecondSurname = ` ${surnameUpper} `;
  const middleIndex = fullUpper.lastIndexOf(withSecondSurname);
  if (middleIndex > 0) {
    return {
      firstNames: fullName.slice(0, middleIndex),
      firstSurname,
      secondSurname: fullName.slice(middleIndex + withSecondSurname.length),
    };
  }

  const finalSurname = ` ${surnameUpper}`;
  if (fullUpper.endsWith(finalSurname)) {
    return {
      firstNames: fullName.slice(0, -finalSurname.length),
      firstSurname,
      secondSurname: "",
    };
  }
  return null;
}

/** A later Veriff refresh must not replace a name corrected through the audit flow. */
export function hasAuditedCreditIdentityCorrection(payload: Record<string, unknown>) {
  const correction = payload.analystDataCorrection;
  const auditedData = correction && typeof correction === "object" && !Array.isArray(correction)
    ? correction as Record<string, unknown> : {};
  return payload.firmaSeguroIdentityCorrectionPending === true ||
    Boolean(String(payload.firmaSeguroIdentityReissueProcessUuid || "").trim()) ||
    payload.firmaSeguroClientCorrectionPending === true ||
    Boolean(String(payload.firmaSeguroClientCorrectionReissueProcessUuid || "").trim()) ||
    (auditedData.preserveIdentityEvidence === true && Array.isArray(auditedData.fields) &&
      auditedData.fields.some((field) => ["clientePrimerNombre", "clienteSegundoApellido",
        "clienteFechaNacimiento"].includes(String(field))));
}
