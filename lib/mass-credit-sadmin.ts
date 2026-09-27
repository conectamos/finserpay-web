import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { getSecondCreditEligibility } from "@/lib/second-credit-authorization";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export type ImportIdentity = { cedula?: unknown; numeroCreditoSadmin?: unknown };
export type ImportSadminMode = "EXISTING" | "PENDING";

export function readImportSadminMode(value: unknown): ImportSadminMode {
  if (value === undefined || value === "EXISTING") return "EXISTING";
  if (value === "PENDING") return "PENDING";
  throw new CreditApprovalError("INVALID_IMPORT_SADMIN_MODE", "Selecciona si los créditos ya existen en SADMIN o están pendientes de creación.");
}

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
export async function validateImportIdentities(db: Database, rows: ImportIdentity[], sadminMode: ImportSadminMode = "EXISTING") {
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
  // The historical-import duplicate rule stays in force unless the central
  // administrator explicitly authorized this document. Commit rechecks this
  // after the shared document locks; preview never grants an authorization.
  const secondCreditEligibility = existingDocuments.size
    ? await getSecondCreditEligibility(db, [...existingDocuments])
    : new Map();
  const existingNumbers = new Set(registrations.map(row => row.numero));
  return rows.map((row, index) => {
    const errors: string[] = [];
    if (sadminMode === "PENDING") {
      const number = row.numeroCreditoSadmin;
      if (number != null && (typeof number !== "string" || number.trim() !== "" || /[\u0000-\u001f\u007f]/.test(number))) {
        errors.push("Deja vacío el número de crédito en SADMIN para créditos pendientes. Si ya tienes un número, selecciona créditos existentes en SADMIN");
      }
    } else {
      if (!numbers[index]) errors.push("Número de crédito en SADMIN obligatorio");
      if (typeof row.numeroCreditoSadmin !== "string" || String(row.numeroCreditoSadmin).length > 80 || /[\u0000-\u001f\u007f]/.test(String(row.numeroCreditoSadmin))) {
        errors.push("Número de crédito en SADMIN: usa texto de hasta 80 caracteres");
      }
      if (repeatedNumbers.has(numberKeys[index])) errors.push("Número de crédito en SADMIN repetido en la carga");
      if (existingNumbers.has(numberKeys[index])) errors.push("Número de crédito en SADMIN ya registrado en otro crédito");
    }
    if (repeatedDocuments.has(documents[index])) errors.push("Cédula repetida en la carga: no se permite crear otro crédito");
    if (existingDocuments.has(documents[index])) {
      const eligibility = secondCreditEligibility.get(documents[index]);
      if (!eligibility?.authorization?.active) {
        errors.push("Esta cédula ya tiene un crédito en FINSER PAY. Se requiere autorización del administrador para crear otro");
      } else if (!eligibility.canCreate) {
        errors.push("Esta cédula ya tiene dos créditos vigentes. La autorización de segundo crédito no permite crear un tercero");
      }
    }
    return errors;
  });
}

export function requireImportConfirmation(body: { sadminConfirmed?: unknown; requestId?: unknown }, sadminMode: ImportSadminMode = "EXISTING") {
  if (sadminMode === "EXISTING" && body.sadminConfirmed !== true) {
    throw new CreditApprovalError("SADMIN_CONFIRMATION_REQUIRED", "Confirma que los créditos, codeudores y números ya existen en SADMIN antes de crear.");
  }
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new CreditApprovalError("INVALID_IMPORT_REQUEST", "Actualiza la página e intenta nuevamente.");
  }
  return body.requestId.toLowerCase();
}

type ImportedSadminCredit = {
  creditoId: number; actor: { id: number; nombre: string };
  requestId: string; rowNumber: number; cedula: string;
} & ({
  sadminMode?: "EXISTING"; numeroCredito: string; confirmedAt: Date;
} | {
  sadminMode: "PENDING"; createdAt: Date;
});

// Existing mode records an administrator's attestation, not an external API
// response. Pending mode records no confirmation or number. Both MUST share the
// transaction that creates the credit, including the audit.
export async function registerImportedSadminCredit(db: Database, input: ImportedSadminCredit) {
  const pending = input.sadminMode === "PENDING";
  const numeroCredito = pending ? null : input.numeroCredito;
  const recordedAt = pending ? input.createdAt : input.confirmedAt;
  const rows = await db.$queryRawUnsafe<Array<{ creditoId: number }>>(
    `INSERT INTO "CreditSadminRegistration"
      ("creditoId","version","codeudorCreado","creditoCreado","numeroCreditoConfirmado","numeroCredito","completedAt","updatedAt")
     VALUES ($1,1,${pending ? "false,false,false,$2,NULL" : "true,true,true,$2,$3"},$3) RETURNING "creditoId"`,
    input.creditoId, numeroCredito, recordedAt,
  );
  if (rows[0]?.creditoId !== input.creditoId) throw new Error("No se confirmó el registro SADMIN");
  const insertedEvents = await db.$executeRawUnsafe(
    `INSERT INTO "CreditSadminEvent"
      ("id","creditoId","version","actorKind","actorUserId","actorName","payload")
     VALUES ($1::uuid,$2,1,'USER',$3,$4,$5::jsonb)`,
    randomUUID(), input.creditoId, input.actor.id, input.actor.nombre,
    JSON.stringify({ source: "IMPORTACION_MASIVA", confirmation: pending ? "PENDING_SADMIN" : "ADMIN_EXISTING_SADMIN",
      requestId: input.requestId, rowNumber: input.rowNumber, clienteDocumento: input.cedula,
      numeroCredito, codeudorCreado: !pending, creditoCreado: !pending,
      numeroCreditoConfirmado: !pending,
      ...(pending ? { recordedAt: recordedAt.toISOString() } : { confirmedAt: recordedAt.toISOString() }) }),
  );
  if (insertedEvents !== 1) throw new Error("No se confirmó la auditoría del registro SADMIN");
}
