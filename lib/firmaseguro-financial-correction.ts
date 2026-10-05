import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";
import { getUnresolvedDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import {
  buildDraftCredit,
  CreditValidationError,
  type DraftRow as FirmaSeguroDraftRow,
} from "@/lib/firmaseguro-draft-credit-builder";
import {
  ensureFirmaSeguroSchema,
  lockSolicitudOperationMutation,
  markFirmaSeguroDraftProcessesSuperseded,
  type FirmaSeguroProcessRow,
} from "@/lib/firmaseguro-storage";
import prisma from "@/lib/prisma";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/i;

type DraftRow = FirmaSeguroDraftRow & {
  creditoId: number | null;
  expiresAt: Date | null;
  createdAt: Date;
};

type FinancialValues = {
  valorEquipoTotal: number;
  cuotaInicial: number;
  plazoMeses: number;
};

type CorrectionAuditRow = {
  correlationId: string;
  draftId: number;
  reason: string;
  actorUserId: number;
  actorName: string;
  previousProcessUuid: string;
  previousChecksum: string;
  beforeFinancial: FinancialValues;
  afterFinancial: FinancialValues;
};

export class FirmaSeguroFinancialCorrectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "FirmaSeguroFinancialCorrectionError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  const raw = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_INVALIDA",
      `${label} debe ser un número entero válido.`,
      400,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_INVALIDA",
      `${label} está fuera del rango permitido.`,
      400,
    );
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string, maximum: number) {
  const raw = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_INVALIDA",
      `${label} debe ser un número entero válido.`,
      400,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_INVALIDA",
      `${label} está fuera del rango permitido.`,
      400,
    );
  }
  return parsed;
}

function moneyFromSeal(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new FirmaSeguroFinancialCorrectionError(
      "FIRMASEGURO_SELLO_INVALIDO",
      "Los valores del contrato firmado no superan la validación de integridad.",
    );
  }
  return Math.round(parsed);
}

function sameFinancialValues(
  left: FinancialValues,
  right: FinancialValues,
) {
  return (
    Number(left.valorEquipoTotal) === Number(right.valorEquipoTotal) &&
    Number(left.cuotaInicial) === Number(right.cuotaInicial) &&
    Number(left.plazoMeses) === Number(right.plazoMeses)
  );
}

function hasSignedPdf(process: FirmaSeguroProcessRow) {
  if (
    !process.signedDocumentBase64 ||
    !(process.completedAt || isFirmaSeguroCompletedStatus(process.status))
  ) {
    return false;
  }
  try {
    return Buffer.from(process.signedDocumentBase64, "base64")
      .subarray(0, 5)
      .toString() === "%PDF-";
  } catch {
    return false;
  }
}

let financialCorrectionSchemaPromise: Promise<void> | null = null;

