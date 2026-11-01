// Meta recipients are opaque identifiers. Never derive a phone by stripping
// non-digits from a BSUID; its numeric suffix is not the person's phone number.
const PHONE = /^[1-9]\d{6,14}$/;
const BUSINESS_USER_ID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;

/** Canonical WhatsApp phone recipient: E.164 digits without the leading +. */
export function isMetaPhoneRecipient(value: unknown): value is string {
  return typeof value === "string" && PHONE.test(value);
}

/** Ordinary portfolio-scoped BSUID; parent BSUIDs require separate enablement. */
export function isMetaBusinessUserId(value: unknown): value is string {
  return typeof value === "string" && BUSINESS_USER_ID.test(value);
}

export function isMetaRecipient(value: unknown): value is string {
  return isMetaPhoneRecipient(value) || isMetaBusinessUserId(value);
}

export function metaRecipientPhone(value: unknown): string | null {
  return isMetaPhoneRecipient(value) ? `+${value}` : null;
}
