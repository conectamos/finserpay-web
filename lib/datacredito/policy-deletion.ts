import prisma from "@/lib/prisma";
import {
  DEFAULT_DATACREDITO_POLICY_PROFILE_ID,
  ensureDataCreditoSchema,
} from "@/lib/datacredito/storage";

export class DataCreditoPolicyDeleteDefaultError extends Error {
  constructor() {
    super("La política predeterminada de DataCrédito no se puede eliminar.");
    this.name = "DataCreditoPolicyDeleteDefaultError";
  }
}

export class DataCreditoPolicyDeleteAssignedError extends Error {
  constructor(public readonly assignedAlliesCount: number) {
    super(
      `La política está asignada a ${assignedAlliesCount} aliado(s). Reasígnelos antes de eliminarla.`,
    );
    this.name = "DataCreditoPolicyDeleteAssignedError";
  }
}

export class DataCreditoPolicyDeleteVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(
      `La política cambió y ahora está en la versión ${currentVersion}. Actualice el catálogo e inténtelo nuevamente.`,
    );
    this.name = "DataCreditoPolicyDeleteVersionConflictError";
  }
}

export class DataCreditoPolicyDeleteNotFoundError extends Error {
  constructor() {
    super("La política de DataCrédito no existe.");
    this.name = "DataCreditoPolicyDeleteNotFoundError";
  }
}

export type RetireDataCreditoPolicyResult = {
  policyId: string;
  currentVersion: number;
  alreadyRetired: boolean;
  preservedRevisionCount: number;
  preservedAssignmentAuditCount: number;
  preservedAssessmentCount: number;
};

/**
 * Retira una política del uso operativo sin borrar evidencia histórica.
 *
 * La operación es deliberadamente lógica (`active = false`). Las revisiones,
 * auditorías de asignación y evaluaciones emitidas conservan sus llaves foráneas
 * y siguen siendo reproducibles. El bloqueo del perfil serializa este retiro con
 * la creación de revisiones y las asignaciones, que también bloquean el perfil.
 */
export async function retireDataCreditoPolicyProfile(input: {
  policyId: string;
  expectedVersion: number;
}): Promise<RetireDataCreditoPolicyResult> {
  await ensureDataCreditoSchema();
  return prisma.$transaction(async (tx) => {
    const profiles = await tx.$queryRawUnsafe<
      Array<{ id: string; active: boolean; currentVersion: number }>
    >(
      `
      SELECT
        profile."id",
        profile."active",
        COALESCE((
          SELECT MAX(revision."version")
          FROM "DataCreditoPolicyRevision" revision
          WHERE revision."profileId" = profile."id"
        ), 0)::int AS "currentVersion"
      FROM "DataCreditoPolicyProfile" profile
      WHERE profile."id" = $1::uuid
      FOR UPDATE OF profile
      `,
      input.policyId
    );

    const profile = profiles[0];
    if (!profile) {
      throw new DataCreditoPolicyDeleteNotFoundError();
    }

    if (profile.id === DEFAULT_DATACREDITO_POLICY_PROFILE_ID) {
      throw new DataCreditoPolicyDeleteDefaultError();
    }

    const assignedAllies = await tx.$queryRawUnsafe<Array<{ id: number }>>(
      `
        SELECT ally."id"
        FROM "Aliado" ally
        WHERE ally."dataCreditoPolicyId" = $1::uuid
        ORDER BY ally."id"
        FOR UPDATE
      `,
      input.policyId
    );

    if (assignedAllies.length > 0) {
      throw new DataCreditoPolicyDeleteAssignedError(assignedAllies.length);
    }

    if (profile.active && profile.currentVersion !== input.expectedVersion) {
      throw new DataCreditoPolicyDeleteVersionConflictError(
        profile.currentVersion,
      );
    }

    const [dependencies] = await tx.$queryRawUnsafe<
      Array<{
        revisionCount: number;
        assignmentAuditCount: number;
        assessmentCount: number;
      }>
    >(
      `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM "DataCreditoPolicyRevision" revision
          WHERE revision."profileId" = $1::uuid
        ) AS "revisionCount",
        (
          SELECT COUNT(*)::int
          FROM "DataCreditoPolicyAssignmentAudit" audit
          WHERE audit."previousPolicyId" = $1::uuid
             OR audit."policyId" = $1::uuid
        ) AS "assignmentAuditCount",
        (
          SELECT COUNT(*)::int
          FROM "DataCreditoAssessment" assessment
          INNER JOIN "DataCreditoPolicyRevision" revision
            ON revision."id" = assessment."policyRevisionId"
          WHERE revision."profileId" = $1::uuid
        ) AS "assessmentCount"
      `,
      input.policyId
    );

    if (!profile.active) {
      return {
        policyId: profile.id,
        currentVersion: profile.currentVersion,
        alreadyRetired: true,
        preservedRevisionCount: dependencies?.revisionCount ?? 0,
        preservedAssignmentAuditCount:
          dependencies?.assignmentAuditCount ?? 0,
        preservedAssessmentCount: dependencies?.assessmentCount ?? 0,
      };
    }

    await tx.$executeRawUnsafe(
      `
        UPDATE "DataCreditoPolicyProfile"
        SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
      `,
      input.policyId
    );

    return {
      policyId: profile.id,
      currentVersion: profile.currentVersion,
      alreadyRetired: false,
      preservedRevisionCount: dependencies?.revisionCount ?? 0,
      preservedAssignmentAuditCount:
        dependencies?.assignmentAuditCount ?? 0,
      preservedAssessmentCount: dependencies?.assessmentCount ?? 0,
    };
  });
}
