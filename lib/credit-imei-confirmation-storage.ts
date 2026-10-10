import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import {
  hasCurrentContractImeiConfirmation,
  ImeiConfirmationError,
  readCreditImeiConfirmation,
  validateCreditImeiConfirmation,
  type CreditImeiConfirmation,
} from "@/lib/credit-imei-confirmation";
import { lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { canOperateSolicitud } from "@/lib/solicitud-operation-access";

type Database = typeof prisma | Prisma.TransactionClient;
type ConfirmationDraft = {
  id: number;
  imei: string | null;
  payload: Record<string, unknown> | null;
  vendedorId: number | null;
  aliadoId: number | null;
};

/** Call while holding the existing solicitud operation lock for mutations. */
export async function requireDraftImeiConfirmation(draftId: number, database: Database = prisma) {
  const rows = await database.$queryRawUnsafe<ConfirmationDraft[]>(
    `SELECT "id", "imei", "payload" FROM "CreditoBorrador"
     WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
       AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
     LIMIT 1`, draftId);
  const draft = rows[0];
  if (draft && readCreditImeiConfirmation(draft.payload, draft.imei)) return;
  const processes = draft ? await database.$queryRawUnsafe<Array<{
    processUuid: string; draftPayload: unknown;
  }>>(`SELECT "processUuid", "draftPayload" FROM "FirmaSeguroProcess"
       WHERE "draftId"=$1 AND "supersededAt" IS NULL AND "creditoId" IS NULL
       ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`, draftId) : [];
  if (draft && hasCurrentContractImeiConfirmation({ ...draft, currentProcess: processes[0] })) return;
  throw new ImeiConfirmationError("IMEI_CONFIRMATION_REQUIRED", "Confirma nuevamente los 15 dígitos del IMEI en Equipo y plan antes de continuar.");
}

export async function confirmDraftImei(input: {
  draftId: number;
  enteredImei: unknown;
  userId: number;
  central: boolean;
  viewerAllyId: number | null | undefined;
  seller: { id: number; tipoPerfil?: string | null } | null;
}) {
  // Invalid identifiers are rejected even before taking a database lock.
  validateCreditImeiConfirmation(input.enteredImei, input.enteredImei);
  return prisma.$transaction(async (transaction) => {
    await lockSolicitudOperationMutation(transaction, input.draftId);
    const rows = await transaction.$queryRawUnsafe<ConfirmationDraft[]>(
      `SELECT d."id", d."imei", d."payload", d."vendedorId", s."aliadoId"
       FROM "CreditoBorrador" d LEFT JOIN "Sede" s ON s."id"=d."sedeId"
       WHERE d."id"=$1 AND d."estado"='ABIERTO' AND d."creditoId" IS NULL
         AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
       LIMIT 1 FOR UPDATE OF d`, input.draftId);
    const draft = rows[0];
    if (!draft || !canOperateSolicitud({ ...input, owner: draft })) throw new Error("SOLICITUD_NO_AUTORIZADA");
    const imei = validateCreditImeiConfirmation(input.enteredImei, draft.imei);
    const previous = readCreditImeiConfirmation(draft.payload, imei);
    if (previous && previous.confirmedByUserId === input.userId && previous.confirmedBySellerId === (input.seller?.id || null)) {
      return { confirmation: previous, idempotent: true, currentStep: 4 };
    }
    const confirmation: CreditImeiConfirmation = {
      imei, confirmedAt: new Date().toISOString(), confirmedByUserId: input.userId,
      confirmedBySellerId: input.seller?.id || null,
    };
    const history = Array.isArray(draft.payload?.imeiConfirmationHistory) ? draft.payload.imeiConfirmationHistory : [];
    const payload = { ...draft.payload, imeiConfirmation: confirmation, imeiConfirmationHistory: [...history, confirmation] };
    const changed = await transaction.$executeRawUnsafe(
      `UPDATE "CreditoBorrador" SET "payload"=$2::jsonb, "updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1 AND "imei"=$3 AND "estado"='ABIERTO' AND "creditoId" IS NULL`,
      input.draftId, JSON.stringify(payload), imei);
    if (changed !== 1) throw new Error("SOLICITUD_NO_AUTORIZADA");
    return { confirmation, idempotent: false, currentStep: 4 };
  });
}
