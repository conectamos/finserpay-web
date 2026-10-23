import { createHash, randomUUID } from "node:crypto";
import { normalizeAllyEmail, normalizeAllyWhatsApp } from "./ally-contact";
import {
  buildSettlementDeliveryPayload,
  type SettlementDeliveryAttempt, type SettlementDeliveryChannel, type SettlementDeliveryPayload,
} from "./ally-settlement-delivery-types";

export type DeliveryDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type DeliveryDatabase = DeliveryDb & {
  $transaction<T>(fn: (tx: DeliveryDb) => Promise<T>): Promise<T>;
};
type SettlementSnapshot = {
  id: number; aliado: { id: number; nombre: string };
  periodoInicio: string; periodoFin: string; saldoNeto: number;
};
export class DeliveryConflictError extends Error {}

async function contact(db: DeliveryDb, settlementId: number, channel: SettlementDeliveryChannel) {
  const [row] = await db.$queryRawUnsafe<Array<{ email: string | null; telefonoWhatsapp: string | null }>>(
    'SELECT a."email", a."telefonoWhatsapp" FROM public."Aliado" a JOIN public."LiquidacionAliado" s ON s."aliadoId"=a."id" WHERE s."id"=$1',
    settlementId,
  );
  if (!row) throw new Error("Liquidación inexistente.");
  try {
    const recipient = channel === "EMAIL" ? normalizeAllyEmail(row.email) : normalizeAllyWhatsApp(row.telefonoWhatsapp);
    return { recipient, error: recipient ? null : channel === "EMAIL"
      ? "Falta el correo electrónico del aliado. Actualízalo y reintenta este canal."
      : "Falta el teléfono de WhatsApp del aliado. Actualízalo y reintenta este canal." };
  } catch {
    return { recipient: null, error: "El destinatario registrado no es válido. Actualiza los datos del aliado." };
  }
}

async function insertAttempt(db: DeliveryDb, input: {
  settlementId: number; channel: SettlementDeliveryChannel; sequence: number;
  requestId: string; payload: SettlementDeliveryPayload; actorUserId: number | null;
}) {
  const target = await contact(db, input.settlementId, input.channel);
  const [row] = await db.$queryRawUnsafe<SettlementDeliveryAttempt[]>(
    `INSERT INTO public."AllySettlementDeliveryAttempt"
      ("id","settlementId","channel","sequence","requestId","recipient","payload","status","error","actorUserId")
      VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7::jsonb,$8,$9,$10) RETURNING *`,
    randomUUID(), input.settlementId, input.channel, input.sequence, input.requestId,
    target.recipient, JSON.stringify(input.payload), target.error ? "FAILED" : "QUEUED", target.error, input.actorUserId,
  );
  return row;
}

/** Called ONLY within the same transaction that creates a new settlement. */
export async function enqueueInitialSettlementDeliveries(db: DeliveryDb, settlement: SettlementSnapshot, actorUserId: number) {
  const payload = buildSettlementDeliveryPayload({
    allyName: settlement.aliado.nombre, periodStart: settlement.periodoInicio,
    periodEnd: settlement.periodoFin, netAmount: settlement.saldoNeto,
  });
  for (const channel of ["EMAIL", "WHATSAPP"] as const) {
    const inserted = await db.$executeRawUnsafe(
      'INSERT INTO public."AllySettlementDelivery" ("settlementId","channel") VALUES ($1,$2) ON CONFLICT DO NOTHING',
      settlement.id, channel,
    );
    if (inserted) await insertAttempt(db, {
      settlementId: settlement.id, channel, sequence: 1, requestId: randomUUID(), payload, actorUserId,
    });
  }
}

