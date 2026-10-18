import { after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { isSameApprovalOrigin } from "@/lib/credit-approval-http";
import { createCuotaVencidaWhatsAppHandlers } from "@/lib/cuotavencida-whatsapp-http";
import { createCuotaVencidaWhatsAppBatch, getCuotaVencidaWhatsAppBatch } from "@/lib/cuotavencida-whatsapp-store";
import { isCuotaVencidaWhatsAppConfigured, runCuotaVencidaWhatsApp } from "@/lib/cuotavencida-whatsapp-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createCuotaVencidaWhatsAppHandlers({
  session: async () => {
    const user = await getSessionUser();
    return user ? { id: user.id, centralAdmin: user.sedeAccesoActiva && user.aliadoAccesoActivo
      && isAdminRole(user.rolNombre) && isFinserPayCentralAlly(user.aliadoAccesoCodigo) } : null;
  },
  sameOrigin: isSameApprovalOrigin,
  configured: isCuotaVencidaWhatsAppConfigured,
  latest: () => getCuotaVencidaWhatsAppBatch({}),
  create: createCuotaVencidaWhatsAppBatch,
  start: () => after(async () => {
    try { await runCuotaVencidaWhatsApp({ limit: 10 }); }
    catch { console.error("[cuotavencida] No se pudo procesar el lote; el seguimiento continuará en la cola."); }
  }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
