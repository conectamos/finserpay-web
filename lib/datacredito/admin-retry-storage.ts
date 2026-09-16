import "server-only";

import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  ensureDataCreditoSchema,
  hmacDataCreditoValue,
  normalizeDataCreditoDocument,
  normalizeDataCreditoSurname,
} from "@/lib/datacredito/storage";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURNAME_PATTERN = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u;
const RETRY_ACTION = "OPS_TX06_RETRY_AUTHORIZED";
const RETRY_OUTCOME = "AUTHORIZED";

export type DataCreditoAdminRetryErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_SURNAME"
  | "INVALID_ASSESSMENT_ID"
  | "INVALID_MUTATION_ID"
  | "ASSESSMENT_NOT_FOUND"
  | "RETRY_NOT_ELIGIBLE"
  | "RETRY_SURNAME_UNCHANGED"
  | "RETRY_STATE_CHANGED";

export class DataCreditoAdminRetryError extends Error {
  readonly code: DataCreditoAdminRetryErrorCode;
  readonly status: 400 | 404 | 409;

  constructor(
    code: DataCreditoAdminRetryErrorCode,
    message: string,
    status: 400 | 404 | 409
  ) {
    super(message);
    this.name = "DataCreditoAdminRetryError";
    this.code = code;
    this.status = status;
  }
}

type CandidateRow = {
  assessmentId: string;
  documentLast4: string;
  platform: string;
  providerEnvironment: string;
  status: string;
  score: number | null;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  reusedFromAssessmentId: string | null;
  consumedAt: Date | null;
  creditId: number | null;
  expiresAt: Date;
  retainedUntil: Date;
  createdAt: Date;
  updatedAt: Date;
  draftId: number | null;
  draftState: string | null;
  draftStep: number | null;
  draftCreditId: number | null;
  draftExpiresAt: Date | null;
  draftImei: string | null;
  draftDocumentMatches: boolean;
  draftPlatformMatches: boolean;
  userName: string | null;
  sellerName: string | null;
  aliadoName: string | null;
  sedeName: string | null;
  authorizedAt: Date | null;
  databaseNow: Date;
};

type LockedAssessmentRow = {
  id: string;
  documentHash: string;
  documentLast4: string;
  surnameHash: string;
  platform: string;
  providerEnvironment: string;
  status: string;
  score: number | null;
  reusedFromAssessmentId: string | null;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  creditId: number | null;
  retainedUntil: Date;
  createdAt: Date;
};

type LockedDraftRow = {
  id: number;
  estado: string;
  currentStep: number;
  clienteDocumento: string | null;
  imei: string | null;
  plataforma: string | null;
  assessmentId: string | null;
  creditoId: number | null;
  effectiveExpiresAt: Date;
};

export type DataCreditoAdminRetryEligibilityCode =
  | "ELIGIBLE"
  | "ALREADY_AUTHORIZED"
  | "FINAL_DECISION"
  | "EVALUATION_IN_PROGRESS"
  | "NOT_TX06_SURNAME_CASE"
  | "ASSESSMENT_EXPIRED"
  | "DRAFT_UNAVAILABLE";

export type DataCreditoAdminRetryCandidate = {
  assessmentId: string;
  documentLabel: string;
  platform: string;
  providerEnvironment: string;
  status: string;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  draftId: number | null;
  actor: {
    userName: string | null;
    sellerName: string | null;
    aliadoName: string | null;
    sedeName: string | null;
  };
  createdAt: string;
  expiresAt: string;
  authorizedAt: string | null;
  eligible: boolean;
  eligibilityCode: DataCreditoAdminRetryEligibilityCode;
  eligibilityMessage: string;
  alreadyAuthorized: boolean;
};

function parseDocument(value: unknown) {
  const raw = String(value ?? "").trim();
  const normalized = normalizeDataCreditoDocument(raw);
  if (raw !== normalized || !/^\d{3,13}$/.test(normalized)) {
    throw new DataCreditoAdminRetryError(
      "INVALID_DOCUMENT",
      "La cédula debe contener entre 3 y 13 dígitos.",
      400
    );
  }
  return normalized;
}

