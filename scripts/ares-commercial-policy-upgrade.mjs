import { randomUUID } from "node:crypto";

export const ARES_COMMERCIAL_POLICY_VERSION = "ARES_FRANCES_V2";
export const ARES_COMMERCIAL_POLICY_RATE_EA = 29.24;
export const ARES_REFERENCE_SURETY_TOTAL_PERCENTAGE = 75;
export const ARES_REFERENCE_INSURANCE_PERCENTAGE = 0.03;
const GENERAL_PROFILE_ID = "00000000-0000-4000-8000-000000000001";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPercentage = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const isAres = (value) => value === "ARES_FRANCES_V1" || value === ARES_COMMERCIAL_POLICY_VERSION;
const referenceChargesMatch = (settings) => settings.fianzaTotalPorcentaje === ARES_REFERENCE_SURETY_TOTAL_PERCENTAGE && settings.seguroCuotaPorcentaje === ARES_REFERENCE_INSURANCE_PERCENTAGE;
const chargesAudit = (settings) => ({
  observedSuretyTotalPercentage: settings.fianzaTotalPorcentaje,
  observedInsurancePercentage: settings.seguroCuotaPorcentaje,
  expectedSuretyTotalPercentage: ARES_REFERENCE_SURETY_TOTAL_PERCENTAGE,
  expectedInsurancePercentage: ARES_REFERENCE_INSURANCE_PERCENTAGE,
});

function validAresSettings(value) {
  return isObject(value) && isAres(value.calculoVersion) &&
    isPercentage(value.tasaInteresEa) && isPercentage(value.fianzaTotalPorcentaje) &&
    isPercentage(value.seguroCuotaPorcentaje) &&
    ["SEMANAL", "QUINCENAL", "MENSUAL"].includes(value.frecuenciaPago) &&
    value.tasaPeriodoDecimales === 6 && value.redondeoComercial?.modo === "PISO" &&
    value.redondeoComercial?.multiplo === 50;
}

function globalFinancialSettings(row) {
  if (!row || (row.calculoVersion != null && !isAres(row.calculoVersion))) return null;
  const settings = {
    calculoVersion: row.calculoVersion || "ARES_FRANCES_V1",
    tasaInteresEa: row.tasaInteresEa,
    fianzaTotalPorcentaje: row.fianzaTotalPorcentaje ?? row.fianzaPorcentaje,
    seguroCuotaPorcentaje: row.seguroCuotaPorcentaje,
    frecuenciaPago: row.frecuenciaPago,
    tasaPeriodoDecimales: row.tasaPeriodoDecimales ?? 6,
    redondeoComercial: {
      modo: row.redondeoComercialModo ?? "PISO",
      multiplo: row.redondeoComercialMultiplo ?? 50,
    },
  };
  return validAresSettings(settings) ? settings : null;
}

/**
 * Explicit, operator-authorized activation. Importing this module never opens a
 * connection or executes SQL. Pass a dedicated connected pg Client, not Pool.query
 * or a client already inside a transaction. dryRun defaults to true. Applying
 * requires a complete upgrade by default; any skipped configuration rolls back
 * the whole transaction. An explicitly authorized partial apply must pass
 * requireComplete: false and cannot claim parity for every profile.
 *
 * Only appends policy revisions and updates the live GLOBAL rate/version. Never
 * updates assessments, their 15-day root expiry, drafts, signatures, loans, payment
 * schedules, document exceptions, score bands or delinquency limits.
 *
 * Mock and isolated PostgreSQL/WASM tests cover planning, immutable revision and
 * mirror triggers, rollback and idempotency. Before production activation review
 * every skipped configuration and validate multi-client SAVE_REVISION/assignment
 * concurrency; the in-memory PostgreSQL test uses a single dedicated client.
 */
