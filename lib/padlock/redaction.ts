const AUTHORIZATION_VALUE_PATTERN =
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{6,}/gi;
const JSON_WEB_TOKEN_PATTERN =
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]*\b/gi;
const LABELED_SECRET_PATTERN =
  /(["']?(?:password|passwd|secret|token|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}\]]+)/gi;

export function redactPadlockSensitiveText(value: unknown) {
  return String(value ?? "")
    .replace(AUTHORIZATION_VALUE_PATTERN, "[REDACTED]")
    .replace(JSON_WEB_TOKEN_PATTERN, "[REDACTED]")
    .replace(LABELED_SECRET_PATTERN, "$1[REDACTED]")
    .replace(/\b\d{15}\b/g, "[REDACTED_DEVICE]");
}
