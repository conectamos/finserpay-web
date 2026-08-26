export type CreditClientFormValues = {
  clientePrimerNombre: string;
  clientePrimerApellido: string;
  clienteTipoDocumento: string;
  clienteDocumento: string;
  clienteFechaExpedicion: string;
  clienteFechaNacimiento: string;
  clienteTelefono: string;
  clienteCorreo: string;
  clienteDepartamento: string;
  clienteCiudad: string;
  clienteGenero: string;
  clienteEstadoCivil: string;
  clienteEstrato: string;
  clienteDireccion: string;
  referenciaFamiliar1Nombre: string;
  referenciaFamiliar1Parentesco: string;
  referenciaFamiliar1Telefono: string;
  referenciaFamiliar2Nombre: string;
  referenciaFamiliar2Parentesco: string;
  referenciaFamiliar2Telefono: string;
};

export type CreditClientField = keyof CreditClientFormValues;

export type CreditClientValidationResult = {
  errors: Partial<Record<CreditClientField, string>>;
  personalComplete: boolean;
  contactComplete: boolean;
  referencesComplete: boolean;
  complete: boolean;
  completedBlocks: number;
  firstInvalidField: CreditClientField | null;
};

const PERSONAL_FIELDS: CreditClientField[] = [
  "clientePrimerNombre",
  "clientePrimerApellido",
  "clienteTipoDocumento",
  "clienteDocumento",
  "clienteFechaExpedicion",
  "clienteFechaNacimiento",
];

const CONTACT_FIELDS: CreditClientField[] = [
  "clienteTelefono",
  "clienteCorreo",
  "clienteDepartamento",
  "clienteCiudad",
  "clienteGenero",
  "clienteEstadoCivil",
  "clienteEstrato",
  "clienteDireccion",
];

const REFERENCE_FIELDS: CreditClientField[] = [
  "referenciaFamiliar1Nombre",
  "referenciaFamiliar1Parentesco",
  "referenciaFamiliar1Telefono",
  "referenciaFamiliar2Nombre",
  "referenciaFamiliar2Parentesco",
  "referenciaFamiliar2Telefono",
];