export async function upgradeAresCommercialPolicies(client, options = {}) {
  if (typeof client?.query !== "function") throw new Error("Se requiere un pg Client conectado y dedicado.");
  if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) {
    throw new Error("actorUserId debe identificar al administrador que autoriza la activación.");
  }
  const dryRun = options.dryRun !== false;
  const requireComplete = !dryRun && options.requireComplete !== false;
  const report = {
    dryRun,
    requireComplete,
    calculationVersion: ARES_COMMERCIAL_POLICY_VERSION,
    rateEa: ARES_COMMERCIAL_POLICY_RATE_EA,
    actorUserId: options.actorUserId,
    global: { status: "UNCHANGED" },
    revisions: [],
    skipped: [],
    unchanged: [],
  };
  await client.query("BEGIN");
  try {
    // Same global-before-profile order as the application's general-policy path.
    // EXCLUSIVE also waits for SELECT FOR UPDATE before locking revisions, so an
    // in-flight editor can finish without racing a stale next-version number.
    // Ordinary SELECT readers continue; assignment uses profile-before-ally too.
    await client.query(`LOCK TABLE "DataCreditoPolicy", "DataCreditoPolicyProfile", "DataCreditoPolicyRevision", "Aliado", "CreditoConfiguracion" IN EXCLUSIVE MODE`);
    const globalResult = await client.query(`SELECT * FROM "CreditoConfiguracion" WHERE "nombre" = 'GLOBAL' FOR UPDATE`);
    const globalRow = globalResult.rows[0] || null;
    const globalSettings = globalFinancialSettings(globalRow);
    if (!globalRow) {
      report.global = { status: "SKIPPED", reason: "GLOBAL_NOT_FOUND" };
    } else if (!globalSettings) {
      report.global = { status: "SKIPPED", reason: "GLOBAL_NOT_COMPATIBLE_ARES" };
    } else if (!referenceChargesMatch(globalSettings)) {
      report.global = { status: "SKIPPED", reason: "GLOBAL_ARES_CHARGES_DIFFER", ...chargesAudit(globalSettings) };
    } else if (globalRow.calculoVersion !== ARES_COMMERCIAL_POLICY_VERSION || globalRow.tasaInteresEa !== ARES_COMMERCIAL_POLICY_RATE_EA) {
      report.global = {
        status: dryRun ? "PLANNED" : "UPDATED",
        previousVersion: globalRow.calculoVersion,
        previousRateEa: globalRow.tasaInteresEa,
      };
    }
    const profiles = await client.query(`
      SELECT profile."id" AS "profileId", profile."name", profile."active",
        revision."id" AS "revisionId", revision."version", revision."policy"
      FROM "DataCreditoPolicyProfile" profile
      LEFT JOIN LATERAL (
        SELECT candidate."id", candidate."version", candidate."policy"
        FROM "DataCreditoPolicyRevision" candidate
        WHERE candidate."profileId" = profile."id"
        ORDER BY candidate."version" DESC LIMIT 1
      ) revision ON true
      WHERE profile."active" = TRUE OR EXISTS (
        SELECT 1 FROM "Aliado" ally WHERE ally."dataCreditoPolicyId" = profile."id"
      )
      ORDER BY profile."id"
    `);
    for (const row of profiles.rows) {
      const identity = { profileId: row.profileId, name: row.name };
      if (!row.revisionId || !Number.isSafeInteger(row.version) || row.version < 1 || !isObject(row.policy) || !Array.isArray(row.policy.bands) || !row.policy.bands.length) {
        report.skipped.push({ ...identity, reason: "POLICY_REVISION_INVALID" });
        continue;
      }
      const sourceSettings = row.policy.financialSettings ?? globalSettings;
      if (!validAresSettings(sourceSettings)) {
        report.skipped.push({ ...identity, reason: "POLICY_NOT_COMPATIBLE_ARES" });
        continue;
      }
      // Do not silently relabel a differently-priced policy as the reference ARES
      // contract. Its owner must explicitly resolve these configuration differences.
      if (!referenceChargesMatch(sourceSettings)) {
        report.skipped.push({ ...identity, reason: "POLICY_ARES_CHARGES_DIFFER", ...chargesAudit(sourceSettings) });
        continue;
      }
      if (row.policy.financialSettings?.calculoVersion === ARES_COMMERCIAL_POLICY_VERSION && row.policy.financialSettings.tasaInteresEa === ARES_COMMERCIAL_POLICY_RATE_EA) {
        report.unchanged.push(identity);
        continue;
      }
      const nextPolicy = {
        ...row.policy,
        financialSettings: {
          ...sourceSettings,
          calculoVersion: ARES_COMMERCIAL_POLICY_VERSION,
          tasaInteresEa: ARES_COMMERCIAL_POLICY_RATE_EA,
        },
      };
      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) throw new Error("La versión de política excede el rango válido.");
      const nextRevisionId = randomUUID();
      report.revisions.push({
        ...identity, previousRevisionId: row.revisionId, previousVersion: row.version,
        previousRateEa: sourceSettings.tasaInteresEa,
        revisionId: dryRun ? null : nextRevisionId, version: nextVersion,
      });
      if (dryRun) continue;
      await client.query(`
        INSERT INTO "DataCreditoPolicyRevision" ("id", "profileId", "version", "policy", "createdByUserId")
        VALUES ($1, $2, $3, $4::jsonb, $5)
      `, [nextRevisionId, row.profileId, nextVersion, JSON.stringify(nextPolicy), options.actorUserId]);
      if (row.profileId === GENERAL_PROFILE_ID) {
        // Keep the legacy general table append-only, as createDataCreditoPolicyRevision does.
        // A collision is an inconsistency: roll back, never hide it with DO NOTHING.
        await client.query(`INSERT INTO "DataCreditoPolicy" ("version", "policy", "createdByUserId") VALUES ($1, $2::jsonb, $3)`,
          [nextVersion, JSON.stringify(nextPolicy), options.actorUserId]);
      }
    }
    if (requireComplete && (report.skipped.length > 0 || report.global.status === "SKIPPED")) {
      const error = new Error("Activación ARES incompleta: hay configuraciones incompatibles. Se revierte toda la activación.");
      error.code = "ARES_POLICY_UPGRADE_INCOMPLETE";
      error.report = report;
      throw error;
    }
    if (!dryRun && report.global.status === "UPDATED") {
      const updated = await client.query(`
        UPDATE "CreditoConfiguracion"
        SET "calculoVersion" = $1, "tasaInteresEa" = $2, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "nombre" = 'GLOBAL'
      `, [ARES_COMMERCIAL_POLICY_VERSION, ARES_COMMERCIAL_POLICY_RATE_EA]);
      if (updated.rowCount !== 1) throw new Error("La configuración GLOBAL cambió durante la activación.");
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return report;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
      if (error.report === report) report.rolledBack = true;
    } catch (rollbackError) {
      if (error.report === report) report.rolledBack = false;
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}
