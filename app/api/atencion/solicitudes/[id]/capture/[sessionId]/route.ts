import {attentionWorkCaptureHandlers} from "@/lib/atencion-work-capture-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=attentionWorkCaptureHandlers("attention").status;
export const DELETE=attentionWorkCaptureHandlers("attention").revoke;
