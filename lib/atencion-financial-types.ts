export type AttentionExtensionDays = 1 | 2 | 3 | 4;
export type AttentionFinancialCredit = {
  id: number;
  number: string;
  state: "AL_DIA" | "EN_MORA" | "PAGADO" | "ANULADO" | "NO_VERIFICADO";
  extension: {
    canGrant: boolean;
    blockedReason: string | null;
    installmentNumber: number | null;
    dueDate: string | null;
    choices: { days: AttentionExtensionDays; expiresOn: string }[];
    active: { id: string; expiresOn: string | null } | null;
    promise: { amount: number; date: string };
  };
  lastPayment: { id: number; date: string; amount: number; method: string; receiptAvailable: boolean } | null;
};
export type AttentionFinancial = { credits: AttentionFinancialCredit[]; version: number; blockedReason: string | null };
export type AttentionExtensionInput = {
  creditId: number; days: AttentionExtensionDays; version: number; requestId: string;
  /** Required for a new grant; optional only to replay an already recorded legacy request. */
  installmentNumber?: number; installmentDueDate?: string;
  reason: string; observation: string; promiseAmount: number; promiseDate: string;
};
export type AttentionReceiptSendInput = { creditId: number; paymentId: number; version: number; requestId: string };
export type AttentionExtensionResult = {
  extension: { id: string; creditId: number; status: "APPROVED" | "EXPIRED" | "CANCELLED" | "REPLACED" | "REJECTED" | "PENDING"; expiresOn: string; installmentNumber: number; installmentDueDate: string };
  version: number; unchanged: boolean;
  management?: { id: string; creditId: number; nextFollowUpAt: string };
  moraSync?: { ok: boolean; message: string };
};
