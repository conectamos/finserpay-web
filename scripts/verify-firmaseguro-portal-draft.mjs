import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PRIVATE_ENDPOINT = "ws://firma-portal-browser.railway.internal:3010/connect";
const PORTAL_CODES = new Set([
  "PORTAL_NOT_CONFIGURED", "PORTAL_NAVIGATION_BLOCKED", "PORTAL_NETWORK_FAILED", "PORTAL_CHALLENGE",
  "PORTAL_LOGIN_CHANGED", "PORTAL_LOGIN_FAILED", "PORTAL_STRUCTURE_CHANGED", "PORTAL_UNAVAILABLE",
  "PORTAL_PROCESS_CHANGED", "PORTAL_PROCESS_MISMATCH", "PORTAL_IDENTITY_MISMATCH",
  "PORTAL_SIGNATURE_NOT_PENDING", "PORTAL_NOTIFICATION_CHANNELS_UNVERIFIED", "PORTAL_PHONE_INVALID", "PORTAL_EMAIL_INVALID",
]);
const SELECT_PROCESS = `SELECT "draftId","draftFolio","creditoId","processUuid","status",
  "requestPayload","signaturesPayload","completedAt","supersededAt",
  (COALESCE("signedDocumentBase64",'') <> '') AS "hasSignedDocument",
  (COALESCE("lastError",'') <> '') AS "hasLastError"
  FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "supersededAt" IS NULL LIMIT 2`;

class DraftProbeError extends Error {
  constructor(code, uncertain = false) {
    super(code);
    this.name = "FirmaSeguroPortalDraftProbeError";
    this.code = code;
    this.stage = "READ";
    this.uncertain = uncertain;
  }
}
const fail = code => { throw new DraftProbeError(code); };
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const text = value => typeof value === "string" ? value.trim() : "";
const integer = value => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
const field = (value, ...keys) => keys.map(key => value?.[key]).find(value => value !== undefined && value !== null);

// Same explicit pending states and normalization as approval-operations-core.ts.
// The parity test exercises the real pure guard, including terminal/unknown states.
export function isPendingDraftProbeStatus(status) {
  const normalized = String(status ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return new Set(["CREATED", "CREADO", "PENDING", "WAITING", "SENT", "IN_PROGRESS", "IN_PROCESS",
    "INITIATED", "STARTED", "AWAITING_SIGNATURE", "PENDING_SIGNATURE", "EN_PROCESO", "ENVIADO",
    "PROCESS_CREATED", "PROCESS_PENDING", "PROCESS_WAITING", "PROCESS_SENT"]).has(normalized);
}

function configuration(env) {
  const id = value => typeof value === "string" && /^[1-9]\d*$/.test(value) ? integer(Number(value)) : null;
  const draftId = id(env.FIRMASEGURO_VERIFY_DRAFT_ID), signatureId = id(env.FIRMASEGURO_VERIFY_SIGNATURE_ID);
  const identification = env.FIRMASEGURO_VERIFY_IDENTIFICATION, folio = env.FIRMASEGURO_VERIFY_FOLIO;
  if (!draftId || !signatureId || typeof identification !== "string" || !/^\d{5,20}$/.test(identification)
    || typeof folio !== "string" || !folio.trim() || folio !== folio.trim() || folio.length > 200)
    fail("PORTAL_DRAFT_CONFIG_INVALID");
  if (env.FIRMASEGURO_BROWSER_ENDPOINT !== PRIVATE_ENDPOINT || typeof env.FIRMASEGURO_BROWSER_TOKEN !== "string"
    || !/^[A-Za-z0-9_-]{32,256}$/.test(env.FIRMASEGURO_BROWSER_TOKEN)) fail("PORTAL_DRAFT_PRIVATE_BROWSER_REQUIRED");
  if (typeof env.DB_URL !== "string" || !env.DB_URL.trim()) fail("PORTAL_DRAFT_DATABASE_NOT_CONFIGURED");
  let url;
  try { url = new URL(env.DB_URL); } catch { fail("PORTAL_DRAFT_DATABASE_NOT_CONFIGURED"); }
  // pg can let URL options override Client options. Do not accept an override of the read-only session.
  const sessionOverrides = /^(?:options|query_timeout|statement_timeout|connectionTimeoutMillis|connect_timeout|default_transaction_read_only)$/i;
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname
    || [...url.searchParams.keys()].some(key => sessionOverrides.test(key)))
    fail("PORTAL_DRAFT_DATABASE_NOT_CONFIGURED");
  return { draftId, signatureId, identification, folio, connectionString: env.DB_URL };
}

