import type { AttentionActor, AttentionMessage, AttentionNote, AttentionStatus } from "./atencion-types";

export const attentionWorkKinds = { enrollment: "Enrolamiento iPhone", welcome: "Aprobación · bienvenida" } as const;
export const attentionWorkStates = { pending: "Pendiente", review: "En revisión", information: "Información pendiente", completed: "Finalizada" } as const;
export type AttentionWorkKind = keyof typeof attentionWorkKinds;
export type AttentionWorkState = keyof typeof attentionWorkStates;
export type AttentionWorkListFilters = { search: string; filter: "all" | "unread" | "unassigned"; state: AttentionWorkState | "active" | "" };
export type AttentionWorkActor = { type: "attention"; actor: AttentionActor } | {
  type: "seller"; userId: number; userSedeId: number; sellerId: number; sedeId: number; accessSedeId: number;
  aliadoId: number; supervisor: boolean; name: string; key: string;
};
export type AttentionWorkItem = {
  id: string; conversationId: string; kind: AttentionWorkKind; target: string;
  state: AttentionWorkState; callMode: "human" | "dapta" | "undecided";
  name: string; advisor: string; ally: string; branch: string; assignee: string | null;
  assigneeKey: string | null; version: number; createdAt: string; updatedAt: string;
  preview?: string | null; lastMessageAt?: string | null; conversationStatus?: AttentionStatus;
  /** Nominal staff read state; omitted from the commercial profile's response. */
  unreadCount?: number;
};
export type AttentionWorkDetail = {
  item: AttentionWorkItem; messages: AttentionMessage[]; notes: AttentionNote[];
  canManage: boolean; canWrite: boolean; canAssign: boolean; historyTruncated: boolean;
  document: string | null; imei: string | null; deviceReference: string | null; operationHref: string | null;
  team: { key: string; name: string }[];
  events: { id: string; action: string; author: string; at: string; state: string | null }[];
};
export type AttentionWorkSummary = {
  workId: string; kind: "welcome"; target: string; unreadCount: number;
  lastInbound: { id: string; sentAt: string } | null;
  lastUnreadInbound: { id: string; sentAt: string } | null;
};
