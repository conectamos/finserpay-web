import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export type ImportIdentity = { cedula?: unknown; numeroCreditoSadmin?: unknown };

export function importDocument(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
}
export function importSadminNumber(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function duplicates(values: string[]) {
  const seen = new Set<string>();
  return new Set(values.filter(value => {
    const repeated = Boolean(value && seen.has(value));
    seen.add(value);
    return repeated;
  }));
}

// Preview and commit use the same checks. The commit caller holds the shared
// document locks before reading, and the existing SADMIN unique index is final.
export async function validateImportIdentities(db: Database, rows: ImportIdentity[]) {
  const documents = rows.map(row => importDocument(row.cedula));
  const numbers = rows.map(row => importSadminNumber(row.numeroCreditoSadmin));
  const numberKeys = numbers.map(number => number.toLowerCase());
  const repeatedDocuments = duplicates(documents);
  const repeatedNumbers = duplicates(numberKeys);
  const credits = await db.$queryRawUnsafe<Array<{ documento: string; folio: string }>>(
    `SELECT LTRIM(REGEXP_REPLACE(COALESCE("clienteDocumento",''),'[^0-9]','','g'),'0') AS documento, "folio"
     FROM "Credito" WHERE LTRIM(REGEXP_REPLACE(COALESCE("clienteDocumento",''),'[^0-9]','','g'),'0') = ANY($1::text[])`,
    [...new Set(documents.filter(Boolean))],
  );
  const registrations = await db.$queryRawUnsafe<Array<{ numero: string }>>(
    `SELECT LOWER(BTRIM("numeroCredito")) AS numero FROM "CreditSadminRegistration"
     WHERE LOWER(BTRIM("numeroCredito")) = ANY($1::text[])`, [...new Set(numberKeys.filter(Boolean))],
  );
  const existingDocuments = new Set(credits.map(credit => credit.documento));
  const existingNumbers = new Set(registrations.map(row => row.numero));
  return rows.map((row, index) => {
    const errors: string[] = [];
    if (!numbers[index]) errors.push("Número de crédito en SADMIN obligatorio");
    if (typeof row.numeroCreditoSadmin !== "string" || String(row.numeroCreditoSadmin).length > 80 || /[\u0000-\u001f\u007f]/.test(String(row.numeroCreditoSadmin))) {
      errors.push("Número de crédito en SADMIN: usa texto de hasta 80 caracteres");
    }
    if (repeatedNumbers.has(numberKeys[index])) errors.push("Número de crédito en SADMIN repetido en la carga");
    if (existingNumbers.has(numberKeys[index])) errors.push("Número de crédito en SADMIN ya registrado en otro crédito");
    if (repeatedDocuments.has(documents[index])) errors.push("Cédula repetida en la carga: no se permite crear otro crédito");
    if (existingDocuments.has(documents[index])) errors.push("Esta cédula ya tiene un crédito en FINSER PAY. No se permite crear otro");
    return errors;
  });
}

export function requireImportConfirmation(body: { sadminConfirmed?: unknown; requestId?: unknown }) {
  if (body.sadminConfirmed !== true) {
    throw new CreditApprovalError("SADMIN_CONFIRMATION_REQUIRED", "Confirma que los créditos, codeudores y números ya existen en SADMIN antes de crear.");
  }
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new CreditApprovalError("INVALID_IMPORT_REQUEST", "Actualiza la página e intenta nuevamente.");
  }
  return body.requestId.toLowerCase();
}

// This records the administrator's attestation, not an external API response.
// It MUST share the transaction that creates the credit, including its audit.
export async function registerImportedSadminCredit(db: Database, input: {
  creditoId: number; numeroCredito: string; actor: { id: number; nombre: string };
  requestId: string; rowNumber: number; cedula: string; confirmedAt: Date;
}) {
  const rows = await db.$queryRawUnsafe<Array<{ creditoId: number }>>(
    `INSERT INTO "CreditSadminRegistration"
      ("creditoId","version","codeudorCreado","creditoCreado","numeroCreditoConfirmado","numeroCredito","completedAt","updatedAt")
     VALUES ($1,1,true,true,true,$2,$3,$3) RETURNING "creditoId"`,
    input.creditoId, input.numeroCredito, input.confirmedAt,
  );
  if (rows[0]?.creditoId !== input.creditoId) throw new Error("No se confirmó el registro SADMIN");
  await db.$executeRawUnsafe(
    `INSERT INTO "CreditSadminEvent"
      ("id","creditoId","version","actorKind","actorUserId","actorName","payload")
     VALUES ($1::uuid,$2,1,'USER',$3,$4,$5::jsonb)`,
    randomUUID(), input.creditoId, input.actor.id, input.actor.nombre,
    JSON.stringify({ source: "IMPORTACION_MASIVA", confirmation: "ADMIN_EXISTING_SADMIN",
      requestId: input.requestId, rowNumber: input.rowNumber, clienteDocumento: input.cedula,
      numeroCredito: input.numeroCredito, codeudorCreado: true, creditoCreado: true,
      numeroCreditoConfirmado: true, confirmedAt: input.confirmedAt.toISOString() }),
  );
}
