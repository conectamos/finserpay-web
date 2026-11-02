import type { DaptaEventScope } from "./atencion-dapta-events";

export type DianaExtensionProposalInput = {
  cedula: string;
  folio: string;
  days: 1 | 2 | 3 | 4;
  promiseAmount: number;
  promiseDate: string;
  reason: string;
};
export type DianaExtensionProposalStatus = "PENDING" | "OFFERED" | "GRANTED" | "EXPIRED" | "REJECTED";
/** Deliberately excludes the internal credit/chat IDs and the debtor's identity. */
export type DianaExtensionProposalView = {
  code: string;
  status: DianaExtensionProposalStatus;
  offerText: string;
  expiresAt: string;
  days: 1 | 2 | 3 | 4;
  installmentNumber: number;
  installmentDueDate: string;
  expiresOn: string;
  promiseAmount: number;
  promiseDate: string;
  approved: boolean;
};
/** Constructed only after native scope/binding and fresh MCP message verification. */
export type DianaExtensionVerifiedMessage = {
  scope: DaptaEventScope;
  direction: "outbound" | "inbound";
  conversationId: string;
  externalConversationId: string;
  contactId: string;
  phone: string;
  messageId: string;
  messageAt: string;
  text: string;
  deliveryId: string;
};
export type DianaExtensionMessageResult = {
  outcome: "ignored" | "offered" | "granted" | "already_granted" | "rejected" | "pending_offer";
  /** Internal worker use only; do not expose through the public action. */
  creditId?: number;
  extensionId?: string;
  managementId?: string;
  code?: string;
  reason?: string;
};
