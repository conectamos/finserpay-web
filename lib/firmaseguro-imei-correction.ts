import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureIphoneEnrollmentSchema } from "@/lib/iphone-enrollment-storage";
import {
  ensureFirmaSeguroSchema,
  lockSolicitudOperationMutation,
  markFirmaSeguroDraftProcessesSuperseded,
  type FirmaSeguroProcessRow,
} from "@/lib/firmaseguro-storage";
import {
  ensureSolicitudSchema,
  lockSolicitudIdentityMutation,
} from "@/lib/solicitudes-storage";

type DraftCorrectionRow = {
  id: number;
  estado: string;
  creditoId: number | null;
  currentStep: number;
  imei: string | null;
  payload: unknown;
  expiresAt: Date | null;
  createdAt: Date;
};

type ActiveFirmaSeguroCorrectionRow = {
  processUuid: string;
  draftPayload: unknown;
  signedDocumentBase64: string | null;
  completedAt: Date | null;
};

type ActiveEnrollmentReviewRow = {
  id: string;
  analystName: string;
  correlationId: string;
  checklistHash: string;
  approvedAt: Date | string;
};

type CorrectionAuditRow = {
  correlationId: string;
  draftId: number;
  previousImei: string;
  newImei: string;
  reason: string;
  actorUserId: number;
  actorName: string;
  previousProcessUuid: string | null;
};

const EQUIPMENT_DEPENDENT_PAYLOAD_FIELDS = [
  "fotoEntregaDataUrl",
  "fotoEntregaCapturedAt",
  "fotoEntregaSource",
  "fotoRemisionDataUrl",
  "fotoRemisionCapturedAt",
  "fotoRemisionSource",
  "iphoneEnrollmentVerified",
  "iphoneEnrollmentConfirmedAt",
  "iphoneEnrolamientoVerificado",
  "iphoneEnrolamientoConfirmadoAt",
  "iphoneEnrollmentReview",
  "iphoneEnrollmentReviewId",
  "androidEnrollment",
  "deliveryValidation",
  "deliveryStatus",
  "enrollmentConfirmed",
  "entregaValidada",
  "deliverableReady",
] as const;

export class FirmaSeguroImeiCorrectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "FirmaSeguroImeiCorrectionError";
    this.code = code;
    this.status = status;
  }
}

function normalizeImei(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeReason(value: unknown) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalizeExpectedProcessUuid(value: unknown) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
}

function normalizeCorrectionId(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : "";
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function archiveEquipmentDependentPayload(
  payload: Record<string, unknown>,
  previousImei: string,
  enrollmentReview: ActiveEnrollmentReviewRow | null
) {
  const fields: Record<string, unknown> = {};
  for (const field of EQUIPMENT_DEPENDENT_PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      fields[field] = payload[field];
    }
  }
  if (Object.keys(fields).length === 0 && !enrollmentReview) return null;
  return {
    previousImei,
    fields,
    enrollmentReview: enrollmentReview
      ? {
          id: enrollmentReview.id,
          analystName: enrollmentReview.analystName,
          correlationId: enrollmentReview.correlationId,
          checklistHash: enrollmentReview.checklistHash,
          approvedAt: enrollmentReview.approvedAt,
        }
      : null,
  };
}

function normalizeExpectedEnrollmentReviewId(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new FirmaSeguroImeiCorrectionError(
      "ENROLAMIENTO_ESPERADO_INVALIDO",
      "Actualiza el estado del enrolamiento antes de corregir el IMEI.",
      400
    );
  }
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized
    )
  ) {
    throw new FirmaSeguroImeiCorrectionError(
      "ENROLAMIENTO_ESPERADO_INVALIDO",
      "Actualiza el estado del enrolamiento antes de corregir el IMEI.",
      400
    );
  }
  return normalized;
}

function assertActiveDraft(row: DraftCorrectionRow | undefined) {
  if (
    !row ||
    row.estado !== "ABIERTO" ||
    row.creditoId !== null ||
    (row.expiresAt || new Date(row.createdAt.getTime() + 15 * 86_400_000)) <=
      new Date()
  ) {
    throw new FirmaSeguroImeiCorrectionError(
      "SOLICITUD_NO_DISPONIBLE",
      "La solicitud ya no está abierta o ya fue convertida en crédito."
    );
  }
}

async function readDraft(
  database: Prisma.TransactionClient,
  draftId: number,
  lock = false
) {
  const rows = await database.$queryRawUnsafe<DraftCorrectionRow[]>(
    `
      SELECT "id", "estado", "creditoId", "currentStep", "imei", "payload",
        "expiresAt", "createdAt"
      FROM "CreditoBorrador"
      WHERE "id" = $1
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}
    `,
    draftId
  );
  return rows[0];
}

