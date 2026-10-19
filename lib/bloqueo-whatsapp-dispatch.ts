import "server-only";
import { createCuotaVencidaWhatsAppDispatcher, isCuotaVencidaWhatsAppConfigured } from "@/lib/cuotavencida-whatsapp-dispatch";

export const isBloqueoWhatsAppConfigured = (env: NodeJS.ProcessEnv = process.env) => isCuotaVencidaWhatsAppConfigured(env, "BLOQUEO");
export const runBloqueoWhatsApp = createCuotaVencidaWhatsAppDispatcher({ campaign: "BLOQUEO" });