export function ensureFirmaSeguroFinancialCorrectionSchema() {
  if (!financialCorrectionSchemaPromise) {
    financialCorrectionSchemaPromise = (async () => {
      await ensureFirmaSeguroSchema();
      await prisma.$transaction(async (database) => {
        await database.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext('finserpay-firmaseguro-financial-correction-schema'))",
        );
        await database.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SolicitudFinancialCorrectionAudit" (
          "id" UUID PRIMARY KEY,
          "correlationId" UUID NOT NULL,
          "draftId" INTEGER NOT NULL,
          "eventType" TEXT NOT NULL,
          "reason" TEXT NOT NULL,
          "actorUserId" INTEGER NOT NULL,
          "actorName" TEXT NOT NULL,
          "previousProcessUuid" TEXT NOT NULL,
          "newProcessUuid" TEXT,
          "previousChecksum" CHAR(64) NOT NULL,
          "newChecksum" CHAR(64),
          "beforeFinancial" JSONB NOT NULL,
          "afterFinancial" JSONB NOT NULL,
          "archivedRemission" JSONB,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "SolicitudFinancialCorrectionAudit_event_check"
            CHECK ("eventType" IN ('CORRECTED', 'REISSUED')),
          CONSTRAINT "SolicitudFinancialCorrectionAudit_reason_check"
            CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500)
        )
        `);
        await database.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "SolicitudFinancialCorrectionAudit_event_key"
          ON "SolicitudFinancialCorrectionAudit" ("correlationId", "eventType")
        `);
        await database.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "SolicitudFinancialCorrectionAudit_draft_created_idx"
          ON "SolicitudFinancialCorrectionAudit" ("draftId", "createdAt" DESC)
        `);
        await database.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "FinserRejectFinancialCorrectionAuditMutation"()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'Solicitud financial correction audit records are immutable';
        END;
        $$ LANGUAGE plpgsql
        `);
        await database.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'SolicitudFinancialCorrectionAudit_immutable'
              AND tgrelid = '"SolicitudFinancialCorrectionAudit"'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER "SolicitudFinancialCorrectionAudit_immutable"
              BEFORE UPDATE OR DELETE ON "SolicitudFinancialCorrectionAudit"
              FOR EACH ROW EXECUTE FUNCTION "FinserRejectFinancialCorrectionAuditMutation"();
          END IF;
        END
        $$
        `);
        await database.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "FinserProtectFinancialCorrectionProcessHistory"()
        RETURNS TRIGGER AS $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM "SolicitudFinancialCorrectionAudit" audit
            WHERE audit."previousProcessUuid" = OLD."processUuid"
          ) AND (
            NEW."draftPayload" IS DISTINCT FROM OLD."draftPayload" OR
            NEW."signedDocumentBase64" IS DISTINCT FROM OLD."signedDocumentBase64" OR
            NEW."signedDocumentFileName" IS DISTINCT FROM OLD."signedDocumentFileName" OR
            NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
          ) THEN
            RAISE EXCEPTION 'Historical FirmaSeguro contract evidence is immutable';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        `);
        await database.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'FirmaSeguroProcess_financial_history_immutable'
              AND tgrelid = '"FirmaSeguroProcess"'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER "FirmaSeguroProcess_financial_history_immutable"
              BEFORE UPDATE ON "FirmaSeguroProcess"
              FOR EACH ROW EXECUTE FUNCTION "FinserProtectFinancialCorrectionProcessHistory"();
          END IF;
        END
        $$
        `);
      }, { timeout: 30_000 });
    })().catch((error) => {
      financialCorrectionSchemaPromise = null;
      throw error;
    });
  }
  return financialCorrectionSchemaPromise;
}

async function readActiveProcess(
  database: Prisma.TransactionClient,
  draftId: number,
) {
  const rows = await database.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `SELECT * FROM "FirmaSeguroProcess"
      WHERE "draftId"=$1 AND "creditoId" IS NULL AND "supersededAt" IS NULL
      ORDER BY "createdAt" DESC,"id" DESC LIMIT 2 FOR UPDATE`,
    draftId,
  );
  if (rows.length > 1) {
    throw new FirmaSeguroFinancialCorrectionError(
      "FIRMASEGURO_PROCESO_AMBIGUO",
      "El expediente tiene más de una firma vigente. Requiere revisión técnica.",
    );
  }
  return rows[0] || null;
}

export async function correctFirmaSeguroDraftFinancialTerms(input: {
  draftId: number;
  idempotencyKey: unknown;
  expectedProcessUuid: unknown;
  expectedFinancialTermsChecksum: unknown;
  reason: unknown;
  valorEquipoTotal: unknown;
  cuotaInicial: unknown;
  plazoMeses: unknown;
  actorUserId: number;
  actorName: string;
}) {
  if (!Number.isSafeInteger(input.draftId) || input.draftId <= 0) {
    throw new FirmaSeguroFinancialCorrectionError(
      "SOLICITUD_INVALIDA",
      "La solicitud indicada no es válida.",
      400,
    );
  }
  const correlationId = cleanText(input.idempotencyKey, 36).toLowerCase();
  const expectedProcessUuid = cleanText(input.expectedProcessUuid, 200);
  const expectedChecksum = cleanText(
    input.expectedFinancialTermsChecksum,
    64,
  ).toLowerCase();
  const reason = cleanText(input.reason, 500);
  const actorName = cleanText(input.actorName || "Administrador central", 160);
  const afterFinancial: FinancialValues = {
    valorEquipoTotal: positiveInteger(
      input.valorEquipoTotal,
      "El valor de venta",
      2_000_000_000,
    ),
    cuotaInicial: nonNegativeInteger(
      input.cuotaInicial,
      "La cuota inicial",
      2_000_000_000,
    ),
    plazoMeses: positiveInteger(input.plazoMeses, "El plazo", 240),
  };

  if (!UUID_PATTERN.test(correlationId)) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_IDEMPOTENCIA_INVALIDA",
      "Actualiza el expediente y vuelve a intentar la corrección.",
      400,
    );
  }
  if (!expectedProcessUuid || !CHECKSUM_PATTERN.test(expectedChecksum)) {
    throw new FirmaSeguroFinancialCorrectionError(
      "FIRMASEGURO_VERSION_ESPERADA_INVALIDA",
      "Actualiza la firma vigente antes de corregir los valores.",
      400,
    );
  }
  if (reason.length < 5) {
    throw new FirmaSeguroFinancialCorrectionError(
      "MOTIVO_CORRECCION_REQUERIDO",
      "Escribe el motivo de la corrección de valores.",
      400,
    );
  }
  if (afterFinancial.cuotaInicial >= afterFinancial.valorEquipoTotal) {
    throw new FirmaSeguroFinancialCorrectionError(
      "CORRECCION_FINANCIERA_INVALIDA",
      "La cuota inicial debe ser menor que el valor de venta.",
      400,
    );
  }

  await ensureFirmaSeguroFinancialCorrectionSchema();
  return prisma.$transaction(async (database) => {
    await lockSolicitudOperationMutation(database, input.draftId);

    const priorAudit = await database.$queryRawUnsafe<CorrectionAuditRow[]>(
      `SELECT "correlationId"::text,"draftId","reason","actorUserId","actorName",
        "previousProcessUuid","previousChecksum","beforeFinancial","afterFinancial"
       FROM "SolicitudFinancialCorrectionAudit"
       WHERE "correlationId"=$1::uuid AND "eventType"='CORRECTED' LIMIT 1`,
      correlationId,
    );
    if (priorAudit[0]) {
      const prior = priorAudit[0];
      if (
        prior.draftId !== input.draftId ||
        prior.actorUserId !== input.actorUserId ||
        prior.previousProcessUuid !== expectedProcessUuid ||
        prior.previousChecksum !== expectedChecksum ||
        prior.reason !== reason ||
        !sameFinancialValues(prior.afterFinancial, afterFinancial)
      ) {
        throw new FirmaSeguroFinancialCorrectionError(
          "CORRECCION_FINANCIERA_IDEMPOTENCIA_CONFLICTO",
          "Esta confirmación ya fue usada para otra corrección.",
        );
      }
      return {
        idempotent: true as const,
        correlationId,
        previousProcessUuid: prior.previousProcessUuid,
        beforeFinancial: prior.beforeFinancial,
        afterFinancial: prior.afterFinancial,
        currentStep: 4 as const,
      };
    }

    if (await getUnresolvedDraftDispatch(input.draftId, database)) {
      throw new FirmaSeguroFinancialCorrectionError(
        "FIRMASEGURO_ENVIO_EN_CURSO",
        "La solicitud tiene un envío de firma sin resultado confirmado. Espera o solicita conciliación.",
      );
    }
    const drafts = await database.$queryRawUnsafe<DraftRow[]>(
      `SELECT d.*,
         u."nombre" AS "usuarioNombre",u."usuario" AS "usuarioLogin",
         v."nombre" AS "vendedorNombre",v."documento" AS "vendedorDocumento",
         v."telefono" AS "vendedorTelefono",v."email" AS "vendedorEmail",
         s."nombre" AS "sedeNombre",s."codigo" AS "sedeCodigo",
         s."aliadoId" AS "sedeAliadoId"
       FROM "CreditoBorrador" d
       LEFT JOIN "Usuario" u ON u."id"=d."usuarioId"
       LEFT JOIN "Vendedor" v ON v."id"=d."vendedorId"
       LEFT JOIN "Sede" s ON s."id"=d."sedeId"
       WHERE d."id"=$1 LIMIT 1 FOR UPDATE OF d`,
      input.draftId,
    );
    const draft = drafts[0];
    if (
      !draft ||
      draft.estado !== "ABIERTO" ||
      draft.creditoId !== null ||
      (draft.expiresAt || new Date(draft.createdAt.getTime() + 15 * 86_400_000)) <=
        new Date()
    ) {
      throw new FirmaSeguroFinancialCorrectionError(
        "SOLICITUD_NO_DISPONIBLE",
        "La solicitud ya no está abierta o ya fue convertida en crédito.",
      );
    }
    const currentPayload = record(draft.payload);
    if (currentPayload.firmaSeguroFinancialCorrectionPending === true) {
      throw new FirmaSeguroFinancialCorrectionError(
        "CORRECCION_FINANCIERA_PENDIENTE",
        "Esta solicitud ya tiene una corrección de valores pendiente de nueva firma.",
      );
    }

    const activeProcess = await readActiveProcess(database, input.draftId);
    if (
      !activeProcess ||
      activeProcess.processUuid !== expectedProcessUuid ||
      !hasSignedPdf(activeProcess)
    ) {
      throw new FirmaSeguroFinancialCorrectionError(
        "FIRMASEGURO_VERSION_CAMBIO",
        "La firma vigente cambió. Actualiza el expediente antes de corregir los valores.",
      );
    }
    const processPayload = record(activeProcess.draftPayload);
    const signedSeal = readFinancingTermsSeal(processPayload.financialTermsSeal);
    if (!signedSeal || signedSeal.checksum !== expectedChecksum) {
      throw new FirmaSeguroFinancialCorrectionError(
        "FIRMASEGURO_SELLO_CAMBIO",
        "Los términos firmados cambiaron. Actualiza el expediente antes de corregirlos.",
      );
    }
    const beforeFinancial: FinancialValues = {
      valorEquipoTotal: moneyFromSeal(signedSeal.snapshot.valorVenta),
      cuotaInicial: moneyFromSeal(signedSeal.snapshot.cuotaInicial),
      plazoMeses: signedSeal.snapshot.numeroCuotas,
    };
    if (sameFinancialValues(beforeFinancial, afterFinancial)) {
      throw new FirmaSeguroFinancialCorrectionError(
        "CORRECCION_FINANCIERA_SIN_CAMBIOS",
        "Los valores ingresados son iguales a los del contrato firmado.",
        400,
      );
    }

    // Run the same authoritative builder used by FirmaSeguro before replacing
    // the current contract. This keeps policy errors or minimum-initial
    // adjustments from leaving the draft without its valid signed version.
    let canonicalFinancial: FinancialValues;
    try {
      const built = await buildDraftCredit({
        ...draft,
        payload: {
          ...currentPayload,
          valorEquipoTotal: String(afterFinancial.valorEquipoTotal),
          cuotaInicial: String(afterFinancial.cuotaInicial),
          plazoMeses: String(afterFinancial.plazoMeses),
        },
      });
      canonicalFinancial = {
        valorEquipoTotal: Math.round(Number(built.credit.valorEquipoTotal)),
        cuotaInicial: Math.round(Number(built.credit.cuotaInicial)),
        plazoMeses: Math.round(Number(built.credit.plazoMeses)),
      };
    } catch (error) {
      if (error instanceof CreditValidationError) {
        throw new FirmaSeguroFinancialCorrectionError(
          "CORRECCION_FINANCIERA_POLITICA_INVALIDA",
          error.message,
          error.status >= 500 ? error.status : 422,
        );
      }
      throw error;
    }
    if (!sameFinancialValues(canonicalFinancial, afterFinancial)) {
      const requiredInitial = new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
      }).format(canonicalFinancial.cuotaInicial);
      throw new FirmaSeguroFinancialCorrectionError(
        "CORRECCION_FINANCIERA_AJUSTE_REQUERIDO",
        `La política vigente requiere una cuota inicial de ${requiredInitial} para esos valores. Ajusta la corrección antes de reemplazar el contrato firmado.`,
        422,
      );
    }

    const archivedRemission = currentPayload.fotoRemisionDataUrl
      ? {
          dataUrl: currentPayload.fotoRemisionDataUrl,
          capturedAt: currentPayload.fotoRemisionCapturedAt || null,
          source: currentPayload.fotoRemisionSource || null,
        }
      : null;
    const nextPayload: Record<string, unknown> = {
      ...currentPayload,
      valorEquipoTotal: String(afterFinancial.valorEquipoTotal),
      cuotaInicial: String(afterFinancial.cuotaInicial),
      plazoMeses: String(afterFinancial.plazoMeses),
      wizardStep: 4,
      firmaSeguroFinancialCorrectionPending: true,
      firmaSeguroFinancialCorrectionId: correlationId,
      firmaSeguroFinancialCorrectionPreviousProcessUuid: expectedProcessUuid,
      firmaSeguroFinancialCorrectionPreviousChecksum: expectedChecksum,
    };
    delete nextPayload.firmaSeguroDraftFolio;
    delete nextPayload.financialTermsSeal;
    delete nextPayload.fotoRemisionDataUrl;
    delete nextPayload.fotoRemisionCapturedAt;
    delete nextPayload.fotoRemisionSource;

    const archived = await markFirmaSeguroDraftProcessesSuperseded(database, {
      draftId: input.draftId,
      actorUserId: input.actorUserId,
      reason,
    });
    if (
      archived.length !== 1 ||
      archived[0]?.processUuid !== expectedProcessUuid
    ) {
      throw new FirmaSeguroFinancialCorrectionError(
        "FIRMASEGURO_VERSION_CAMBIO",
        "La firma vigente cambió durante la corrección. Actualiza el expediente.",
      );
    }

    const updated = await database.$queryRawUnsafe<Array<{ id: number }>>(
      `UPDATE "CreditoBorrador"
       SET "currentStep"=4,"payload"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
       RETURNING "id"`,
      input.draftId,
      JSON.stringify(nextPayload),
    );
    if (updated.length !== 1) {
      throw new FirmaSeguroFinancialCorrectionError(
        "CORRECCION_FINANCIERA_CONCURRENTE",
        "La solicitud cambió durante la corrección. Actualiza el expediente.",
      );
    }

    await database.$executeRawUnsafe(
      `INSERT INTO "SolicitudFinancialCorrectionAudit" (
        "id","correlationId","draftId","eventType","reason","actorUserId","actorName",
        "previousProcessUuid","previousChecksum","beforeFinancial","afterFinancial","archivedRemission"
       ) VALUES ($1::uuid,$2::uuid,$3,'CORRECTED',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`,
      randomUUID(),
      correlationId,
      input.draftId,
      reason,
      input.actorUserId,
      actorName || "Administrador central",
      expectedProcessUuid,
      expectedChecksum,
      JSON.stringify(beforeFinancial),
      JSON.stringify(afterFinancial),
      archivedRemission ? JSON.stringify(archivedRemission) : null,
    );

    return {
      idempotent: false as const,
      correlationId,
      previousProcessUuid: expectedProcessUuid,
      beforeFinancial,
      afterFinancial,
      currentStep: 4 as const,
    };
  });
}

export async function recordFirmaSeguroFinancialCorrectionReissue(
  draftId: number,
  process: FirmaSeguroProcessRow | null,
) {
  if (!process || process.draftId !== draftId || process.supersededAt) return false;
  const processPayload = record(process.draftPayload);
  const correctionId = cleanText(
    processPayload.firmaSeguroFinancialCorrectionId,
    36,
  ).toLowerCase();
  const newSeal = readFinancingTermsSeal(processPayload.financialTermsSeal);
  if (!UUID_PATTERN.test(correctionId) || !newSeal) return false;

  // El envío no equivale a una firma. El evento REISSUED debe apuntar a la
  // versión que realmente produjo el PDF firmado, incluso después de reintentos.
  if (!hasSignedPdf(process)) return true;

  const reissuedFinancial: FinancialValues = {
    valorEquipoTotal: moneyFromSeal(newSeal.snapshot.valorVenta),
    cuotaInicial: moneyFromSeal(newSeal.snapshot.cuotaInicial),
    plazoMeses: newSeal.snapshot.numeroCuotas,
  };

  await ensureFirmaSeguroFinancialCorrectionSchema();
  return prisma.$transaction(async (database) => {
    await lockSolicitudOperationMutation(database, draftId);
    const pendingRows = await database.$queryRawUnsafe<CorrectionAuditRow[]>(
      `SELECT corrected."correlationId"::text,corrected."draftId",corrected."reason",
        corrected."actorUserId",corrected."actorName",corrected."previousProcessUuid",
        corrected."previousChecksum",corrected."beforeFinancial",corrected."afterFinancial"
       FROM "SolicitudFinancialCorrectionAudit" corrected
       WHERE corrected."draftId"=$1 AND corrected."eventType"='CORRECTED'
          AND corrected."correlationId"=$2::uuid
       LIMIT 1`,
      draftId,
      correctionId,
    );
    const pending = pendingRows[0];
    if (!pending) return false;

    await database.$executeRawUnsafe(
      `INSERT INTO "SolicitudFinancialCorrectionAudit" (
        "id","correlationId","draftId","eventType","reason","actorUserId","actorName",
        "previousProcessUuid","newProcessUuid","previousChecksum","newChecksum",
        "beforeFinancial","afterFinancial"
        ) SELECT $1::uuid,"correlationId","draftId",'REISSUED',"reason","actorUserId","actorName",
          "previousProcessUuid",$2,"previousChecksum",$3,"beforeFinancial",$5::jsonb
         FROM "SolicitudFinancialCorrectionAudit"
        WHERE "correlationId"=$4::uuid AND "eventType"='CORRECTED'
       ON CONFLICT ("correlationId","eventType") DO NOTHING`,
      randomUUID(),
      process.processUuid,
      newSeal.checksum,
      correctionId,
      JSON.stringify(reissuedFinancial),
    );

    await database.$executeRawUnsafe(
      `UPDATE "CreditoBorrador"
       SET "payload"=(COALESCE("payload",'{}'::jsonb)
          - 'firmaSeguroFinancialCorrectionPending'
          - 'firmaSeguroFinancialCorrectionId'
          - 'firmaSeguroFinancialCorrectionPreviousProcessUuid'
          - 'firmaSeguroFinancialCorrectionPreviousChecksum')
          || jsonb_build_object(
            'firmaSeguroFinancialCorrectionReissuedAt',CURRENT_TIMESTAMP::text,
            'firmaSeguroFinancialCorrectionReissueProcessUuid',$2::text
          ),
          "updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
         AND COALESCE("payload"->>'firmaSeguroFinancialCorrectionId','')=$3`,
      draftId,
      process.processUuid,
      correctionId,
    );
    return true;
  });
}
