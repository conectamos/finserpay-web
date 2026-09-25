import { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";

/** Identifiers must never be rounded, reconstructed from exponents or truncated. */
export function readImportImei(input: unknown): { value: string; error: string | null } {
  const raw = typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
  // Excel strips the text-prefix apostrophe internally; some CSV editors retain it.
  const value = raw.startsWith("'") ? raw.slice(1) : raw;
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(value)) {
    return { value: raw, error: "IMEI en notación científica. Recupera los 15 dígitos originales, guárdalos como Texto en Excel y vuelve a cargar el archivo." };
  }
  if (!/^\d{15}$/.test(value)) {
    return { value: raw, error: "IMEI debe contener exactamente 15 dígitos. Usa formato Texto; no se completan ni recortan números." };
  }
  if (!isValidCreditDeviceReplacementImei(value)) {
    return { value, error: "IMEI debe tener un dígito de control válido. Verifica el IMEI original del equipo; no inventes ni cambies el último dígito." };
  }
  return { value, error: null };
}