// Mirrors originalSigner in firmaseguro-recipient-provider.ts without importing its API clients or Prisma.
export function frozenDraftProbeIdentity(requestPayload) {
  const request = record(requestPayload), payload = record(request?.payload ?? request);
  if (!payload) fail("PORTAL_DRAFT_FROZEN_IDENTITY_INVALID");
  const lists = [payload.signatures, payload.signers].filter(value => value !== undefined && value !== null);
  if (lists.length !== 1 || !Array.isArray(lists[0]) || lists[0].length !== 1) fail("PORTAL_DRAFT_FROZEN_IDENTITY_INVALID");
  const source = record(lists[0][0]);
  if (!source) fail("PORTAL_DRAFT_FROZEN_IDENTITY_INVALID");
  const contact = record(field(source, "contact_information", "contactInformation")) ?? source;
  const person = record(contact.person) ?? contact;
  const firstName = text(field(person, "first_name", "firstName"));
  const firstLastName = text(field(person, "first_last_name", "firstLastName"));
  const identification = text(person.identification);
  if (firstName.length < 2 || firstLastName.length < 2 || !identification
    || !integer(field(person, "identification_type_id", "identificationTypeId"))
    || !integer(field(source, "authentication_method_id", "authenticationMethodId"))) fail("PORTAL_DRAFT_FROZEN_IDENTITY_INVALID");
  return { identification, firstName, firstLastName };
}

function assertUnsigned(value, depth = 0) {
  if (depth > 3) return;
  if (Array.isArray(value)) { for (const item of value) assertUnsigned(item, depth + 1); return; }
  if (!record(value)) return;
  const flags = ["isSigned", "is_signed", "signed", "declined", "isDeclined", "is_declined"];
  const dates = ["signedAt", "signed_at", "signDate", "sign_date", "date_signed", "dateSigned", "date_signed_process",
    "completedAt", "completed_at", "date_completed", "dateCompleted", "declinedAt", "declined_at", "date_declined", "dateDeclined", "date_declined_process"];
  if (flags.some(key => value[key] === true) || dates.some(key => value[key] !== undefined && value[key] !== null
    && !(typeof value[key] === "string" && !text(value[key])))) fail("PORTAL_DRAFT_SIGNATURE_NOT_PENDING");
  for (const key of ["data", "result", "processes", "signatures"]) assertUnsigned(value[key], depth + 1);
}

function assertStoredSignatures(payload, processUuid, signatureId) {
  if (payload === null || payload === undefined) return; // Portal-observed ID is independently bound by the exact driver.
  let value = payload, uuidBound = false, signer;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(value)) {
      if (value.length !== 1 || !record(value[0])) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
      signer = value[0];
      break;
    }
    const outer = record(value);
    if (!outer || field(outer, "success", "ok", "isSuccess") === false) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
    assertUnsigned(outer);
    for (const key of ["uuid", "processUuid", "process_uuid"]) if (Object.hasOwn(outer, key)) {
      if (outer[key] !== processUuid) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
      uuidBound = true;
    }
    for (const key of ["status", "status_process", "state"]) if (Object.hasOwn(outer, key)
      && !isPendingDraftProbeStatus(outer[key])) fail("PORTAL_DRAFT_SIGNATURE_NOT_PENDING");
    value = field(outer, "signatures", "data");
  }
  if (!signer) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
  for (const key of ["processUuid", "process_uuid"]) if (Object.hasOwn(signer, key)) {
    if (signer[key] !== processUuid) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
    uuidBound = true;
  }
  const ids = [signer.signature_id, signer.signatureId, signer.id].filter(value => value !== undefined && value !== null);
  if (!uuidBound || !ids.length || ids.some(value => integer(value) !== signatureId)) fail("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID");
  assertUnsigned(signer);
  const states = ["status", "state", "signatureStatus", "signature_status"].filter(key => Object.hasOwn(signer, key));
  if (!states.length || states.some(key => !isPendingDraftProbeStatus(signer[key])))
    fail("PORTAL_DRAFT_SIGNATURE_NOT_PENDING");
}

function inputFromProcess(rows, config) {
  if (!Array.isArray(rows) || rows.length !== 1) fail("PORTAL_DRAFT_PROCESS_NOT_UNIQUE");
  const row = rows[0];
  if (!row || row.draftId !== config.draftId || row.creditoId !== null || row.supersededAt !== null
    || row.draftFolio !== config.folio || typeof row.processUuid !== "string" || !row.processUuid.trim()
    || row.processUuid !== row.processUuid.trim()) fail("PORTAL_DRAFT_PROCESS_BINDING_INVALID");
  if (row.completedAt !== null || row.hasSignedDocument !== false || row.hasLastError !== false
    || !isPendingDraftProbeStatus(row.status)) fail("PORTAL_DRAFT_SIGNATURE_NOT_PENDING");
  const identity = frozenDraftProbeIdentity(row.requestPayload);
  if (identity.identification !== config.identification) fail("PORTAL_DRAFT_IDENTITY_MISMATCH");
  assertStoredSignatures(row.signaturesPayload, row.processUuid, config.signatureId);
  return { processUuid: row.processUuid, folio: config.folio, signatureId: config.signatureId, identity };
}

