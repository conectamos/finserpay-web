// Production QA against existing accounts and real installments. Credentials
// come only from the service environment; no secrets/customer data are logged.
// Direct SQL is enforced read-only. Without --save, every HTTP request is GET.
// With --save, two idempotent POSTs verify ONE durable projection; never delete it.
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import ExcelJS from "exceljs";

const ROUTE = "/api/reportes/recaudo-por-corte";
const CUT = "2026-10-17";
const FILTERS = { day: 17, month: 10, year: 2026, status: "todos" };
const MAX_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class VerificationError extends Error {
  constructor(code, httpStatus) { super(code); this.httpStatus = httpStatus; }
}
function check(condition, code) { if (!condition) throw new VerificationError(code); }
function output(checkName, fields = {}) { console.log(JSON.stringify({ check: checkName, ...fields })); }
const cents = value => { check(typeof value === "number" && Number.isFinite(value), "invalid_numeric_value"); return Math.round(value * 100); };

export function verificationRequestKey(origin) {
  const bytes = createHash("sha256").update(`FINSERPAY:cut-production-verification:v1:${origin}:${CUT}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function verifyReport(report, filters = FILTERS) {
  check(report?.ok === true && report.cutDate === CUT && Array.isArray(report.rows), "invalid_report_shape_or_cut");
  check(report.filters.day === 17 && report.filters.month === 10 && report.filters.year === 2026, "incorrect_calendar_filters");
  check(Number.isFinite(new Date(report.asOf).getTime()), "invalid_as_of");
  const keys = new Set();
  for (const row of report.rows) {
    check(row.dueDate === CUT && !keys.has(row.key), "wrong_or_duplicate_installment");
    keys.add(row.key);
    check(["pendiente", "parcial", "pagado"].includes(row.status), "invalid_installment_status");
    if (filters.status !== "todos") check(row.status === filters.status, "status_filter_ignored");
    if (filters.aliadoId) check(row.aliadoId === filters.aliadoId, "foreign_ally_in_rows");
    if (filters.sedeId) check(row.sedeId === filters.sedeId, "foreign_site_in_rows");
    for (const field of ["expected", "received", "pending", "priorPayments", "installmentAmount"]) check(cents(row[field]) >= 0, "negative_row_value");
    check(cents(row.received) === row.payments.reduce((sum, payment) => sum + cents(payment.received), 0), "payment_detail_received_mismatch");
    check(cents(row.pending) === Math.max(0, cents(row.expected) - cents(row.received) + cents(row.priorReversals)), "pending_equation_mismatch");
  }
  for (const field of ["expected", "received", "pending", "priorPayments", "priorReversals"]) {
    check(cents(report.summary[field]) === report.rows.reduce((sum, row) => sum + cents(row[field]), 0), "card_detail_total_mismatch");
  }
  const clients = new Set(report.rows.filter(row => cents(row.pending) > 0).map(row => row.document.replace(/[.\s-]/g, "").toUpperCase() || `credit:${row.creditId}`));
  check(report.summary.pendingClients === clients.size, "pending_clients_mismatch");
  const expected = cents(report.summary.expected);
  const completion = expected > 0 ? Math.round(cents(report.summary.received) / expected * 10000) / 100 : null;
  check(report.summary.completion === completion, "completion_mismatch");
  const credits = new Map(report.rows.map(row => [row.creditId, row]));
  for (const field of ["previousRecovery", "futureAdvances"]) {
    check(cents(report.summary[field]) === [...credits.values()].reduce((sum, row) => sum + cents(row[field] || 0), 0), "other_collection_cohort_mismatch");
  }
  check(Array.isArray(report.history) && report.history.length <= 10 && Number.isSafeInteger(report.historyPage), "history_not_paginated");
  return report;
}

export async function verifyWorkbook(bytes, report) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const detail = workbook.getWorksheet("Cuotas");
  const summary = workbook.getWorksheet("Resumen");
  check(Boolean(detail && summary && workbook.getWorksheet("Pagos aplicados") && workbook.getWorksheet("Histórico")), "missing_excel_sheets");
  check(detail.rowCount - 1 === report.rows.length && detail.columnCount === 16, "excel_row_or_column_count_mismatch");
  check(detail.views[0]?.ySplit === 1 && Boolean(detail.autoFilter), "excel_missing_filters_or_frozen_header");
  const values = new Map();
  summary.eachRow((row, index) => { if (index > 1) values.set(row.getCell(1).text, row.getCell(2).value); });
  for (const [field, label, column] of [["expected", "Recaudo esperado", 9], ["received", "Recaudo recibido", 10], ["pending", "Pendiente por recaudar", 11]]) {
    check(cents(values.get(label)) === cents(report.summary[field]), "excel_summary_mismatch");
    let total = 0;
    detail.eachRow((row, index) => { if (index > 1) total += cents(row.getCell(column).value); });
    check(total === cents(report.summary[field]), "excel_table_total_mismatch");
  }
  for (let index = 0; index < report.rows.length; index++) {
    const actual = detail.getRow(index + 2);
    const expected = report.rows[index];
    for (const [column, value] of [[2, expected.document], [3, expected.folio]]) {
      const cell = actual.getCell(column);
      check(cell.text === value && cell.numFmt === "@" && !cell.formula && !cell.hyperlink, "excel_identifier_changed_or_unsafe");
    }
    for (const column of [7, 8, 9, 10, 11, 14]) check(actual.getCell(column).type === ExcelJS.ValueType.Number, "excel_amount_not_number");
    check(actual.getCell(6).value instanceof Date && actual.getCell(6).value.toISOString().slice(0, 10) === CUT, "excel_due_date_shifted");
    check(actual.getCell(13).text === expected.status, "excel_status_mismatch");
  }
  check(values.get("Zona horaria") === "America/Bogota (UTC-05:00)", "excel_timezone_missing");
  const consultDate = values.get("Consultado al (Bogotá)");
  const expectedConsult = new Date(Math.floor(new Date(report.asOf).getTime() / 1000) * 1000 - 5 * 60 * 60 * 1000);
  // The download is a later transaction than the JSON request. Allow its HTTP
  // window while still detecting a timezone shift of several hours.
  check(consultDate instanceof Date && Math.abs(consultDate.getTime() - expectedConsult.getTime()) <= 120_000, "excel_colombia_timestamp_mismatch");
  check(values.get("Página de historial exportada") === report.historyPage + 1, "excel_history_page_mismatch");
}

export async function runProductionVerification(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--help")) {
    output("usage", { command: "node scripts/verify-cut-collection-production.mjs [--save]", environment: ["DATABASE_URL", "SESSION_SECRET", "FINSERPAY_VERIFY_BASE_URL (optional)"], cut: CUT, defaultMode: "read-only", saveMode: "one idempotent projection in one existing site" });
    return 0;
  }
  let stage = "configuration";
  let client;
  try {
    check(args.every(value => value === "--save") && args.length <= 1, "unknown_arguments");
    const save = args.includes("--save");
    check(Boolean(env.DATABASE_URL && env.SESSION_SECRET), "missing_required_environment");
    let base;
    try { base = new URL(env.FINSERPAY_VERIFY_BASE_URL || "https://finserpay.com"); } catch { throw new VerificationError("invalid_base_url"); }
    check(base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "invalid_base_url");
    check(["finserpay.com", "www.finserpay.com"].includes(base.hostname) || base.hostname.endsWith(".up.railway.app"), "unapproved_base_host");
    const origin = base.origin;
    const requestKey = verificationRequestKey(origin);
    client = new pg.Client({ connectionString: env.DATABASE_URL, application_name: "finserpay-cut-production-verification",
      connectionTimeoutMillis: 15_000, options: "-c default_transaction_read_only=on -c statement_timeout=60000" });
    await client.connect();
    const sql = async (query, values = []) => (await client.query(query, values)).rows;
    check((await sql("SHOW default_transaction_read_only"))[0].default_transaction_read_only === "on", "database_not_read_only");
    const token = payload => {
      const encoded = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 15 * 60 })).toString("base64url");
      return `${encoded}.${createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url")}`;
    };
    const cookies = account => account ? `session=${token({ userId: account.userId })}${account.vendedorId ? `; seller_session=${token({ userId: account.userId, vendedorId: account.vendedorId, accesoSedeId: account.sedeId, sedeId: account.sedeId })}` : ""}` : "";
    const query = filters => new URLSearchParams(Object.entries({ ...FILTERS, ...filters }).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]));
    async function request(account, filters = {}, body, status = 200) {
      check(body === undefined || save, "save_flag_required");
      const headers = { Origin: origin, Accept: "application/json", "Cache-Control": "no-store" };
      if (account) headers.Cookie = cookies(account);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${origin}${ROUTE}?${query(filters)}`, { method: body === undefined ? "GET" : "POST", headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (response.status !== status) throw new VerificationError("unexpected_http_status", response.status);
      check(response.headers.get("cache-control")?.includes("private") && response.headers.get("cache-control")?.includes("no-store"), "missing_private_no_store");
      check(response.headers.get("x-content-type-options") === "nosniff" && response.headers.get("vary")?.includes("Cookie"), "missing_security_headers");
      return response;
    }
    const read = async (account, filters = {}) => verifyReport(await (await request(account, filters)).json(), { ...FILTERS, ...filters });

    stage = "existing_accounts";
    // These are the current regular-session contracts. No password/PIN hashes,
    // analyst grants, names, documents or contact fields are queried.
    const admins = await sql(`SELECT u.id AS "userId",s.id AS "sedeId",s."aliadoId",UPPER(BTRIM(a.codigo))='FINSERPAY' AS central,
      (SELECT COUNT(*)::integer FROM "Credito" c JOIN "Sede" own ON own.id=c."sedeId" WHERE own."aliadoId"=a.id) AS credits
      FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
      WHERE u.activo AND s.activa AND a.activo AND UPPER(BTRIM(r.nombre))='ADMIN' ORDER BY credits,u.id`);
    const central = admins.find(account => account.central);
    const schema = (await sql(`SELECT to_regclass('public."CutCollectionProjection"') IS NOT NULL AS present`))[0].present;
    check(schema, "projection_schema_missing");
    const existingVerification = await sql(`SELECT "createdBy" FROM "CutCollectionProjection" WHERE "requestKey"=$1::uuid`, [requestKey]);
    check(existingVerification.length <= 1, "more_than_one_existing_verification_projection");
    let ally = existingVerification.length
      ? admins.find(account => account.userId === existingVerification[0].createdBy && !account.central)
      : admins.find(account => !account.central && account.credits > 0);
    check(Boolean(central && ally), "missing_existing_admin_accounts");
    const profiles = await sql(`SELECT u.id AS "userId",s.id AS "sedeId",s."aliadoId",v.id AS "vendedorId",UPPER(BTRIM(v."tipoPerfil")) AS profile
      FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
      JOIN "SedeVendedor" sv ON sv."sedeId"=s.id AND sv.activo JOIN "Vendedor" v ON v.id=sv."vendedorId" AND v.activo
      WHERE u.activo AND s.activa AND a.activo AND UPPER(BTRIM(r.nombre)) NOT IN ('ADMIN','ANALISTA_APROBACION')
        AND UPPER(BTRIM(v."tipoPerfil")) IN ('SUPERVISOR','VENDEDOR') ORDER BY u.id,v.id`);
    const supervisor = profiles.find(account => account.profile === "SUPERVISOR");
    const seller = profiles.find(account => account.profile === "VENDEDOR");
    const missingRoles = [!supervisor && "supervisor", !seller && "seller"].filter(Boolean);
    output("existing_account_coverage", { central: true, ally: true, supervisor: Boolean(supervisor), seller: Boolean(seller) });

    stage = "unauthenticated_and_seller";
    await request(null, {}, undefined, 401);
    await request(null, { format: "xlsx" }, undefined, 401);
    if (seller) { await request(seller, {}, undefined, 403); await request(seller, { format: "xlsx" }, undefined, 403); }
    output("unauthenticated_and_seller_denied", { sellerChecked: Boolean(seller) });

    stage = "role_previews";
    const centralReport = await read(central);
    if (!existingVerification.length) {
      ally = admins.find(account => !account.central && centralReport.rows.some(row => row.aliadoId === account.aliadoId));
      check(Boolean(ally), "no_existing_ally_account_with_cut_installments");
    }
    const allyReport = await read(ally, { aliadoId: ally.aliadoId });
    check(allyReport.options.sedes.every(site => site.aliadoId === ally.aliadoId), "foreign_site_in_ally_options");
    check(allyReport.options.aliados.every(item => item.id === ally.aliadoId), "foreign_ally_in_options");
    if (supervisor) {
      const local = await read(supervisor, { sedeId: supervisor.sedeId });
      check(local.options.sedes.every(site => site.id === supervisor.sedeId), "foreign_site_in_supervisor_options");
    }
    output("authorized_previews_reconciled", { centralRows: centralReport.rows.length, allyRows: allyReport.rows.length, supervisorChecked: Boolean(supervisor) });

    stage = "scope_denials";
    const foreignSite = centralReport.options.sedes.find(site => site.aliadoId !== ally.aliadoId);
    check(Boolean(foreignSite), "missing_foreign_scope_fixture");
    await request(ally, { sedeId: foreignSite.id }, undefined, 403);
    await request(ally, { sedeId: foreignSite.id, format: "xlsx" }, undefined, 403);
    if (foreignSite.aliadoId) await request(ally, { aliadoId: foreignSite.aliadoId }, undefined, 403);
    if (supervisor) {
      const other = centralReport.options.sedes.find(site => site.id !== supervisor.sedeId);
      check(Boolean(other), "missing_foreign_supervisor_site");
      await request(supervisor, { sedeId: other.id }, undefined, 403);
    }
    await request(central, { day: 3 }, undefined, 400);
    await request(central, { historyPage: -1 }, undefined, 400);
    output("scope_and_invalid_filters_denied");

    stage = "sample_site";
    // Reuse the original QA projection's site on subsequent invocations. If
    // permissions changed, fail instead of creating another projection elsewhere.
    const prior = await sql(`SELECT id::text,"scopeSedeIds" FROM "CutCollectionProjection" WHERE "createdBy"=$1 AND "requestKey"=$2::uuid`, [ally.userId, requestKey]);
    const groups = new Map();
    for (const row of allyReport.rows) groups.set(row.sedeId, (groups.get(row.sedeId) || 0) + 1);
    const siteId = prior[0]?.scopeSedeIds?.[0] || [...groups].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]?.[0];
    check(Boolean(siteId) && allyReport.options.sedes.some(site => site.id === siteId), "no_authorized_site_with_cut_installments");
    const sampleFilters = { ...FILTERS, aliadoId: ally.aliadoId, sedeId: siteId };
    const fingerprints = async () => (await sql(`SELECT
      (SELECT COUNT(*)::integer FROM "Credito" c WHERE c."sedeId"=$1) AS credits,
      (SELECT md5(COALESCE(string_agg(md5(to_jsonb(c)::text),'' ORDER BY c.id),'')) FROM "Credito" c WHERE c."sedeId"=$1) AS credit_hash,
      (SELECT COUNT(*)::integer FROM "CreditoAbono" p JOIN "Credito" c ON c.id=p."creditoId" WHERE c."sedeId"=$1) AS payments,
      (SELECT md5(COALESCE(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'')) FROM "CreditoAbono" p JOIN "Credito" c ON c.id=p."creditoId" WHERE c."sedeId"=$1) AS payment_hash`, [siteId]))[0];
    const before = await fingerprints();
    let selected = await read(ally, sampleFilters);
    check(selected.rows.length > 0, "sample_cut_is_empty");
    const sourceCredits = await sql(`SELECT id FROM "Credito" WHERE "sedeId"=$1 AND id=ANY($2::integer[])`,
      [siteId, [...new Set(selected.rows.map(row => row.creditId))]]);
    check(sourceCredits.length === new Set(selected.rows.map(row => row.creditId)).size, "preview_not_linked_to_real_scope_credits");
    let projectionId = null;

    if (save) {
      stage = "save_one_idempotent_projection";
      const body = { ...sampleFilters, requestKey };
      selected = verifyReport(await (await request(ally, {}, body, 201)).json(), sampleFilters);
      projectionId = selected.projection?.id;
      check(UUID.test(projectionId || ""), "invalid_saved_projection_id");
      const stored = async () => (await sql(`SELECT id::text,"cutDate"::text AS cut,"scopeSedeIds",md5(snapshot::text) AS hash,
        (SELECT COUNT(*)::integer FROM jsonb_array_elements(snapshot->'schedule') AS installment
          WHERE installment->>'fechaVencimiento'=$3 AND NOT (installment->>'eliminada')::boolean) AS rows,
        (SELECT COALESCE(SUM((installment->>'saldoPendiente')::numeric),0)::text FROM jsonb_array_elements(snapshot->'schedule') AS installment
          WHERE installment->>'fechaVencimiento'=$3 AND NOT (installment->>'eliminada')::boolean) AS expected
        FROM "CutCollectionProjection" WHERE "createdBy"=$1 AND "requestKey"=$2::uuid`, [ally.userId, requestKey, CUT]));
      const persisted = await stored();
      check(persisted.length === 1 && persisted[0].id === projectionId && persisted[0].cut === CUT, "projection_not_persisted_once");
      check(persisted[0].scopeSedeIds.length === 1 && persisted[0].scopeSedeIds[0] === siteId, "projection_scope_mismatch");
      check(persisted[0].rows === selected.rows.length && cents(Number(persisted[0].expected)) === cents(selected.summary.expected), "persisted_baseline_mismatch");
      const retry = verifyReport(await (await request(ally, {}, body, 201)).json(), sampleFilters);
      check(retry.projection.id === projectionId, "idempotency_created_another_projection");
      selected = await read(ally, { ...sampleFilters, projectionId });
      check(cents(selected.summary.expected) === cents(Number(persisted[0].expected)), "saved_expected_changed");
      check(JSON.stringify(await stored()) === JSON.stringify(persisted), "stored_projection_mutated");
      const [trigger] = await sql(`SELECT COUNT(*)::integer AS count FROM pg_trigger
        WHERE tgrelid='"CutCollectionProjection"'::regclass AND tgname='CutCollectionProjection_immutable' AND tgenabled IN ('O','A') AND NOT tgisinternal`);
      check(trigger.count === 1, "immutability_trigger_missing");
      output("one_idempotent_projection_persisted", { projectionId, createdNew: prior.length === 0, rows: selected.rows.length });
    } else output("projection_save_not_requested", { existingVerificationProjection: prior.length === 1 });

    stage = "status_filters_and_excel";
    const selectedFilters = { ...sampleFilters, ...(projectionId ? { projectionId } : {}) };
    for (const status of ["pendiente", "parcial", "pagado"]) {
      const filtered = await read(ally, { ...selectedFilters, status });
      check(filtered.rows.every(row => selected.rows.some(original => original.key === row.key)), "filtered_row_not_in_base_report");
    }
    selected = await read(ally, selectedFilters);
    const response = await request(ally, { ...selectedFilters, format: "xlsx" });
    check(response.headers.get("content-type")?.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "invalid_excel_mime");
    check(response.headers.get("content-disposition")?.includes(".xlsx"), "missing_excel_filename");
    const length = Number(response.headers.get("content-length"));
    check(Number.isSafeInteger(length) && length > 0 && length <= MAX_BYTES, "unexpected_excel_size");
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes.length === length && bytes.subarray(0, 2).toString() === "PK", "invalid_excel_bytes");
    const after = await fingerprints();
    check(JSON.stringify(before) === JSON.stringify(after), "financial_data_changed_during_check_retry_needed");
    await verifyWorkbook(bytes, selected);
    output("filtered_excel_and_financial_immutability_verified", { rows: selected.rows.length, bytes: bytes.length, creditsChecked: before.credits, paymentsChecked: before.payments });
    output("production_cut_verification_complete", { cut: CUT, saved: save, coverageComplete: missingRoles.length === 0, missingRoles });
    return missingRoles.length ? 2 : 0;
  } catch (error) {
    // Never print SQL errors, response bodies, stack traces, identifiers of
    // people, hashes, connection strings, cookie material or customer values.
    output("production_cut_verification_failed", { stage, code: error instanceof VerificationError ? error.message : "runtime_failure",
      ...(error instanceof VerificationError && Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) });
    return 1;
  } finally { await client?.end().catch(() => undefined); }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  process.exitCode = await runProductionVerification();
}
