import { attentionPushHandlers } from "@/lib/atencion-push-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const {GET,POST,DELETE}=attentionPushHandlers("attention");
