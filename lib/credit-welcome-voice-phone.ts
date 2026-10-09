/** A manual destination accepts Colombian mobile numbers and harmless formatting only. */
export function normalizeManualVoicePhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const input = value.trim();
  if (!/^\+?[0-9 ()-]+$/.test(input)) return null;
  const digits = input.replace(/[ ()-]/g, "").replace(/^\+/, "");
  if (input.startsWith("+") && !digits.startsWith("57")) return null;
  const phone = /^3\d{9}$/.test(digits) ? `57${digits}` : digits;
  return /^573\d{9}$/.test(phone) ? phone : null;
}
