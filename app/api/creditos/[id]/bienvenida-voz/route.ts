import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { createCreditWelcomeVoiceManualHandler, createCreditWelcomeVoiceReadHandler } from "@/lib/credit-welcome-voice-http";
import { safeDaptaWelcomeVoiceUrl } from "@/lib/credit-welcome-voice-core";
import { ensureCreditWelcomeVoiceSchema, getCreditWelcomeVoiceOperatorAvailability, getCreditWelcomeVoiceOperatorRequest, listCreditWelcomeVoiceCallsForCredit,
  prepareCreditWelcomeVoiceOperatorCall } from "@/lib/credit-welcome-voice-store";
import { dispatchCreditWelcomeVoice, getCreditWelcomeVoiceConfig } from "@/lib/credit-welcome-voice-dispatch";
import { isSameApprovalOrigin } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const getUser = async () => await getSessionUser() ?? await getSessionUser({ allowApprovalAnalyst: true });

export const GET = createCreditWelcomeVoiceReadHandler({
  getUser,
  getSeller: async user => getSellerSessionUser(user as NonNullable<Awaited<ReturnType<typeof getSessionUser>>>),
  findCredit: (id, access) => prisma.credito.findFirst({ where: { AND: [{ id }, access] }, select: { id: true } }),
  listCalls: listCreditWelcomeVoiceCallsForCredit,
  safeUrl: safeDaptaWelcomeVoiceUrl,
  getManualRequest: getCreditWelcomeVoiceOperatorRequest,
  getManualCall: async id => getCreditWelcomeVoiceConfig()
    ? getCreditWelcomeVoiceOperatorAvailability(id)
    : { canCall: false, phone: null, reason: "Las llamadas de bienvenida no están disponibles en este momento." },
});

export const POST = createCreditWelcomeVoiceManualHandler({
  getUser,
  sameOrigin: isSameApprovalOrigin,
  configured: () => Boolean(getCreditWelcomeVoiceConfig()),
  findCredit: (id, access) => prisma.credito.findFirst({ where: { AND: [{ id }, access] }, select: { id: true } }),
  prepare: async input => {
    await ensureCreditWelcomeVoiceSchema();
    return prepareCreditWelcomeVoiceOperatorCall(input);
  },
  dispatch: claim => dispatchCreditWelcomeVoice({ limit: 1 }, { claim: async () => [claim] }),
  listCalls: listCreditWelcomeVoiceCallsForCredit,
});
