export function normalizeIdentityDocumentNumber(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

export function veriffIdentityMatchesExpectedDocument(
  veriffDocumentNumber: unknown,
  expectedDocumentNumber?: unknown
) {
  const expected = normalizeIdentityDocumentNumber(expectedDocumentNumber);

  if (!expected) {
    return true;
  }

  const received = normalizeIdentityDocumentNumber(veriffDocumentNumber);
  return !received || received === expected;
}
