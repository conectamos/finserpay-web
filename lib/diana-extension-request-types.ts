import type { DaptaEventScope } from "./atencion-dapta-events";

export type DianaExtensionRequestIntent =
  | { kind: "days"; days: 1 | 2 | 3 | 4; date?: string; folio?: string }
  | { kind: "date"; date: string; folio?: string };

/** Private evidence derived from the original, freshly read native customer message. */
export type DianaExtensionVerifiedRequest = {
  scope: DaptaEventScope;
  conversationId: string;
  externalConversationId: string;
  contactId: string;
  phone: string;
  messageId: string;
  messageAt: string;
  deliveryId: string;
  textDigest: string;
  intent: DianaExtensionRequestIntent;
  /** The complete current conversation tail did not revoke or supersede this request. */
  latest: true;
  observedAt: string;
};

export type DianaExtensionRequestConsumeResult = {
  outcome: "ignored" | "granted" | "already_granted" | "rejected" | "needs_credit";
  creditId?: number;
  extensionId?: string;
  managementId?: string;
};

/** No customer document, phone, native message IDs or internal record IDs leave this view. */
export type DianaExtensionRequestView = {
  status: "GRANTED" | "ACTIVE" | "PENDING" | "NEEDS_CREDIT" | "REJECTED" | "NO_REQUEST";
  approved: boolean;
  existing: boolean;
  days: 1 | 2 | 3 | 4 | null;
  installmentNumber: number | null;
  installmentDueDate: string | null;
  expiresOn: string | null;
  reason: string | null;
};
