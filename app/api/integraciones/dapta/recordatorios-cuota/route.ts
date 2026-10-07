import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { runCreditDueReminders } from "@/lib/credit-due-reminders";
import { createCreditDueReminderHandlers } from "@/lib/credit-due-reminders-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createCreditDueReminderHandlers({
  getAdmin: async () => {
    const user = await getSessionUser();
    return Boolean(user && user.activo && user.sedeAccesoActiva && user.aliadoAccesoActivo
      && isAdminRole(user.rolNombre) && isFinserPayCentralAlly(user.aliadoAccesoCodigo));
  },
  cronTokens: () => [process.env.MORA_SYNC_TOKEN, process.env.CRON_SECRET],
  previewToken: () => process.env.FINSERPAY_DIANA_API_TOKEN,
  run: runCreditDueReminders,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
