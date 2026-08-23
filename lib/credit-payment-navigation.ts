type CreditPaymentRouteInput = {
  id: number;
  clienteDocumento?: string | null;
  clienteTelefono?: string | null;
  folio?: string | null;
};

export function buildCreditPaymentHref(credit: CreditPaymentRouteInput) {
  const params = new URLSearchParams();
  const searchValue = [
    credit.clienteDocumento,
    credit.clienteTelefono,
    credit.folio,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);

  if (searchValue) {
    params.set("search", searchValue);
  }

  params.set("selected", String(credit.id));

  return `/dashboard/abonos?${params.toString()}`;
}
