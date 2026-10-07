export type CreditReportIdentifiers = { folio: string; numeroSadmin?: string | null; numeroCreditoVisible?: string | null };

/** The report API supplies the confirmed registration number explicitly, without a folio fallback. */
export function creditReportSadmin(item: CreditReportIdentifiers) {
  if ("numeroSadmin" in item) return item.numeroSadmin?.trim() || null;
  const visible = item.numeroCreditoVisible?.trim();
  return visible && visible !== item.folio ? visible : null;
}

export function creditReportDocument(value: string | null | undefined) {
  return String(value ?? "").replace(/[\s.,-]/g, "");
}
