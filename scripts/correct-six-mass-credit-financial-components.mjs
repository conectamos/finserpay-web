// Dry run by default. Use --apply only after deploying component-aware readers.
// Never runs during startup, migrations or CSV imports.
import pg from 'pg';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { correctionBatchId, correctionKey, correctionTargets, CorrectionBlocked, planMassComponentCorrection }
  from './mass-financial-correction-core.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) throw new CorrectionBlocked('Únicamente se admite --apply; el alcance no es configurable.');
const apply = args.includes('--apply');
const dbAddress = process.env.FINSER_MASS_FINANCE_DB_ADDRESS;
const client = new pg.Client({
  connectionString: process.env.FINSER_MASS_FINANCE_DB_URL,
  connectionTimeoutMillis: 15000,
  ...(dbAddress ? { stream: () => {
    const socket = new net.Socket();
    const connect = socket.connect.bind(socket);
    socket.connect = (port, host) => connect({ port, host, autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, dbAddress, 4) });
    return socket;
  } } : {}),
});
let transactionOpen = false;
try {
  if (!process.env.FINSER_MASS_FINANCE_DB_URL) throw new CorrectionBlocked('Falta la conexión de base de datos.');
  await client.connect();
  await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  transactionOpen = true;
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const config = await client.query('SELECT "fianzaTotalPorcentaje","seguroCuotaPorcentaje" FROM "CreditoConfiguracion" WHERE nombre=$1', ['GLOBAL']);
  if (config.rows.length !== 1) throw new CorrectionBlocked('No existe una configuración global única.');
  const targets = await client.query(`SELECT c.*,
    (SELECT COUNT(*)::int FROM "CreditoAbono" p WHERE p."creditoId"=c.id) AS payment_count,
    (SELECT COUNT(*)::int FROM "CreditPrincipalPaymentRevision" p WHERE p."creditoId"=c.id) AS principal_revision_count,
    (SELECT COUNT(*)::int FROM "CreditoAmortizacion" p WHERE p."creditoId"=c.id) AS amortization_count,
    (SELECT COUNT(*)::int FROM "WompiPaymentIntent" p WHERE p."creditoId"=c.id) AS intent_count
    FROM "Credito" c WHERE c."contratoSnapshot"#>>'{origen,batchId}'=$1 ORDER BY c.id ${apply ? 'FOR UPDATE OF c' : ''}`, [correctionBatchId]);
  const overrides = await client.query(`SELECT COUNT(*)::int AS count FROM "CreditoConfiguracionDocumento"
    WHERE activo=true AND "documentoNormalizado"=ANY($1::text[])`, [targets.rows.map(row => row.clienteDocumento)]);
  if (overrides.rows[0].count) throw new CorrectionBlocked('Existe una excepción activa por cédula; debe revisarse antes de aplicar porcentajes globales.');
  const appliedAt = new Date().toISOString();
  const plans = planMassComponentCorrection(targets.rows, config.rows[0], appliedAt);
  const changed = plans.filter(plan => plan.changed);
  const previous = await client.query(`SELECT COUNT(*)::int AS count,
    md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.id)) AS fingerprint FROM "Credito" c
    WHERE c."contratoSnapshot"#>>'{origen,batchId}'=ANY($1::text[])`,
    [['59867415-97ea-4145-a056-d6a76fa15086', '4f235cd1-17cd-4ab6-a565-682b65aa49c4']]);
  if (previous.rows[0].count !== 393) throw new CorrectionBlocked('No se localizaron los 393 créditos anteriores.');
  let backup;
  if (apply && changed.length) {
    const content = JSON.stringify({ correctionKey, correctionBatchId, appliedAt, rows: targets.rows }, null, 2);
    backup = path.resolve(`tmp-mass-financial-backup-${appliedAt.replaceAll(':', '-')}.json`);
    await writeFile(backup, content, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ backup: path.basename(backup), sha256: createHash('sha256').update(content).digest('hex') }));
    for (const plan of changed) {
      const result = await client.query(`UPDATE "Credito" SET "valorFianza"=$1,"fianzaPorcentaje"=$2,"valorInteres"=$3,
        "contratoSnapshot"=$4::jsonb,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE id=$5 AND "contratoSnapshot"#>>'{origen,batchId}'=$6`,
        [plan.components.fianza, 75, plan.components.intereses, JSON.stringify(plan.snapshot), plan.id, correctionBatchId]);
      if (result.rowCount !== 1) throw new CorrectionBlocked('La escritura no afectó exactamente un crédito objetivo.');
    }
    const result = await client.query('SELECT * FROM "Credito" WHERE id=ANY($1::int[]) ORDER BY id', [correctionTargets.map(item => item.id)]);
    for (const row of result.rows) {
      const before = targets.rows.find(item => item.id === row.id);
      const plan = plans.find(item => item.id === row.id);
      if (!before || !plan) throw new CorrectionBlocked('Se alteró el alcance al verificar.');
      for (const key of Object.keys(row)) {
        if (['valorFianza', 'fianzaPorcentaje', 'valorInteres', 'contratoSnapshot', 'updatedAt'].includes(key)) continue;
        if (JSON.stringify(row[key]) !== JSON.stringify(before[key])) throw new CorrectionBlocked(`Cambió un campo fuera del ajuste: ${key}.`);
      }
      if (row.valorFianza !== plan.components.fianza || row.fianzaPorcentaje !== 75 ||
        row.valorInteres !== plan.components.intereses || canonical(row.contratoSnapshot) !== canonical(plan.snapshot)) {
        throw new CorrectionBlocked('El desglose persistido no concilia.');
      }
    }
    if (result.rows.length !== 6) throw new CorrectionBlocked('Faltan créditos en la verificación.');
    const after = await client.query(`SELECT md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.id)) AS fingerprint FROM "Credito" c
      WHERE c."contratoSnapshot"#>>'{origen,batchId}'=ANY($1::text[])`,
      [['59867415-97ea-4145-a056-d6a76fa15086', '4f235cd1-17cd-4ab6-a565-682b65aa49c4']]);
    if (after.rows[0].fingerprint !== previous.rows[0].fingerprint) throw new CorrectionBlocked('Los créditos anteriores cambiaron durante el ajuste.');
  }
  await client.query('COMMIT');
  transactionOpen = false;
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', changed: apply ? changed.length : 0,
    planned: changed.length, previous393Preserved: true,
    credits: plans.map(plan => ({ id: plan.id, ...plan.components })) }));
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof CorrectionBlocked ? error.message : `MASS_FINANCE_FAILED: ${error.code || error.name}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}