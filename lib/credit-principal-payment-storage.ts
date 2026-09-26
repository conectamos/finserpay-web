import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";

type PrincipalRevisionDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes semantic values, independent of JSON key ordering. */
export function hashPrincipalPayment(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function findPrincipalPaymentRevision(
  db: PrincipalRevisionDb,
  creditoId: number,
  idempotencyKey: string,
) {
  const rows = await db.$queryRawUnsafe<Array<{
    id: string;
    requestHash: string;
    resultado: Record<string, unknown>;
  }>>(
    `SELECT "id", "requestHash", "resultado" FROM "CreditPrincipalPaymentRevision"
     WHERE "creditoId"=$1 AND "idempotencyKey"=$2 LIMIT 1`,
    creditoId, idempotencyKey,
  );
  return rows[0] || null;
}

export async function persistPrincipalPaymentRevision(
  db: PrincipalRevisionDb,
  input: {
    creditoId: number;
    abonoId: number;
    revision: number;
    idempotencyKey: string;
    requestHash: string;
    previewHash: string;
    snapshotBefore: unknown;
    snapshotAfter: unknown;
    conciliacion: unknown;
    resultado: unknown;
    usuarioId: number;
  },
) {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "CreditPrincipalPaymentRevision"
      ("id","creditoId","abonoId","revision","idempotencyKey","requestHash","previewHash",
       "snapshotBefore","snapshotAfter","conciliacion","resultado","usuarioId")
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
    id, input.creditoId, input.abonoId, input.revision, input.idempotencyKey,
    input.requestHash, input.previewHash,
    input.snapshotBefore == null ? null : JSON.stringify(input.snapshotBefore),
    JSON.stringify(input.snapshotAfter), JSON.stringify(input.conciliacion),
    JSON.stringify(input.resultado), input.usuarioId,
  );
  return id;
}
