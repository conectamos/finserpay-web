import {attentionWorkCaptureHandlers} from "@/lib/atencion-work-capture-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=attentionWorkCaptureHandlers("seller").status;
export const DELETE=attentionWorkCaptureHandlers("seller").revoke;
