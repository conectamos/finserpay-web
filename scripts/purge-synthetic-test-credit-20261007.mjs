// One-off physical removal of the exact synthetic credit below. Not a general
// admin deletion endpoint, migration, or predeploy task. Defaults to dry run.
// The external Sadmin account was confirmed absent by the operator; a locally
// entered Sadmin number is removed together with this synthetic test record.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const TEST_CREDIT_PURGE = Object.freeze({
  folio: "FC-20261007042755-TQLK",
  customerName: "PRUEBA DAPTA",
  equipmentValue: 5000,
  financedValue: 5000,
  initialPayment: 0,
  state: "GENERADO",
  allowedStates: ["GENERADO", "ANULADO"],
  localSadminNumber: "1234567891",
  confirmation: "PURGE FC-20261007042755-TQLK",
});
export const SECOND_TEST_CREDIT_PURGE = Object.freeze({
  folio: "FC-20261007051500-NMIK",
  customerName: "PRUEBA DOS DAPTA",
  equipmentValue: 150000,
  financedValue: 150000,
  initialPayment: 0,
  allowedStates: ["GENERADO", "ANULADO"],
  localSadminNumber: "1111111238",
  confirmation: "PURGE FC-20261007051500-NMIK",
});
export const TEST_CREDITS_PURGE = Object.freeze([TEST_CREDIT_PURGE, SECOND_TEST_CREDIT_PURGE]);
export const PURGE_BOTH_CONFIRMATION = "PURGE BOTH FINSERPAY SYNTHETIC TEST CREDITS 2026-10-07";

const allowedDirect = new Map([
  ["CreditSadminRegistration", "RESTRICT"],
  ["CreditSadminEvent", "RESTRICT"],
  ["CreditApprovalReview", "RESTRICT"],
  ["CommissionCreditSource", "RESTRICT"],
  ["CreditoAmortizacion", "CASCADE"],
]);
const allowedUnconstrained = new Set(["CreditApprovalEvent", "CreditoBorrador"]);
const protectedTriggers = Object.freeze([
  ["CreditSadminEvent", "CreditSadminEvent_immutable"],
  ["CreditApprovalEvent", "CreditApprovalEvent_immutable"],
  ["CommissionAudit", "finser_commission_audit_immutable"],
]);
const quoteIdent = value => `"${String(value).replaceAll('"', '""')}"`;
const refKey = entry => `${entry.schema}.${entry.table}.${entry.column}`;
const count = value => Number(value || 0);

