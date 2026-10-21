import type { SettlementDeliveryAttempt } from "./ally-settlement-delivery-types";
import { DeliveryProviderError, sendSettlementDelivery } from "./ally-settlement-delivery-provider";

export type DeliveryDispatchStore = {
  recover(): Promise<void>;
  claim(settlementId?: number): Promise<SettlementDeliveryAttempt | null>;
  beforeSend(id: string, claimToken: string): Promise<void>;
  accepted(id: string, providerId: string, claimToken: string): Promise<void>;
  failed(id: string, error: string, uncertain: boolean, claimToken: string): Promise<void>;
};

export async function dispatchSettlementDeliveries(input: {
  store: DeliveryDispatchStore;
  document: (settlementId: number) => Promise<{ pdf: Buffer; filename: string }>;
  send?: typeof sendSettlementDelivery;
  settlementId?: number;
  limit?: number;
}) {
  await input.store.recover();
  let processed = 0;
  for (let index = 0; index < (input.limit ?? 10); index++) {
    const attempt = await input.store.claim(input.settlementId);
    if (!attempt) break;
    let sending = false;
    try {
      if (!attempt.recipient) throw new Error("Falta el destinatario del aliado.");
      const document = await input.document(attempt.settlementId);
      const result = await (input.send || sendSettlementDelivery)({
        ...attempt.payload, ...document, channel: attempt.channel,
        recipient: attempt.recipient, attemptId: attempt.id,
      }, { beforeSend: async () => {
        await input.store.beforeSend(attempt.id, attempt.claimToken);
        sending = true;
      } });
      // If persistence fails after provider acceptance, retain the durable send boundary.
      await input.store.accepted(attempt.id, result.providerId, attempt.claimToken);
    } catch (error) {
      const uncertain = error instanceof DeliveryProviderError ? error.uncertain : sending;
      const message = error instanceof DeliveryProviderError ? error.message
        : sending ? "Resultado incierto del envío. Concilia con el proveedor antes de reenviar."
        : "No se pudo preparar el PDF o el envío. La liquidación está guardada; puedes reintentar.";
      await input.store.failed(attempt.id, message, uncertain, attempt.claimToken);
    }
    processed++;
  }
  return { processed };
}
