import "server-only";

import prisma from "@/lib/prisma";

type PadlockBindingLookupDatabase = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

function requiredCreditId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PADLOCK_CREDIT_ID_INVALID");
  }

  return value;
}

function normalizedDeviceIdentifier(value: unknown) {
  return String(value || "").trim();
}

/**
 * Shared ownership guard for legacy Equality flows. An ACTIVE Padlock binding
 * means Padlock exclusively owns remote lock/unlock operations for the credit.
 */
export async function hasActivePadlockBindingForCredit(
  creditId: number,
  database: PadlockBindingLookupDatabase = prisma
) {
  const normalizedCreditId = requiredCreditId(creditId);
  const rows = await database.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM "PadlockDeviceBinding"
        WHERE "creditId" = $1
          AND "status" = 'ACTIVE'
      ) AS "exists"
    `,
    normalizedCreditId,
  );

  return Boolean(rows[0]?.exists);
}

export async function hasActivePadlockBindingForDeviceIdentifier(
  deviceIdentifier: unknown,
  database: PadlockBindingLookupDatabase = prisma
) {
  const normalizedIdentifier = normalizedDeviceIdentifier(deviceIdentifier);

  if (!/^\d{15}$/.test(normalizedIdentifier)) {
    return false;
  }

  const rows = await database.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM "PadlockDeviceBinding"
        WHERE "imei" = $1
          AND "status" = 'ACTIVE'
      ) AS "exists"
    `,
    normalizedIdentifier,
  );

  return Boolean(rows[0]?.exists);
}
