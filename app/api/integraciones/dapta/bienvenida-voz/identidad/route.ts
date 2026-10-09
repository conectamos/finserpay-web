import { createCreditWelcomeVoiceIdentityHandler } from "@/lib/credit-welcome-voice-http";
import { verifyWelcomeVoiceToken, verifyWelcomeVoiceIdentityFlowAuthorization } from "@/lib/credit-welcome-voice-core";
import { verifyCreditWelcomeVoiceIdentity } from "@/lib/credit-welcome-voice-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCreditWelcomeVoiceIdentityHandler({
  verifyToken: verifyWelcomeVoiceToken,
  verifyFlowAuthorization: verifyWelcomeVoiceIdentityFlowAuthorization,
  verifyIdentity: verifyCreditWelcomeVoiceIdentity,
});
