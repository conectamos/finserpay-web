import "server-only";
import { createCuotaVencidaWhatsAppStore } from "@/lib/cuotavencida-whatsapp-store";

const store = createCuotaVencidaWhatsAppStore({ campaign: "BLOQUEO" });
export const getBloqueoWhatsAppBatch = store.getCuotaVencidaWhatsAppBatch;
export const createBloqueoWhatsAppBatch = store.createCuotaVencidaWhatsAppBatch;
