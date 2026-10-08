import { createCreditWelcomeVoiceResultHandler } from "@/lib/credit-welcome-voice-http";
import { safeDaptaWelcomeVoiceUrl, verifyWelcomeVoiceToken } from "@/lib/credit-welcome-voice-core";
import { saveCreditWelcomeVoiceResult } from "@/lib/credit-welcome-voice-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCreditWelcomeVoiceResultHandler({
  verifyToken: verifyWelcomeVoiceToken,
  expectedAgent: () => process.env.DAPTA_WELCOME_VOICE_AGENT_ID || "",
  safeUrl: safeDaptaWelcomeVoiceUrl,
  saveResult: saveCreditWelcomeVoiceResult,
});
