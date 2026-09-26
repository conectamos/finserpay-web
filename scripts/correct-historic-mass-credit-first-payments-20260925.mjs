// One-time correction of the two historical CSV imports confirmed on 2026-09-25.
// Their individual identities remain in the production import receipts; only
// aggregate SHA-256 fingerprints and expected counts are kept in source control.
import pg from "pg";
import {
  fingerprintBatch,
  normalizeDocument,
  validateCreditActivity,
  validateImportedCredit,
} from "./mass-first-payment-correction-core.mjs";

const { Client } = pg;
const targets = Object.freeze([
  Object.freeze({
    count: 245,
    fingerprint: "539750a9e5843a6acc16fa7ec0d281f5ecf497020e8b375e58948f9be54a24ac",
  }),
  Object.freeze({
    count: 148,
    fingerprint: "ec8a95afd1cbb7fed87d7c9663bc3a2937c992f6bdd56d3ff9cda23ef6874ded",
  }),
]);
const windowStart = "2026-09-25 21:56:00";
const windowEnd = "2026-09-26 05:00:00";
const correctionKey = "HISTORIC_MASS_FIRST_PAYMENT_20260925_V1";
const connectionString = String(process.env.DATABASE_URL || "").trim();

class CorrectionBlocked extends Error {}

function blocked(message) {
  throw new CorrectionBlocked(message);
}

function groupByBatch(rows) {
  const batches = new Map();
  for (const row of rows) {
    const batchId = row.snapshot?.origen?.batchId;
    if (typeof batchId !== "string" || !batchId) continue;
    if (!batches.has(batchId)) batches.set(batchId, []);
    batches.get(batchId).push(row);
  }
  return batches;
}

function identifyBatches(rows) {
  const found = new Map();
  for (const [batchId, batchRows] of groupByBatch(rows)) {
    if (!targets.some((target) => target.count === batchRows.length)) continue;
    let fingerprint;
    try {
      fingerprint = fingerprintBatch(
        batchRows.map((row) => row.snapshot?.origen?.importReceipt)
      );
    } catch {
      continue; // An unrelated import with an incomplete receipt is not a target.
    }
    const target = targets.find(
      (item) => item.count === batchRows.length && item.fingerprint === fingerprint
    );
    if (!target) continue;
    if (found.has(fingerprint)) blocked("More than one batch matches a historical CSV fingerprint");
    found.set(fingerprint, { batchId, rows: batchRows, target });
  }
  if (found.size !== targets.length) {
    blocked("Both historical CSV batches were not found exactly; no credit was changed");
  }
  return found;
}