export function evaluatePurgePreconditions({ credit, references = [], extraReferences = [],
  signature = null, sadmin = null, ancillary = {}, target = TEST_CREDIT_PURGE }) {
  const blockers = [];
  if (!credit) return { eligible: false, blockers: ["CREDIT_NOT_FOUND_OR_NOT_UNIQUE"] };
  if (credit.folio !== target.folio ||
      credit.clienteNombre !== target.customerName ||
      Number(credit.valorEquipoTotal) !== target.equipmentValue ||
      Number(credit.montoCredito) !== target.financedValue ||
      Number(credit.cuotaInicial) !== target.initialPayment ||
      !target.allowedStates.includes(credit.estado)) {
    blockers.push("CREDIT_IDENTITY_MISMATCH");
  }
  // The normal creation flow writes local contract timestamps and evidence
  // even for this fictitious test. Provider dispatches/signatures are checked
  // separately and must still be absent.
  if (credit.pazYSalvoEmitidoAt || credit.planCapitalVigente != null) {
    blockers.push("CREDIT_HAS_FINANCIAL_CLOSURE_OR_CAPITAL_STATE");
  }
  if (credit.deliverableReady) blockers.push("CREDIT_DELIVERY_READY");
  if (credit.firmaProcessUuid) blockers.push("FIRMASEGURO_PROVIDER_REFERENCE_EXISTS");
  if (sadmin?.numeroCredito && sadmin.numeroCredito !== target.localSadminNumber) {
    blockers.push("SADMIN_NUMBER_MISMATCH");
  }
  if (signature && (count(signature.count) > 0 || count(signature.signedCount) > 0)) {
    blockers.push("FIRMASEGURO_PROCESS_EXISTS");
  }
  for (const reference of references) {
    if (count(reference.count) === 0) continue;
    const expected = allowedDirect.get(reference.table);
    if (reference.schema !== "public" || !expected || reference.deleteAction !== expected ||
        reference.column !== (reference.table === "CommissionCreditSource" ? "creditId" : "creditoId")) {
      blockers.push(`LINKED_RECORD:${refKey(reference)}`);
    }
  }
  for (const reference of extraReferences) {
    if (count(reference.count) > 0 &&
        !(reference.schema === "public" && reference.column === "creditoId" &&
          allowedUnconstrained.has(reference.table))) {
      blockers.push(`UNCONSTRAINED_REFERENCE:${refKey(reference)}`);
    }
  }
  const draft = ancillary.draft;
  const linkedDraftCount = extraReferences.find(ref => ref.schema === "public" &&
    ref.table === "CreditoBorrador" && ref.column === "creditoId")?.count || 0;
  if (count(linkedDraftCount) !== count(ancillary.draftCount)) {
    blockers.push("DRAFT_INSPECTION_MISMATCH");
  }
  if (count(ancillary.draftCount) > 1 ||
      (count(ancillary.draftCount) === 1 && (!draft || draft.estado !== "CERRADO" ||
        draft.closedReason !== "FINALIZADA" ||
        String(draft.clienteNombre || "").trim().toUpperCase() !== target.customerName ||
        (draft.clienteDocumento && credit.clienteDocumento &&
          String(draft.clienteDocumento).replace(/\D/g, "") !== String(credit.clienteDocumento).replace(/\D/g, "")) ||
        (draft.imei && credit.imei && String(draft.imei).trim() !== String(credit.imei).trim()) ||
        (draft.dataCreditoAssessmentId || draft.payloadAssessmentId)))) {
    blockers.push("DRAFT_IDENTITY_OR_EXTERNAL_ASSESSMENT");
  }
  for (const reference of ancillary.draftReferences || []) {
    if (count(reference.count) > 0) blockers.push(`DRAFT_LINKED_RECORD:${refKey(reference)}`);
  }
  const review = ancillary.approvalReview;
  if (review && (review.status !== "PENDING" || review.approvedRevision != null ||
      review.approvedAt != null || review.approvedByUserId != null ||
      review.callRecordingId != null)) {
    blockers.push("APPROVAL_ACTION_EXISTS");
  }
  for (const event of ancillary.approvalEventTypes || []) {
    if (count(event.count) > 0 && event.eventType !== "INVALIDATED") {
      blockers.push("APPROVAL_ACTION_EXISTS");
    }
  }
  const source = ancillary.commissionSource;
  if (source && (source.isTest !== true || source.eligible !== false || source.finalizedAt != null)) {
    blockers.push("COMMISSION_SOURCE_NOT_SYNTHETIC");
  }
  for (const audit of ancillary.commissionAuditActions || []) {
    if (count(audit.count) > 0 && audit.action !== "CREDIT_CHANGED") {
      blockers.push("COMMISSION_AUDIT_NOT_GENERATED");
    }
  }
  if (count(ancillary.commissionPeriodReferences) || count(ancillary.commissionRequestReferences)) {
    blockers.push("COMMISSION_FINANCIAL_REFERENCE_EXISTS");
  }
  if (count(ancillary.cashMovements)) blockers.push("CASH_MOVEMENT_EXISTS");
  return { eligible: blockers.length === 0, blockers: [...new Set(blockers)] };
}

