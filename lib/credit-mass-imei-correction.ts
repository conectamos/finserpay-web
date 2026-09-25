import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";
import {
  ensureCreditDeviceReplacementSchema,
  lockCreditDeviceReplacementImeiForCreditCreation,
} from "@/lib/credit-device-replacement-storage";
import { MASS_CREDIT_SOURCE } from "@/lib/credit-import-flags";
import { importDocument } from "@/lib/mass-credit-sadmin";
import prisma from "@/lib/prisma";

const MAX_ROWS = 250;
const CANCELLED_STATES = new Set(["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"]);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Reader = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

export type ImeiCorrectionInput = {
  numeroCreditoSadmin: string;
  cedula: string;
  nuevoImei: string;
};
export type ImeiCorrectionRow = {
  rowNumber: number;
  numeroCreditoSadmin: string;
  cedula: string;
  nuevoImei: string;
  creditoId: number | null;
  folio: string | null;
  imeiAnterior: string | null;
  errors: string[];
};
export type ImeiCorrectionResult = {
  ok: boolean;
  commit: boolean;
  corrected: number;
  rows: ImeiCorrectionRow[];
  summary: { total: number; valid: number; invalid: number };
};
type SadminCredit = {
  creditoId: number;
  sadminNumber: string;
  clienteDocumento: string | null;
  creditoCreado: boolean;
  numeroCreditoConfirmado: boolean;
  folio: string;
  previousImei: string;
  previousDeviceUid: string;
  estado: string;
  equalityService: string | null;
  importSource: string | null;
  pending: string | null;
};
type ExistingCreditImei = { imei: string; folio: string };
type ExistingImei = { imei: string };
type AuditRow = {
  creditoId: number;
  rowNumber: number;
  numeroCreditoSadmin: string;
  clienteDocumento: string;
  previousImei: string;
  newImei: string;
  requestHash: string;
  folio: string;
};

export class MassImeiCorrectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "MassImeiCorrectionError";
  }
}

export function parseMassImeiCorrectionRows(value: unknown): ImeiCorrectionInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROWS) {
    throw new MassImeiCorrectionError(
      "INVALID_ROWS",
      "Carga entre 1 y 250 filas con número SADMIN, cédula e IMEI nuevo."
    );
  }
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "cedula,nuevoImei,numeroCreditoSadmin" ||
      typeof item.numeroCreditoSadmin !== "string" ||
      typeof item.cedula !== "string" ||
      typeof item.nuevoImei !== "string"
    ) {
      throw new MassImeiCorrectionError(
        "INVALID_ROW",
        "Cada fila debe contener únicamente numeroCreditoSadmin, cedula y nuevoImei como texto."
      );
    }
    return {
      numeroCreditoSadmin: item.numeroCreditoSadmin.trim(),
      cedula: item.cedula.trim(),
      nuevoImei: item.nuevoImei.trim(),
    };
  });
}

function summary(rows: ImeiCorrectionRow[]) {
  const invalid = rows.filter((row) => row.errors.length > 0).length;
  return { total: rows.length, valid: rows.length - invalid, invalid };
}

function result(rows: ImeiCorrectionRow[], commit: boolean, corrected = 0): ImeiCorrectionResult {
  const totals = summary(rows);
  return { ok: totals.invalid === 0, commit, corrected, rows, summary: totals };
}

