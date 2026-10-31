import {attentionWorkCaptureHandlers} from "@/lib/atencion-work-capture-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const POST=attentionWorkCaptureHandlers("attention").create;
