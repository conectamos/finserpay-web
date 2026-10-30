import { attentionWorkHandlers } from "@/lib/atencion-work-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=attentionWorkHandlers("seller").list;
export const POST=attentionWorkHandlers("seller").create;
