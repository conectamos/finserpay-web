export const CREDIT_CONTACT_PHONE_LENGTH = 10;

export type CreditContactPhones = {
  clienteTelefono: unknown;
  referenciaFamiliar1Telefono: unknown;
  referenciaFamiliar2Telefono: unknown;
};

export type CreditContactPhoneValidationCode =
  | "CLIENT_PHONE_INVALID"
  | "REFERENCE_1_PHONE_INVALID"
  | "REFERENCE_2_PHONE_INVALID"
  | "CONTACT_PHONE_DUPLICATE";

export type CreditContactPhoneValidation =
  | {
      ok: true;
      values: {
        clienteTelefono: string;
        referenciaFamiliar1Telefono: string;
        referenciaFamiliar2Telefono: string;
      };
    }
  | {
      ok: false;
      code: CreditContactPhoneValidationCode;
      message: string;
    };

function phoneText(value: unknown) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

export function normalizeCreditContactPhoneInput(value: unknown) {
  const digits = phoneText(value).replace(/\D/g, "");

  if (digits.length === 12 && digits.startsWith("57")) {
    return digits.slice(2);
  }

  if (digits.length === 14 && digits.startsWith("0057")) {
    return digits.slice(4);
  }

  return digits.length <= CREDIT_CONTACT_PHONE_LENGTH ? digits : "";
}

export function isValidCreditContactPhone(value: unknown) {
  return /^\d{10}$/.test(phoneText(value));
}

export function validateCreditContactPhones(
  phones: CreditContactPhones
): CreditContactPhoneValidation {
  const values = {
    clienteTelefono: phoneText(phones.clienteTelefono),
    referenciaFamiliar1Telefono: phoneText(phones.referenciaFamiliar1Telefono),
    referenciaFamiliar2Telefono: phoneText(phones.referenciaFamiliar2Telefono),
  };

  if (!isValidCreditContactPhone(values.clienteTelefono)) {
    return {
      ok: false,
      code: "CLIENT_PHONE_INVALID",
      message: "El número de WhatsApp debe tener exactamente 10 dígitos.",
    };
  }

  if (!isValidCreditContactPhone(values.referenciaFamiliar1Telefono)) {
    return {
      ok: false,
      code: "REFERENCE_1_PHONE_INVALID",
      message: "El teléfono de la referencia familiar 1 debe tener exactamente 10 dígitos.",
    };
  }

  if (!isValidCreditContactPhone(values.referenciaFamiliar2Telefono)) {
    return {
      ok: false,
      code: "REFERENCE_2_PHONE_INVALID",
      message: "El teléfono de la referencia familiar 2 debe tener exactamente 10 dígitos.",
    };
  }

  if (new Set(Object.values(values)).size !== 3) {
    return {
      ok: false,
      code: "CONTACT_PHONE_DUPLICATE",
      message:
        "El WhatsApp del cliente y los teléfonos de las dos referencias deben ser diferentes. No se pueden repetir.",
    };
  }

  return { ok: true, values };
}
