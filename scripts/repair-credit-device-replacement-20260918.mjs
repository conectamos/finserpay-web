import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();
const target = Object.freeze({
  folio: "FC-20260829214932-PJEJ",
  previousImei: "354627901806291",
  newImei: "352228709273867",
});
const supportActorName = "Reparacion automatica FINSER PAY";
const checklistVersion = "IPHONE_ENROLLMENT_V1";
const sharedGrantId = "00000000-0000-4000-8000-000000000001";
const sharedAnalyst = Object.freeze({
  name: "Especialista de enrolamiento",
  externalId: "ACCESO-COMPARTIDO",
});

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para reparar el reemplazo identificado."
  );
}

const client = new Client({
  application_name: "finserpay-targeted-device-replacement-repair",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

async function advisoryLocks(keys) {
  for (const key of [...new Set(keys)].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))",
      [key]
    );
  }
}

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await advisoryLocks([
    `credit-device-replacement:repair:${target.folio}`,
  ]);

  const identityResult = await client.query(
    `
      SELECT replacement."id"::text, replacement."creditId"
      FROM "CreditDeviceReplacement" replacement
      INNER JOIN "Credito" credit ON credit."id" = replacement."creditId"
      WHERE credit."folio" = $1
        AND replacement."previousImei" = $2
        AND replacement."newImei" = $3
      ORDER BY replacement."createdAt" DESC
      LIMIT 2
    `,
    [target.folio, target.previousImei, target.newImei]
  );

  if (identityResult.rows.length > 1) {
    throw new Error(
      "Existe mas de un reemplazo para el folio e IMEI objetivo; no se aplico ningun cambio."
    );
  }
  const identity = identityResult.rows[0];
  if (!identity) {
    console.warn(
      `No se encontro el reemplazo objetivo ${target.folio}; reparacion omitida.`
    );
    await client.query("COMMIT");
  } else {
    await advisoryLocks([
      `credit-device-replacement:credit:${identity.creditId}`,
      `credit-device-replacement:replacement:${identity.id}`,
      `credit-device-replacement:imei:${target.previousImei}`,
      `credit-device-replacement:imei:${target.newImei}`,
    ]);

    const currentResult = await client.query(
      `
        SELECT
          replacement."id"::text,
          replacement."creditId",
          replacement."solicitudId",
          replacement."status",
          credit."clienteDocumento" AS "clientDocument",
          credit."imei" AS "creditImei",
          credit."deviceUid" AS "creditDeviceUid",
          credit."estado" AS "creditState",
          draft."estado" AS "draftState",
          draft."closedReason" AS "draftClosedReason",
          COALESCE(
            NULLIF(draft."plataforma", ''),
            NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', '')
          ) AS "platform",
          credit."referenciaEquipo" AS "equipmentReference",
          credit."equipoMarca" AS "equipmentBrand",
          credit."equipoModelo" AS "equipmentModel",
          review."id"::text AS "reviewId",
          review."decision" AS "reviewDecision",
          review."analystName",
          review."analystExternalId",
          review."checklistVersion" AS "reviewChecklistVersion",
          review."checklist" AS "reviewChecklist",
          review."checklistHash" AS "reviewChecklistHash",
          review."documentHash" AS "reviewDocumentHash",
          review."imeiHash" AS "reviewImeiHash",
          review."identityKeyVersion" AS "reviewIdentityKeyVersion",
          review."grantId"::text AS "reviewGrantId",
          review."grantIssuedByUserId" AS "reviewGrantIssuedByUserId",
          review."grantIssuedByName" AS "reviewGrantIssuedByName",
          review."accessFingerprint" AS "reviewAccessFingerprint",
          review."correlationId"::text AS "reviewCorrelationId",
          review."approvedAt" AS "reviewApprovedAt",
          review."createdAt" AS "reviewCreatedAt"
        FROM "CreditDeviceReplacement" replacement
        INNER JOIN "Credito" credit ON credit."id" = replacement."creditId"
        INNER JOIN "CreditoBorrador" draft
          ON draft."id" = replacement."solicitudId"
        LEFT JOIN "CreditDeviceReplacementReview" review
          ON review."replacementId" = replacement."id"
        WHERE replacement."id" = $1::uuid
          AND credit."folio" = $2
          AND replacement."previousImei" = $3
          AND replacement."newImei" = $4
        LIMIT 1
        FOR UPDATE OF replacement, credit
      `,
      [identity.id, target.folio, target.previousImei, target.newImei]
    );
    const row = currentResult.rows[0];
    if (!row) {
      throw new Error("El reemplazo objetivo cambio durante la reparacion.");
    }

    if (row.status === "COMPLETED") {
      const alreadyApplied =
        row.creditImei === target.newImei &&
        row.creditDeviceUid === target.newImei;
      console[alreadyApplied ? "log" : "warn"](
        alreadyApplied
          ? `El reemplazo objetivo ${target.folio} ya estaba aplicado; reparacion sin cambios.`
          : `El reemplazo objetivo ${target.folio} ya fue cerrado y el credito tiene un IMEI posterior; reparacion sin cambios.`
      );
      await client.query("COMMIT");
    } else if (row.status !== "ENROLLMENT_APPROVED") {
      console.warn(
        `El reemplazo objetivo ${target.folio} aun no tiene enrolamiento aprobado; reparacion omitida.`
      );
      await client.query("COMMIT");
    } else {
      const normalizedState = String(row.creditState || "")
        .trim()
        .toUpperCase();
      const platform = String(row.platform || "").trim().toUpperCase();
      const equipment = [
        row.equipmentReference,
        row.equipmentBrand,
        row.equipmentModel,
      ]
        .map((value) => String(value || "").trim().toUpperCase())
        .join(" ");
      const eligible =
        !["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(
          normalizedState
        ) &&
        row.draftState === "CERRADO" &&
        row.draftClosedReason === "FINALIZADA" &&
        (platform === "IPHONE" || equipment.includes("IPHONE"));
      if (!eligible) {
        throw new Error(
          "El credito objetivo ya no cumple las condiciones del cambio de equipo."
        );
      }
      if (row.reviewDecision !== "APROBADO" || !row.reviewId) {
        throw new Error(
          "El reemplazo objetivo no tiene una revision aprobada verificable."
        );
      }
      const identityPepper = String(
        process.env.IPHONE_ENROLLMENT_IDENTITY_PEPPER || ""
      ).trim();
      const identityKeyVersion = String(
        process.env.IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION || "v1"
      ).trim();
      const document = String(row.clientDocument || "").replace(/\D/g, "");
      const identityHash = (domain, value) =>
        createHmac("sha256", identityPepper)
          .update(`${identityKeyVersion}:${domain}:${value}`)
          .digest("hex");
      const checklist = row.reviewChecklist;
      const checklistKeys =
        checklist && typeof checklist === "object" && !Array.isArray(checklist)
          ? Object.keys(checklist).sort()
          : [];
      const checklistApproved =
        checklistKeys.join(",") ===
          "documentMatched,enrollmentApproved,imeiMatched" &&
        checklist.documentMatched === true &&
        checklist.imeiMatched === true &&
        checklist.enrollmentApproved === true;
      const expectedChecklistHash = identityHash(
        "checklist",
        JSON.stringify({
          version: checklistVersion,
          documentMatched: true,
          imeiMatched: true,
          enrollmentApproved: true,
        })
      );
      const hasPersonalGrant = Boolean(row.reviewGrantId);
      const validProvenance = hasPersonalGrant
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.reviewGrantId
          ) &&
          Boolean(String(row.reviewGrantIssuedByName || "").trim()) &&
          row.reviewAccessFingerprint ===
            identityHash("grant", row.reviewGrantId)
        : row.analystName === sharedAnalyst.name &&
          row.analystExternalId === sharedAnalyst.externalId &&
          row.reviewGrantIssuedByUserId === null &&
          row.reviewGrantIssuedByName === null &&
          row.reviewAccessFingerprint ===
            identityHash("shared-review", sharedGrantId);
      if (
        identityPepper.length < 32 ||
        !/^[A-Za-z0-9._-]{1,32}$/.test(identityKeyVersion) ||
        !/^\d{5,20}$/.test(document) ||
        row.reviewChecklistVersion !== checklistVersion ||
        !checklistApproved ||
        row.reviewChecklistHash !== expectedChecklistHash ||
        row.reviewIdentityKeyVersion !== identityKeyVersion ||
        row.reviewDocumentHash !== identityHash("document", document) ||
        row.reviewImeiHash !== identityHash("imei", target.newImei) ||
        !validProvenance ||
        !row.analystName ||
        !row.analystExternalId ||
        !row.reviewCorrelationId ||
        !row.reviewApprovedAt ||
        !row.reviewCreatedAt
      ) {
        throw new Error(
          "La identidad criptografica de la revision aprobada no coincide con el reemplazo objetivo."
        );
      }

      const conflicts = await client.query(
        `
          SELECT EXISTS (
            SELECT 1 FROM "Credito" other
            WHERE other."id" <> $2
              AND (
                regexp_replace(COALESCE(other."imei", ''), '[^0-9]', '', 'g') = $1
                OR regexp_replace(COALESCE(other."deviceUid", ''), '[^0-9]', '', 'g') = $1
              )
          ) AS "creditConflict",
          EXISTS (
            SELECT 1 FROM "CreditoBorrador" draft
            WHERE draft."id" <> $3
              AND draft."estado" = 'ABIERTO'
              AND draft."creditoId" IS NULL
              AND COALESCE(
                draft."expiresAt", draft."createdAt" + INTERVAL '15 days'
              ) > CURRENT_TIMESTAMP
              AND regexp_replace(COALESCE(draft."imei", ''), '[^0-9]', '', 'g') = $1
          ) AS "draftConflict"
        `,
        [target.newImei, row.creditId, row.solicitudId]
      );
      if (
        conflicts.rows[0]?.creditConflict ||
        conflicts.rows[0]?.draftConflict
      ) {
        throw new Error(
          "El IMEI nuevo del reemplazo objetivo esta asignado a otra operacion."
        );
      }

      const creditUpdate = await client.query(
        `
          UPDATE "Credito"
          SET "imei" = $1, "deviceUid" = $1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $2
            AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g')
              IN ($1, $3)
            AND regexp_replace(COALESCE("deviceUid", ''), '[^0-9]', '', 'g')
              IN ($1, $3)
          RETURNING "id"
        `,
        [target.newImei, row.creditId, target.previousImei]
      );
      if (creditUpdate.rowCount !== 1) {
        throw new Error(
          "El IMEI operativo del credito objetivo cambio; reparacion cancelada."
        );
      }

      const analystName = String(row.analystName || "Analista")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      const replacementUpdate = await client.query(
        `
          UPDATE "CreditDeviceReplacement"
          SET "status" = 'COMPLETED',
            "completedByUserId" = NULL,
            "completedByName" = $2,
            "completedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
            AND "status" = 'ENROLLMENT_APPROVED'
          RETURNING "id"
        `,
        [row.id, analystName]
      );
      if (replacementUpdate.rowCount !== 1) {
        throw new Error(
          "El estado del reemplazo objetivo cambio; reparacion cancelada."
        );
      }

      await client.query(
        `
          INSERT INTO "CreditDeviceReplacementEvent" (
            "id", "replacementId", "eventType", "actorType", "actorUserId",
            "actorName", "correlationId", "payload", "createdAt"
          )
          SELECT
            $1::uuid, $2::uuid, 'COMPLETED', 'SYSTEM_SUPPORT', NULL,
            $3, $4::uuid, $5::jsonb, CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1 FROM "CreditDeviceReplacementEvent"
            WHERE "replacementId" = $2::uuid AND "eventType" = 'COMPLETED'
          )
        `,
        [
          randomUUID(),
          row.id,
          supportActorName,
          randomUUID(),
          JSON.stringify({
            creditId: row.creditId,
            reviewId: row.reviewId,
            automatic: true,
            repair: "TARGETED_APPROVED_REPLACEMENT",
            analystName,
          }),
        ]
      );
      await client.query("COMMIT");
      console.log(
        `IMEI operativo del reemplazo objetivo ${target.folio} reparado.`
      );
    }
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
