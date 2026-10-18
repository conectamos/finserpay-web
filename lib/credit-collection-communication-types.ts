export type CreditCommunicationAction = "REMINDER" | "CALL";
export type CreditCommunicationStatus = "REQUESTED" | "ACCEPTED" | "FAILED" | "UNKNOWN" | "SKIPPED";
export type CreditCommunicationItem = {
  id: string; requestId: string; creditoId: number; action: CreditCommunicationAction;
  status: CreditCommunicationStatus; phone: string; actorName: string;
  requestedAt: string; createdAt: string; message: string; providerReference: string | null;
};
export type CreditCommunicationState = {
  capabilities: {
    phone: string | null; whatsappHref: string | null;
    reminder: { available: boolean; reason: string | null; label: string };
    call: { available: boolean; reason: string | null };
  };
  history: CreditCommunicationItem[];
};
export type CreditCommunicationInput = {
  action: CreditCommunicationAction; expectedPhone: string; idempotencyKey: string;
};