function parseSurname(value: unknown) {
  const normalized = normalizeDataCreditoSurname(value);
  if (
    !normalized ||
    normalized.length > 80 ||
    !SURNAME_PATTERN.test(normalized)
  ) {
    throw new DataCreditoAdminRetryError(
      "INVALID_SURNAME",
      "Ingresa el primer apellido correcto usando únicamente letras y espacios.",
      400
    );
  }
  return normalized;
}

function parseUuid(
  value: unknown,
  code: "INVALID_ASSESSMENT_ID" | "INVALID_MUTATION_ID",
  message: string
) {
  const normalized = String(value ?? "").trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new DataCreditoAdminRetryError(code, message, 400);
  }
  return normalized;
}

function iso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function documentLabel(last4: string) {
  return `•••• ${String(last4 || "").padStart(4, "•")}`;
}

function serializeActor(row: CandidateRow) {
  return {
    userName: row.userName,
    sellerName: row.sellerName,
    aliadoName: row.aliadoName,
    sedeName: row.sedeName,
  };
}

function candidateEligibility(row: CandidateRow) {
  if (row.authorizedAt) {
    return {
      eligible: false,
      code: "ALREADY_AUTHORIZED" as const,
      message: "Esta consulta ya fue liberada para un nuevo intento.",
    };
  }
  if (["APROBADO", "RECHAZADO"].includes(normalizedCode(row.status))) {
    return {
      eligible: false,
      code: "FINAL_DECISION" as const,
      message: "Los resultados crediticios aprobados o rechazados no se pueden liberar.",
    };
  }
  if (normalizedCode(row.status) === "PENDING") {
    return {
      eligible: false,
      code: "EVALUATION_IN_PROGRESS" as const,
      message: "La consulta todavía se encuentra en proceso.",
    };
  }
  const now = new Date(row.databaseNow).getTime();
  if (
    !Number.isFinite(now) ||
    new Date(row.expiresAt).getTime() <= now ||
    new Date(row.retainedUntil).getTime() <= now
  ) {
    return {
      eligible: false,
      code: "ASSESSMENT_EXPIRED" as const,
      message: "La consulta ya venció y no requiere una liberación administrativa.",
    };
  }
  if (
    row.reusedFromAssessmentId ||
    normalizedCode(row.status) !== "NO_EVALUADO" ||
    row.score !== null ||
    normalizedCode(row.errorCode) !== "NO_EVALUABLE_INFORMATION" ||
    normalizedCode(row.providerStatus) !== "ACCEPTED" ||
    normalizedCode(row.transactionCode) !== "06" ||
    row.consumedAt !== null ||
    row.creditId !== null
  ) {
    return {
      eligible: false,
      code: "NOT_TX06_SURNAME_CASE" as const,
      message: "La consulta no corresponde al caso técnico TX06 habilitado para corrección de apellido.",
    };
  }
  if (
    !row.draftId ||
    normalizedCode(row.draftState) !== "ABIERTO" ||
    Number(row.draftStep) !== 1 ||
    row.draftCreditId !== null ||
    !row.draftExpiresAt ||
    new Date(row.draftExpiresAt).getTime() <= now ||
    normalizeDataCreditoDocument(row.draftImei).length > 0 ||
    !row.draftDocumentMatches ||
    !row.draftPlatformMatches
  ) {
    return {
      eligible: false,
      code: "DRAFT_UNAVAILABLE" as const,
      message: "La solicitud vinculada ya no está abierta en el paso inicial y no puede liberarse.",
    };
  }
  return {
    eligible: true,
    code: "ELIGIBLE" as const,
    message: "TX06 confirmado. Puede autorizarse una nueva consulta con el apellido correcto.",
  };
}