async function tableExists(client, table) {
  const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${quoteIdent(table)}`]);
  return result.rows[0]?.present === true;
}

async function directReferences(client, recordId, targetTable = "Credito") {
  const metadata = await client.query(`
    SELECT ns.nspname AS schema, rel.relname AS "table", att.attname AS "column",
      cardinality(c.conkey) AS key_length, target_att.attname AS target_column,
      c.confdeltype AS delete_code
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    JOIN pg_attribute att ON att.attrelid=rel.oid AND att.attnum=c.conkey[1]
    JOIN pg_attribute target_att ON target_att.attrelid=c.confrelid AND target_att.attnum=c.confkey[1]
    WHERE c.contype='f' AND c.confrelid=to_regclass($1)
    ORDER BY ns.nspname, rel.relname, c.conname`, [`public.${quoteIdent(targetTable)}`]);
  const actions = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  const result = [];
  const seen = new Set();
  for (const row of metadata.rows) {
    const key = `${row.schema}.${row.table}.${row.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (count(row.key_length) !== 1 || row.target_column !== "id") {
      result.push({ schema: row.schema, table: row.table, column: row.column,
        count: 1, deleteAction: "UNSUPPORTED_FK" });
      continue;
    }
    const linked = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdent(row.schema)}.${quoteIdent(row.table)}
      WHERE ${quoteIdent(row.column)}=$1`, [recordId]);
    result.push({ schema: row.schema, table: row.table, column: row.column,
      count: count(linked.rows[0]?.count), deleteAction: actions[row.delete_code] || "UNKNOWN" });
  }
  return result;
}

async function unconstrainedReferences(client, recordId, direct, targetTable = "Credito") {
  const columnsToFind = targetTable === "Credito" ? ["creditoId", "creditId"] :
    ["draftId", "solicitudId", "borradorId"];
  const columns = await client.query(`SELECT table_schema AS schema, table_name AS "table",
      column_name AS "column" FROM information_schema.columns
    WHERE table_schema='public' AND column_name=ANY($1::text[])
      AND data_type IN ('integer','bigint') AND table_name <> $2
    ORDER BY table_name,column_name`, [columnsToFind, targetTable]);
  const constrained = new Set(direct.map(refKey));
  const result = [];
  for (const column of columns.rows) {
    if (constrained.has(refKey(column))) continue;
    const linked = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdent(column.schema)}.${quoteIdent(column.table)}
      WHERE ${quoteIdent(column.column)}=$1`, [recordId]);
    result.push({ ...column, count: count(linked.rows[0]?.count) });
  }
  return result;
}

