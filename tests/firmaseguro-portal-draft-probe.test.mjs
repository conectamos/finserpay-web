import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { frozenDraftProbeIdentity, isPendingDraftProbeStatus, runFirmaSeguroPortalDraftProbe,
  verifyFirmaSeguroPortalDraft } from "../scripts/verify-firmaseguro-portal-draft.mjs";

const UUID = "11111111-2222-4333-8444-555555555555";
const ENV = {
  FIRMASEGURO_VERIFY_DRAFT_ID: "41", FIRMASEGURO_VERIFY_SIGNATURE_ID: "73",
  FIRMASEGURO_VERIFY_IDENTIFICATION: "00123456", FIRMASEGURO_VERIFY_FOLIO: "FC-SYNTHETIC-ONLY",
  FIRMASEGURO_BROWSER_ENDPOINT: "ws://firma-portal-browser.railway.internal:3010/connect",
  FIRMASEGURO_BROWSER_TOKEN: "synthetic_abcdefghijklmnopqrstuvwxyz012345",
  DB_URL: "postgresql://synthetic:private-value@database.invalid/fixture",
};
const request = () => ({ payload: { signatures: [{ authentication_method_id: 2, contact_information: {
  identification: ENV.FIRMASEGURO_VERIFY_IDENTIFICATION, identification_type_id: 1,
  first_name: "Synthetic", first_last_name: "Fixture", email: "private@example.invalid", mobile_number: "3000000000",
} }] } });
const row = () => ({ draftId: 41, draftFolio: ENV.FIRMASEGURO_VERIFY_FOLIO, creditoId: null, processUuid: UUID,
  status: "CREATED", requestPayload: request(), signaturesPayload: null, completedAt: null, supersededAt: null,
  hasSignedDocument: false, hasLastError: false });
const signatures = () => ({ uuid: UUID, status_process: "CREATED", signatures: [{ id: 73, status: "PENDING", date_signed: "" }] });

function fixture(overrides = {}) {
  const state = { created: 0, connected: 0, queries: [], ended: 0, loaded: 0, opened: [], closed: 0,
    inspected: 0, edited: 0, resent: 0, logs: [], errors: [] };
  const options = {
    env: { ...ENV, ...overrides.env }, platform: overrides.platform ?? "linux", getuid: overrides.getuid ?? (() => 1000),
    readVersion: () => overrides.version ?? "1.65.0",
    createClient: async config => {
      state.created++;
      state.config = config;
      if (overrides.createError) throw overrides.createError;
      return {
        on: (event, listener) => { assert.equal(event, "error"); state.databaseErrorListener = listener; },
        connect: async () => { state.connected++; if (overrides.connectError) throw overrides.connectError; },
        query: async (sql, params) => {
          state.queries.push({ sql, params });
          if (overrides.idleError) state.databaseErrorListener(overrides.idleError);
          if (overrides.queryError) throw overrides.queryError;
          if (sql === "SHOW default_transaction_read_only") return { rows: [{ default_transaction_read_only: overrides.readOnly ?? "on" }] };
          if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: overrides.transactionReadOnly ?? "on" }] };
          if (sql === "SHOW statement_timeout") return { rows: [{ statement_timeout: overrides.timeout ?? "15s" }] };
          assert.match(sql, /^SELECT /);
          return { rows: overrides.rows ?? [row()] };
        },
        end: async () => { state.ended++; if (overrides.endError) throw overrides.endError; },
      };
    },
    loadDriver: async () => {
      state.loaded++;
      assert.equal(state.ended, 1, "close the database before opening the portal");
      if (overrides.loadError) throw overrides.loadError;
      if (overrides.driver) return overrides.driver;
      return { openFirmaSeguroPortalRecipient: async input => {
        state.opened.push(input);
        if (overrides.openError) throw overrides.openError;
        return {
          inspect: async () => { state.inspected++; assert.fail("no extra inspect"); },
          edit: async () => { state.edited++; assert.fail("no edit"); },
          resend: async () => { state.resent++; assert.fail("no resend"); },
          close: async () => { state.closed++; if (overrides.closeError) throw overrides.closeError; },
        };
      } };
    },
  };
  const logger = { log: value => state.logs.push(value), error: value => state.errors.push(value) };
  return { options, state, logger };
}

function code(expected) {
  return error => error.code === expected && error.message === expected && error.stage === "READ" && error.uncertain === false;
}

