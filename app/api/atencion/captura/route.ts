import {attentionWorkCaptureMobileHandlers} from "@/lib/atencion-work-capture-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=attentionWorkCaptureMobileHandlers.status;
export const POST=attentionWorkCaptureMobileHandlers.upload;
