import "server-only";
import prisma from "@/lib/prisma";
import { getAllyPaymentDetail } from "@/lib/ally-payments";
import { buildSavedSettlementPdf } from "@/lib/ally-settlement-document";
import { createSettlementDeliveryStore } from "@/lib/ally-settlement-delivery-store";
import { dispatchSettlementDeliveries } from "@/lib/ally-settlement-delivery-dispatch";

export const settlementDeliveryStore = createSettlementDeliveryStore(prisma);
export function runSettlementDeliveryQueue(settlementId?: number) {
  return dispatchSettlementDeliveries({
    store: settlementDeliveryStore, settlementId, limit: settlementId ? 2 : 10,
    document: id => settlementDeliveryStore.document(id, async () => {
      const settlement = await getAllyPaymentDetail({ id, allyId: null });
      return buildSavedSettlementPdf(settlement);
    }),
  });
}

declare global {
  var __finserSettlementDeliveryTimer: ReturnType<typeof setInterval> | undefined;
}
export function startSettlementDeliveryWorker() {
  if (process.env.NODE_ENV !== "production" || process.env.ALLY_SETTLEMENT_DELIVERY_ENABLED !== "true" ||
      globalThis.__finserSettlementDeliveryTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runSettlementDeliveryQueue(); }
    catch { console.error("[settlement-delivery] No se pudo procesar la cola persistente."); }
    finally { running = false; }
  };
  globalThis.__finserSettlementDeliveryTimer = setInterval(() => { void tick(); }, 30_000);
  globalThis.__finserSettlementDeliveryTimer.unref?.();
  void tick();
}
