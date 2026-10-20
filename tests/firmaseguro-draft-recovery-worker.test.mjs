import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const ledgerSource = readFileSync(new URL("../lib/firmaseguro-draft-dispatch-ledger.ts", import.meta.url), "utf8");
const schema = [...ledgerSource.matchAll(/await prisma\.\$executeRawUnsafe\(`([\s\S]*?)`\);/g)]
  .map(match => match[1]).filter(sql => /FirmaSeguroDraftRecovery|firmaseguro_draft_recovery/.test(sql));
const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture(t, options = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "FirmaSeguroDraftDispatch" ("id" UUID PRIMARY KEY,"status" TEXT NOT NULL,
    "processUuid" TEXT,"documentHash" TEXT,"createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "FirmaSeguroDraftDispatchReceipt" ("dispatchId" UUID PRIMARY KEY,"processUuid" TEXT);`);
  for (const sql of schema) await db.exec(sql);
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...params) => (await connection.query(sql, params)).rows,
    $executeRawUnsafe: async (sql, ...params) => (await connection.query(sql, params)).affectedRows,
  });
  const prisma = { ...adapter(db), $transaction: operation => db.transaction(tx => operation(adapter(tx))) };
  const dispatchId = randomUUID(), processUuid = randomUUID();
  const state = { reads: 0, refreshes: 0, finalized: 0, error: null, discovery: { dispatchId, originalPdfHashes: [] }, ...options };
  await db.query(`INSERT INTO "FirmaSeguroDraftDispatch"("id","status","processUuid","documentHash") VALUES ($1,'UNCERTAIN',$2,$3)`,
    [dispatchId, options.locator ? processUuid : null, hash("original PDF")]);
  if (options.receipt) await db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt" VALUES ($1,$2)`,
    [dispatchId, options.uppercase ? processUuid.toUpperCase() : processUuid]);
  const row = async id => (await db.query(`SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`, [id])).rows[0] || null;
  const receipt = async id => (await db.query(`SELECT * FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1`, [id])).rows[0] || null;
  const finalize = async id => {
    state.finalized++;
    const proof = await receipt(id);
    assert.ok(proof);
    await db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='AWAITING_SIGNATURE',"processUuid"=$2 WHERE "id"=$1`, [id, proof.processUuid]);
    return row(id);
  };
  const dependencies = {
    "@/lib/prisma": { default: prisma },
    "@/lib/firmaseguro-draft-dispatch-ledger": {
      ensureDraftDispatchSchema: async () => {}, getDraftDispatch: row, getDraftDispatchReceipt: receipt, finalizeDraftDispatch: finalize,
    },
    "@/lib/firmaseguro-draft-reconciliation": {
      discoverDraftDispatchEvidenceFromProvider: async () => { state.reads++; if (state.error) throw state.error; return state.discovery; },
      reconcileDraftDispatchFromProviderAsSystem: async ({ dispatchId: id, processUuid: uuid }) => {
        state.reads++;
        if (state.error) throw state.error;
        assert.equal(id, dispatchId);
        await db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt" VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, uuid]);
        return finalize(id);
      },
    },
    "@/lib/firmaseguro-credit": {
      getFirmaSeguroProcessForCallback: async uuid => {
        const existing = await row(dispatchId);
        assert.equal(uuid, existing.processUuid, "preserve uppercase legacy provider identifiers for local lookup");
        return { processUuid: uuid };
      },
      refreshFirmaSeguroProcess: async process => { state.refreshes++; return process; },
    },
    "@/lib/firmaseguro-draft-correction-complete": { recordVerifiedDraftCorrectionReissues: async () => {} },
  };
  const load = () => loadReissueModule("lib/firmaseguro-draft-recovery.ts", dependencies, { setTimeout, clearTimeout });
  return { db, dispatchId, processUuid, state, load, service: load(),
    input: (patch = {}) => ({ processUuid, dispatchId, payloadSha256: hash("callback"), ...patch }),
    jobs: async () => (await db.query(`SELECT * FROM "FirmaSeguroDraftRecovery"`)).rows,
    due: async () => db.query(`UPDATE "FirmaSeguroDraftRecovery" SET "nextAttemptAt"=CURRENT_TIMESTAMP-INTERVAL '1 second'`),
  };
}

test("504 without receipt recovers the same provider UUID through durable callback proof; restart never sends", async t => {
  const f = await fixture(t);
  const queued = await f.service.enqueueDraftSignatureRecovery(f.input());
  assert.equal((await f.service.enqueueDraftSignatureRecovery(f.input())).id, queued.id);
  const result = await f.load().runDraftSignatureRecovery();
  assert.equal(result.recovered, 1);
  assert.equal((await f.jobs())[0].status, "RECOVERED");
  assert.equal(f.state.reads, 1);
  assert.equal((await f.service.runDraftSignatureRecovery()).selected, 0);
  assert.equal(f.state.finalized, 1);
});

test("durable receipts finalize first without provider verification, preserving uppercase identifiers", async t => {
  const f = await fixture(t, { receipt: true, uppercase: true });
  assert.equal((await f.service.runDraftSignatureRecovery()).recovered, 1);
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.refreshes, 1);
  assert.equal((await f.service.runDraftSignatureRecovery()).selected, 0);
});

test("unknown callback correlation is discovered from authenticated provider evidence, including exact original PDF", async t => {
  const f = await fixture(t, { discovery: { dispatchId: null, originalPdfHashes: [hash("original PDF")] } });
  await f.service.enqueueDraftSignatureRecovery(f.input({ dispatchId: null }));
  assert.equal((await f.service.runDraftSignatureRecovery()).recovered, 1);
  assert.equal(f.state.reads, 2);
  assert.equal((await f.jobs())[0].resolvedDispatchId, f.dispatchId);
});

test("provider unavailable backs off and retains no error payload, token, body or secret", async t => {
  const f = await fixture(t, { locator: true, error: Object.assign(new Error("secret customer body"), { code: "DRAFT_DISPATCH_RECONCILIATION_PROVIDER_UNAVAILABLE" }) });
  assert.equal((await f.service.runDraftSignatureRecovery()).deferred, 1);
  assert.equal((await f.service.runDraftSignatureRecovery()).selected, 0);
  const [job] = await f.jobs();
  assert.equal(job.lastErrorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(job).includes("secret customer"), false);
  f.state.error = null;
  await f.due();
  assert.equal((await f.service.runDraftSignatureRecovery()).recovered, 1);
});

test("mismatched evidence cannot be woken by a fresh callback and never finalizes", async t => {
  const f = await fixture(t, { error: Object.assign(new Error("private"), { code: "DRAFT_DISPATCH_RECONCILIATION_CONFLICT" }) });
  await f.service.enqueueDraftSignatureRecovery(f.input());
  assert.equal((await f.service.runDraftSignatureRecovery()).needsReview, 1);
  await f.service.enqueueDraftSignatureRecovery(f.input({ payloadSha256: hash("new callback") }));
  assert.equal((await f.service.runDraftSignatureRecovery()).selected, 0);
  assert.equal(f.state.finalized, 0);
});

test("a newly persisted receipt wakes a deferred callback immediately and takes precedence", async t => {
  const f = await fixture(t, { error: Object.assign(new Error("offline"), { code: "DRAFT_DISPATCH_RECONCILIATION_PROVIDER_UNAVAILABLE" }) });
  await f.service.enqueueDraftSignatureRecovery(f.input());
  assert.equal((await f.service.runDraftSignatureRecovery()).deferred, 1);
  await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt" VALUES ($1,$2)`, [f.dispatchId, f.processUuid]);
  f.state.error = null;
  assert.equal((await f.service.runDraftSignatureRecovery()).recovered, 1);
  assert.equal(f.state.reads, 1, "the new receipt is finalized without another provider verification");
  assert.equal((await f.jobs())[0].receiptObserved, true);
});