function serializeCandidate(row: CandidateRow): DataCreditoAdminRetryCandidate {
  const eligibility = candidateEligibility(row);
  return {
    assessmentId: row.assessmentId,
    documentLabel: documentLabel(row.documentLast4),
    platform: row.platform,
    providerEnvironment: row.providerEnvironment,
    status: row.status,
    transactionCode: row.transactionCode,
    providerStatus: row.providerStatus,
    errorCode: row.errorCode,
    draftId: row.draftId ? Number(row.draftId) : null,
    actor: serializeActor(row),
    createdAt: iso(row.createdAt)!,
    expiresAt: iso(row.expiresAt)!,
    authorizedAt: iso(row.authorizedAt),
    eligible: eligibility.eligible,
    eligibilityCode: eligibility.code,
    eligibilityMessage: eligibility.message,
    alreadyAuthorized: eligibility.code === "ALREADY_AUTHORIZED",
  };
}

async function loadCandidate(
  documentHash: string,
  documentNumber: string,
  providerEnvironment: string,
  assessmentId: string | null = null
) {
  const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(
    `
      SELECT assessment."id" AS "assessmentId",
        assessment."documentLast4", assessment."platform",
        assessment."providerEnvironment", assessment."status", assessment."score",
        assessment."transactionCode", assessment."providerStatus", assessment."errorCode",
        assessment."reusedFromAssessmentId", assessment."consumedAt", assessment."creditId",
        assessment."expiresAt", assessment."retainedUntil", assessment."createdAt",
        assessment."updatedAt", draft."id" AS "draftId", draft."estado" AS "draftState",
        draft."currentStep" AS "draftStep", draft."creditoId" AS "draftCreditId",
        COALESCE(draft."expiresAt", draft."createdAt" + INTERVAL '15 days') AS "draftExpiresAt",
        draft."imei" AS "draftImei",
        CASE WHEN draft."id" IS NULL THEN FALSE ELSE
          regexp_replace(COALESCE(draft."clienteDocumento", ''), '[^0-9]', '', 'g') = $4
        END AS "draftDocumentMatches",
        CASE WHEN draft."id" IS NULL THEN FALSE ELSE
          UPPER(COALESCE(NULLIF(draft."plataforma", ''), NULLIF(draft."payload"->>'plataformaDispositivo', ''))) = assessment."platform"
        END AS "draftPlatformMatches",
        app_user."nombre" AS "userName", seller."nombre" AS "sellerName",
        ally."nombre" AS "aliadoName", site."nombre" AS "sedeName",
        retry_authorization."authorizedAt", CURRENT_TIMESTAMP AS "databaseNow"
      FROM "DataCreditoAssessment" assessment
      LEFT JOIN LATERAL (
        SELECT linked.*
        FROM "CreditoBorrador" linked
        WHERE linked."dataCreditoAssessmentId" = assessment."id"
          OR (
            linked."dataCreditoAssessmentId" IS NULL
            AND NULLIF(linked."payload"->>'dataCreditoAssessmentId', '') = assessment."id"::text
          )
        ORDER BY
          (linked."estado" = 'ABIERTO' AND linked."creditoId" IS NULL) DESC,
          linked."updatedAt" DESC, linked."id" DESC
        LIMIT 1
      ) draft ON TRUE
      LEFT JOIN "Sede" site ON site."id" = assessment."sedeId"
      LEFT JOIN "Aliado" ally ON ally."id" = assessment."aliadoId"
      LEFT JOIN "Usuario" app_user ON app_user."id" = assessment."userId"
      LEFT JOIN "Vendedor" seller ON seller."id" = assessment."sellerId"
      LEFT JOIN LATERAL (
        SELECT MIN(audit."createdAt") AS "authorizedAt"
        FROM "DataCreditoAdminAccessAudit" audit
        WHERE audit."assessmentId" = assessment."id"
          AND audit."action" = '${RETRY_ACTION}'
          AND audit."outcome" = '${RETRY_OUTCOME}'
      ) retry_authorization ON TRUE
      WHERE assessment."documentHash" = $1
        AND assessment."providerEnvironment" = $2
        AND ($3::uuid IS NULL OR assessment."id" = $3::uuid)
        AND assessment."retainedUntil" > CURRENT_TIMESTAMP
      ORDER BY assessment."createdAt" DESC, assessment."id" DESC
      LIMIT 1
    `,
    documentHash,
    providerEnvironment,
    assessmentId,
    documentNumber
  );
  return rows[0] || null;
}