async function one(client, table, sql, params) {
  if (!await tableExists(client, table)) return null;
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

function referencesCredit(json, creditId, folio) {
  if (json === creditId || json === folio) return true;
  if (Array.isArray(json)) return json.some(value => referencesCredit(value, creditId, folio));
  if (!json || typeof json !== "object") return false;
  for (const [key, value] of Object.entries(json)) {
    if ((key === "id" || key === "creditId" || key === "creditoId") && Number(value) === creditId) return true;
    if ((key === "code" || key === "folio") && value === folio) return true;
    if (referencesCredit(value, creditId, folio)) return true;
  }
  return false;
}

async function countCommissionReferences(client, table, creditId, folio) {
  if (!await tableExists(client, table)) return 0;
  const result = await client.query(`SELECT credits FROM ${quoteIdent(table)}`);
  return result.rows.filter(row => referencesCredit(row.credits, creditId, folio)).length;
}

async function inspectDraft(client, creditId) {
  if (!await tableExists(client, "CreditoBorrador")) {
    return { draft: null, draftCount: 0, draftReferences: [] };
  }
  const result = await client.query(`SELECT id,estado,"closedReason","clienteNombre",
    "clienteDocumento",imei,"dataCreditoAssessmentId",
    NULLIF("payload"->>'dataCreditoAssessmentId','') AS "payloadAssessmentId" FROM "CreditoBorrador"
    WHERE "creditoId"=$1 LIMIT 2`, [creditId]);
  if (result.rows.length !== 1) {
    return { draft: null, draftCount: result.rows.length, draftReferences: [] };
  }
  const draft = result.rows[0];
  const direct = await directReferences(client, draft.id, "CreditoBorrador");
  const extra = await unconstrainedReferences(client, draft.id, direct, "CreditoBorrador");
  return { draft, draftCount: 1, draftReferences: [...direct, ...extra] };
}

async function inspectAncillary(client, creditId, target) {
  const approvalReview = await one(client, "CreditApprovalReview", `SELECT status,"approvedRevision","approvedAt",
    "approvedByUserId","callRecordingId" FROM "CreditApprovalReview" WHERE "creditoId"=$1`, [creditId]);
  const approvalEventTypes = await tableExists(client, "CreditApprovalEvent")
    ? (await client.query(`SELECT "eventType",count(*)::int AS count FROM "CreditApprovalEvent"
        WHERE "creditoId"=$1 GROUP BY "eventType"`, [creditId])).rows : [];
  const commissionSource = await one(client, "CommissionCreditSource", `SELECT "isTest",eligible,"finalizedAt"
    FROM "CommissionCreditSource" WHERE "creditId"=$1`, [creditId]);
  const commissionAuditActions = await tableExists(client, "CommissionAudit")
    ? (await client.query(`SELECT action,count(*)::int AS count FROM "CommissionAudit"
        WHERE payload#>>'{current,id}'=$1::text OR payload#>>'{previous,id}'=$1::text
        GROUP BY action`, [creditId])).rows : [];
  const commissionPeriodReferences = await countCommissionReferences(client, "CommissionPeriod", creditId, target.folio);
  const commissionRequestReferences = await countCommissionReferences(client, "CommissionRequest", creditId, target.folio);
  const cashMovements = await tableExists(client, "CajaMovimiento")
    ? count((await client.query(`SELECT count(*)::int AS count FROM "CajaMovimiento"
        WHERE descripcion LIKE '%' || $1 || '%'`, [target.folio])).rows[0]?.count) : 0;
  const draftInspection = await inspectDraft(client, creditId);
  return { approvalReview, approvalEventTypes, commissionSource, commissionAuditActions,
    commissionPeriodReferences, commissionRequestReferences, cashMovements, ...draftInspection };
}

async function inspect(client, execute, target) {
  const result = await client.query(`SELECT id,folio,"clienteNombre","valorEquipoTotal","montoCredito",
    "cuotaInicial",estado,"deliverableReady","contratoAceptadoAt","pagareAceptadoAt",
    "pazYSalvoEmitidoAt","planCapitalVigente","contratoFirmaDataUrl","contratoFotoDataUrl",
    "fotoEntregaDataUrl","fotoRemisionDataUrl","contratoOtpVerificadoAt",
    "contratoSnapshot"#>>'{firma,procesoUuid}' AS "firmaProcessUuid",
    "clienteDocumento",imei FROM "Credito" WHERE folio=$1 LIMIT 2 ${execute ? "FOR UPDATE" : ""}`,
    [target.folio]);
  if (result.rows.length !== 1) {
    return { verdict: { eligible: false, blockers: ["CREDIT_NOT_FOUND_OR_NOT_UNIQUE"] },
      credit: null, notFound: result.rows.length === 0, references: [], extraReferences: [], ancillary: {} };
  }
  const credit = result.rows[0];
  const references = await directReferences(client, credit.id);
  const extraReferences = await unconstrainedReferences(client, credit.id, references);
  const sadmin = await one(client, "CreditSadminRegistration", `SELECT "numeroCredito"
    FROM "CreditSadminRegistration" WHERE "creditoId"=$1`, [credit.id]);
  const signature = await one(client, "FirmaSeguroProcess", `SELECT count(*)::int AS count,
    count(*) FILTER (WHERE "completedAt" IS NOT NULL OR nullif("signedDocumentBase64",'') IS NOT NULL)::int AS "signedCount"
    FROM "FirmaSeguroProcess" WHERE "creditoId"=$1`, [credit.id]);
  const ancillary = await inspectAncillary(client, credit.id, target);
  const verdict = evaluatePurgePreconditions({ credit, references, extraReferences,
    signature, sadmin, ancillary, target });
  return { verdict, credit, references, extraReferences, ancillary };
}

async function toggleImmutableTrigger(client, table, trigger, enabled) {
  const result = await client.query(`SELECT t.tgenabled FROM pg_trigger t
    WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2 AND NOT t.tgisinternal`,
    [`public.${quoteIdent(table)}`, trigger]);
  if (result.rows.length === 0) return false;
  if (result.rows[0].tgenabled !== "O") throw new Error("UNEXPECTED_TRIGGER_STATE");
  if (!enabled) await client.query(`ALTER TABLE public.${quoteIdent(table)} DISABLE TRIGGER ${quoteIdent(trigger)}`);
  return true;
}

async function restoreImmutableTrigger(client, table, trigger, toggled) {
  if (toggled) await client.query(`ALTER TABLE public.${quoteIdent(table)} ENABLE TRIGGER ${quoteIdent(trigger)}`);
}

function summarize(checked, target, execute) {
  return { mode: execute ? "EXECUTE" : "DRY_RUN", folio: target.folio, ...checked.verdict,
    references: checked.references.filter(item => item.count > 0).map(item => ({ table: item.table, count: item.count })),
    extraReferences: checked.extraReferences.filter(item => item.count > 0).map(item => ({ table: item.table, count: item.count })),
    commissionAuditCount: checked.ancillary.commissionAuditActions?.reduce((n, row) => n + count(row.count), 0) || 0 };
}

async function deleteChecked(client, checked, target, summary) {
  const creditId = checked.credit.id;
  const deleted = {};
  const auditCount = summary.commissionAuditCount;
  const approvalEventCount = checked.ancillary.approvalEventTypes?.reduce((n, row) => n + count(row.count), 0) || 0;
  const sadminEventCount = checked.references.find(row => row.table === "CreditSadminEvent")?.count || 0;
  const toggled = [];
  try {
    for (const [table, trigger] of protectedTriggers) {
      const linked = table === "CommissionAudit" ? auditCount :
        table === "CreditApprovalEvent" ? approvalEventCount : sadminEventCount;
      if (linked > 0 && await toggleImmutableTrigger(client, table, trigger, false)) {
        toggled.push([table, trigger]);
      }
    }
    if (auditCount) {
      const response = await client.query(`DELETE FROM "CommissionAudit"
        WHERE payload#>>'{current,id}'=$1::text OR payload#>>'{previous,id}'=$1::text`, [creditId]);
      deleted.CommissionAudit = response.rowCount;
      if (response.rowCount !== auditCount) throw new Error("COMMISSION_AUDIT_COUNT_CHANGED");
    }
    for (const [table, column] of [
      ["CommissionCreditSource", "creditId"], ["CreditSadminEvent", "creditoId"],
      ["CreditSadminRegistration", "creditoId"], ["CreditApprovalEvent", "creditoId"],
      ["CreditApprovalReview", "creditoId"],
    ]) {
      if (!await tableExists(client, table)) continue;
      const response = await client.query(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)}=$1`, [creditId]);
      deleted[table] = response.rowCount;
    }
  } finally {
    // PostgreSQL rolls back trigger DDL on error; on success restore before COMMIT.
    for (const [table, trigger] of toggled.reverse()) {
      await restoreImmutableTrigger(client, table, trigger, true);
    }
  }
  if (checked.ancillary.draft) {
    const response = await client.query(`DELETE FROM "CreditoBorrador"
      WHERE id=$1 AND "creditoId"=$2`, [checked.ancillary.draft.id, creditId]);
    deleted.CreditoBorrador = response.rowCount;
    if (response.rowCount !== 1) throw new Error("DRAFT_DELETE_COUNT_CHANGED");
  }
  const response = await client.query('DELETE FROM "Credito" WHERE id=$1 AND folio=$2', [creditId, target.folio]);
  deleted.Credito = response.rowCount;
  if (response.rowCount !== 1) throw new Error("CREDIT_DELETE_COUNT_CHANGED");
  const remaining = await client.query('SELECT count(*)::int AS count FROM "Credito" WHERE folio=$1', [target.folio]);
  if (count(remaining.rows[0]?.count) !== 0) throw new Error("CREDIT_STILL_PRESENT");
  return deleted;
}

export async function purgeWithClient(client, { execute = false, confirmation = "",
  folio = TEST_CREDIT_PURGE.folio } = {}) {
  const target = TEST_CREDITS_PURGE.find(item => item.folio === folio);
  if (!target) throw new Error("TARGET_NOT_ALLOWED");
  if (execute && confirmation !== target.confirmation) throw new Error("CONFIRMATION_REQUIRED");
  await client.query(execute ? "BEGIN ISOLATION LEVEL SERIALIZABLE" :
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL lock_timeout='8s'");
    await client.query("SET LOCAL statement_timeout='90s'");
    const checked = await inspect(client, execute, target);
    const summary = summarize(checked, target, execute);
    if (!checked.verdict.eligible || !execute) {
      await client.query("COMMIT");
      return { ...summary, deleted: false };
    }
    const deleted = await deleteChecked(client, checked, target, summary);
    await client.query("COMMIT");
    return { ...summary, deleted: true, deletedRows: deleted };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// The two synthetic records are inspected before either is changed. If one
// fails a guard, the whole batch is untouched. A later retry may find one or
// both missing; that is the idempotent success case for this fixed allowlist.
export async function purgeBothWithClient(client, { execute = false, confirmation = "" } = {}) {
  if (execute && confirmation !== PURGE_BOTH_CONFIRMATION) throw new Error("CONFIRMATION_REQUIRED");
  await client.query(execute ? "BEGIN ISOLATION LEVEL SERIALIZABLE" :
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL lock_timeout='8s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    const inspected = [];
    for (const target of TEST_CREDITS_PURGE) {
      const checked = await inspect(client, execute, target);
      const summary = checked.notFound
        ? { mode: execute ? "EXECUTE" : "DRY_RUN", folio: target.folio,
          eligible: true, alreadyAbsent: true, blockers: [], deleted: false }
        : { ...summarize(checked, target, execute), deleted: false };
      inspected.push({ target, checked, summary });
    }
    const eligible = inspected.every(item => item.summary.eligible);
    if (!eligible || !execute) {
      await client.query("COMMIT");
      return { mode: execute ? "EXECUTE" : "DRY_RUN", eligible, deleted: false,
        targets: inspected.map(item => item.summary) };
    }
    for (const item of inspected) {
      if (item.checked.notFound) continue;
      const deletedRows = await deleteChecked(client, item.checked, item.target, item.summary);
      item.summary = { ...item.summary, deleted: true, deletedRows };
    }
    await client.query("COMMIT");
    return { mode: "EXECUTE", eligible: true,
      deleted: inspected.some(item => item.summary.deleted),
      targets: inspected.map(item => item.summary) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runPurge(connectionString, options = {}) {
  if (!connectionString) throw new Error("DATABASE_URL_MISSING");
  const client = new pg.Client({ connectionString,
    application_name: "finserpay-one-off-test-credit-purge", connectionTimeoutMillis: 10_000 });
  await client.connect();
  try { return options.allTests
    ? await purgeBothWithClient(client, options)
    : await purgeWithClient(client, options); }
  finally { await client.end(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allTests = process.argv.includes("--all-tests") || process.argv.includes("--execute-all-tests");
  const execute = process.argv.includes("--execute") || process.argv.includes("--execute-all-tests");
  const folio = process.argv.find(arg => arg.startsWith("--folio="))?.slice("--folio=".length) || "";
  const confirmation = process.argv.find(arg => arg.startsWith("--confirm="))?.slice("--confirm=".length) || "";
  try {
    const result = await runPurge(process.env.DATABASE_URL, { execute, confirmation, folio, allTests });
    console.log(JSON.stringify(result));
    if (!result.eligible) process.exitCode = 2;
  } catch (error) {
    // A raw database error may contain customer data or connection details.
    const safe = new Set(["DATABASE_URL_MISSING", "CONFIRMATION_REQUIRED", "UNEXPECTED_TRIGGER_STATE", "TARGET_NOT_ALLOWED"]);
    console.error(JSON.stringify({ mode: execute ? "EXECUTE" : "DRY_RUN", deleted: false,
      error: safe.has(error?.message) ? error.message : "PURGE_FAILED" }));
    process.exitCode = 1;
  }
}