test("import is inert and Linux/non-root/version gates precede connections", async () => {
  for (const [overrides, expected] of [
    [{ platform: "win32" }, "PORTAL_DRAFT_LINUX_REQUIRED"], [{ platform: "darwin" }, "PORTAL_DRAFT_LINUX_REQUIRED"],
    [{ getuid: () => 0 }, "PORTAL_DRAFT_NON_ROOT_REQUIRED"], [{ getuid: () => undefined }, "PORTAL_DRAFT_NON_ROOT_REQUIRED"],
    [{ getuid: () => { throw new Error("private operating system error"); } }, "PORTAL_DRAFT_NON_ROOT_REQUIRED"],
    [{ version: "1.64.0" }, "PORTAL_DRAFT_PLAYWRIGHT_VERSION_REQUIRED"],
  ]) {
    const f = fixture(overrides);
    assert.equal(f.state.created, 0);
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code(expected));
    assert.equal(f.state.created, 0);
    assert.equal(f.state.loaded, 0);
  }
});

test("configuration binds exact IDs, folio, document and private transport before reading", async () => {
  for (const env of [
    { FIRMASEGURO_VERIFY_DRAFT_ID: "41 OR 1=1" }, { FIRMASEGURO_VERIFY_DRAFT_ID: "0" },
    { FIRMASEGURO_VERIFY_SIGNATURE_ID: "-73" }, { FIRMASEGURO_VERIFY_SIGNATURE_ID: "2147483648" },
    { FIRMASEGURO_VERIFY_IDENTIFICATION: "CC00123456" }, { FIRMASEGURO_VERIFY_FOLIO: " " },
    { FIRMASEGURO_VERIFY_FOLIO: " FC-SYNTHETIC-ONLY" },
  ]) {
    const f = fixture({ env });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_CONFIG_INVALID"));
    assert.equal(f.state.created, 0);
  }
  for (const env of [{ FIRMASEGURO_BROWSER_TOKEN: "" }, { FIRMASEGURO_BROWSER_ENDPOINT: "" },
    { FIRMASEGURO_BROWSER_ENDPOINT: ENV.FIRMASEGURO_BROWSER_ENDPOINT + "?token=private" },
    { FIRMASEGURO_BROWSER_ENDPOINT: "ws://attacker.invalid/connect" }]) {
    const f = fixture({ env });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_PRIVATE_BROWSER_REQUIRED"));
    assert.equal(f.state.created, 0);
  }
  for (const DB_URL of ["", "not a URL", "https://database.invalid", ENV.DB_URL + "?options=-c%20default_transaction_read_only=off",
    ENV.DB_URL + "?query_timeout=300000", ENV.DB_URL + "?connectionTimeoutMillis=300000", ENV.DB_URL + "?statement_timeout=0"]) {
    const f = fixture({ env: { DB_URL } });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_DATABASE_NOT_CONFIGURED"));
    assert.equal(f.state.created, 0);
  }
});

test("only one parameterized bounded SELECT follows verified read-only session settings", async () => {
  const f = fixture();
  assert.deepEqual(await verifyFirmaSeguroPortalDraft(f.options), { code: "PORTAL_DRAFT_READ_VERIFIED", stage: "READ", uncertain: false });
  assert.equal(f.state.config.options, "-c default_transaction_read_only=on -c statement_timeout=15000");
  assert.equal(f.state.config.query_timeout, 15000);
  assert.deepEqual(f.state.queries.slice(0, 3).map(q => q.sql), ["SHOW default_transaction_read_only", "SHOW transaction_read_only", "SHOW statement_timeout"]);
  assert.equal(f.state.queries.length, 4);
  assert.match(f.state.queries[3].sql, /WHERE "draftId"=\$1 AND "supersededAt" IS NULL LIMIT 2$/);
  assert.deepEqual(f.state.queries[3].params, [41]);
  assert.doesNotMatch(f.state.queries[3].sql, /\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|FOR UPDATE)\b/);
  assert.deepEqual(f.state.opened, [{ processUuid: UUID, folio: ENV.FIRMASEGURO_VERIFY_FOLIO, signatureId: 73,
    identity: { identification: ENV.FIRMASEGURO_VERIFY_IDENTIFICATION, firstName: "Synthetic", firstLastName: "Fixture" } }]);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.inspected + f.state.edited + f.state.resent, 0);
});

