import { normalizeAllyWhatsApp } from "./ally-contact";
import { createSettlementMediaUrl } from "./ally-settlement-delivery-media";
import { verifySettlementDaptaToken } from "./ally-settlement-delivery-dapta-auth";
import type { DeliveryDatabase } from "./ally-settlement-delivery-store";
import type { SettlementDeliveryPayload } from "./ally-settlement-delivery-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAMID = /^wamid\.[A-Za-z0-9+/=_-]{5,512}$/;
export const SETTLEMENT_WHATSAPP_SENDER = "573124085562";
const DEFINITE_REJECTION_HTTP = new Set([400, 401, 403, 404, 422, 429]);
const RECEIPT_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export class DaptaCallbackInputError extends Error {}
export class DaptaCallbackConflictError extends Error {}

type ClaimInput = { action: "claim"; eventId: string; recipient: string };
type ReceiptInput = {
  action: "receipt"; eventId: string; recipient: string; sender: string;
  outcome: "SENT" | "FAILED" | "UNCERTAIN"; providerId: string | null;
  timestamp: Date; code: string | null;
};
export type DaptaCallbackInput = ClaimInput | ReceiptInput;

/** Authorize only this normalized event/recipient using an expiring token. */
export function daptaCallbackAuthorized(request: Request, input: Pick<DaptaCallbackInput, "eventId" | "recipient">, env: NodeJS.ProcessEnv = process.env) {
  const candidate = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] || "";
  return verifySettlementDaptaToken(candidate, input.eventId, input.recipient, env);
}

function recipient(value: unknown) {
  if (typeof value !== "string") throw new DaptaCallbackInputError("Destinatario inválido.");
  try {
    const normalized = normalizeAllyWhatsApp(value);
    if (normalized) return normalized;
  } catch { /* Report only the validation category, never the callback body. */ }
  throw new DaptaCallbackInputError("Destinatario inválido.");
}

export function parseDaptaCallback(input: unknown): DaptaCallbackInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DaptaCallbackInputError("Callback inválido.");
  const body = input as Record<string, unknown>;
  if (typeof body.event_id !== "string" || !UUID.test(body.event_id)) throw new DaptaCallbackInputError("event_id inválido.");
  const base = { eventId: body.event_id.toLowerCase(), recipient: recipient(body.recipient) };
  if (body.action === "claim") return { ...base, action: "claim" };
  if (body.action !== "receipt") throw new DaptaCallbackInputError("Acción inválida.");
  const sender = recipient(body.sender);
  if (sender !== SETTLEMENT_WHATSAPP_SENDER) throw new DaptaCallbackInputError("Remitente no autorizado.");
  if (!["accepted", "failed", "uncertain"].includes(String(body.status))) throw new DaptaCallbackInputError("Estado inválido.");
  if (typeof body.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(body.timestamp)) throw new DaptaCallbackInputError("Fecha inválida.");
  const timestamp = new Date(body.timestamp);
  if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + RECEIPT_CLOCK_TOLERANCE_MS) {
    throw new DaptaCallbackInputError("Fecha inválida.");
  }
  const providerId = typeof body.provider_message_id === "string" && WAMID.test(body.provider_message_id) ? body.provider_message_id : null;
  // A generic Dapta failure or timeout does not establish that Meta rejected the
  // message. Only an explicit 4xx rejection with a Meta error code permits retry.
  const definiteFailure = body.status === "failed" && body.code === "META_REJECTED" &&
    DEFINITE_REJECTION_HTTP.has(Number(body.provider_http_status)) &&
    typeof body.provider_error_code === "number" && Number.isSafeInteger(body.provider_error_code) && body.provider_error_code > 0 &&
    (body.provider_message_id === null || body.provider_message_id === undefined);
  const contradictorySuccess = ["ok", "accepted", "success"].some(key => body[key] !== undefined && body[key] !== true) ||
    ["suppressed", "scheduled"].some(key => body[key] !== undefined && body[key] !== false) ||
    Boolean(body.error) || (Array.isArray(body.errors) ? body.errors.length > 0 : Boolean(body.errors));
  const outcome = body.status === "accepted" && providerId && !contradictorySuccess ? "SENT" : definiteFailure ? "FAILED" : "UNCERTAIN";
  return {
    ...base, action: "receipt", sender, timestamp, outcome,
    providerId: outcome === "SENT" ? providerId : null,
    code: outcome === "SENT" ? null : outcome === "FAILED" ? `META_REJECTED_${body.provider_error_code}` : "PROVIDER_RECEIPT_UNCONFIRMED",
  };
}

type ClaimRow = {
  id: string; settlementId: number; channel: string; recipient: string | null;
  status: string; sendStartedAt: Date | null; leaseValid: boolean;
  payload: SettlementDeliveryPayload; filename: string;
};
type ReceiptRow = {
  id: string; channel: string; recipient: string; claimRecipient: string;
  status: string; providerId: string | null; claimProviderId: string | null;
  receiptStatus: string | null; sendStartedAt: Date | null;
};

