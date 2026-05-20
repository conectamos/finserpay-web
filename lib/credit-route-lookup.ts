export type CreditRouteLookup = {
  id: number | null;
  folio: string | null;
};

export function parseNumericRouteId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function parseCreditRouteLookup(value: string): CreditRouteLookup {
  const decoded = decodeURIComponent(String(value || "")).trim();
  const id = parseNumericRouteId(decoded);

  return {
    id,
    folio: id ? null : decoded,
  };
}

export function buildCreditLookupWhere(lookup: CreditRouteLookup) {
  return lookup.id ? { id: lookup.id } : { folio: lookup.folio || "" };
}

export function buildSedeScopeIds(
  ...values: Array<number | null | undefined>
) {
  return Array.from(
    new Set(
      values.filter(
        (item): item is number =>
          typeof item === "number" && Number.isInteger(item) && item > 0
      )
    )
  );
}
