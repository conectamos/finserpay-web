import { attentionWorkWelcomeHandlers } from "@/lib/atencion-work-welcome-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;
export const GET = attentionWorkWelcomeHandlers.voices;
export const POST = attentionWorkWelcomeHandlers.call;
