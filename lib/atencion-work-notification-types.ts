import type { AttentionWorkKind } from "./atencion-work-types";

export type AttentionWorkNotificationKind = "created" | "reply" | "assigned" | "followup";
export type AttentionWorkNotification = {
  id:string; kind:AttentionWorkNotificationKind; workKind:AttentionWorkKind;
  title:string; description:string; createdAt:string; readAt:string|null; href:string;
};
export type AttentionWorkNotifications = {items:AttentionWorkNotification[]; unreadCount:number; actorKey:string};