export async function findDataCreditoAdminRetryCandidate(input: {
  documentNumber: unknown;
  providerEnvironment: string;
}) {
  const documentNumber = parseDocument(input.documentNumber);
  await Promise.all([ensureDataCreditoSchema(), ensureSolicitudSchema()]);
  const documentHash = hmacDataCreditoValue("document", documentNumber);
  const row = await loadCandidate(
    documentHash,
    documentNumber,
    String(input.providerEnvironment || "").trim().toLowerCase()
  );
  return row ? serializeCandidate(row) : null;
}

function exactAssessmentIsEligible(
  row: LockedAssessmentRow,
  databaseNow: Date
) {
  const now = new Date(databaseNow).getTime();
  return (
    !row.reusedFromAssessmentId &&
    normalizedCode(row.status) === "NO_EVALUADO" &&
    row.score === null &&
    normalizedCode(row.errorCode) === "NO_EVALUABLE_INFORMATION" &&
    normalizedCode(row.providerStatus) === "ACCEPTED" &&
    normalizedCode(row.transactionCode) === "06" &&
    row.consumedAt === null &&
    row.creditId === null &&
    Number.isFinite(now) &&
    new Date(row.expiresAt).getTime() > now &&
    new Date(row.retainedUntil).getTime() > now
  );
}

function exactDraftIsEligible(
  row: LockedDraftRow,
  input: { assessmentId: string; documentNumber: string; platform: string },
  databaseNow: Date
) {
  return (
    normalizedCode(row.estado) === "ABIERTO" &&
    Number(row.currentStep) === 1 &&
    row.creditoId === null &&
    row.assessmentId?.toLowerCase() === input.assessmentId.toLowerCase() &&
    normalizeDataCreditoDocument(row.clienteDocumento) === input.documentNumber &&
    normalizedCode(row.plataforma) === normalizedCode(input.platform) &&
    normalizeDataCreditoDocument(row.imei).length === 0 &&
    new Date(row.effectiveExpiresAt).getTime() > new Date(databaseNow).getTime()
  );
}

