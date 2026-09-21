function parsePositiveInt(value: unknown) {
  const parsed = Number(String(value ?? "").trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveCarteraAliadoId(input: {
  adminCentral: boolean;
  ownAliadoId: unknown;
  requestedAliadoId: unknown;
}) {
  return input.adminCentral
    ? parsePositiveInt(input.requestedAliadoId)
    : parsePositiveInt(input.ownAliadoId);
}