test("unverified read-only settings and timeout stop before SELECT and still close", async () => {
  for (const [overrides, expected, queries] of [
    [{ readOnly: "off" }, "PORTAL_DRAFT_DATABASE_NOT_READ_ONLY", 1],
    [{ transactionReadOnly: "off" }, "PORTAL_DRAFT_DATABASE_NOT_READ_ONLY", 2],
    [{ timeout: "0" }, "PORTAL_DRAFT_DATABASE_TIMEOUT_UNVERIFIED", 3],
  ]) {
    const f = fixture(overrides);
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code(expected));
    assert.equal(f.state.queries.length, queries);
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.loaded, 0);
  }
});

test("zero or multiple active rows are rejected without opening the portal", async () => {
  for (const rows of [[], [row(), row()]]) {
    const f = fixture({ rows });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_PROCESS_NOT_UNIQUE"));
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.loaded, 0);
  }
});

test("the returned process must still bind exact draft, folio and a nonempty UUID", async () => {
  for (const changes of [{ draftId: 42 }, { creditoId: 5 }, { supersededAt: "synthetic" },
    { draftFolio: "OTHER" }, { processUuid: "" }, { processUuid: " " }, { processUuid: " " + UUID }]) {
    const f = fixture({ rows: [{ ...row(), ...changes }] });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_PROCESS_BINDING_INVALID"));
    assert.equal(f.state.loaded, 0);
  }
});

test("completed, signed, errored, terminal or unknown processes fail closed", async () => {
  for (const changes of [{ completedAt: "synthetic" }, { hasSignedDocument: true }, { hasLastError: true },
    { hasSignedDocument: undefined }, { status: "COMPLETED" }, { status: "REJECTED" }, { status: "UNKNOWN" }]) {
    const f = fixture({ rows: [{ ...row(), ...changes }] });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_SIGNATURE_NOT_PENDING"));
    assert.equal(f.state.loaded, 0);
  }
});

test("frozen identity must match the exact configured document without removing leading zeros", async () => {
  const f = fixture({ env: { FIRMASEGURO_VERIFY_IDENTIFICATION: "123456" } });
  await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_IDENTITY_MISMATCH"));
  assert.equal(f.state.loaded, 0);
  for (const payload of [null, {}, { signatures: [] }, { signatures: [{}, {}] },
    { signatures: [request().payload.signatures[0]], signers: [request().payload.signatures[0]] }]) {
    const other = fixture({ rows: [{ ...row(), requestPayload: payload }] });
    await assert.rejects(verifyFirmaSeguroPortalDraft(other.options), code("PORTAL_DRAFT_FROZEN_IDENTITY_INVALID"));
    assert.equal(other.state.loaded, 0);
  }
});

test("available stored signatures must bind the same UUID and unique exact numeric signer ID", async () => {
  const good = fixture({ rows: [{ ...row(), signaturesPayload: signatures() }] });
  await verifyFirmaSeguroPortalDraft(good.options);
  assert.equal(good.state.opened.length, 1);
  const mismatches = [
    {}, { ...signatures(), uuid: "different" }, { signatures: signatures().signatures },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], id: 74 }] },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], id: "73" }] },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], signature_id: 74 }] },
    { ...signatures(), signatures: [...signatures().signatures, ...signatures().signatures] },
    { ...signatures(), process_uuid: "different" },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], processUuid: "different" }] },
  ];
  for (const payload of mismatches) {
    const f = fixture({ rows: [{ ...row(), signaturesPayload: payload }] });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_SIGNATURE_BINDING_INVALID"));
    assert.equal(f.state.loaded, 0);
  }
});

test("signed or declined evidence in stored metadata prevents portal access", async () => {
  for (const payload of [
    { ...signatures(), status_process: "SIGNED" }, { ...signatures(), completedAt: "synthetic" },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], date_signed: "synthetic" }] },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], declined: true }] },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], status: "UNKNOWN" }] },
    { ...signatures(), signatures: [{ ...signatures().signatures[0], state: "SIGNED" }] },
    { ...signatures(), result: { completedAt: "synthetic" } },
  ]) {
    const f = fixture({ rows: [{ ...row(), signaturesPayload: payload }] });
    await assert.rejects(verifyFirmaSeguroPortalDraft(f.options), code("PORTAL_DRAFT_SIGNATURE_NOT_PENDING"));
    assert.equal(f.state.loaded, 0);
  }
});

