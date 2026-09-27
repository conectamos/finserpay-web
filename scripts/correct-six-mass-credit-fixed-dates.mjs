// Dry run by default. This reviewed six-credit correction never runs at startup.
import pg from 'pg';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fixedDatesBatchId, fixedDatesCorrectionKey, fixedDatesTargets,
  FixedDatesCorrectionBlocked, canonical, planSixMassFixedDates } from './mass-fixed-dates-correction-core.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply') || args.length > 1) {
  throw new FixedDatesCorrectionBlocked('Únicamente se admite --apply; el alcance no es configurable.');
}
const apply = args.includes('--apply');
const dbAddress = process.env.FINSER_MASS_FINANCE_DB_ADDRESS;
const client = new pg.Client({
  connectionString: process.env.FINSER_MASS_FINANCE_DB_URL,
  connectionTimeoutMillis: 15000,
  application_name: 'finserpay-six-mass-fixed-dates-20260927',
  ...(dbAddress ? { stream: () => {
    const socket = new net.Socket();
    const connect = socket.connect.bind(socket);
    socket.connect = (port, host) => connect({ port, host, autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, dbAddress, 4) });
    return socket;
  } } : {}),
});
const previousBatchIds = ['59867415-97ea-4145-a056-d6a76fa15086', '4f235cd1-17cd-4ab6-a565-682b65aa49c4'];
const targetIds = fixedDatesTargets.map(item => item.id);
let transactionOpen = false;
function requireCondition(value, message) {
  if (!value) throw new FixedDatesCorrectionBlocked(message);
}
async function preservationProof() {
  const previous = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.id)) AS fingerprint FROM "Credito" c
    WHERE c."contratoSnapshot"#>>'{origen,batchId}'=ANY($1::text[])`, [previousBatchIds]);
  const payments = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(p)::text, '' ORDER BY p.id)) AS fingerprint
    FROM "CreditoAbono" p WHERE p."creditoId"=ANY($1::int[])`, [targetIds]);
  // CajaMovimiento has no credit foreign key. Its complete stored rows are read,
  // never written, to verify this correction cannot change the cash ledger.
  const cash = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(m)::text, '' ORDER BY m.id)) AS fingerprint FROM "CajaMovimiento" m`);
  const approvals = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(r)::text, '' ORDER BY r."creditoId")) AS fingerprint
    FROM "CreditApprovalReview" r WHERE r."creditoId"=ANY($1::int[])`, [targetIds]);
  const sadmin = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(r)::text, '' ORDER BY r."creditoId")) AS fingerprint
    FROM "CreditSadminRegistration" r WHERE r."creditoId"=ANY($1::int[])`, [targetIds]);
  const sadminEvents = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)) AS fingerprint
    FROM "CreditSadminEvent" e WHERE e."creditoId"=ANY($1::int[])`, [targetIds]);
  const settlements = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(s)::text, '' ORDER BY s."creditoId")) AS fingerprint
    FROM "LiquidacionAliadoCredito" s WHERE s."creditoId"=ANY($1::int[])`, [targetIds]);
  return { previous: previous.rows[0], payments: payments.rows[0], cash: cash.rows[0],
    approvals: approvals.rows[0], sadmin: sadmin.rows[0], sadminEvents: sadminEvents.rows[0],
    settlements: settlements.rows[0] };
}
try {
  requireCondition(process.env.FINSER_MASS_FINANCE_DB_URL, 'Falta la conexión de base de datos.');
  await client.connect();
  await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  transactionOpen = true;
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  if (apply) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))',
    [fixedDatesCorrectionKey]);
  const result = await client.query(`SELECT c.*, to_jsonb(c) AS "originalCreditRow",
    c."fechaCredito"::date::text AS "creditDate",
    c."fechaPrimerPago"::date::text AS "firstPaymentDate",
    c."fechaProximoPago"::date::text AS "nextPaymentDate",
    (SELECT COUNT(*)::int FROM "CreditPrincipalPaymentRevision" r WHERE r."creditoId"=c.id) AS principal_revision_count,
    (SELECT COUNT(*)::int FROM "CreditoAmortizacion" a WHERE a."creditoId"=c.id) AS amortization_count,
    (SELECT COUNT(*)::int FROM "WompiPaymentIntent" w WHERE w."creditoId"=c.id) AS intent_count,(SELECT COUNT(*)::int FROM "CreditApprovalReview" r WHERE r."creditoId"=c.id) AS approval_review_count
    FROM "Credito" c WHERE c."contratoSnapshot"#>>'{origen,batchId}'=$1
    ORDER BY c.id ${apply ? 'FOR UPDATE OF c' : ''}`, [fixedDatesBatchId]);
  requireCondition(result.rows.length === 6 && result.rows.every((row, index) => row.id === targetIds[index]),
    'La carga objetivo no coincide exactamente con los seis créditos revisados.');
  const payments = await client.query(`SELECT p.*, to_jsonb(p) AS "originalPaymentRow"
    FROM "CreditoAbono" p WHERE p."creditoId"=ANY($1::int[])
    ORDER BY p.id ${apply ? 'FOR UPDATE OF p' : ''}`, [targetIds]);
  const signatureAvailability = await client.query(`SELECT to_regclass('public."FirmaSeguroProcess"') IS NOT NULL AS available`);
  let signatures = [];
  if (signatureAvailability.rows[0].available) {
    const signatureResult = await client.query(`SELECT "creditoId", COUNT(*)::int AS count
      FROM "FirmaSeguroProcess" WHERE "creditoId"=ANY($1::int[]) GROUP BY "creditoId"`, [targetIds]);
    signatures = signatureResult.rows;
  }
  const rows = result.rows.map(row => ({ ...row,
    abonos: payments.rows.filter(payment => payment.creditoId === row.id),
    signature_process_count: signatures.find(item => item.creditoId === row.id)?.count ?? 0 }));
  const appliedAt = new Date().toISOString();
  const plans = planSixMassFixedDates(rows, appliedAt);
  const changed = plans.filter(plan => plan.changed);
  const proofBefore = await preservationProof();
  requireCondition(proofBefore.previous.count === 393, 'No se localizaron exactamente los 393 créditos anteriores.');
  if (apply && changed.length) {
    const content = JSON.stringify({ fixedDatesCorrectionKey, fixedDatesBatchId, appliedAt,
      credits: rows.map(row => row.originalCreditRow),
      payments: payments.rows.map(row => row.originalPaymentRow), preservationProof: proofBefore }, null, 2);
    const backupPath = path.resolve(`tmp-six-fixed-dates-backup-${appliedAt.replaceAll(':', '-')}.json`);
    await writeFile(backupPath, content, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ backup: path.basename(backupPath), sha256: createHash('sha256').update(content).digest('hex') }));
    for (const plan of changed) {
      const before = rows.find(row => row.id === plan.id);
      const updated = await client.query(`UPDATE "Credito"
        SET "frecuenciaPago"='QUINCENAL', "fechaPrimerPago"=$1::timestamp,
          "fechaProximoPago"=$2::timestamp, "contratoSnapshot"=$3::jsonb,
          "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE id=$4 AND "contratoSnapshot"#>>'{origen,batchId}'=$5 AND "frecuenciaPago"='CATORCENAL'
          AND "fechaPrimerPago"::date::text=$6 AND "fechaProximoPago"::date::text=$7
          AND "contratoSnapshot"=$8::jsonb`,
      [`${plan.firstPayment}T12:00:00.000Z`, `${plan.nextPayment}T12:00:00.000Z`, JSON.stringify(plan.snapshot),
        plan.id, fixedDatesBatchId, before.firstPaymentDate, before.nextPaymentDate, JSON.stringify(before.contratoSnapshot)]);
      requireCondition(updated.rowCount === 1, 'La escritura no afectó exactamente un crédito objetivo.');
    }
    const verified = await client.query(`SELECT to_jsonb(c) AS row FROM "Credito" c
      WHERE c.id=ANY($1::int[]) ORDER BY c.id`, [targetIds]);
    requireCondition(verified.rows.length === 6, 'Faltan créditos en la verificación.');
    for (const { row } of verified.rows) {
      const before = rows.find(item => item.id === row.id)?.originalCreditRow;
      const plan = plans.find(item => item.id === row.id);
      requireCondition(before && plan, 'Se alteró el alcance al verificar.');
      for (const field of Object.keys(before)) {
        if (['frecuenciaPago', 'fechaPrimerPago', 'fechaProximoPago', 'contratoSnapshot', 'updatedAt'].includes(field)) continue;
        requireCondition(canonical(row[field]) === canonical(before[field]), `Cambió un campo fuera del ajuste: ${field}.`);
      }
      requireCondition(row.frecuenciaPago === 'QUINCENAL' &&
        row.fechaPrimerPago === `${plan.firstPayment}T12:00:00` && row.fechaProximoPago === `${plan.nextPayment}T12:00:00` &&
        canonical(row.contratoSnapshot) === canonical(plan.snapshot), 'El calendario persistido no concilia.');
    }
    const proofAfter = await preservationProof();
    requireCondition(canonical(proofAfter) === canonical(proofBefore),
      'Los créditos anteriores, abonos, caja, aprobaciones, SADMIN o liquidaciones cambiaron durante la corrección.');
  }
  await client.query('COMMIT');
  transactionOpen = false;
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', changed: apply ? changed.length : 0,
    planned: changed.length, previous393Preserved: true, paymentsPreserved: true, cashLedgerPreserved: true, approvalsPreserved: true, sadminPreserved: true, settlementsPreserved: true,
    credits: plans.map(plan => ({ id: plan.id, previousFrequency: rows.find(row => row.id === plan.id).frecuenciaPago,
      frequency: 'QUINCENAL', firstPayment: plan.firstPayment, previousNextPayment: rows.find(row => row.id === plan.id).nextPaymentDate,
      nextPayment: plan.nextPayment, paidCount: plan.correctedPlan.paidCount,
      nextQuota: plan.correctedPlan.nextInstallment.numero,
      nextQuotaPaid: plan.correctedPlan.nextInstallment.valorAbonado,
      nextQuotaPending: plan.correctedPlan.nextInstallment.saldoPendiente })) }));
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof FixedDatesCorrectionBlocked ? error.message : `MASS_FIXED_DATES_FAILED: ${error.code || error.name}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
