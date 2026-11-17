/** Fields intentionally withheld by the credit API for non-administrator profiles. */
export const CREDIT_CLIENT_REDACTED_FIELDS = [
  "clienteDireccion",
  "clienteFechaNacimiento",
  "clienteFechaExpedicion",
  "clienteCorreo",
  "clienteGenero",
  "clienteEstadoCivil",
  "clienteEstrato",
  "referenciasFamiliares",
] as const;

export type CreditClientRedactedField = typeof CREDIT_CLIENT_REDACTED_FIELDS[number];

type CreditClientVisibility = {
  redactedClientFields?: readonly CreditClientRedactedField[];
};

export function isCreditClientFieldRedacted(
  credit: CreditClientVisibility | null | undefined,
  field: CreditClientRedactedField
) {
  return credit?.redactedClientFields?.includes(field) === true;
}

/** Presentation only: absence and permission-based redaction are different states. */
export function creditClientFieldDisplay(
  credit: CreditClientVisibility | null | undefined,
  field: CreditClientRedactedField,
  formattedValue: string
) {
  return isCreditClientFieldRedacted(credit, field)
    ? "No visible para este perfil"
    : formattedValue;
}

export function creditClientNamePartDisplay(
  value: unknown,
  nameMode: "FULL_NAME_ONLY" | null | undefined
) {
  const part = String(value ?? "").replace(/\s+/g, " ").trim();
  return part || (nameMode === "FULL_NAME_ONLY"
    ? "Registrado como nombre completo"
    : "No registrado");
}
