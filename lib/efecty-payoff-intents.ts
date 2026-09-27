import type { Prisma } from "@/app/generated/prisma/client";
import {
  isEarlyPayoffIntentMeta,
  type EarlyPayoffIntentMeta,
} from "@/lib/credit-early-payoff";
import prisma from "@/lib/prisma";

type SqlClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export type EfectyPayoffIntent = {
  id: number;
  creditoId: number;
  referencia: string;
  amountInCents: number;
  quote: EarlyPayoffIntentMeta;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  paymentKey: string | null;
};

type StoredIntent = Omit<EfectyPayoffIntent, "quote"> & { quote: unknown };

type IntentLookup = {
  creditoId: number;
  referencia: string;
  amountInCents: number;
  paidAt: Date;
};

type IntentCreate = Omit<IntentLookup, "paidAt"> & {
  quote: EarlyPayoffIntentMeta;
  now?: Date;
};

const INTENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
let ensureTablePromise: Promise<void> | null = null;

function normalizeReference(value: string) {
  return value.replace(/\D/g, "");
}

function validQuote(value: unknown): value is EarlyPayoffIntentMeta {
  if (!isEarlyPayoffIntentMeta(value)) return false;

  const amounts = [
    value.capitalPendiente,
    value.condonacion,
    value.montoCreditoLiquidado,
    value.saldoObligacion,
  ];
  return amounts.every((amount) => typeof amount === "number" && Number.isFinite(amount));
}

function parseIntent(row: StoredIntent | undefined): EfectyPayoffIntent | null {
  if (
    !row ||
    !validQuote(row.quote) ||
    Math.round(row.quote.capitalPendiente * 100) !== row.amountInCents
  ) return null;
  return { ...row, quote: row.quote };
}

/** A separate table keeps the customer's Efecty payoff instruction auditable. */
export function ensureEfectyPayoffIntentTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "EfectyPayoffIntent" (
          "id" SERIAL PRIMARY KEY,
          "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE CASCADE,
          "referencia" TEXT NOT NULL,
          "amountInCents" INTEGER NOT NULL CHECK ("amountInCents" > 0),
          "quote" JSONB NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "consumedAt" TIMESTAMP(3),
          "paymentKey" TEXT
        )
      `;
      await prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "EfectyPayoffIntent_lookup_idx"
        ON "EfectyPayoffIntent" ("creditoId", "referencia", "amountInCents", "createdAt" DESC)
      `;
      await prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "EfectyPayoffIntent_paymentKey_key"
        ON "EfectyPayoffIntent" ("paymentKey")
        WHERE "paymentKey" IS NOT NULL
      `;
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }

  return ensureTablePromise;
}

/** Call under the credit-row lock. Reopening an unchanged live quote is idempotent. */
export async function createEfectyPayoffIntent(client: SqlClient, input: IntentCreate) {
  const referencia = normalizeReference(input.referencia);
  const now = input.now ?? new Date();
  const amountInCents = Math.trunc(input.amountInCents);
  if (
    !Number.isInteger(input.creditoId) ||
    input.creditoId <= 0 ||
    referencia.length < 5 ||
    !Number.isSafeInteger(amountInCents) ||
    amountInCents <= 0 ||
    !validQuote(input.quote) ||
    Math.round(input.quote.capitalPendiente * 100) !== amountInCents ||
    Number.isNaN(now.getTime())
  ) {
    throw new Error("Intencion de liquidacion Efecty invalida");
  }

  const quoteJson = JSON.stringify(input.quote);
  const existing = await client.$queryRaw<StoredIntent[]>`
    SELECT * FROM "EfectyPayoffIntent"
    WHERE "creditoId" = ${input.creditoId}
      AND "referencia" = ${referencia}
      AND "amountInCents" = ${amountInCents}
      AND "quote" = CAST(${quoteJson} AS JSONB)
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${now}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 1
    FOR UPDATE
  `;
  const current = parseIntent(existing[0]);
  if (current) return current;

  const expiresAt = new Date(now.getTime() + INTENT_LIFETIME_MS);
  const rows = await client.$queryRaw<StoredIntent[]>`
    INSERT INTO "EfectyPayoffIntent"
      ("creditoId", "referencia", "amountInCents", "quote", "createdAt", "expiresAt")
    VALUES
      (${input.creditoId}, ${referencia}, ${amountInCents}, CAST(${quoteJson} AS JSONB), ${now}, ${expiresAt})
    RETURNING *
  `;
  const created = parseIntent(rows[0]);
  if (!created) throw new Error("No se pudo registrar la intencion de liquidacion Efecty");
  return created;
}

/** Reconciliation uses Efecty's confirmed payment timestamp, not the import time. */
export async function findEfectyPayoffIntent(client: SqlClient, input: IntentLookup) {
  const referencia = normalizeReference(input.referencia);
  const amountInCents = Math.trunc(input.amountInCents);
  if (
    !Number.isInteger(input.creditoId) ||
    input.creditoId <= 0 ||
    referencia.length < 5 ||
    !Number.isSafeInteger(amountInCents) ||
    amountInCents <= 0 ||
    Number.isNaN(input.paidAt.getTime())
  ) return null;

  const rows = await client.$queryRaw<StoredIntent[]>`
    SELECT * FROM "EfectyPayoffIntent"
    WHERE "creditoId" = ${input.creditoId}
      AND "referencia" = ${referencia}
      AND "amountInCents" = ${amountInCents}
      AND "createdAt" <= ${input.paidAt}
      AND "expiresAt" >= ${input.paidAt}
      AND "consumedAt" IS NULL
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 1
    FOR UPDATE
  `;
  return parseIntent(rows[0]);
}

/** The payment and this one-time claim must commit in the same transaction. */
export async function consumeEfectyPayoffIntent(
  client: SqlClient,
  id: number,
  paymentKey: string
) {
  if (!Number.isInteger(id) || id <= 0 || !paymentKey.trim()) return false;
  const rows = await client.$queryRaw<Array<{ id: number }>>`
    UPDATE "EfectyPayoffIntent"
    SET "consumedAt" = CURRENT_TIMESTAMP, "paymentKey" = ${paymentKey}
    WHERE "id" = ${id} AND "consumedAt" IS NULL
    RETURNING "id"
  `;
  return rows.length === 1;
}