async function validate(
  db: Reader,
  input: ImeiCorrectionInput[],
  lockTargets: boolean
): Promise<ImeiCorrectionRow[]> {
  const numberKeys = input.map((row) => row.numeroCreditoSadmin.toLowerCase());
  const documentKeys = input.map((row) => importDocument(row.cedula));
  const imeis = input.map((row) => row.nuevoImei);
  const numberCounts = new Map<string, number>();
  const documentCounts = new Map<string, number>();
  const imeiCounts = new Map<string, number>();
  for (const key of numberKeys) numberCounts.set(key, (numberCounts.get(key) || 0) + 1);
  for (const key of documentKeys) documentCounts.set(key, (documentCounts.get(key) || 0) + 1);
  for (const imei of imeis) imeiCounts.set(imei, (imeiCounts.get(imei) || 0) + 1);

  const lockingSql = lockTargets ? " FOR UPDATE OF credit" : "";
  const credits = await db.$queryRawUnsafe<SadminCredit[]>(
    'SELECT registration."creditoId", registration."numeroCredito" AS "sadminNumber", ' +
      'registration."creditoCreado", registration."numeroCreditoConfirmado", ' +
      'credit."clienteDocumento", ' +
      'credit."folio", credit."imei" AS "previousImei", ' +
      'credit."deviceUid" AS "previousDeviceUid", credit."estado", ' +
      'credit."equalityService", ' +
      'credit."contratoSnapshot"#>>\'{origen,tipo}\' AS "importSource", ' +
      'credit."contratoSnapshot"#>>\'{origen,imeiTemporalPendienteCorreccion}\' AS "pending" ' +
      'FROM "CreditSadminRegistration" registration ' +
      'JOIN "Credito" credit ON credit."id" = registration."creditoId" ' +
      'WHERE LOWER(BTRIM(registration."numeroCredito")) = ANY($1::text[]) ' +
      'ORDER BY credit."id"' + lockingSql,
    [...new Set(numberKeys.filter(Boolean))]
  );
  const creditByNumber = new Map<string, SadminCredit>();
  for (const credit of credits) {
    creditByNumber.set(credit.sadminNumber.trim().toLowerCase(), credit);
  }

  const uniqueImeis = [...new Set(imeis.filter((imei) => /^\d{15}$/.test(imei)))];
  const creditConflicts = await db.$queryRawUnsafe<ExistingCreditImei[]>(
    'SELECT credit."folio", regexp_replace(COALESCE(credit."imei", \'\'), \'[^0-9]\', \'\', \'g\') AS "imei" ' +
      'FROM "Credito" credit WHERE regexp_replace(COALESCE(credit."imei", \'\'), \'[^0-9]\', \'\', \'g\') = ANY($1::text[]) ' +
      'UNION ALL SELECT credit."folio", regexp_replace(COALESCE(credit."deviceUid", \'\'), \'[^0-9]\', \'\', \'g\') AS "imei" ' +
      'FROM "Credito" credit WHERE regexp_replace(COALESCE(credit."deviceUid", \'\'), \'[^0-9]\', \'\', \'g\') = ANY($1::text[])',
    uniqueImeis
  );
  const draftConflicts = await db.$queryRawUnsafe<ExistingImei[]>(
    'SELECT regexp_replace(COALESCE("imei", \'\'), \'[^0-9]\', \'\', \'g\') AS "imei" ' +
      'FROM "CreditoBorrador" WHERE "estado" = \'ABIERTO\' AND "creditoId" IS NULL ' +
      'AND COALESCE("expiresAt", "createdAt" + INTERVAL \'15 days\') > CURRENT_TIMESTAMP ' +
      'AND regexp_replace(COALESCE("imei", \'\'), \'[^0-9]\', \'\', \'g\') = ANY($1::text[])',
    uniqueImeis
  );
  const replacementConflicts = await db.$queryRawUnsafe<ExistingImei[]>(
    'SELECT "newImei" AS "imei" FROM "CreditDeviceReplacement" ' +
      'WHERE "status" IN (\'PENDING_ENROLLMENT\', \'ENROLLMENT_APPROVED\') ' +
      'AND "newImei" = ANY($1::text[])',
    uniqueImeis
  );
  const creditConflictByImei = new Map(
    creditConflicts.map((credit) => [credit.imei, credit.folio])
  );
  const reservedImeis = new Set([
    ...draftConflicts.map((row) => row.imei),
    ...replacementConflicts.map((row) => row.imei),
  ]);

  return input.map((row, index) => {
    const errors: string[] = [];
    const number = row.numeroCreditoSadmin;
    const document = documentKeys[index];
    const imei = row.nuevoImei;
    const credit = creditByNumber.get(numberKeys[index]);
    if (!number || number.length > 80 || /[\u0000-\u001f\u007f]/.test(number)) {
      errors.push("Número de crédito en SADMIN inválido.");
    }
    if ((numberCounts.get(numberKeys[index]) || 0) > 1) {
      errors.push("Número de crédito en SADMIN repetido en esta corrección.");
    }
    if (document.length < 5 || document.length > 80 || row.cedula.length > 80) {
      errors.push("Cédula inválida.");
    }
    if (document && (documentCounts.get(document) || 0) > 1) {
      errors.push("Cédula repetida en esta corrección.");
    }
    if (!isValidCreditDeviceReplacementImei(imei)) {
      errors.push("El IMEI nuevo debe tener 15 dígitos y dígito de control válido.");
    }
    if ((imeiCounts.get(imei) || 0) > 1) {
      errors.push("IMEI nuevo repetido en esta corrección.");
    }
    if (!credit) {
      errors.push("No se encontró un crédito con este número en SADMIN.");
    } else {
      if (document && document !== importDocument(credit.clienteDocumento)) {
        errors.push("La cédula no coincide con el crédito de SADMIN.");
      }
      if (
        !credit.creditoCreado ||
        !credit.numeroCreditoConfirmado ||
        credit.equalityService !== MASS_CREDIT_SOURCE ||
        credit.importSource !== MASS_CREDIT_SOURCE ||
        credit.pending !== "true" ||
        CANCELLED_STATES.has(String(credit.estado || "").trim().toUpperCase())
      ) {
        errors.push("Este crédito no tiene una corrección de IMEI temporal pendiente.");
      }
      if (
        !/^\d{15}$/.test(credit.previousImei) ||
        credit.previousImei !== credit.previousDeviceUid
      ) {
        errors.push("Los identificadores vigentes del crédito son inconsistentes.");
      }
      if (imei === credit.previousImei) {
        errors.push("El nuevo IMEI es igual al IMEI temporal vigente.");
      }
    }
    if (creditConflictByImei.has(imei)) {
      errors.push("El IMEI nuevo ya está asignado al crédito " + creditConflictByImei.get(imei) + ".");
    }
    if (reservedImeis.has(imei)) {
      errors.push("El IMEI nuevo está reservado por otra solicitud o reemplazo.");
    }
    return {
      rowNumber: index + 1,
      numeroCreditoSadmin: number,
      cedula: document,
      nuevoImei: imei,
      creditoId: credit?.creditoId || null,
      folio: credit?.folio || null,
      imeiAnterior: credit?.previousImei || null,
      errors,
    };
  });
}

