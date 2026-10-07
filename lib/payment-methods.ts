export const PAYMENT_METHOD_OPTIONS = [
  {value: "EFECTIVO", label: "Efectivo"},
  {value: "TRANSFERENCIA", label: "Transferencia"},
  {value: "NEQUI", label: "Nequi"},
  {value: "DAVIPLATA", label: "Daviplata"},
  {value: "OTRO", label: "Otro"},
  {value: "BANCOLOMBIA", label: "Bancolombia"},
  {value: "BRE-B", label: "BRE-B"},
] as const;
export function paymentMethodLabel(value: string | null | undefined) {
  const normalized = String(value || "").trim().toUpperCase();
  return PAYMENT_METHOD_OPTIONS.find(option => option.value === normalized)?.label || String(value || "Efectivo");
}