function safeError(error, fallback) {
  if (error instanceof DraftProbeError) return error;
  if (error?.name === "FirmaSeguroPortalError" && error.stage === "READ" && PORTAL_CODES.has(error.code))
    return new DraftProbeError(error.code, error.uncertain === true);
  return new DraftProbeError(fallback);
}

/** Offline tests inject dependencies. The CLI defaults import only the real generated driver and pg. */
export async function verifyFirmaSeguroPortalDraft({ env = process.env, platform = process.platform,
  getuid = () => process.getuid?.(), readVersion = () => require("playwright/package.json").version,
  createClient = async options => new (await import("pg")).Client(options),
  loadDriver = () => import("./generated/firmaseguro-portal.mjs") } = {}) {
  if (platform !== "linux") fail("PORTAL_DRAFT_LINUX_REQUIRED");
  let uid;
  try { uid = getuid(); } catch { /* Stable error below. */ }
  if (!Number.isSafeInteger(uid) || uid <= 0) fail("PORTAL_DRAFT_NON_ROOT_REQUIRED");
  let version;
  try { version = readVersion(); } catch { /* Stable error below. */ }
  if (version !== "1.65.0") fail("PORTAL_DRAFT_PLAYWRIGHT_VERSION_REQUIRED");
  const config = configuration(env);
  let client, input, databaseError;
  try {
    client = await createClient({ connectionString: config.connectionString, connectionTimeoutMillis: 10_000,
      query_timeout: 15_000, options: "-c default_transaction_read_only=on -c statement_timeout=15000" });
    // pg emits connection errors outside an active query too. Consume them without raw stderr/credentials.
    client.on("error", () => { databaseError ??= new DraftProbeError("PORTAL_DRAFT_DATABASE_READ_FAILED"); });
    await client.connect();
    const readOnly = await client.query("SHOW default_transaction_read_only");
    if (readOnly?.rows?.length !== 1 || readOnly.rows[0].default_transaction_read_only !== "on") fail("PORTAL_DRAFT_DATABASE_NOT_READ_ONLY");
    const transaction = await client.query("SHOW transaction_read_only");
    if (transaction?.rows?.length !== 1 || transaction.rows[0].transaction_read_only !== "on") fail("PORTAL_DRAFT_DATABASE_NOT_READ_ONLY");
    const timeout = await client.query("SHOW statement_timeout");
    if (timeout?.rows?.length !== 1 || !["15s", "15000ms"].includes(timeout.rows[0].statement_timeout)) fail("PORTAL_DRAFT_DATABASE_TIMEOUT_UNVERIFIED");
    input = inputFromProcess((await client.query(SELECT_PROCESS, [config.draftId])).rows, config);
  } catch (error) { databaseError = safeError(error, "PORTAL_DRAFT_DATABASE_READ_FAILED"); }
  finally {
    if (client) try { await client.end(); } catch { databaseError ??= new DraftProbeError("PORTAL_DRAFT_DATABASE_CLOSE_FAILED"); }
  }
  if (databaseError) throw databaseError;
  let session, portalError;
  try {
    const driver = await loadDriver();
    if (typeof driver?.openFirmaSeguroPortalRecipient !== "function") fail("PORTAL_DRAFT_DRIVER_UNAVAILABLE");
    // Opening already verifies the exact process, signer, frozen identity and channels.
    // Never inspect again, edit, resend, or persist the contacts read from the portal.
    session = await driver.openFirmaSeguroPortalRecipient(input);
    if (typeof session?.close !== "function") fail("PORTAL_DRAFT_DRIVER_UNAVAILABLE");
  } catch (error) { portalError = safeError(error, "PORTAL_DRAFT_READ_FAILED"); }
  finally {
    if (typeof session?.close === "function") try { await session.close(); } catch { portalError ??= new DraftProbeError("PORTAL_DRAFT_PORTAL_CLOSE_FAILED"); }
  }
  if (portalError) throw portalError;
  return { code: "PORTAL_DRAFT_READ_VERIFIED", stage: "READ", uncertain: false };
}

export async function runFirmaSeguroPortalDraftProbe(options, logger = console) {
  try { logger.log(JSON.stringify(await verifyFirmaSeguroPortalDraft(options))); return 0; }
  catch (error) {
    const safe = safeError(error, "PORTAL_DRAFT_READ_FAILED");
    logger.error(JSON.stringify({ code: safe.code, stage: safe.stage, uncertain: safe.uncertain }));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runFirmaSeguroPortalDraftProbe();