export async function correctFirmaSeguroDraftImei(input: {
  draftId: number;
  imei: unknown;
  reason: unknown;
  expectedCurrentImei: unknown;
  expectedProcessUuid: unknown;
  expectedEnrollmentReviewId: unknown;
  actorUserId: number;
  actorName: string;
}) {
  const imei = normalizeImei(input.imei);
  const expectedCurrentImei = normalizeImei(input.expectedCurrentImei);
  const expectedProcessUuid = normalizeExpectedProcessUuid(
    input.expectedProcessUuid
  );
  const expectedEnrollmentReviewId = normalizeExpectedEnrollmentReviewId(
    input.expectedEnrollmentReviewId
  );
  const reason = normalizeReason(input.reason);
  const actorName = String(input.actorName || "Administrador central")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  if (!Number.isSafeInteger(input.draftId) || input.draftId <= 0) {
    throw new FirmaSeguroImeiCorrectionError(
      "SOLICITUD_INVALIDA",
      "La solicitud indicada no es válida.",
      400
    );
  }
  if (!/^\d{15}$/.test(imei)) {
    throw new FirmaSeguroImeiCorrectionError(
      "IMEI_CORRECCION_INVALIDO",
      "El IMEI corregido debe tener exactamente 15 números.",
      400
    );
  }
  if (!/^\d{15}$/.test(expectedCurrentImei)) {
    throw new FirmaSeguroImeiCorrectionError(
      "IMEI_ACTUAL_ESPERADO_INVALIDO",
      "Recarga la solicitud antes de corregir el IMEI.",
      400
    );
  }
  if (!expectedProcessUuid) {
    throw new FirmaSeguroImeiCorrectionError(
      "FIRMASEGURO_PROCESO_ESPERADO_REQUERIDO",
      "Recarga el proceso firmado antes de corregir el IMEI.",
      400
    );
  }
  if (reason.length < 5) {
    throw new FirmaSeguroImeiCorrectionError(
      "MOTIVO_CORRECCION_REQUERIDO",
      "Escribe el motivo de la corrección del IMEI.",
      400
    );
  }

  await Promise.all([
    ensureSolicitudSchema(),
    ensureFirmaSeguroSchema(),
    ensureIphoneEnrollmentSchema(),
  ]);

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `iphone-enrollment:${input.draftId}`
    );
    await lockSolicitudOperationMutation(transaction, input.draftId);
    const initialDraft = await readDraft(transaction, input.draftId);
    assertActiveDraft(initialDraft);
    const initialPayload = payloadObject(initialDraft?.payload);
    const platform = String(initialPayload.plataformaDispositivo || "")
      .trim()
      .toUpperCase();
    if (platform !== "IPHONE") {
      throw new FirmaSeguroImeiCorrectionError(
        "CORRECCION_IMEI_SOLO_IPHONE",
        "La corrección de IMEI con reemisión de FirmaSeguro solo está disponible para solicitudes iPhone.",
        409
      );
    }
    const previousImei = normalizeImei(initialDraft?.imei);
    if (!/^\d{15}$/.test(previousImei)) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_ANTERIOR_INVALIDO",
        "La solicitud no tiene un IMEI anterior válido para corregir."
      );
    }
    if (previousImei !== expectedCurrentImei) {
      throw new FirmaSeguroImeiCorrectionError(
        "CORRECCION_IMEI_CONFLICTO",
        "La solicitud cambio desde que la abriste. Recarga el caso antes de corregir.",
        409
      );
    }
    if (previousImei === imei) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_CORRECCION_SIN_CAMBIOS",
        "El IMEI corregido es igual al IMEI actual."
      );
    }

    for (const identityImei of [previousImei, imei].sort()) {
      await lockSolicitudIdentityMutation(transaction, "imei", identityImei);
    }

    const draft = await readDraft(transaction, input.draftId, true);
    assertActiveDraft(draft);
    if (normalizeImei(draft?.imei) !== previousImei) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_CORRECCION_CONCURRENTE",
        "El IMEI de la solicitud cambió durante la corrección. Recarga el caso."
      );
    }

    const activeProcessRows = await transaction.$queryRawUnsafe<
      ActiveFirmaSeguroCorrectionRow[]
    >(
      `
        SELECT "processUuid", "draftPayload", "signedDocumentBase64", "completedAt"
        FROM "FirmaSeguroProcess"
        WHERE "draftId" = $1
          AND "supersededAt" IS NULL
          AND "creditoId" IS NULL
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1
        FOR UPDATE
      `,
      input.draftId
    );
    const activeProcess = activeProcessRows[0];
    const activeProcessPayload = payloadObject(activeProcess?.draftPayload);
    const activeProcessImei = normalizeImei(
      activeProcessPayload.imei || activeProcessPayload.deviceUid
    );
    if (
      !activeProcess ||
      (!activeProcess.completedAt &&
        !String(activeProcess.signedDocumentBase64 || "").trim())
    ) {
      throw new FirmaSeguroImeiCorrectionError(
        "FIRMASEGURO_FIRMADO_REQUERIDO",
        "La solicitud no tiene un proceso firmado vigente para corregir.",
        409
      );
    }
    if (
      activeProcess.processUuid !== expectedProcessUuid ||
      activeProcessImei !== expectedCurrentImei
    ) {
      throw new FirmaSeguroImeiCorrectionError(
        "CORRECCION_IMEI_CONFLICTO",
        "El proceso firmado cambio desde que lo consultaste. Recarga el caso.",
        409
      );
    }

    const [draftConflicts, creditConflicts] = await Promise.all([
      transaction.$queryRawUnsafe<Array<{ id: number }>>(
        `
          SELECT "id"
          FROM "CreditoBorrador"
          WHERE "id" <> $1
            AND "estado" = 'ABIERTO'
            AND "creditoId" IS NULL
            AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
            AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $2
          LIMIT 1
        `,
        input.draftId,
        imei
      ),
      transaction.$queryRawUnsafe<Array<{ id: number; folio: string }>>(
        `
          SELECT "id", "folio"
          FROM "Credito"
          WHERE UPPER(COALESCE("estado", '')) <> 'ANULADO'
            AND (
              regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE("deviceUid", ''), '[^0-9]', '', 'g') = $1
            )
          LIMIT 1
        `,
        imei
      ),
    ]);

    if (draftConflicts[0]) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_EN_OTRA_SOLICITUD",
        "El IMEI corregido ya pertenece a otra solicitud activa."
      );
    }
    if (creditConflicts[0]) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_YA_VENDIDO",
        `El IMEI corregido ya fue usado en el crédito ${creditConflicts[0].folio}.`
      );
    }
    const enrollmentReviews = await transaction.$queryRawUnsafe<
      ActiveEnrollmentReviewRow[]
    >(
      `
        SELECT "id"::text, "analystName", "correlationId"::text,
          "checklistHash", "approvedAt"
        FROM "IphoneEnrollmentReview"
        WHERE "solicitudId" = $1
          AND "supersededAt" IS NULL
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1
        FOR UPDATE
      `,
      input.draftId
    );
    const activeEnrollmentReview = enrollmentReviews[0] || null;
    if (
      (activeEnrollmentReview?.id || null) !== expectedEnrollmentReviewId
    ) {
      throw new FirmaSeguroImeiCorrectionError(
        "ENROLAMIENTO_CORRECCION_CONFLICTO",
        "El estado del enrolamiento cambió desde que abriste la solicitud. Recarga el caso antes de corregir el IMEI.",
        409
      );
    }
    const correlationId = randomUUID();
    const originalPayload = payloadObject(draft?.payload);
    const archivedEvidence = archiveEquipmentDependentPayload(
      originalPayload,
      previousImei,
      activeEnrollmentReview
    );
    const nextPayload: Record<string, unknown> = {
      ...originalPayload,
      imei,
      deviceUid: imei,
      wizardStep: 4,
      firmaSeguroCorrectionPending: true,
      firmaSeguroCorrectionId: correlationId,
    };
    delete nextPayload.firmaSeguroDraftFolio;
    delete nextPayload.financialTermsSeal;
    for (const field of EQUIPMENT_DEPENDENT_PAYLOAD_FIELDS) {
      delete nextPayload[field];
    }

    if (activeEnrollmentReview) {
      const supersededReviews = await transaction.$queryRawUnsafe<
        Array<{ id: string }>
      >(
        `
          UPDATE "IphoneEnrollmentReview"
          SET "supersededAt" = CURRENT_TIMESTAMP,
              "supersededByUserId" = $2,
              "supersededByName" = $3,
              "supersededReason" = $4,
              "supersededCorrelationId" = $5::uuid
          WHERE "id" = $1::uuid
            AND "solicitudId" = $6
            AND "supersededAt" IS NULL
          RETURNING "id"::text
        `,
        activeEnrollmentReview.id,
        input.actorUserId,
        actorName || "Administrador central",
        reason,
        correlationId,
        input.draftId
      );
      if (supersededReviews.length !== 1) {
        throw new FirmaSeguroImeiCorrectionError(
          "ENROLAMIENTO_CORRECCION_CONCURRENTE",
          "El enrolamiento cambió durante la corrección. Recarga el caso."
        );
      }
    }

    const updated = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
      `
        UPDATE "CreditoBorrador"
        SET "imei" = $2,
            "currentStep" = 4,
            "payload" = $3::jsonb,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
          AND "estado" = 'ABIERTO'
          AND "creditoId" IS NULL
          AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $4
        RETURNING "id"
      `,
      input.draftId,
      imei,
      JSON.stringify(nextPayload),
      previousImei
    );
    if (updated.length !== 1) {
      throw new FirmaSeguroImeiCorrectionError(
        "IMEI_CORRECCION_CONCURRENTE",
        "La solicitud cambió durante la corrección. Recarga el caso."
      );
    }

    await markFirmaSeguroDraftProcessesSuperseded(transaction, {
      draftId: input.draftId,
      actorUserId: input.actorUserId,
      reason,
    });

    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "SolicitudImeiCorrectionAudit" (
          "id", "correlationId", "draftId", "eventType",
          "previousImei", "newImei", "reason", "actorUserId", "actorName",
          "previousProcessUuid", "newProcessUuid", "archivedEvidence"
        )
        VALUES (
          $1::uuid, $2::uuid, $3, 'CORRECTED', $4, $5, $6, $7, $8, $9,
          NULL, $10::jsonb
        )
      `,
      randomUUID(),
      correlationId,
      input.draftId,
      previousImei,
      imei,
      reason,
      input.actorUserId,
      actorName || "Administrador central",
      activeProcess.processUuid,
      archivedEvidence ? JSON.stringify(archivedEvidence) : null
    );

    return {
      previousImei,
      imei,
      reissueRequired: true as const,
      enrollmentReapprovalRequired: Boolean(activeEnrollmentReview),
      supersededEnrollmentReviewId: activeEnrollmentReview?.id || null,
      currentStep: 4 as const,
    };
  });
}

export async function recordFirmaSeguroImeiCorrectionReissue(
  draftId: number,
  process: FirmaSeguroProcessRow | null
) {
  if (!process || process.draftId !== draftId || process.supersededAt) return false;
  const processPayload = payloadObject(process.draftPayload);
  const processImei = normalizeImei(processPayload.imei || processPayload.deviceUid);
  const correctionId = normalizeCorrectionId(
    processPayload.firmaSeguroCorrectionId
  );
  if (!/^\d{15}$/.test(processImei) || !correctionId) return false;

  await ensureFirmaSeguroSchema();
  return prisma.$transaction(async (transaction) => {
    const pendingRows = await transaction.$queryRawUnsafe<CorrectionAuditRow[]>(
      `
        SELECT corrected."correlationId"::text, corrected."draftId",
          corrected."previousImei", corrected."newImei", corrected."reason",
          corrected."actorUserId", corrected."actorName",
          corrected."previousProcessUuid"
        FROM "SolicitudImeiCorrectionAudit" corrected
        WHERE corrected."draftId" = $1
          AND corrected."eventType" = 'CORRECTED'
          AND corrected."newImei" = $2
          AND corrected."correlationId" = $3::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM "SolicitudImeiCorrectionAudit" reissued
            WHERE reissued."correlationId" = corrected."correlationId"
              AND reissued."eventType" = 'REISSUED'
          )
        LIMIT 1
      `,
      draftId,
      processImei,
      correctionId
    );
    const pending = pendingRows[0];
    if (!pending) return false;

    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "SolicitudImeiCorrectionAudit" (
          "id", "correlationId", "draftId", "eventType",
          "previousImei", "newImei", "reason", "actorUserId", "actorName",
          "previousProcessUuid", "newProcessUuid", "archivedEvidence"
        )
        VALUES (
          $1::uuid, $2::uuid, $3, 'REISSUED', $4, $5, $6, $7, $8, $9, $10,
          NULL
        )
        ON CONFLICT ("correlationId", "eventType") DO NOTHING
      `,
      randomUUID(),
      pending.correlationId,
      draftId,
      pending.previousImei,
      pending.newImei,
      pending.reason,
      pending.actorUserId,
      pending.actorName,
      pending.previousProcessUuid,
      process.processUuid
    );

    await transaction.$executeRawUnsafe(
      `
        UPDATE "CreditoBorrador"
        SET "payload" = (
              COALESCE("payload", '{}'::jsonb)
              - 'firmaSeguroCorrectionPending'
              - 'firmaSeguroCorrectionId'
            ) || jsonb_build_object(
              'firmaSeguroReissuedAt', CURRENT_TIMESTAMP::text,
              'firmaSeguroReissueProcessUuid', $2::text
            ),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
          AND "estado" = 'ABIERTO'
          AND "creditoId" IS NULL
          AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $3
          AND COALESCE("payload"->>'firmaSeguroCorrectionId', '') = $4
      `,
      draftId,
      process.processUuid,
      processImei,
      correctionId
    );

    return true;
  });
}