test("a fresh callback wakes exhausted transient reads; original evidence and audit are immutable", async t => {
  const f = await fixture(t, { error: Object.assign(new Error("offline"), { code: "DRAFT_DISPATCH_RECONCILIATION_PROVIDER_UNAVAILABLE" }) });
  await f.service.enqueueDraftSignatureRecovery(f.input());
  await f.db.query(`UPDATE "FirmaSeguroDraftRecovery" SET "attempts"=11`);
  assert.equal((await f.service.runDraftSignatureRecovery()).needsReview, 1);
  f.state.error = null;
  await f.service.enqueueDraftSignatureRecovery(f.input({ payloadSha256: hash("completed callback") }));
  assert.equal((await f.service.runDraftSignatureRecovery()).recovered, 1);
  assert.equal((await f.jobs())[0].payloadSha256, hash("callback"));
  await assert.rejects(f.db.query(`DELETE FROM "FirmaSeguroDraftRecoveryEvent"`), /DRAFT_RECOVERY_EVENT_IMMUTABLE/);
  await assert.rejects(f.db.query(`DELETE FROM "FirmaSeguroDraftRecovery"`), /DRAFT_RECOVERY_IMMUTABLE/);
});

test("leases survive process restart and concurrent workers cannot both claim an active job", async t => {
  const f = await fixture(t);
  await f.service.enqueueDraftSignatureRecovery(f.input());
  await f.db.query(`UPDATE "FirmaSeguroDraftRecovery" SET "status"='PROCESSING',"leaseToken"=$1,"leaseUntil"=CURRENT_TIMESTAMP+INTERVAL '1 hour'`, [randomUUID()]);
  assert.equal((await f.load().runDraftSignatureRecovery()).selected, 0);
  await f.db.query(`UPDATE "FirmaSeguroDraftRecovery" SET "leaseUntil"=CURRENT_TIMESTAMP-INTERVAL '1 second'`);
  const results = await Promise.all([f.load().runDraftSignatureRecovery(), f.load().runDraftSignatureRecovery()]);
  assert.equal(results.reduce((sum, value) => sum + value.selected, 0), 1);
  assert.equal(f.state.finalized, 1);
});