test("DB failures are sanitized, closed once, and never retried", async () => {
  for (const key of ["connectError", "queryError", "endError", "idleError"]) {
    const f = fixture({ [key]: new Error("password=private person=synthetic URL=private") });
    assert.equal(await runFirmaSeguroPortalDraftProbe(f.options, f.logger), 1);
    assert.equal(f.state.created, 1);
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.loaded, 0);
    assert.doesNotMatch(f.state.errors.join(""), /password|person|URL|private|synthetic/);
    assert.equal(f.state.errors.length, 1);
  }
});

test("portal errors and closure produce only fixed code/stage/uncertain, without data or retry", async () => {
  for (const overrides of [{ loadError: new Error("secret path") }, { driver: {} },
    { openError: new Error("secret customer") }, { closeError: new Error("secret token") },
    { openError: { name: "FirmaSeguroPortalError", code: "PORTAL_IDENTITY_MISMATCH", stage: "READ", uncertain: false, message: "secret identity" } },
    { openError: { name: "FirmaSeguroPortalError", code: "SECRET_PRIVATE_VALUE", stage: "READ", uncertain: true } }]) {
    const f = fixture(overrides);
    assert.equal(await runFirmaSeguroPortalDraftProbe(f.options, f.logger), 1);
    assert.equal(f.state.loaded, 1);
    assert.equal(f.state.errors.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(f.state.errors[0])).sort(), ["code", "stage", "uncertain"]);
    assert.doesNotMatch(f.state.errors[0], /secret|customer|identity|token|path|PRIVATE_VALUE/);
    assert.equal(f.state.inspected + f.state.edited + f.state.resent, 0);
    if (overrides.closeError) assert.equal(f.state.closed, 1);
  }
});

test("CLI runner emits one safe success after closure, with no contacts, IDs, URL or environment", async () => {
  const f = fixture();
  assert.equal(await runFirmaSeguroPortalDraftProbe(f.options, f.logger), 0);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(f.state.logs.map(JSON.parse), [{ code: "PORTAL_DRAFT_READ_VERIFIED", stage: "READ", uncertain: false }]);
  assert.deepEqual(f.state.errors, []);
});

function compilePure(source, imports = {}) {
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  runInNewContext(result.outputText, { exports, require: name => {
    if (name === "server-only") return {};
    assert.ok(Object.hasOwn(imports, name), "unexpected dependency: " + name);
    return imports[name];
  } });
  return exports;
}

test("pending predicate matches the actual pure core across explicit and unrecognized states", async () => {
  const core = compilePure(await readFile(new URL("../lib/approval-operations-core.ts", import.meta.url), "utf8"));
  for (const status of [null, undefined, "", "CREATED", "CREADO", "PENDING", "WAITING", "SENT", "IN_PROGRESS", "IN_PROCESS",
    "INITIATED", "STARTED", "AWAITING_SIGNATURE", "PENDING_SIGNATURE", "EN_PROCESO", "ENVIADO", "PROCESS_CREATED",
    "PROCESS_PENDING", "PROCESS_WAITING", "PROCESS_SENT", " en próceso ", "Completed", "APPROVED", "REJECTED", "NOT_SIGNED", "UNKNOWN"])
    assert.equal(isPendingDraftProbeStatus(status), core.isVerifiedPendingSignatureStatus(status));
});

test("frozen identity matches the actual provider reader for supported layouts and invalid metadata", async () => {
  const provider = compilePure(await readFile(new URL("../lib/firmaseguro-recipient-provider.ts", import.meta.url), "utf8"), {
    "@/lib/firmaseguro": {}, "@/lib/approval-operations-core": { isVerifiedPendingSignatureStatus: isPendingDraftProbeStatus },
  });
  const signer = request().payload.signatures[0];
  const layouts = [request(), request().payload, { signers: [signer] },
    { signatures: [{ authenticationMethodId: 2, contactInformation: { person: { identification: "00123456", identificationTypeId: 1,
      firstName: "Synthetic", firstLastName: "Fixture" } } }] }];
  for (const payload of layouts) assert.deepEqual(frozenDraftProbeIdentity(payload),
    JSON.parse(JSON.stringify(provider.frozenFirmaSeguroRecipientIdentity({ requestPayload: payload }))));
  for (const payload of [{}, { signatures: [] }, { signatures: [{ ...signer, authentication_method_id: "2" }] },
    { signatures: [{ ...signer, contact_information: { ...signer.contact_information, first_name: "X" } }] }]) {
    assert.throws(() => frozenDraftProbeIdentity(payload));
    assert.throws(() => provider.frozenFirmaSeguroRecipientIdentity({ requestPayload: payload }));
  }
});
