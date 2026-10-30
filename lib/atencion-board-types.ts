import type { AttentionConversation } from "./atencion-types";

export const attentionBoardColors = ["green", "lime", "amber", "slate", "navy"] as const;
export type AttentionBoardColor = typeof attentionBoardColors[number];
export type AttentionBoardSection = {
  id: string | null; name: string; color: AttentionBoardColor; position: number; version: number;
  /** Visible chats matching search; totalCount uses the same actor scope without search. */
  count: number; totalCount: number;
};
export type AttentionBoard = { sections: AttentionBoardSection[]; permissions: { manage: boolean }; pageSize: number };
export type AttentionBoardCard = AttentionConversation & { sectionId: string | null; boardVersion: number };
export type AttentionBoardCards = { sectionId: string | null; conversations: AttentionBoardCard[]; total: number; page: number; pageSize: number };
export type AttentionBoardSectionMutation = { requestId: string } & (
  | { action: "create"; name: string; color: AttentionBoardColor }
  | { action: "rename"; id: string; version: number; name: string }
  | { action: "color"; id: string; version: number; color: AttentionBoardColor }
  | { action: "archive"; id: string; version: number }
  | { action: "reorder"; ordered: { id: string; version: number }[] }
);
export type AttentionBoardMutationResult = { section: AttentionBoardSection | null; unchanged: boolean };
export type AttentionBoardMove = { sectionId: string | null; boardVersion: number; requestId: string };
export type AttentionBoardMoveResult = { conversationId: string; sectionId: string | null; boardVersion: number; unchanged: boolean };
