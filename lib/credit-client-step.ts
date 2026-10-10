import {
  CREDIT_CLIENT_FIELD_ORDER,
  validateCreditClientForm,
  type CreditClientFormValues,
} from "./credit-client-validation";

export class CreditClientStepValidationError extends Error {
  readonly code = "CREDIT_CLIENT_INCOMPLETE";
  readonly status = 422;
  readonly errors;
  readonly firstInvalidField;

  constructor(result: ReturnType<typeof validateCreditClientForm>) {
    super(result.firstInvalidField
      ? result.errors[result.firstInvalidField] || "Completa los datos del cliente."
      : "Completa los datos del cliente.");
    this.name = "CreditClientStepValidationError";
    this.errors = result.errors;
    this.firstInvalidField = result.firstInvalidField;
  }
}

// Autosave may preserve an unfinished correction in a previously reached step.
// Explicit transitions and attempts to reach a new step require every block.
export function requiresCreditClientStepValidation(input: {
  action?: unknown;
  currentStep: number;
  storedStep?: number | null;
  payload: Record<string, unknown>;
  payloadScope?: string;
}) {
  if (input.payloadScope === "DELIVERY_EVIDENCE") return false;
  const requestedStep = Math.max(input.currentStep, Number(input.payload.wizardStep) || 1);
  return String(input.action || "").toUpperCase() === "ADVANCE_CLIENT" ||
    (requestedStep > 1 && requestedStep > Math.max(1, input.storedStep || 1));
}

export function assertCompleteCreditClientStep(
  payload: Record<string, unknown>,
  verifiedFullName?: string,
  now = new Date(),
) {
  const values = Object.fromEntries(CREDIT_CLIENT_FIELD_ORDER.map((field) => [
    field, typeof payload[field] === "string" ? payload[field] : "",
  ])) as CreditClientFormValues;
  const result = validateCreditClientForm(values, now, { verifiedFullName });
  if (!result.complete) throw new CreditClientStepValidationError(result);
  return result;
}
