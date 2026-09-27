import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  buildMerchantMail,
  MerchantApplicationError,
  type MerchantApplicationRecord,
  type MerchantApplicationStore,
  type MerchantMail,
  type MerchantMailClaim,
} from "@/lib/merchant-applications";

type Row = MerchantApplicationRecord & {
  mailPayload: MerchantMail | null;
  attempts: number;
  ambiguousAttempt: boolean;
  firstAttemptAt: Date | null;
};

export function createMerchantApplicationStore(database = prisma): MerchantApplicationStore {
  return {
  async receive(input) {
    return database.$transaction(async (tx) => {
      // Consistent locking makes both browser retries and identical new submissions atomic.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-request:${input.requestId}`}))`;
      const mapped = await tx.$queryRaw<Array<Row & { contentHash: string }>>`
        SELECT a.*, r."contentHash" FROM "MerchantApplicationRequest" r
        JOIN "MerchantApplication" a ON a."id" = r."applicationId"
        WHERE r."requestId" = ${input.requestId}::uuid
      `;
      if (mapped[0]) {
        if (mapped[0].contentHash !== input.contentHash) {
          throw new MerchantApplicationError("IDEMPOTENCY_CONFLICT", 409, "El formulario cambió durante el envío. Recarga la página e inténtalo de nuevo.");
        }
        return { record: mapped[0], created: false };
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-content:${input.contentHash}`}))`;
      const same = await tx.$queryRaw<Row[]>`
        SELECT * FROM "MerchantApplication"
        WHERE "contentHash" = ${input.contentHash} AND "createdAt" > NOW() - INTERVAL '24 hours'
        ORDER BY "createdAt" DESC LIMIT 1
      `;
      let record = same[0];
      if (!record) {
        // Stored in PostgreSQL so the limit also works across server instances.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-contact:${input.data.email}`}))`;
        const recent = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM "MerchantApplication"
          WHERE "contactEmail" = ${input.data.email} AND "createdAt" > NOW() - INTERVAL '24 hours'
        `;
        if (Number(recent[0].count) >= 5) {
          throw new MerchantApplicationError("RATE_LIMIT", 429, "Ya recibimos varias postulaciones con este correo. Inténtalo más tarde.");
        }
        const inserted = await tx.$queryRaw<Row[]>`
          INSERT INTO "MerchantApplication" ("id", "contentHash", "contactEmail", "data")
          VALUES (${input.requestId}::uuid, ${input.contentHash}, ${input.data.email}, ${JSON.stringify(input.data)}::jsonb)
          RETURNING *
        `;
        record = inserted[0];
      }
      await tx.$executeRaw`
        INSERT INTO "MerchantApplicationRequest" ("requestId", "applicationId", "contentHash")
        VALUES (${input.requestId}::uuid, ${record.id}::uuid, ${input.contentHash})
      `;
      return { record, created: !same.length };
    }, { timeout: 10_000 });
  },
  async claim(id, from, force = false) {
    return database.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT * FROM "MerchantApplication"
        WHERE "id" = ${id}::uuid AND (
          ("notificationStatus" = 'PENDING' AND (${force} OR "nextAttemptAt" <= NOW())) OR
          ("notificationStatus" = 'SENDING' AND "leaseUntil" < NOW())
        ) FOR UPDATE SKIP LOCKED
      `;
      const row = rows[0];
      if (!row) return null;
      // Resend deduplication expires at 24h. A missing acknowledgement older than
      // 23h requires reconciliation, never a blind resend with an expired key.
      if (row.ambiguousAttempt && row.firstAttemptAt && Date.now() - new Date(row.firstAttemptAt).getTime() >= 23 * 3_600_000) {
        await tx.$executeRaw`
          UPDATE "MerchantApplication" SET "notificationStatus" = 'REVIEW',
          "lastErrorCode" = 'IDEMPOTENCY_WINDOW_EXPIRED', "leaseToken" = NULL,
          "leaseUntil" = NULL, "updatedAt" = NOW() WHERE "id" = ${id}::uuid
        `;
        return null;
      }
      const leaseToken = randomUUID();
      const mailPayload = row.mailPayload || buildMerchantMail(row, from);
      await tx.$executeRaw`
        UPDATE "MerchantApplication" SET "notificationStatus" = 'SENDING',
        "leaseToken" = ${leaseToken}::uuid, "leaseUntil" = NOW() + INTERVAL '2 minutes',
        "mailPayload" = ${JSON.stringify(mailPayload)}::jsonb,
        "firstAttemptAt" = COALESCE("firstAttemptAt", NOW()),
        "ambiguousAttempt" = TRUE, "attempts" = "attempts" + 1,
        "updatedAt" = NOW() WHERE "id" = ${id}::uuid
      `;
      return { ...row, mailPayload, leaseToken, attempts: row.attempts + 1, hadAmbiguousAttempt: row.ambiguousAttempt };
    });
  },
  async accepted(claim: MerchantMailClaim, providerId: string) {
    await database.$executeRaw`
      UPDATE "MerchantApplication" SET "notificationStatus" = 'ACCEPTED',
      "providerEmailId" = ${providerId}::uuid, "acceptedAt" = NOW(),
      "lastErrorCode" = NULL, "ambiguousAttempt" = FALSE,
      "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
      WHERE "id" = ${claim.id}::uuid AND "leaseToken" = ${claim.leaseToken}::uuid
    `;
  },
  async failed(claim, code, ambiguous) {
    const remainsAmbiguous = ambiguous || claim.hadAmbiguousAttempt;
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(claim.attempts, 7));
    await database.$executeRaw`
      UPDATE "MerchantApplication" SET "notificationStatus" = 'PENDING',
      "lastErrorCode" = ${code}, "ambiguousAttempt" = ${remainsAmbiguous},
      "firstAttemptAt" = CASE WHEN ${remainsAmbiguous} THEN "firstAttemptAt" ELSE NULL END,
      "nextAttemptAt" = NOW() + (${delaySeconds} * INTERVAL '1 second'),
      "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
      WHERE "id" = ${claim.id}::uuid AND "leaseToken" = ${claim.leaseToken}::uuid
    `;
  },
  async configurationPending(id) {
    await database.$executeRaw`
      UPDATE "MerchantApplication" SET "lastErrorCode" = 'MISSING_EMAIL_CONFIGURATION',
      "nextAttemptAt" = NOW() + INTERVAL '5 minutes', "updatedAt" = NOW()
      WHERE "id" = ${id}::uuid AND "notificationStatus" = 'PENDING'
    `;
  },
  async pending(limit) {
    const rows = await database.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "MerchantApplication"
      WHERE ("notificationStatus" = 'PENDING' AND "nextAttemptAt" <= NOW())
        OR ("notificationStatus" = 'SENDING' AND "leaseUntil" < NOW())
      ORDER BY "createdAt" ASC LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },
  };
}

export const merchantApplicationStore = createMerchantApplicationStore();

export async function retryMerchantApplications(limit = 10, applicationId?: string) {
  const { notifyMerchantApplication } = await import("@/lib/merchant-applications");
  const ids = applicationId ? [applicationId] : await merchantApplicationStore.pending(Math.min(Math.max(limit, 1), 10));
  const summary = { selected: ids.length, accepted: 0, pending: 0, skipped: 0, errors: 0 };
  for (const id of ids) {
    try {
      const result = await notifyMerchantApplication(merchantApplicationStore, id, { force: Boolean(applicationId) });
      if (result === "ACCEPTED") summary.accepted++;
      else if (result === "PENDING") summary.pending++;
      else summary.skipped++;
    } catch { summary.errors++; }
  }
  return summary;
}