export function createSettlementDeliveryStore(db: DeliveryDatabase) {
  return {
    async list(settlementId: number) {
      const rows = await db.$queryRawUnsafe<SettlementDeliveryAttempt[]>(
        'SELECT * FROM public."AllySettlementDeliveryAttempt" WHERE "settlementId"=$1 ORDER BY "sequence" DESC,"createdAt" DESC',
        settlementId,
      );
      const serialize = (row: SettlementDeliveryAttempt) => ({
        id: row.id, channel: row.channel,
        status: row.status === "SENT" ? "SENT" : row.status === "FAILED" || row.status === "UNCERTAIN" ? "FAILED" : "PENDING",
        recipient: row.recipient, attemptedAt: row.attemptedAt, sentAt: row.sentAt,
        createdAt: row.createdAt, error: row.error, uncertain: row.status === "UNCERTAIN",
        canRetry: row.status === "SENT" || row.status === "FAILED", attempts: row.sequence,
      });
      return {
        deliveries: (["EMAIL", "WHATSAPP"] as const).map(channel => {
          const row = rows.find(item => item.channel === channel);
          return row ? serialize(row) : {
            channel, status: "PENDING", recipient: null, attemptedAt: null, sentAt: null,
            error: "Liquidación anterior a los envíos automáticos. Puedes enviarla manualmente.",
            uncertain: false, canRetry: true, attempts: 0,
          };
        }),
        history: rows.slice(0, 100).map(serialize),
      };
    },
    async retry(settlement: SettlementSnapshot, channel: SettlementDeliveryChannel, requestId: string, actorUserId: number) {
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe(
          'INSERT INTO public."AllySettlementDelivery" ("settlementId","channel") VALUES ($1,$2) ON CONFLICT DO NOTHING', settlement.id, channel,
        );
        await tx.$queryRawUnsafe(
          'SELECT "settlementId" FROM public."AllySettlementDelivery" WHERE "settlementId"=$1 AND "channel"=$2 FOR UPDATE',
          settlement.id, channel,
        );
        const [replayed] = await tx.$queryRawUnsafe<SettlementDeliveryAttempt[]>(
          'SELECT a.* FROM public."AllySettlementDeliveryAttempt" a WHERE a."requestId"=$1::uuid OR a."id" IN (SELECT "attemptId" FROM public."AllySettlementDeliveryRequest" WHERE "requestId"=$1::uuid)', requestId,
        );
        if (replayed) {
          if (replayed.settlementId !== settlement.id || replayed.channel !== channel) throw new DeliveryConflictError("Este reintento pertenece a otro envío.");
          return replayed;
        }
        const [last] = await tx.$queryRawUnsafe<SettlementDeliveryAttempt[]>(
          'SELECT * FROM public."AllySettlementDeliveryAttempt" WHERE "settlementId"=$1 AND "channel"=$2 ORDER BY "sequence" DESC LIMIT 1',
          settlement.id, channel,
        );
        if (last?.status === "UNCERTAIN") throw new DeliveryConflictError("Resultado incierto: concilia el envío con el proveedor antes de reenviar para evitar duplicados.");
        if (last && ["QUEUED", "PROCESSING"].includes(last.status)) {
          await tx.$executeRawUnsafe('INSERT INTO public."AllySettlementDeliveryRequest" ("requestId","attemptId") VALUES ($1::uuid,$2::uuid)', requestId, last.id);
          return last;
        }
        const attempt = await insertAttempt(tx, {
          settlementId: settlement.id, channel, sequence: (last?.sequence || 0) + 1, requestId, actorUserId,
          payload: last?.payload || buildSettlementDeliveryPayload({
            allyName: settlement.aliado.nombre, periodStart: settlement.periodoInicio,
            periodEnd: settlement.periodoFin, netAmount: settlement.saldoNeto,
          }),
        });
        await tx.$executeRawUnsafe('INSERT INTO public."AllySettlementDeliveryRequest" ("requestId","attemptId") VALUES ($1::uuid,$2::uuid)', requestId, attempt.id);
        return attempt;
      });
    },
    async recover() {
      // A process may crash after the provider accepted a message. Never blindly resend it.
      await db.$executeRawUnsafe(`UPDATE public."AllySettlementDeliveryAttempt"
        SET "status"=CASE WHEN "sendStartedAt" IS NULL THEN 'QUEUED' ELSE 'UNCERTAIN' END,
            "error"=CASE WHEN "sendStartedAt" IS NULL THEN NULL ELSE 'Resultado incierto tras una interrupción. Requiere conciliación con el proveedor; reenvío bloqueado.' END,
            "leaseUntil"=NULL
        WHERE "status"='PROCESSING' AND "leaseUntil"<now()`);
    },
    async claim(settlementId?: number) {
      const [row] = await db.$queryRawUnsafe<Array<SettlementDeliveryAttempt & { allyId: number }>>(
        `UPDATE public."AllySettlementDeliveryAttempt" AS attempt SET "status"='PROCESSING',
            "attemptedAt"=now(),"leaseUntil"=now()+interval '5 minutes',"claimToken"=$2::uuid
          WHERE "id"=(SELECT "id" FROM public."AllySettlementDeliveryAttempt"
            WHERE "status"='QUEUED' AND ($1::integer IS NULL OR "settlementId"=$1)
            ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING attempt.*, (SELECT s."aliadoId" FROM public."LiquidacionAliado" s
            WHERE s."id"=attempt."settlementId") AS "allyId"`,
        settlementId ?? null, randomUUID(),
      );
      return row || null;
    },
    async beforeSend(id: string, claimToken: string) {
      const changed = await db.$executeRawUnsafe(
        `UPDATE public."AllySettlementDeliveryAttempt" SET "sendStartedAt"=now()
          WHERE "id"=$1::uuid AND "claimToken"=$2::uuid AND "status"='PROCESSING' AND "sendStartedAt" IS NULL AND "leaseUntil">now()`, id, claimToken,
      );
      if (!changed) throw new Error("El intento perdió su reserva. No se inició un nuevo envío.");
    },
    async accepted(id: string, providerId: string, claimToken: string) {
      await db.$executeRawUnsafe(
        `UPDATE public."AllySettlementDeliveryAttempt" SET "status"='SENT',"providerId"=$2,"sentAt"=COALESCE("sentAt",now()),"error"=NULL,"leaseUntil"=NULL
         WHERE "id"=$1::uuid AND "claimToken"=$3::uuid AND "status" IN ('PROCESSING','UNCERTAIN')`, id, providerId, claimToken,
      );
    },
    async failed(id: string, error: string, uncertain: boolean, claimToken: string) {
      await db.$executeRawUnsafe(
        `UPDATE public."AllySettlementDeliveryAttempt" SET "status"=$2,"error"=$3,"leaseUntil"=NULL
          WHERE "id"=$1::uuid AND "claimToken"=$4::uuid AND "status"='PROCESSING'`,
        id, uncertain ? "UNCERTAIN" : "FAILED", error.slice(0, 600), claimToken,
      );
    },
    async document(settlementId: number, build: () => Promise<Buffer>) {
      const read = () => db.$queryRawUnsafe<Array<{ pdf: Uint8Array; filename: string }>>(
        'SELECT "pdf","filename" FROM public."AllySettlementDocument" WHERE "settlementId"=$1', settlementId,
      );
      let [stored] = await read();
      if (!stored) {
        const pdf = await build();
        const filename = `liquidacion-aliado-LA-${settlementId}.pdf`;
        await db.$executeRawUnsafe(
          'INSERT INTO public."AllySettlementDocument" ("settlementId","pdf","sha256","filename") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          settlementId, pdf, createHash("sha256").update(pdf).digest("hex"), filename,
        );
        [stored] = await read();
      }
      return { pdf: Buffer.from(stored.pdf), filename: stored.filename };
    },
    async reconcileWhatsApp(input: { attemptId: string; providerId: string; recipient: string; status: string; timestamp: Date }) {
      // Signed Meta webhook: match callback, recipient AND provider id to avoid cross-ally updates.
      const sent = ["sent", "delivered", "read"].includes(input.status);
      if (!sent && input.status !== "failed") return;
      await db.$executeRawUnsafe(
        `UPDATE public."AllySettlementDeliveryAttempt" SET "status"=$4,"providerId"=$2,
          "sentAt"=CASE WHEN $4='SENT' THEN COALESCE("sentAt",$5) ELSE "sentAt" END,
          "error"=CASE WHEN $4='FAILED' THEN 'Meta informó un fallo de entrega. Puedes reintentar este canal.' ELSE NULL END,
          "leaseUntil"=NULL,"providerEventAt"=$5
          WHERE "id"=$1::uuid AND "channel"='WHATSAPP' AND "recipient"=$3
            AND ("providerId" IS NULL OR "providerId"=$2) AND "sendStartedAt" IS NOT NULL
            AND ("providerEventAt" IS NULL OR "providerEventAt"<$5
              OR ("providerEventAt"=$5 AND $4='FAILED' AND "status"<>'FAILED'))`,
        input.attemptId, input.providerId, input.recipient, sent ? "SENT" : "FAILED", input.timestamp,
      );
    },
  };
}