export const CREDIT_CLIENT_FIELD_ORDER: CreditClientField[] = [
  ...PERSONAL_FIELDS,
  ...CONTACT_FIELDS,
  ...REFERENCE_FIELDS,
];

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function parseIsoDate(value: unknown) {
  const normalized = normalizeText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function hasErrors(
  fields: CreditClientField[],
  errors: Partial<Record<CreditClientField, string>>
) {
  return fields.some((field) => Boolean(errors[field]));
}

export function validateCreditClientForm(
  values: CreditClientFormValues,
  now = new Date()
): CreditClientValidationResult {
  const errors: Partial<Record<CreditClientField, string>> = {};
  const required = (field: CreditClientField, label: string) => {
    if (!normalizeText(values[field])) {
      errors[field] = `${label} es obligatorio.`;
    }
  };

  required("clientePrimerNombre", "El primer nombre");
  required("clientePrimerApellido", "El primer apellido");
  required("clienteTipoDocumento", "El tipo de documento");
  required("clienteDocumento", "El numero de documento");
  required("clienteFechaExpedicion", "La fecha de expedicion");
  required("clienteFechaNacimiento", "La fecha de nacimiento");
  required("clienteTelefono", "El celular con WhatsApp");
  required("clienteCorreo", "El correo electronico");
  required("clienteDepartamento", "El departamento");
  required("clienteCiudad", "La ciudad");
  required("clienteGenero", "El genero");
  required("clienteEstadoCivil", "El estado civil");
  required("clienteEstrato", "El estrato");
  required("clienteDireccion", "La direccion completa");
  required("referenciaFamiliar1Nombre", "El nombre de la referencia 1");
  required("referenciaFamiliar1Parentesco", "El parentesco de la referencia 1");
  required("referenciaFamiliar1Telefono", "El telefono de la referencia 1");
  required("referenciaFamiliar2Nombre", "El nombre de la referencia 2");
  required("referenciaFamiliar2Parentesco", "El parentesco de la referencia 2");
  required("referenciaFamiliar2Telefono", "El telefono de la referencia 2");

  if (
    !errors.clientePrimerNombre &&
    normalizeText(values.clientePrimerNombre).length < 2
  ) {
    errors.clientePrimerNombre = "Ingresa un primer nombre valido.";
  }

  if (
    !errors.clientePrimerApellido &&
    normalizeText(values.clientePrimerApellido).length < 2
  ) {
    errors.clientePrimerApellido = "Ingresa un primer apellido valido.";
  }

  if (!errors.clienteDocumento && !/^\d{5,15}$/.test(digits(values.clienteDocumento))) {
    errors.clienteDocumento = "El documento debe tener entre 5 y 15 numeros.";
  }

  const birthDate = parseIsoDate(values.clienteFechaNacimiento);
  const issueDate = parseIsoDate(values.clienteFechaExpedicion);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  if (!errors.clienteFechaNacimiento && !birthDate) {
    errors.clienteFechaNacimiento = "Ingresa una fecha de nacimiento valida.";
  } else if (birthDate && birthDate > today) {
    errors.clienteFechaNacimiento = "La fecha de nacimiento no puede estar en el futuro.";
  }

  if (!errors.clienteFechaExpedicion && !issueDate) {
    errors.clienteFechaExpedicion = "Ingresa una fecha de expedicion valida.";
  } else if (issueDate && issueDate > today) {
    errors.clienteFechaExpedicion = "La fecha de expedicion no puede estar en el futuro.";
  } else if (issueDate && birthDate && issueDate < birthDate) {
    errors.clienteFechaExpedicion =
      "La fecha de expedicion no puede ser anterior al nacimiento.";
  }

  if (!errors.clienteTelefono && !/^\d{10}$/.test(digits(values.clienteTelefono))) {
    errors.clienteTelefono = "Ingresa un celular colombiano de 10 numeros.";
  }

  if (
    !errors.clienteCorreo &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeText(values.clienteCorreo))
  ) {
    errors.clienteCorreo = "Ingresa un correo electronico valido.";
  }

  if (!errors.clienteDireccion && normalizeText(values.clienteDireccion).length < 5) {
    errors.clienteDireccion = "Ingresa una direccion completa.";
  }

  const phoneFields = [
    "clienteTelefono",
    "referenciaFamiliar1Telefono",
    "referenciaFamiliar2Telefono",
  ] as const;

  for (const field of phoneFields.slice(1)) {
    if (!errors[field] && !/^\d{10}$/.test(digits(values[field]))) {
      errors[field] = "Ingresa un telefono valido de 10 numeros.";
    }
  }

  for (const field of phoneFields) {
    const normalizedPhone = digits(values[field]);
    if (errors[field] || normalizedPhone.length !== 10) {
      continue;
    }

    const isDuplicated = phoneFields.some(
      (otherField) =>
        otherField !== field && digits(values[otherField]) === normalizedPhone
    );

    if (isDuplicated) {
      errors[field] = "Este telefono debe ser diferente a los otros contactos.";
    }
  }

  const personalComplete = !hasErrors(PERSONAL_FIELDS, errors);
  const contactComplete = personalComplete && !hasErrors(CONTACT_FIELDS, errors);
  const referencesComplete = contactComplete && !hasErrors(REFERENCE_FIELDS, errors);
  const firstInvalidField =
    CREDIT_CLIENT_FIELD_ORDER.find((field) => Boolean(errors[field])) ?? null;

  return {
    errors,
    personalComplete,
    contactComplete,
    referencesComplete,
    complete: referencesComplete,
    completedBlocks: referencesComplete ? 3 : contactComplete ? 2 : personalComplete ? 1 : 0,
    firstInvalidField,
  };
}
