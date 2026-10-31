import { attentionWorkNotificationHandlers } from "@/lib/atencion-work-notification-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const {GET,PATCH}=attentionWorkNotificationHandlers("attention");
