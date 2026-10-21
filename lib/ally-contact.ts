export class AllyContactValidationError extends Error {
  readonly field: "email" | "telefonoWhatsapp";

  constructor(field: "email" | "telefonoWhatsapp", message: string) {
    super(message);
    this.name = "AllyContactValidationError";
    this.field = field;
  }
}

/** Empty contact information is permitted; malformed supplied data is never discarded. */
export function normalizeAllyEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const invalid = () => new AllyContactValidationError("email", "Correo electrónico inválido. Ingresa una sola dirección válida.");
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  const address = value.trim();
  if (!address) return null;
  if (address.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(address)) throw invalid();
  const [local, domain] = address.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      domain.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) throw invalid();
  // Preserve the local part; only the domain is guaranteed case insensitive.
  return `${local}@${domain.toLowerCase()}`;
}

/** Canonical recipient digits for the existing Meta Cloud API integration. */
export function normalizeAllyWhatsApp(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const invalid = () => new AllyContactValidationError("telefonoWhatsapp", "WhatsApp inválido. Usa un celular colombiano de 10 dígitos o un número internacional con indicativo.");
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  const phone = value.trim();
  if (!phone) return null;
  if (phone.length > 32 || !/^\+?[0-9 ()-]+$/.test(phone)) throw invalid();
  let digits = phone.replace(/[^0-9]/g, "");
  const explicitInternational = phone.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!explicitInternational && /^3\d{9}$/.test(digits)) digits = `57${digits}`;
  if (digits.startsWith("57")) {
    if (!/^573\d{9}$/.test(digits)) throw invalid();
  } else if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw invalid();
  }
  return digits;
}
