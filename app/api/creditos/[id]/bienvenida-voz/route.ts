import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { createCreditWelcomeVoiceReadHandler } from "@/lib/credit-welcome-voice-http";
import { safeDaptaWelcomeVoiceUrl } from "@/lib/credit-welcome-voice-core";
import { listCreditWelcomeVoiceCallsForCredit } from "@/lib/credit-welcome-voice-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCreditWelcomeVoiceReadHandler({
  getUser: async () => await getSessionUser() ?? await getSessionUser({ allowApprovalAnalyst: true }),
  getSeller: async user => getSellerSessionUser(user as NonNullable<Awaited<ReturnType<typeof getSessionUser>>>),
  findCredit: (id, access) => prisma.credito.findFirst({ where: { AND: [{ id }, access] }, select: { id: true } }),
  listCalls: listCreditWelcomeVoiceCallsForCredit,
  safeUrl: safeDaptaWelcomeVoiceUrl,
});
