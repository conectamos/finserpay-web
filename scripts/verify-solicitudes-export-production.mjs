// Run with the existing service's SESSION_SECRET and DATABASE_URL in its
// environment. Never put either value in command arguments or committed files.
// SQL is read-only. The export API creates normal jobs and their audit entries.
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import ExcelJS from "exceljs";

class VerificationError extends Error {
  constructor(code, httpStatus) { super(code); this.httpStatus = httpStatus; }
}
function check(condition, code) { if (!condition) throw new VerificationError(code); }
function report(checkName, fields = {}) { console.log(JSON.stringify({ check: checkName, ...fields })); }
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const MAX_SAMPLE_ROWS = 25;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const connectionString = process.env.DATABASE_URL;
const signingSecret = process.env.SESSION_SECRET;
let stage = "configuration";
let client;

// The ordinary ADMIN session uses userId and exp; the server resolves the
// active account, role and ally afresh. No password hashes are queried here.
function session(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 10 * 60 })).toString("base64url");
  return `${payload}.${createHmac("sha256", signingSecret).update(payload).digest("base64url")}`;
}

async function main() {
  check(Boolean(connectionString && signingSecret), "missing_required_environment");
  const configuredBase = process.env.FINSERPAY_VERIFY_BASE_URL || "https://finserpay.com";
  let base;
  try { base = new URL(configuredBase); } catch { throw new VerificationError("invalid_base_url"); }
  check(base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "invalid_base_url");
  check(["finserpay.com", "www.finserpay.com"].includes(base.hostname) || base.hostname.endsWith(".up.railway.app"), "unapproved_base_host");
  const origin = base.origin;

  client = new pg.Client({
    connectionString, application_name: "finserpay-export-production-verification", connectionTimeoutMillis: 15_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000",
  });
  await client.connect();
  const sql = async (query, values = []) => (await client.query(query, values)).rows;
  check((await sql("SHOW default_transaction_read_only"))[0].default_transaction_read_only === "on", "database_not_read_only");

  async function request(path, token, body, expectedStatus = 200) {
    const headers = { Origin: origin, Accept: "application/json", "Cache-Control": "no-store" };
    if (token) headers.Cookie = `session=${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!allowed.includes(response.status)) throw new VerificationError("unexpected_http_status", response.status);
    check(response.headers.get("cache-control")?.includes("no-store"), "missing_no_store_header");
    return response;
  }
  async function json(path, token, body, expectedStatus = 200) {
    return (await request(path, token, body, expectedStatus)).json();
  }
  async function count(token, filters) {
    const result = await json("/api/solicitudes/export/count", token, { filters });
    check(Number.isSafeInteger(result.count) && result.count >= 0, "invalid_count");
    return result.count;
  }

  stage = "select_existing_accounts";
  const accounts = await sql(`SELECT u.id AS "userId",s.id AS "sedeId",s."aliadoId",
    UPPER(BTRIM(a.codigo))='FINSERPAY' AS central,
    (SELECT COUNT(*)::integer FROM "Credito" c JOIN "Sede" own ON own.id=c."sedeId" WHERE own."aliadoId"=a.id) AS credits
    FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId"
    JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.activo=true AND s.activa=true AND a.activo=true AND UPPER(BTRIM(r.nombre))='ADMIN'
    ORDER BY credits,u.id`);
  const central = accounts.find(account => account.central);
  const ally = accounts.find(account => !account.central && account.credits > 0);
  check(Boolean(central && ally), "missing_existing_admin_accounts_with_history");
  central.token = session(central.userId);
  ally.token = session(ally.userId);
  report("existing_admin_accounts", { centralUserId: central.userId, allyUserId: ally.userId, aliadoId: ally.aliadoId });

  stage = "unauthenticated_access";
  await request("/api/solicitudes/export/options", null, undefined, 401);
  await request("/api/solicitudes/export/count", null, { filters: { period: "all" } }, 401);
  report("unauthenticated_access_denied");

  const optionsByRole = new Map();
  for (const [role, account] of [["central", central], ["ally", ally]]) {
    stage = `${role}_options`;
    const result = await json("/api/solicitudes/export/options", account.token);
    check(result.scope === (role === "central" ? "CENTRAL_ADMIN" : "ALLY_ADMIN"), "incorrect_session_scope");
    const options = result.options;
    check(Array.isArray(options?.aliados) && Array.isArray(options.sedes) && Array.isArray(options.vendedores), "invalid_options");
    if (role === "ally") {
      check(options.aliados.length === 1 && options.aliados[0].id === ally.aliadoId, "foreign_ally_in_options");
      check(options.sedes.every(sede => sede.aliadoId === ally.aliadoId), "foreign_site_in_options");
      const authorizedVendors = await sql(`WITH associations AS (
        SELECT "vendedorId","sedeId" FROM "SedeVendedor" WHERE activo=true
        UNION SELECT "vendedorId","sedeId" FROM "Credito" WHERE "vendedorId" IS NOT NULL
        UNION SELECT "vendedorId","sedeId" FROM "CreditoBorrador" WHERE "vendedorId" IS NOT NULL
      ) SELECT DISTINCT x."vendedorId" AS id FROM associations x JOIN "Sede" s ON s.id=x."sedeId" WHERE s."aliadoId"=$1`, [ally.aliadoId]);
      const permitted = new Set(authorizedVendors.map(row => row.id));
      check(options.vendedores.every(vendor => permitted.has(vendor.id)), "foreign_vendor_in_options");
    } else {
      check(options.aliados.some(item => item.id === ally.aliadoId) && options.aliados.some(item => item.id === central.aliadoId), "central_missing_authorized_allies");
    }
    optionsByRole.set(role, options);
    report(`${role}_authorized_options`, { aliados: options.aliados.length, sedes: options.sedes.length, vendedores: options.vendedores.length });
  }

  stage = "foreign_identifier_attacks";
  const foreignSite = optionsByRole.get("central").sedes.find(site => site.aliadoId !== ally.aliadoId);
  check(Boolean(foreignSite), "missing_foreign_site_for_check");
  const attacks = [{ aliadoIds: [foreignSite.aliadoId] }, { sedeIds: [foreignSite.id] }];
  const allyVendorIds = new Set(optionsByRole.get("ally").vendedores.map(vendor => vendor.id));
  const foreignVendor = optionsByRole.get("central").vendedores.find(vendor => !allyVendorIds.has(vendor.id));
  if (foreignVendor) attacks.push({ vendedorIds: [foreignVendor.id] });
  for (const attack of attacks) {
    const filters = { period: "all", ...attack };
    await request("/api/solicitudes/export/count", ally.token, { filters }, 403);
    await request("/api/solicitudes/export", ally.token, { filters, expectedCount: 0, userId: central.userId }, 403);
  }
  report("foreign_identifier_attacks_denied", { count: attacks.length });

  stage = "other_role_access";
  const [seller] = await sql(`SELECT u.id FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId"
    WHERE u.activo=true AND UPPER(BTRIM(r.nombre)) NOT IN ('ADMIN','ANALISTA_APROBACION') ORDER BY u.id LIMIT 1`);
  if (seller) {
    const sellerToken = session(seller.id);
    await request("/api/solicitudes/export/options", sellerToken, undefined, [401, 403]);
    await request("/api/solicitudes/export/count", sellerToken, { filters: { period: "all" } }, [401, 403]);
    await request("/api/solicitudes/export", sellerToken, { filters: { period: "all" }, expectedCount: 0 }, [401, 403]);
    report("other_role_access_denied", { userId: seller.id });
  } else report("other_role_check_no_existing_account", { count: 0 });

  const createdJobs = [];
  for (const [role, account] of [["central", central], ["ally", ally]]) {
    stage = `${role}_sample_selection`;
    // Old requests minimize legitimate live count changes while checking the
    // same creation-date semantics as the wall. No customer fields are read.
    const candidates = await sql(`SELECT c.id,c.folio,c."sedeId",c."vendedorId",
      COALESCE(origin."createdAt",c."createdAt" AT TIME ZONE 'UTC') AS created
      FROM "Credito" c JOIN "Sede" s ON s.id=c."sedeId"
      LEFT JOIN LATERAL (SELECT d."createdAt" FROM "CreditoBorrador" d
        WHERE d."creditoId"=c.id ORDER BY d."createdAt",d.id LIMIT 1) origin ON true
      WHERE ($1::integer IS NULL OR s."aliadoId"=$1) AND NULLIF(BTRIM(c.folio),'') IS NOT NULL
      ORDER BY COALESCE(origin."createdAt",c."createdAt" AT TIME ZONE 'UTC'),c.id LIMIT 10`, [role === "ally" ? account.aliadoId : null]);
    let sample, sampleFilters, sampleCount;
    for (const candidate of candidates) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(candidate.created));
      // Central exercises general authorized scope explicitly: a narrow date
      // and search keep volume low without an ally/site/vendor restriction.
      const filters = { period: "range", desde: day, hasta: day, q: candidate.folio, aliadoIds: [], sedeIds: [], vendedorIds: [] };
      if (role === "ally") {
        filters.sedeIds = [candidate.sedeId];
        if (candidate.vendedorId) filters.vendedorIds = [candidate.vendedorId];
      }
      const total = await count(account.token, filters);
      if (total > 0 && total <= MAX_SAMPLE_ROWS) { sample = candidate; sampleFilters = filters; sampleCount = total; break; }
    }
    check(Boolean(sample), "no_small_authorized_sample");

    stage = `${role}_general_month_range_counts`;
    const allCount = await count(account.token, { period: "all" });
    const month = sampleFilters.desde.slice(0, 7);
    const monthCount = await count(account.token, { period: "month", month });
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
    const rangeCount = await count(account.token, { period: "range", desde: `${month}-01`, hasta: monthEnd });
    const allyCount = await count(account.token, { period: "all", aliadoIds: [account.aliadoId] });
    const approvedCount = await count(account.token, { period: "all", estado: "APROBADA" });
    const selectedCount = await count(account.token, {
      ...sampleFilters, sedeIds: [sample.sedeId], vendedorIds: sample.vendedorId ? [sample.vendedorId] : [],
    });
    check(allCount >= monthCount && monthCount === rangeCount && allCount >= sampleCount && allCount >= approvedCount, "counts_inconsistent");
    check(selectedCount > 0 && selectedCount <= sampleCount, "combined_site_vendor_count_inconsistent");
    if (role === "ally") check(allyCount === allCount, "ally_scope_count_mismatch");
    report(`${role}_general_month_range_counts`, { total: allCount, monthCount, rangeCount, aliadoCount: allyCount, approvedCount, sampleCount, selectedCount });

    stage = `${role}_create_export`;
    const { job: created } = await json("/api/solicitudes/export", account.token, { filters: sampleFilters, expectedCount: sampleCount }, 202);
    check(UUID.test(created?.id) && created.count === sampleCount, "invalid_created_job");
    if (role === "central") check(created.filename?.startsWith("FINSERPAY_Clientes_General_"), "central_export_not_general_scope");
    createdJobs.push({ role, account, id: created.id });
    let job = created;
    for (let attempt = 0; attempt < 120 && job.status !== "READY"; attempt += 1) {
      check(job.status === "PENDING" || job.status === "PROCESSING", "export_generation_failed");
      await delay(2_000);
      ({ job } = await json(`/api/solicitudes/export/${created.id}`, account.token));
    }
    check(job.status === "READY" && job.processed === sampleCount, "export_generation_timeout_or_count_mismatch");

    stage = `${role}_download_excel`;
    const response = await request(`/api/solicitudes/export/${job.id}/download`, account.token);
    check(response.headers.get("content-type")?.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "invalid_excel_content_type");
    check(response.headers.get("content-disposition")?.includes(".xlsx"), "missing_excel_filename");
    const contentLength = Number(response.headers.get("content-length"));
    check(Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength <= MAX_DOWNLOAD_BYTES, "unexpected_download_size");
    const buffer = Buffer.from(await response.arrayBuffer());
    check(buffer.length === contentLength, "incomplete_download");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer);
    const manifest = await sql(`SELECT m.source,m."entityId",s."aliadoId",
      CASE WHEN m.source='CREDIT' THEN COALESCE('SOL-' || LPAD(origin.id::text,GREATEST(6,LENGTH(origin.id::text)),'0'),c.folio)
        ELSE 'SOL-' || LPAD(d.id::text,GREATEST(6,LENGTH(d.id::text)),'0') END AS request,
      CASE WHEN m.source='CREDIT' THEN c.folio ELSE '' END AS credit
      FROM "SolicitudExportMember" m
      LEFT JOIN "Credito" c ON m.source='CREDIT' AND c.id=m."entityId"
      LEFT JOIN "CreditoBorrador" d ON m.source='DRAFT' AND d.id=m."entityId"
      LEFT JOIN "Sede" s ON s.id=COALESCE(c."sedeId",d."sedeId")
      LEFT JOIN LATERAL (SELECT o.id FROM "CreditoBorrador" o WHERE o."creditoId"=c.id
        ORDER BY o."createdAt",o.id LIMIT 1) origin ON true WHERE m."jobId"=$1::uuid`, [job.id]);
    check(manifest.length === sampleCount, "manifest_count_mismatch");
    if (role === "ally") check(manifest.every(row => row.aliadoId === account.aliadoId), "foreign_request_in_ally_download");
    const expectedIds = manifest.map(row => JSON.stringify([row.request, row.credit || ""])).sort();
    const actualIds = [];
    let exportedCount = 0;
    for (const sheet of book.worksheets) {
      check(sheet.columnCount === 26 && sheet.views[0]?.state === "frozen" && sheet.views[0]?.ySplit === 1 && Boolean(sheet.autoFilter), "invalid_excel_layout");
      sheet.eachRow((row, rowIndex) => {
        if (rowIndex === 1) return;
        exportedCount += 1;
        actualIds.push(JSON.stringify([row.getCell(1).text, row.getCell(4).text]));
        for (const column of [1, 4, 5, 8, 9, 19]) {
          const cell = row.getCell(column);
          check(!cell.formula && cell.numFmt === "@", "unsafe_identifier_cell");
          check(cell.value === null || cell.type === ExcelJS.ValueType.String, "identifier_not_text");
        }
        check(!row.getCell(8).text.includes("."), "formatted_document_in_excel");
        for (const column of [20, 21, 22, 24]) {
          const cell = row.getCell(column);
          check(cell.value === null || cell.type === ExcelJS.ValueType.Number, "amount_not_numeric");
          check(cell.numFmt.includes("es-CO"), "amount_missing_colombian_format");
        }
      });
    }
    check(exportedCount === sampleCount && JSON.stringify(actualIds.sort()) === JSON.stringify(expectedIds), "excel_count_or_request_identity_mismatch");
    const audit = await sql(`SELECT event,"userId",count,filters FROM "SolicitudExportAudit" WHERE "jobId"=$1::uuid ORDER BY id`, [job.id]);
    check(["REQUESTED", "GENERATED", "DOWNLOAD_STARTED"].every(event => audit.some(row => row.event === event)), "missing_audit_event");
    check(audit.every(row => row.userId === account.userId && row.count === sampleCount && !("q" in row.filters) && row.filters.searchApplied === true), "audit_scope_or_search_redaction_failed");
    if (role === "central") check(audit.every(row => row.filters.scope === "CENTRAL_ADMIN" &&
      row.filters.aliadoIds.length === 0 && row.filters.sedeIds.length === 0 && row.filters.vendedorIds.length === 0), "central_general_scope_audit_mismatch");
    report(`${role}_xlsx_and_audit_verified`, { jobId: job.id, userId: account.userId, count: exportedCount, bytes: buffer.length });
  }

  stage = "cross_user_downloads";
  for (const job of createdJobs) {
    const other = job.role === "central" ? ally : central;
    await request(`/api/solicitudes/export/${job.id}`, other.token, undefined, 403);
    await request(`/api/solicitudes/export/${job.id}/download?aliadoId=${other.aliadoId}`, other.token, undefined, 403);
  }
  report("cross_user_jobs_and_downloads_denied", { count: createdJobs.length });
  report("production_export_verification_passed", { count: createdJobs.length });
}

try { await main(); }
catch (error) {
  // Never print raw SQL/HTTP/XLSX errors: they can contain connection strings,
  // response bodies, session material or customer data.
  report("production_export_verification_failed", {
    stage, code: error instanceof VerificationError ? error.message : "runtime_failure",
    ...(error instanceof VerificationError && Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  });
  process.exitCode = 1;
} finally { await client?.end().catch(() => undefined); }
