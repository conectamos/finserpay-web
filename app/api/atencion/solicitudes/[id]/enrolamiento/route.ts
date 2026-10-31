import { readAttentionWorkEnrollment, approveAttentionWorkEnrollment } from "@/lib/atencion-work-enrollment-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=readAttentionWorkEnrollment;
export const POST=approveAttentionWorkEnrollment;