async function ensureAuditTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public."MassCreditFirstPaymentCorrection20260925" (
      "creditoId" INTEGER PRIMARY KEY REFERENCES public."Credito"("id") ON DELETE RESTRICT,
      "batchId" TEXT NOT NULL,
      "sourceFingerprint" CHAR(64) NOT NULL,
      "sourceRowNumber" INTEGER NOT NULL CHECK ("sourceRowNumber" > 0),
      "originalFirstPayment" TIMESTAMP(3) NOT NULL,
      "originalNextPayment" TIMESTAMP(3) NOT NULL,
      "originalSnapshotFirstPayment" TEXT NOT NULL,
      "correctedFirstPayment" TIMESTAMP(3) NOT NULL,
      "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      UNIQUE ("batchId", "sourceRowNumber")
    )
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION public.mass_credit_first_payment_audit_immutable_20260925()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Historical first-payment correction audit is immutable'
        USING ERRCODE = '23514';
      RETURN NULL;
    END $$
  `);
  await client.query(`
    CREATE OR REPLACE TRIGGER "MassCreditFirstPaymentCorrection20260925_immutable"
    BEFORE UPDATE OR DELETE OR TRUNCATE
    ON public."MassCreditFirstPaymentCorrection20260925"
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.mass_credit_first_payment_audit_immutable_20260925()
  `);
}

async function alreadyApplied(client) {
  const result = await client.query(`
    SELECT "sourceFingerprint" AS fingerprint, "batchId" AS "batchId",
      COUNT(*)::int AS count, MIN("sourceRowNumber")::int AS first,
      MAX("sourceRowNumber")::int AS last,
      COUNT(DISTINCT "sourceRowNumber")::int AS distinct_rows
    FROM public."MassCreditFirstPaymentCorrection20260925"
    GROUP BY "sourceFingerprint", "batchId"
  `);
  if (result.rows.length === 0) return false;
  const complete = result.rows.length === targets.length && targets.every((target) => {
    const matches = result.rows.filter((row) =>
      row.fingerprint.trim() === target.fingerprint &&
      row.count === target.count && row.first === 1 && row.last === target.count &&
      row.distinct_rows === target.count
    );
    return matches.length === 1;
  }) && new Set(result.rows.map((row) => row.batchId)).size === targets.length;
  if (!complete) blocked("A partial or unexpected historical correction audit exists");
  return true;
}

async function discoverCandidates(client) {
  const result = await client.query(`
    SELECT credit."id", credit."contratoSnapshot" AS snapshot
    FROM public."Credito" credit
    WHERE credit."createdAt" >= $1::timestamp
      AND credit."createdAt" < $2::timestamp
      AND credit."equalityService" = 'IMPORTACION_MASIVA'
      AND credit."contratoSnapshot"#>>'{origen,tipo}' = 'IMPORTACION_MASIVA'
      AND credit."contratoSnapshot"#>>'{origen,batchId}' IS NOT NULL
    ORDER BY credit."id"
  `, [windowStart, windowEnd]);
  return identifyBatches(result.rows);
}

async function lockAndReadTargets(client, found) {
  const expectedRows = [...found.values()].flatMap((batch) => batch.rows);
  const ids = expectedRows.map((row) => row.id).sort((left, right) => left - right);
  const result = await client.query(`
    SELECT credit."id", credit."createdAt" AS "createdAt",
      credit."contratoSnapshot" AS snapshot,
      credit."clienteDocumento" AS "clientDocument",
      credit."equalityService" AS "equalityService",
      credit."estado" AS state, credit."frecuenciaPago" AS frequency,
      credit."deliverableReady" AS "deliverableReady",
      credit."pazYSalvoEmitidoAt" AS "pazYSalvoEmitidoAt",
      credit."contratoAceptadoAt" AS "contratoAceptadoAt",
      credit."pagareAceptadoAt" AS "pagareAceptadoAt",
      credit."contratoFirmaDataUrl" AS "contratoFirmaDataUrl",
      credit."contratoFotoDataUrl" AS "contratoFotoDataUrl",
      credit."contratoSelfieDataUrl" AS "contratoSelfieDataUrl",
      credit."contratoOtpVerificadoAt" AS "contratoOtpVerificadoAt",
      to_char(credit."fechaCredito", 'YYYY-MM-DD') AS "creditDate",
      to_char(credit."fechaPrimerPago", 'YYYY-MM-DD') AS "firstPayment",
      to_char(credit."fechaProximoPago", 'YYYY-MM-DD') AS "nextPayment",
      registration."version" AS "sadminVersion",
      registration."codeudorCreado" AS "codeudorCreado",
      registration."creditoCreado" AS "creditoCreado",
      registration."numeroCreditoConfirmado" AS "numeroCreditoConfirmado",
      registration."numeroCredito" AS "numeroCredito",
      registration."completedAt" AS "completedAt"
    FROM public."Credito" credit
    INNER JOIN public."CreditSadminRegistration" registration
      ON registration."creditoId" = credit."id"
    WHERE credit."id" = ANY($1::integer[])
      AND credit."createdAt" >= $2::timestamp
      AND credit."createdAt" < $3::timestamp
    ORDER BY credit."id"
    FOR UPDATE OF credit, registration
  `, [ids, windowStart, windowEnd]);
  if (result.rows.length !== ids.length ||
      result.rows.some((row, index) => row.id !== ids[index])) {
    blocked("Historical credits or SADMIN confirmations changed while locking");
  }
  const seenDocuments = new Set();
  const seenSadminNumbers = new Set();
  for (const row of result.rows) {
    const normalized = row.snapshot?.origen?.importReceipt?.normalized;
    const document = normalizeDocument(normalized?.cedula);
    const sadmin = String(normalized?.numeroCreditoSadmin ?? "").trim().toLowerCase();
    if (!document || !sadmin || seenDocuments.has(document) || seenSadminNumbers.has(sadmin)) {
      blocked("Historical import identities are missing or duplicated");
    }
    seenDocuments.add(document);
    seenSadminNumbers.add(sadmin);
  }
  const rowsByBatch = groupByBatch(result.rows);
  for (const { batchId, target } of found.values()) {
    const locked = rowsByBatch.get(batchId);
    if (!locked || locked.length !== target.count ||
        fingerprintBatch(locked.map((row) => row.snapshot?.origen?.importReceipt)) !==
          target.fingerprint) {
      blocked("Historical CSV identity changed after row locking");
    }
  }
  const batchIds = [...found.values()].map((batch) => batch.batchId);
  const counts = await client.query(`
    SELECT credit."contratoSnapshot"#>>'{origen,batchId}' AS "batchId",
      COUNT(*)::int AS count
    FROM public."Credito" credit
    WHERE credit."contratoSnapshot"#>>'{origen,batchId}' = ANY($1::text[])
    GROUP BY credit."contratoSnapshot"#>>'{origen,batchId}'
  `, [batchIds]);
  const expectedCountByBatch = new Map(
    [...found.values()].map((batch) => [batch.batchId, batch.target.count])
  );
  if (counts.rows.length !== targets.length || counts.rows.some((row) =>
    row.count !== expectedCountByBatch.get(row.batchId)
  )) blocked("Historical batch row count changed during correction");
  return result.rows;
}

async function rejectDownstreamActivity(client, rows) {
  const ids = rows.map((row) => row.id);
  const result = await client.query(`
    SELECT credit."id",
      EXISTS (SELECT 1 FROM public."CreditoAbono" x WHERE x."creditoId" = credit."id") AS abono,
      EXISTS (SELECT 1 FROM public."CreditoAmortizacion" x WHERE x."creditoId" = credit."id") AS amortizacion,
      EXISTS (SELECT 1 FROM public."WompiPaymentIntent" x WHERE x."creditoId" = credit."id") AS wompi,
      EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" x WHERE x."creditoId" = credit."id") AS liquidacion,
      EXISTS (SELECT 1 FROM public."CreditApprovalReview" x WHERE x."creditoId" = credit."id") AS approval,
      EXISTS (SELECT 1 FROM public."CreditApprovalReissue" x WHERE x."creditoId" = credit."id") AS reissue,
      EXISTS (SELECT 1 FROM public."CreditApprovalDataCorrection" x WHERE x."creditoId" = credit."id") AS data_correction,
      EXISTS (SELECT 1 FROM public."CreditApprovalNovelty" x WHERE x."creditoId" = credit."id") AS novelty,
      EXISTS (SELECT 1 FROM public."CreditApprovalCallRecording" x WHERE x."creditoId" = credit."id") AS call_recording,
      EXISTS (SELECT 1 FROM public."CreditApprovalEvidenceRevision" x WHERE x."creditoId" = credit."id") AS evidence_revision
    FROM public."Credito" credit WHERE credit."id" = ANY($1::integer[])
  `, [ids]);
  if (result.rows.length !== ids.length) blocked("Historical credit set changed during activity check");
  const activityById = new Map(result.rows.map((row) => [row.id, row]));
  const signatureTable = await client.query(
    "SELECT to_regclass('public.\"FirmaSeguroProcess\"') IS NOT NULL AS available"
  );
  if (signatureTable.rows[0]?.available) {
    const signatures = await client.query(`
      SELECT COUNT(*)::int AS count FROM public."FirmaSeguroProcess"
      WHERE "creditoId" = ANY($1::integer[])
    `, [ids]);
    if (signatures.rows[0]?.count) blocked("Historical credits have FirmaSeguro processes");
  }
  for (const row of rows) {
    try {
      validateCreditActivity({ ...row, activity: activityById.get(row.id) });
    } catch {
      blocked("Historical credits have payments, approvals, or later contract activity");
    }
  }
}

async function applyCorrection(client, rows, found) {
  const correctionAt = new Date().toISOString();
  const targetByBatch = new Map(
    [...found.values()].map((batch) => [batch.batchId, batch.target])
  );
  let changed = 0;
  let unchanged = 0;
  for (const row of rows) {
    const { previousDate, correctedDate, rowNumber, batchId } = validateImportedCredit({
      ...row,
      sadmin: {
        codeudorCreado: row.codeudorCreado,
        creditoCreado: row.creditoCreado,
        numeroCreditoConfirmado: row.numeroCreditoConfirmado,
        numeroCredito: row.numeroCredito,
        completedAt: row.completedAt,
      },
    });
    const target = targetByBatch.get(batchId);
    if (!target) blocked("Historical credit belongs to another batch");
    const correctedTimestamp = `${correctedDate} 12:00:00.000`;
    const audit = await client.query(`
      INSERT INTO public."MassCreditFirstPaymentCorrection20260925"
        ("creditoId", "batchId", "sourceFingerprint", "sourceRowNumber",
         "originalFirstPayment", "originalNextPayment", "originalSnapshotFirstPayment",
         "correctedFirstPayment")
      SELECT credit."id", $2::text, $3::char(64), $4::integer,
        credit."fechaPrimerPago", credit."fechaProximoPago",
        credit."contratoSnapshot"#>>'{financiero,fechaPrimerPago}',
        $5::timestamp
      FROM public."Credito" credit WHERE credit."id" = $1::integer
      RETURNING "creditoId"
    `, [row.id, batchId, target.fingerprint, rowNumber, correctedTimestamp]);
    if (audit.rowCount !== 1) blocked("Historical correction audit insert failed");
    if (previousDate === correctedDate) {
      unchanged += 1;
      continue;
    }
    const correctionMarker = JSON.stringify({
      key: correctionKey,
      policy: "CATORCENAL_PLUS_14_CALENDAR_DAYS",
      source: "CSV_FECHA",
      sourceFingerprint: target.fingerprint,
      previousDate,
      correctedDate,
      appliedAt: correctionAt,
    });
    const update = await client.query(`
      UPDATE public."Credito" credit
      SET "fechaPrimerPago" = $2::timestamp,
          "fechaProximoPago" = $2::timestamp,
          "contratoSnapshot" = jsonb_set(
            jsonb_set(credit."contratoSnapshot", '{financiero,fechaPrimerPago}',
              to_jsonb($3::text), false),
            '{origen,firstPaymentCorrection}', $4::jsonb, true),
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE credit."id" = $1::integer
        AND to_char(credit."fechaPrimerPago", 'YYYY-MM-DD') = $5::text
        AND to_char(credit."fechaProximoPago", 'YYYY-MM-DD') = $5::text
        AND credit."contratoSnapshot"#>>'{financiero,fechaPrimerPago}' = $6::text
        AND credit."contratoSnapshot"#>'{origen,firstPaymentCorrection}' IS NULL
      RETURNING credit."id",
        to_char(credit."fechaPrimerPago", 'YYYY-MM-DD') AS "firstPaymentDate",
        to_char(credit."fechaProximoPago", 'YYYY-MM-DD') AS "nextPaymentDate",
        credit."contratoSnapshot"#>>'{financiero,fechaPrimerPago}' AS "snapshotFirstPayment",
        credit."contratoSnapshot"#>'{origen,firstPaymentCorrection}' AS marker
    `, [row.id, correctedTimestamp, `${correctedDate}T12:00:00.000Z`,
      correctionMarker, previousDate, row.snapshot.financiero.fechaPrimerPago]);
    const persisted = update.rows[0];
    if (update.rowCount !== 1 || persisted?.firstPaymentDate !== correctedDate ||
        persisted?.nextPaymentDate !== correctedDate ||
        persisted?.snapshotFirstPayment !== `${correctedDate}T12:00:00.000Z` ||
        persisted?.marker?.key !== correctionKey ||
        persisted?.marker?.sourceFingerprint !== target.fingerprint) {
      blocked("Historical payment date postcondition failed");
    }
    changed += 1;
  }
  return { changed, unchanged };
}

async function run() {
  if (!connectionString) blocked("DATABASE_URL is not configured for historical payment correction");
  const client = new Client({
    connectionString,
    application_name: "finserpay-historic-mass-first-payment-20260925",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '180s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))",
      [correctionKey]
    );
    await ensureAuditTable(client);
    if (await alreadyApplied(client)) {
      await client.query("COMMIT");
      console.log("Historical first-payment correction already applied: 2 batches, 393 audited rows.");
      return;
    }
    const found = await discoverCandidates(client);
    const rows = await lockAndReadTargets(client, found);
    for (const row of rows) {
      try {
        validateImportedCredit({
          ...row,
          sadmin: {
            codeudorCreado: row.codeudorCreado,
            creditoCreado: row.creditoCreado,
            numeroCreditoConfirmado: row.numeroCreditoConfirmado,
            numeroCredito: row.numeroCredito,
            completedAt: row.completedAt,
          },
        });
      } catch {
        blocked("A historical credit no longer matches its import receipt or original dates");
      }
    }
    await rejectDownstreamActivity(client, rows);
    const result = await applyCorrection(client, rows, found);
    if (result.changed !== 392 || result.unchanged !== 1) {
      blocked("Historical correction did not match the independently audited 392/1 date split");
    }
    const auditCount = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM public."MassCreditFirstPaymentCorrection20260925"
    `);
    if (auditCount.rows[0]?.count !== 393) {
      blocked("Historical correction did not audit all expected credits");
    }
    await client.query("COMMIT");
    console.log(`Historical first-payment correction applied: 2 batches, ${result.changed} dates changed, ${result.unchanged} already correct, 393 audit rows.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof CorrectionBlocked) throw error;
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    throw new CorrectionBlocked(`Historical first-payment correction failed; transaction rolled back (${code})`);
  } finally {
    await client.end();
  }
}

await run();
