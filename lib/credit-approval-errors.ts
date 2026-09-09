export class CreditApprovalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "CreditApprovalError";
  }
}
