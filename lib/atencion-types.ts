export type AttentionStatus = "pending" | "open" | "closed";
export type AttentionMode = "unknown" | "ai" | "human_requested" | "human";
export type AttentionActor = {
  userId: number; sellerId: number | null; key: string; name: string;
  central: boolean; admin: boolean; supervisor: boolean; analyst: boolean;
  aliadoId: number | null; sedeId: number | null;
};
export type AttentionAssignee = { key: string; name: string; sedeIds: number[] };
export type AttentionBranch = { id: number; name: string };
export type AttentionCreditClassification = {
  status: "finserpay" | "no_credit" | "ambiguous" | "unverified";
  source: "manual_link" | "exact_phone" | null;
  creditCount: number | null;
};
export type AttentionConversation = {
  id: string; externalId: string | null; channel: "whatsapp" | "internal";
  phone: string | null; name: string; status: AttentionStatus; mode: AttentionMode;
  assigneeKey: string | null; assigneeName: string | null; sedeId: number | null;
  lastContactAt: string | null; updatedAt: string; preview: string | null;
  tags: string[]; version: number; linkedCreditId: number | null;
  autoTags: "FINSERPAY"[];
  creditClassification: AttentionCreditClassification;
};
export type AttentionMessage = {
  id: string; direction: "inbound" | "outbound"; text: string; sentAt: string;
  author: string | null;
  deliveryStatus?: "queued" | "sending" | "accepted" | "sent" | "delivered" | "read" | "failed" | "uncertain";
  deliveryError?: string | null;
  attachment?: {
    id: string; kind: "image" | "audio" | "video" | "document" | "sticker";
    url: string | null; fileName: string | null; mimeType: string | null;
  };
};
export type AttentionNote = { id: string; text: string; author: string; createdAt: string };
export type AttentionTask = { id: string; title: string; dueAt: string | null; completedAt: string | null; author: string };
export type AttentionQuickReply = { id: string; title: string; text: string; approvedBy: string; approvedAt: string };
export type AttentionCustomer = {
  match: "linked" | "none" | "ambiguous" | "restricted";
  name: string | null; documentMasked: string | null;
  candidates: { id: number; folio: string; name: string; documentMasked: string }[];
  credits: { id: number; folio: string; state: string; equipment: string;
    balance: number | null; nextDueAt: string | null; nextAmount: number | null;
    payments: { date: string; amount: number; method: string }[] }[];
  studies: { id: string; state: string; createdAt: string }[];
  financialAllowed: boolean;
};
export type AttentionIntegration = {
  configured: boolean; canSync: boolean; canSend: boolean; canHandoff: boolean;
  status: "not_configured" | "read_only" | "meta_ready" | "meta_pending"; message: string;
};
export type AttentionInbox = {
  schemaReady: boolean; conversations: AttentionConversation[]; total: number; page: number; pageSize: number;
  metrics: { pending: number; open: number; closed: number; mine: number };
  team: AttentionAssignee[]; branches: AttentionBranch[]; quickReplies: AttentionQuickReply[];
  actor: AttentionActor; integration: AttentionIntegration;
  dashboard?: {
    daily: { date: string; label: string; count: number }[];
    activity: { id: string; title: string; description: string; at: string; conversationId: string | null }[];
    activeConversations: AttentionConversation[];
    team: { key: string; name: string; assigned: number; pending: number }[];
  };
};
export type AttentionDetail = {
  conversation: AttentionConversation; messages: AttentionMessage[]; notes: AttentionNote[];
  tasks: AttentionTask[]; customer: AttentionCustomer;
  permissions: { manage: boolean; claim: boolean; assign?: boolean; canSend: boolean };
  messaging?: { windowExpiresAt: string | null; canReply: boolean; reason: string | null };
  historyTruncated: boolean;
  notesTruncated?: boolean;
  tasksTruncated?: boolean;
};
export type AttentionFilters = { search: string; filter: "mine" | "all" | "pending" | "closed"; page: number };
export type AttentionMutation = {
  action: "claim" | "transfer" | "close" | "reopen" | "note" | "tags" | "task" | "complete_task" | "link" | "unlink" | "human_request";
  version: number; requestId: string; assigneeKey?: string; text?: string; tags?: string[];
  dueAt?: string | null; taskId?: string; creditId?: number;
};
/** Whitelisted fields from the official read-only MCP; never a raw provider payload. */
export type DaptaConversationSnapshot = {
  externalId: string; phone: string | null; name: string | null;
  lastContactAt: string | null; mode: "unknown" | "ai" | "human";
  messages: AttentionMessage[]; historyTruncated: boolean;
  /** Opaque forward checkpoint; at EOF re-read the last page to collect future messages. */
  historyCursor: string | null;
};