export async function previewMassImeiCorrections(input: ImeiCorrectionInput[]) {
  await ensureCreditDeviceReplacementSchema();
  return result(await validate(prisma, input, false), false);
}

export async function confirmMassImeiCorrections(input: {
  rows: ImeiCorrectionInput[];
  requestId: string;
  actor: { id: number; nombre: string };
}): Promise<ImeiCorrectionResult> {
  const requestId = input.requestId.trim().toLowerCase();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new MassImeiCorrectionError("INVALID_REQUEST_ID", "Genera un identificador nuevo para confirmar la corrección.");
  }
  const actorName = input.actor.nombre.trim();
  if (!Number.isSafeInteger(input.actor.id) || input.actor.id <= 0 || !actorName) {
    throw new MassImeiCorrectionError("INVALID_ACTOR", "Administrador inválido.", 403);
  }
  await ensureCreditDeviceReplacementSchema();
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ rows: input.rows, actorId: input.actor.id }))
    .digest("hex");
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "MASS_IMEI_CORRECTION:" + requestId
    );
    const previous = await transaction.$queryRawUnsafe<AuditRow[]>(
      'SELECT audit."creditoId", audit."rowNumber", audit."numeroCreditoSadmin", ' +
        'audit."clienteDocumento", audit."previousImei", audit."newImei", ' +
        'audit."requestHash", credit."folio" ' +
        'FROM "CreditMassImeiCorrection" audit ' +
        'JOIN "Credito" credit ON credit."id" = audit."creditoId" ' +
        'WHERE audit."requestId" = $1::uuid ORDER BY audit."rowNumber"',
      requestId
    );
    if (previous.length) {
      if (
        previous.length !== input.rows.length ||
        previous.some((row) => row.requestHash.trim() !== requestHash)
      ) {
        throw new MassImeiCorrectionError(
          "REQUEST_CONFLICT",
          "Esta confirmación ya se usó para otra corrección. Vuelve a previsualizar.",
          409
        );
      }
      return result(previous.map((row) => ({
        rowNumber: row.rowNumber,
        numeroCreditoSadmin: row.numeroCreditoSadmin,
        cedula: row.clienteDocumento,
        nuevoImei: row.newImei,
        creditoId: row.creditoId,
        folio: row.folio,
        imeiAnterior: row.previousImei,
        errors: [],
      })), true, previous.length);
    }

    // This is the same lock and uniqueness check used by normal credit creation.
    // Acquiring new IMEI locks in a stable order prevents two correction batches
    // from assigning the same physical device simultaneously.
    for (const imei of [...new Set(input.rows.map((row) => row.nuevoImei))].sort()) {
      if (!isValidCreditDeviceReplacementImei(imei)) continue;
      await lockCreditDeviceReplacementImeiForCreditCreation(transaction, { imei });
    }
    const rows = await validate(transaction, input.rows, true);
    if (summary(rows).invalid > 0) return result(rows, false);

    for (const row of rows) {
      const updated = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
        'UPDATE "Credito" SET "imei" = $1, "deviceUid" = $1, ' +
          '"contratoSnapshot" = jsonb_set("contratoSnapshot", ' +
          '\'{origen,imeiTemporalPendienteCorreccion}\', \'false\'::jsonb, false), ' +
          '"updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 ' +
          'AND "imei" = $3 AND "deviceUid" = $3 ' +
          'AND "equalityService" = $4 ' +
          'AND "contratoSnapshot"#>>\'{origen,tipo}\' = $4 ' +
          'AND "contratoSnapshot"#>>\'{origen,imeiTemporalPendienteCorreccion}\' = \'true\' ' +
          'AND LTRIM(REGEXP_REPLACE(COALESCE("clienteDocumento", \'\'), \'[^0-9]\', \'\', \'g\'), \'0\') = $5 ' +
          'RETURNING "id"',
        row.nuevoImei,
        row.creditoId,
        row.imeiAnterior,
        MASS_CREDIT_SOURCE,
        row.cedula
      );
      if (updated.length !== 1) {
        throw new MassImeiCorrectionError(
          "CONCURRENT_CHANGE",
          "Un crédito cambió durante la corrección. Previsualiza el lote nuevamente.",
          409
        );
      }
      await transaction.$executeRawUnsafe(
        'INSERT INTO "CreditMassImeiCorrection" ' +
          '("id", "creditoId", "requestId", "requestHash", "rowNumber", ' +
          '"numeroCreditoSadmin", "clienteDocumento", "previousImei", "newImei", "actorUserId", "actorName") ' +
          'VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)',
        randomUUID(),
        row.creditoId,
        requestId,
        requestHash,
        row.rowNumber,
        row.numeroCreditoSadmin,
        row.cedula,
        row.imeiAnterior,
        row.nuevoImei,
        input.actor.id,
        actorName.slice(0, 160)
      );
    }
    return result(rows, true, rows.length);
  }, { timeout: 60_000 });
}
