import { attentionWorkHandlers } from "@/lib/atencion-work-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=attentionWorkHandlers("attention").detail;
export const PATCH=attentionWorkHandlers("attention").mutate;