test("a dispatch with no provider locator stays protected and produces no speculative requests", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.runDraftSignatureRecovery()).selected, 0);
  assert.equal(f.state.reads, 0);
  assert.equal((await f.db.query(`SELECT "status" FROM "FirmaSeguroDraftDispatch"`)).rows[0].status, "UNCERTAIN");
});

test("recovery PDF reads use remaining cumulative budget and a single authoritative UUID; defaults are preserved", async () => {
  const source = readFileSync(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("export async function refreshFirmaSeguroProcess("),
    source.indexOf("export async function getLatestFirmaSeguroProcessForCredit(")).replace(/^export /gm, "");
  async function run(options, advance) {
    let clock = 0;
    const calls = [];
    const process = { processUuid: randomUUID(), draftId: 81, creditoId: null, status: "COMPLETED", signedDocumentBase64: null };
    class Clock extends Date { static now() { return clock; } }
    const documents = async (uuid, _token, settings) => {
      calls.push({ uuid, timeoutMs: settings?.timeoutMs });
      clock += Math.min(advance, settings?.timeoutMs || advance);
      return {};
    };
    const refresh = runInNewContext(stripTypeScriptTypes(code) + "\nrefreshFirmaSeguroProcess;", {
      Buffer, Date: Clock,
      runWithFirmaSeguroAuth: async callback => ({ result: await callback("fixture-token") }),
      firmaSeguroGetProcessStatus: async () => ({ status: "COMPLETED" }),
      firmaSeguroGetSignaturesStatus: async () => ({ status: "COMPLETED" }),
      extractFirmaSeguroStatus: payload => payload?.status,
      isFirmaSeguroCompletedStatus: value => value === "COMPLETED",
      collectFirmaSeguroUuidCandidates: () => [randomUUID(), randomUUID()],
      firmaSeguroGetDocumentsByUuid: documents,
      firmaSeguroGetAuraQuanticDocumentByUuid: documents,
      firmaSeguroGetDocumentByUuid: documents,
      extractFirmaSeguroSignedDocument: () => ({ base64: "", fileName: "", url: "" }),
      summarizeFirmaSeguroDocumentPayload: () => ({}),
      summarizeFirmaSeguroDocumentAttempts: () => "",
      redactBase64Payload: value => value,
      isFirmaSeguroUnauthorizedError: () => false,
      updateFirmaSeguroProcess: async (_uuid, patch) => ({ ...process, ...patch }),
    });
    const result = await refresh(process, options);
    return { calls, result, process };
  }
  const bounded = await run({ providerTimeoutMs: 10, documentReadBudgetMs: 5, maxDocumentCandidates: 1 }, 4);
  assert.deepEqual(bounded.calls.map(call => call.timeoutMs), [5, 1]);
  assert.ok(bounded.calls.every(call => call.uuid === bounded.process.processUuid));
  assert.ok(bounded.result.lastError, "unavailable PDF stays eligible for a later read-only recovery");
  const defaultReads = await run({}, 0);
  assert.equal(defaultReads.calls.length, 15, "existing callers retain all document candidates and endpoint fallbacks");
});
