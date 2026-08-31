type PaymentPlanNextInstallment = {
  fechaVencimiento?: string | null;
  numero?: number | null;
} | null;

type ResolveNextPaymentDateAfterPaymentInput = {
  afterPayment: PaymentPlanNextInstallment;
  beforePayment: PaymentPlanNextInstallment;
  currentNextPaymentDate: Date | null;
};

/**
 * Keeps an administrative due-date override while a partial payment remains on
 * the same installment. Once the payment advances the plan, the next
 * installment returns to its contractual calendar.
 */
export function resolveNextPaymentDateAfterPayment(
  input: ResolveNextPaymentDateAfterPaymentInput
) {
  const nextDueDate = String(input.afterPayment?.fechaVencimiento || "").trim();

  if (!nextDueDate) {
    return input.currentNextPaymentDate;
  }

  if (
    input.currentNextPaymentDate &&
    input.beforePayment?.numero != null &&
    input.beforePayment.numero === input.afterPayment?.numero
  ) {
    return input.currentNextPaymentDate;
  }

  return new Date(`${nextDueDate}T12:00:00.000Z`);
}
