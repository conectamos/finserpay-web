import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

export const imeiConfirmation = loadReissueModule("lib/credit-imei-confirmation.ts");
const operationAccess = loadReissueModule("lib/solicitud-operation-access.ts");

/** Provider/identity tests exercise the real acknowledgement guard on their mock DB. */
export function loadImeiConfirmationStorage(prisma) {
  return loadReissueModule("lib/credit-imei-confirmation-storage.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-imei-confirmation": imeiConfirmation,
    "@/lib/solicitud-operation-access": operationAccess,
    // These single-connection fixtures have no concurrent mutation. Production
    // locking and confirmation races are covered in credit-imei-confirmation.test.
    "@/lib/firmaseguro-storage": { lockSolicitudOperationMutation: async () => {} },
  });
}

/** Represents an already persisted acknowledgement; never a browser payload. */
export function persistedImeiConfirmation(imei, userId, sellerId) {
  return {
    imei, confirmedAt: "2026-10-09T10:00:00.000Z",
    confirmedByUserId: userId, confirmedBySellerId: sellerId,
  };
}