export function createDaptaSettlementCallbackStore(db: DeliveryDatabase, env: NodeJS.ProcessEnv = process.env) {
  return {
    async claim(input: ClaimInput) {
      if (env.ALLY_SETTLEMENT_DELIVERY_ENABLED !== "true") return { ok: true as const, authorized: false as const };
      return db.$transaction(async tx => {
        const [row] = await tx.$queryRawUnsafe<ClaimRow[]>(
          `SELECT a.*, a."leaseUntil">now() AS "leaseValid", d."filename"
            FROM public."AllySettlementDeliveryAttempt" a
            JOIN public."AllySettlementDocument" d ON d."settlementId"=a."settlementId"
            WHERE a."id"=$1::uuid FOR UPDATE OF a`, input.eventId,
        );
        if (!row || row.channel !== "WHATSAPP" || row.recipient !== input.recipient || row.status !== "PROCESSING" ||
            !row.sendStartedAt || !row.leaseValid || env.ALLY_SETTLEMENT_DELIVERY_ENABLED !== "true") {
          return { ok: true as const, authorized: false as const };
        }
        const [existing] = await tx.$queryRawUnsafe<Array<{ attemptId: string }>>(
          'SELECT "attemptId" FROM public."AllySettlementDaptaClaim" WHERE "attemptId"=$1::uuid', row.id,
        );
        if (existing) return { ok: true as const, authorized: false as const };
        const payload = row.payload;
        if (!payload || [payload.allyName, payload.periodStart, payload.periodEnd, payload.netAmount].some(value => typeof value !== "string" || !value.trim())) {
          throw new Error("El contenido guardado de la liquidación no es válido.");
        }
        // Sign before consuming the one-time claim: missing configuration cannot
        // authorize a send with an absent document. No caller-provided fields are returned.
        const pdfUrl = createSettlementMediaUrl(row.id, env);
        const inserted = await tx.$executeRawUnsafe(
          `INSERT INTO public."AllySettlementDaptaClaim" ("attemptId","recipient")
            VALUES ($1::uuid,$2) ON CONFLICT ("attemptId") DO NOTHING`, row.id, row.recipient,
        );
        if (!inserted) return { ok: true as const, authorized: false as const };
        return {
          ok: true as const, authorized: true as const, event_id: row.id, recipient: row.recipient,
          sender: SETTLEMENT_WHATSAPP_SENDER, ally_name: payload.allyName,
          period_start: payload.periodStart, period_end: payload.periodEnd, net_amount: payload.netAmount,
          pdf_url: pdfUrl, filename: row.filename,
        };
      });
    },
    async receipt(input: ReceiptInput) {
      if (input.outcome === "SENT" && (!input.providerId || !WAMID.test(input.providerId))) {
        throw new DaptaCallbackInputError("Falta un identificador real de WhatsApp.");
      }
      // Reconciliation of a previously authorized send remains allowed with the
      // gate off. A new claim is never created by a receipt.
      return db.$transaction(async tx => {
        const [row] = await tx.$queryRawUnsafe<ReceiptRow[]>(
          `SELECT a.*, c."recipient" AS "claimRecipient", c."providerId" AS "claimProviderId", c."receiptStatus"
            FROM public."AllySettlementDeliveryAttempt" a
            JOIN public."AllySettlementDaptaClaim" c ON c."attemptId"=a."id"
            WHERE a."id"=$1::uuid FOR UPDATE OF a,c`, input.eventId,
        );
        if (!row || row.channel !== "WHATSAPP" || !row.sendStartedAt || row.recipient !== input.recipient ||
            row.claimRecipient !== input.recipient || input.sender !== SETTLEMENT_WHATSAPP_SENDER) {
          throw new DaptaCallbackConflictError("El recibo no corresponde a un envío autorizado.");
        }
        // Tolerate a small clock difference, but never apply a callback that
        // predates this dispatch or is implausibly in the future.
        if (input.timestamp.getTime() < new Date(row.sendStartedAt).getTime() - RECEIPT_CLOCK_TOLERANCE_MS ||
            input.timestamp.getTime() > Date.now() + RECEIPT_CLOCK_TOLERANCE_MS) {
          throw new DaptaCallbackConflictError("La fecha del recibo no corresponde a este intento.");
        }
        if (input.providerId && ((row.providerId && row.providerId !== input.providerId) ||
            (row.claimProviderId && row.claimProviderId !== input.providerId))) {
          throw new DaptaCallbackConflictError("El recibo tiene un identificador de proveedor distinto.");
        }
        if (["SENT", "FAILED"].includes(row.status) || ["SENT", "FAILED"].includes(row.receiptStatus || "")) {
          // A late ambiguous result cannot undo an acknowledged message, nor can
          // a second contradictory terminal receipt change an already reconciled send.
          return { ok: true as const, reconciled: true, status: row.status, duplicate: true };
        }
        if (!["PROCESSING", "UNCERTAIN"].includes(row.status)) throw new DaptaCallbackConflictError("El intento no admite conciliación.");
        const error = input.outcome === "SENT" ? null : input.outcome === "FAILED"
          ? "Meta rechazó el envío. Puedes reintentar este canal."
          : "Dapta no confirmó un identificador de WhatsApp. Requiere conciliación; reenvío bloqueado.";
        await tx.$executeRawUnsafe(
          `UPDATE public."AllySettlementDeliveryAttempt" SET "status"=$2,"providerId"=COALESCE($3,"providerId"),
            "sentAt"=CASE WHEN $2='SENT' THEN COALESCE("sentAt",$4) ELSE "sentAt" END,
            "error"=$5,"leaseUntil"=NULL
            WHERE "id"=$1::uuid AND "status" IN ('PROCESSING','UNCERTAIN')`,
          input.eventId, input.outcome, input.providerId, input.timestamp, error,
        );
        await tx.$executeRawUnsafe(
          `UPDATE public."AllySettlementDaptaClaim" SET "receiptAt"=now(),"receiptStatus"=$2,
            "providerId"=COALESCE($3,"providerId"),"errorCode"=$4 WHERE "attemptId"=$1::uuid`,
          input.eventId, input.outcome, input.providerId, input.code,
        );
        return { ok: true as const, reconciled: true, status: input.outcome, duplicate: false };
      });
    },
  };
}