export async function authorizeDataCreditoAdminRetry(input: {
  assessmentId: unknown;
  documentNumber: unknown;
  firstSurname: unknown;
  providerEnvironment: string;
  actorUserId: number;
  mutationId: unknown;
  ipHash: string | null;
  userAgentHash: string | null;
}) {
  const assessmentId = parseUuid(
    input.assessmentId,
    "INVALID_ASSESSMENT_ID",
    "La evaluación seleccionada no es válida."
  );
  const mutationId = parseUuid(
    input.mutationId,
    "INVALID_MUTATION_ID",
    "El identificador de la operación no es válido."
  );
  const documentNumber = parseDocument(input.documentNumber);
  const firstSurname = parseSurname(input.firstSurname);
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new DataCreditoAdminRetryError(
      "RETRY_NOT_ELIGIBLE",
      "No fue posible identificar al administrador que autoriza la operación.",
      409
    );
  }
  const providerEnvironment = String(input.providerEnvironment || "")
    .trim()
    .toLowerCase();

  await Promise.all([ensureDataCreditoSchema(), ensureSolicitudSchema()]);
  const documentHash = hmacDataCreditoValue("document", documentNumber);
  const surnameHash = hmacDataCreditoValue("surname", firstSurname);
  const preliminary = await loadCandidate(
    documentHash,
    documentNumber,
    providerEnvironment,
    assessmentId
  );
  if (!preliminary) {
    throw new DataCreditoAdminRetryError(
      "ASSESSMENT_NOT_FOUND",
      "La consulta no existe o ya venció su periodo de retención.",
      404
    );
  }
  if (preliminary.authorizedAt) {
    return {
      authorized: true as const,
      alreadyAuthorized: true,
      assessmentId,
      documentLabel: documentLabel(preliminary.documentLast4),
      draftId: preliminary.draftId ? Number(preliminary.draftId) : null,
      actor: serializeActor(preliminary),
      authorizedAt: iso(preliminary.authorizedAt)!,
    };
  }
  if (!preliminary.draftId || !candidateEligibility(preliminary).eligible) {
    throw new DataCreditoAdminRetryError(
      "RETRY_NOT_ELIGIBLE",
      candidateEligibility(preliminary).message,
      409
    );
  }
  const draftId = Number(preliminary.draftId);

  return prisma.$transaction(
    async (transaction) => {
      // Match the live evaluation path: solicitud operation lock first, then
      // the provider/document lock, and only then row-level locks.
      await lockSolicitudOperationMutation(transaction, draftId);
      await transaction.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
        ["datacredito-document", providerEnvironment, documentHash].join(":")
      );

      const assessmentRows =
        await transaction.$queryRawUnsafe<LockedAssessmentRow[]>(
          `
            SELECT assessment.*
            FROM "DataCreditoAssessment" assessment
            WHERE assessment."id" = $1::uuid
              AND assessment."documentHash" = $2
              AND assessment."providerEnvironment" = $3
            LIMIT 1
            FOR UPDATE
          `,
          assessmentId,
          documentHash,
          providerEnvironment
        );
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new DataCreditoAdminRetryError(
          "RETRY_STATE_CHANGED",
          "La consulta cambió mientras se preparaba la liberación. Vuelve a buscarla.",
          409
        );
      }

      const previousAuthorization = await transaction.$queryRawUnsafe<
        Array<{ createdAt: Date }>
      >(
        `
          SELECT audit."createdAt"
          FROM "DataCreditoAdminAccessAudit" audit
          WHERE audit."assessmentId" = $1::uuid
            AND audit."action" = '${RETRY_ACTION}'
            AND audit."outcome" = '${RETRY_OUTCOME}'
          ORDER BY audit."createdAt" ASC
          LIMIT 1
        `,
        assessmentId
      );
      if (previousAuthorization[0]) {
        return {
          authorized: true as const,
          alreadyAuthorized: true,
          assessmentId,
          documentLabel: documentLabel(assessment.documentLast4),
          draftId,
          actor: serializeActor(preliminary),
          authorizedAt: iso(previousAuthorization[0].createdAt)!,
        };
      }
      const draftRows = await transaction.$queryRawUnsafe<LockedDraftRow[]>(
        `
          SELECT draft."id", draft."estado", draft."currentStep",
            draft."clienteDocumento", draft."imei",
            COALESCE(NULLIF(draft."plataforma", ''), NULLIF(draft."payload"->>'plataformaDispositivo', '')) AS "plataforma",
            COALESCE(draft."dataCreditoAssessmentId"::text, NULLIF(draft."payload"->>'dataCreditoAssessmentId', '')) AS "assessmentId",
            draft."creditoId",
            COALESCE(draft."expiresAt", draft."createdAt" + INTERVAL '15 days') AS "effectiveExpiresAt"
          FROM "CreditoBorrador" draft
          WHERE draft."id" = $1
          LIMIT 1
          FOR UPDATE
        `,
        draftId
      );
      const draft = draftRows[0];

      const timestampRows = await transaction.$queryRawUnsafe<
        Array<{ authorizedAt: Date }>
      >(`SELECT clock_timestamp() AS "authorizedAt"`);
      const authorizedAt = timestampRows[0]?.authorizedAt;
      if (!authorizedAt) throw new Error("DATACREDITO_RETRY_TIMESTAMP_UNAVAILABLE");

      if (!exactAssessmentIsEligible(assessment, authorizedAt)) {
        throw new DataCreditoAdminRetryError(
          "RETRY_STATE_CHANGED",
          "La consulta ya no cumple las condiciones para autorizar un reintento TX06.",
          409
        );
      }
      if (assessment.surnameHash === surnameHash) {
        throw new DataCreditoAdminRetryError(
          "RETRY_SURNAME_UNCHANGED",
          "El apellido correcto debe ser diferente al usado en la consulta TX06.",
          409
        );
      }
      if (
        !draft ||
        !exactDraftIsEligible(
          draft,
          {
            assessmentId,
            documentNumber,
            platform: assessment.platform,
          },
          authorizedAt
        )
      ) {
        throw new DataCreditoAdminRetryError(
          "RETRY_STATE_CHANGED",
          "La solicitud vinculada cambió y no se liberó. Vuelve a buscarla.",
          409
        );
      }

      const updatedAssessments = await transaction.$queryRawUnsafe<
        Array<{ id: string }>
      >(
        `
          UPDATE "DataCreditoAssessment"
          SET "expiresAt" = LEAST("expiresAt", $4::timestamp)
          WHERE "id" = $1::uuid
            AND "documentHash" = $2
            AND "providerEnvironment" = $3
            AND "reusedFromAssessmentId" IS NULL
            AND "status" = 'NO_EVALUADO'
            AND "score" IS NULL
            AND "errorCode" = 'NO_EVALUABLE_INFORMATION'
            AND "providerStatus" = 'ACCEPTED'
            AND "transactionCode" = '06'
            AND "consumedAt" IS NULL
            AND "creditId" IS NULL
            AND "expiresAt" > $4::timestamp
            AND "retainedUntil" > $4::timestamp
          RETURNING "id"
        `,
        assessmentId,
        documentHash,
        providerEnvironment,
        authorizedAt
      );
      if (updatedAssessments.length !== 1) {
        throw new DataCreditoAdminRetryError(
          "RETRY_STATE_CHANGED",
          "La consulta cambió y no se liberó. Vuelve a buscarla.",
          409
        );
      }

      const updatedDrafts = await transaction.$queryRawUnsafe<
        Array<{ id: number }>
      >(
        `
          UPDATE "CreditoBorrador" draft
          SET "dataCreditoAssessmentId" = NULL,
              "dataCreditoStatus" = 'PENDING',
              "dataCreditoErrorCode" = 'ASSESSMENT_RETRY_AUTHORIZED',
              "payload" = (COALESCE(draft."payload", '{}'::jsonb) - 'dataCreditoAssessmentId')
                || jsonb_build_object(
                  'clientePrimerApellido', $3::text,
                  'dataCreditoStatus', 'PENDING',
                  'dataCreditoErrorCode', 'ASSESSMENT_RETRY_AUTHORIZED',
                  'dataCreditoUpdatedAt', $4::timestamp
                ),
              "updatedAt" = $4::timestamp
          WHERE draft."id" = $1
            AND draft."estado" = 'ABIERTO'
            AND draft."currentStep" = 1
            AND draft."creditoId" IS NULL
            AND COALESCE(draft."expiresAt", draft."createdAt" + INTERVAL '15 days') > $4::timestamp
            AND regexp_replace(COALESCE(draft."clienteDocumento", ''), '[^0-9]', '', 'g') = $2
            AND NULLIF(regexp_replace(COALESCE(draft."imei", ''), '[^0-9]', '', 'g'), '') IS NULL
            AND COALESCE(draft."dataCreditoAssessmentId"::text, NULLIF(draft."payload"->>'dataCreditoAssessmentId', '')) = $5
          RETURNING draft."id"
        `,
        draftId,
        documentNumber,
        firstSurname,
        authorizedAt,
        assessmentId
      );
      if (updatedDrafts.length !== 1) {
        throw new DataCreditoAdminRetryError(
          "RETRY_STATE_CHANGED",
          "La solicitud cambió y no se liberó. Vuelve a buscarla.",
          409
        );
      }

      await transaction.$executeRawUnsafe(
        `
          INSERT INTO "DataCreditoAdminAccessAudit" (
            "id", "assessmentId", "actorUserId", "action", "outcome",
            "requestCorrelationId", "ipHash", "userAgentHash",
            "retainedUntil", "createdAt"
          ) VALUES (
            $1::uuid, $2::uuid, $3, '${RETRY_ACTION}', '${RETRY_OUTCOME}',
            $4::uuid, $5, $6, $7::timestamp, $8::timestamp
          )
        `,
        randomUUID(),
        assessmentId,
        input.actorUserId,
        mutationId,
        input.ipHash,
        input.userAgentHash,
        assessment.retainedUntil,
        authorizedAt
      );

      return {
        authorized: true as const,
        alreadyAuthorized: false,
        assessmentId,
        documentLabel: documentLabel(assessment.documentLast4),
        draftId,
        actor: serializeActor(preliminary),
        authorizedAt: authorizedAt.toISOString(),
      };
    },
    { maxWait: 5_000, timeout: 60_000 }
  );
}
