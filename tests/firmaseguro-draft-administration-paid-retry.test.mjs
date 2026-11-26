import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";

const schema = JSON.parse(readFileSync(new URL("../lib/firmaseguro-draft-administration-schema.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../lib/firmaseguro-draft-dispatch-ledger.ts", import.meta.url), "utf8");
const baseSchema = [...source.matchAll(/await prisma\.\$executeRawUnsafe\(`([\s\S]*?)`\);/g)].map(match => match[1]);
const reason = "El administrador revisó cliente y folio en el portal y autoriza otro envío con posible nuevo cobro; el resultado previo sigue incierto.";
const actor = { id: 8, nombre: "Administrador autorizado" };
class DraftDispatchError extends Error { constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; } }

async function fixture(t, options = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Rol"("id" INTEGER PRIMARY KEY,"nombre" TEXT);
    CREATE TABLE "Aliado"("id" INTEGER PRIMARY KEY,"codigo" TEXT,"activo" BOOLEAN DEFAULT true);
    CREATE TABLE "Sede"("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER,"activa" BOOLEAN DEFAULT true);
    CREATE TABLE "Usuario"("id" INTEGER PRIMARY KEY,"nombre" TEXT,"rolId" INTEGER,"sedeId" INTEGER,"activo" BOOLEAN DEFAULT true);
    CREATE TABLE "CreditoBorrador"("id" INTEGER PRIMARY KEY,"estado" TEXT DEFAULT 'ABIERTO',"creditoId" INTEGER,
      "currentStep" INTEGER DEFAULT 3,"payload" JSONB NOT NULL,"closedAt" TIMESTAMP,"closedReason" TEXT,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP+INTERVAL '15 days');
    CREATE TABLE "FirmaSeguroProcess"("processUuid" TEXT PRIMARY KEY,"draftId" INTEGER,"creditoId" INTEGER,
      "draftFolio" TEXT,"draftPayload" JSONB,"supersededAt" TIMESTAMP,"status" TEXT);
    CREATE TABLE "VeriffIdentityValidation"("id" INTEGER PRIMARY KEY,"draftId" INTEGER,"creditoId" INTEGER,"status" TEXT,"clienteDocumento" TEXT);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'ASESOR');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true),(2,'ALLY',true);
    INSERT INTO "Sede" VALUES(1,1,true),(2,2,true);
    INSERT INTO "Usuario" VALUES(7,'Administrador anterior',1,1,true),(8,'Administrador autorizado',1,1,true),(9,'Asesor original',2,2,true);`);
  for (const statement of baseSchema) await db.exec(statement);
  const observed = { sql: [], schemaSetups: 0, balances: 0, balanceError: null, failReservation: false };
  function adapter(connection) {
    return {
      $queryRawUnsafe: async (sql, ...params) => { observed.sql.push(sql); return (await connection.query(sql, params)).rows; },
      $executeRawUnsafe: async (sql, ...params) => {
        observed.sql.push(sql);
        if (observed.failReservation && /^\s*INSERT INTO "FirmaSeguroDraftDispatch"\s/.test(sql))
          return connection.query("SELECT 'injected reservation failure'::integer");
        return (await connection.query(sql, params)).affectedRows;
      },
    };
  }
  let queue = Promise.resolve();
  const prisma = { ...adapter(db), $transaction: operation => {
    const result = queue.then(() => db.transaction(tx => operation(adapter(tx)))); queue = result.catch(() => {}); return result;
  } };
  const frozen = createReissueFixture(81), firstId = randomUUID();
  const pdf = Buffer.from("%PDF-1.7\nFrozen exact paid retry contract\n%%EOF");
  const payload = { clienteDocumento: "100000001", clienteTelefono: "3000000001", veriffValidationId: 91, firmaSeguroDraftFolio: frozen.credit.folio };
  const dates = { dateKey: frozen.seal.snapshot.fechaPrimerPago };
  const common = {
    "@/lib/prisma": { default: prisma },
    "@/lib/firmaseguro-draft-dispatch-ledger": { DraftDispatchError, ensureDraftDispatchSchema: async () => {} },
    "@/lib/firmaseguro-storage": { lockSolicitudOperationMutation: async (database, id) => { await database.$queryRawUnsafe("SELECT pg_advisory_xact_lock(1179865177,$1)", id); } },
    "@/lib/credit-amortization-contract": seals,
    "@/lib/credit-factory": { resolveActivationFirstPaymentDate: () => dates },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true }) },
    "@/lib/veriff": { isVeriffRequired: () => true },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {}, isVeriffApproved: row => row.status === "approved" },
  };
  const admin = loadReissueModule("lib/firmaseguro-draft-administration.ts", {
    ...common, "@/lib/firmaseguro-draft-administration-schema.json": { default: schema },
  });
  const paid = loadReissueModule("lib/firmaseguro-draft-paid-retry.ts", { ...common,
    "@/lib/firmaseguro-draft-administration": { ensureDraftAdministrativeRecoverySchema: async () => { observed.schemaSetups++; await admin.ensureDraftAdministrativeRecoverySchema(); } },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: ally => ally === "FINSERPAY" },
    "@/lib/firmaseguro": {
      getFirmaSeguroConfig: () => ({ nit: "900000001", balanceTypeId: 2, signatureMethodId: 2 }),
      firmaSeguroSignIn: async () => ({ token: "synthetic-token" }),
      assertFirmaSeguroDispatchBalance: async token => {
        observed.balances++; assert.equal(token, "synthetic-token"); if (observed.balanceError) throw observed.balanceError;
      },
    },
  }, { Error });
  await db.query('INSERT INTO "CreditoBorrador"("id","payload") VALUES(81,$1)', [payload]);
  await db.exec(`INSERT INTO "VeriffIdentityValidation" VALUES(91,81,NULL,'approved','100000001')`);
  await db.query(`INSERT INTO "FirmaSeguroDraftDispatch"
    ("id","draftId","actorUserId","actorName","reason","status","draftFolio","sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
    VALUES($1,81,9,'Asesor original','Envío del contrato de la solicitud a FirmaSeguro','PREPARING',$2,$3,$3,$4,$5,$6,$7)`,
  [firstId, frozen.credit.folio, payload, { ...payload, financialTermsSeal: frozen.seal }, frozen.credit, pdf.toString("base64"), createHash("sha256").update(pdf).digest("hex")]);
  await db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='DISPATCHING',"dispatchedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [firstId]);
  await db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='UNCERTAIN',"lastError"=$2 WHERE "id"=$1`, [firstId, options.firstError ?? paid.PAID_DRAFT_RETRY_BALANCE_ERROR]);
  const recovery = await admin.recoverUncertainDraftDispatch({ draftId: 81, dispatchId: firstId,
    actor: { id: 7, nombre: "Administrador anterior" }, reason, providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true });
  const leafId = recovery.replacementDispatchId;
  await db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='DISPATCHING',"dispatchedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [leafId]);
  await db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='UNCERTAIN',"lastError"=$2 WHERE "id"=$1`, [leafId, options.leafError ?? paid.PAID_DRAFT_RETRY_BALANCE_ERROR]);
  observed.sql = []; observed.schemaSetups = 0;
  const input = patch => ({ draftId: 81, dispatchId: leafId, actor, reason,
    providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true, newChargeAccepted: true, ...patch });
  const rows = async () => (await db.query('SELECT * FROM "FirmaSeguroDraftDispatch" ORDER BY "createdAt","id"')).rows;
  const verify = patch => paid.verifyAuthorizedPaidDraftRetry(input(patch));
  const reserve = async patch => { const plan = await verify(patch); return paid.reserveAuthorizedPaidDraftRetry(input({ expectedFingerprint: plan.expectedFingerprint, ...patch })); };
  const audits = async () => (await db.query('SELECT * FROM "FirmaSeguroDraftPaidRetryAuthorization"')).rows;
  const rawGrant = async patch => {
    const [first, leaf] = await Promise.all([db.query('SELECT d.*,md5((to_jsonb(d)-\'status\'-\'updatedAt\')::text) AS fingerprint FROM "FirmaSeguroDraftDispatch" d WHERE "id"=$1', [firstId]),
      db.query('SELECT d.*,md5((to_jsonb(d)-\'status\'-\'updatedAt\')::text) AS fingerprint FROM "FirmaSeguroDraftDispatch" d WHERE "id"=$1', [leafId])]);
    const values = { firstId, leafId, actorId: actor.id, actorName: actor.nombre, originalFingerprint: leaf.rows[0].fingerprint,
      firstFingerprint: first.rows[0].fingerprint, ...patch };
    return db.query(`INSERT INTO "FirmaSeguroDraftPaidRetryAuthorization"
      ("originalDispatchId","replacementDispatchId","firstOriginalDispatchId","draftId","actorUserId","actorName","reason",
       "providerReviewConfirmed","remoteOutcomeUnknownAccepted","newChargeAccepted","originalFingerprint","firstOriginalFingerprint",
       "authorizationFingerprint","documentHash","sealChecksum","balancePositiveConfirmed","balanceVerifiedAt","balanceTypeId","signatureMethodId")
      VALUES($1,$2,$3,81,$4,$5,$6,true,true,true,$7,$8,$9,$10,$11,true,CURRENT_TIMESTAMP,2,2)`,
    [values.leafId, randomUUID(), values.firstId, values.actorId, values.actorName, reason, values.originalFingerprint,
      values.firstFingerprint, "a".repeat(64), leaf.rows[0].documentHash, frozen.seal.checksum]);
  };
  return { db, observed, paid, admin, input, verify, reserve, rows, audits, dates, firstId, leafId, frozen, rawGrant };
}

test("dry-run is SELECT-only and a paid authorization reserves the identical frozen contract once", async t => {
  const f = await fixture(t), before = await f.rows();
  const plan = await f.verify();
  assert.equal(plan.status, "ELIGIBLE"); assert.equal(plan.replacementDispatchId, null);
  assert.match(plan.expectedFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(f.observed.sql.every(sql => /^\s*SELECT\b/.test(sql)));
  assert.ok(f.observed.sql.every(sql => !/FOR UPDATE|FOR SHARE|pg_advisory/.test(sql)));
  assert.equal(f.observed.schemaSetups, 0); assert.equal(f.observed.balances, 1);
  assert.doesNotMatch(JSON.stringify(plan), /900000001|100000001|balance|token|documentBase64|cliente/);
  const result = await f.paid.reserveAuthorizedPaidDraftRetry(f.input({ expectedFingerprint: plan.expectedFingerprint }));
  assert.equal(result.status, "PREPARING"); assert.equal(result.idempotent, false);
  const rows = await f.rows(), original = rows.find(row => row.id === f.firstId), leaf = rows.find(row => row.id === f.leafId);
  assert.deepEqual(original, before.find(row => row.id === f.firstId)); assert.equal(leaf.status, "ABANDONED");
  for (const key of Object.keys(leaf).filter(key => !["status", "updatedAt"].includes(key)))
    assert.deepEqual(leaf[key], before.find(row => row.id === f.leafId)[key], key);
  const replacement = rows.find(row => row.id === result.replacementDispatchId);
  for (const key of ["draftFolio", "updatedPayload", "draftPayload", "frozenCredit", "documentBase64", "documentHash"])
    assert.deepEqual(replacement[key], leaf[key], key);
  assert.deepEqual(replacement.sourcePayload, leaf.updatedPayload); assert.equal(replacement.actorUserId, actor.id);
  assert.equal(replacement.processUuid, null); assert.equal(replacement.dispatchedAt, null); assert.equal(replacement.requestPayload, null);
  const [audit] = await f.audits();
  assert.equal(audit.providerOutcome, "UNKNOWN"); assert.equal(audit.newChargeAccepted, true);
  assert.equal(audit.providerReviewConfirmed, true); assert.equal(audit.remoteOutcomeUnknownAccepted, true);
  assert.equal(audit.authorizationFingerprint, plan.expectedFingerprint); assert.equal(audit.actorUserId, actor.id);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "FirmaSeguroDraftAdministrativeRecovery"')).rows[0].n, 1);
  await assert.rejects(f.db.query(`UPDATE "CreditoBorrador" SET "payload"="payload"||'{"changed":true}'::jsonb WHERE "id"=81`), /DRAFT_ADMINISTRATIVE_CONTRACT_FROZEN/);
  await assert.rejects(f.db.exec('DELETE FROM "FirmaSeguroDraftPaidRetryAuthorization"'), /DRAFT_ADMINISTRATIVE_AUDIT_IMMUTABLE/);
  await assert.rejects(f.db.exec('UPDATE "FirmaSeguroDraftPaidRetryAuthorization" SET "newChargeAccepted"=false'), /DRAFT_ADMINISTRATIVE_AUDIT_IMMUTABLE/);
});

test("concurrent grants and replay reuse one reserve; another actor, reason or fingerprint cannot adopt it", async t => {
  const f = await fixture(t), plan = await f.verify(), input = f.input({ expectedFingerprint: plan.expectedFingerprint });
  const [first, second] = await Promise.all([f.paid.reserveAuthorizedPaidDraftRetry(input), f.paid.reserveAuthorizedPaidDraftRetry(input)]);
  assert.equal(first.replacementDispatchId, second.replacementDispatchId); assert.equal((await f.rows()).length, 3); assert.equal((await f.audits()).length, 1);
  assert.equal((await f.paid.reserveAuthorizedPaidDraftRetry(input)).idempotent, true);
  for (const patch of [{ actor: { id: 7, nombre: "Administrador anterior" } }, { reason: reason + " Otro." }])
    await assert.rejects(f.verify(patch), { code: "DRAFT_PAID_RETRY_REPLAY_CONFLICT" });
  await assert.rejects(f.verify({ expectedFingerprint: "b".repeat(64) }), { code: "DRAFT_PAID_RETRY_PLAN_CHANGED" });
});

test("all three literal acknowledgements, bounded reason and a verified fingerprint are required before writes", async t => {
  const f = await fixture(t);
  for (const patch of [{ providerReviewConfirmed: false }, { remoteOutcomeUnknownAccepted: false }, { newChargeAccepted: false },
    { newChargeAccepted: "true" }, { reason: "Short" }, { reason: "x".repeat(501) }, { actor: { id: 8, nombre: "Spoofed" } }])
    await assert.rejects(f.verify(patch));
  await assert.rejects(f.paid.reserveAuthorizedPaidDraftRetry(f.input()), { code: "DRAFT_PAID_RETRY_PLAN_REQUIRED" });
  assert.equal(f.observed.schemaSetups, 0); assert.equal((await f.rows()).length, 2); assert.equal((await f.audits()).length, 0);
});

test("zero or unavailable balance forbids authorization and never abandons the uncertain attempt", async t => {
  for (const code of ["FIRMASEGURO_BALANCE_INSUFFICIENT", "FIRMASEGURO_BALANCE_UNVERIFIED"]) await t.test(code, async sub => {
    const f = await fixture(sub), plan = await f.verify(); f.observed.balanceError = Object.assign(new Error("Balance preflight failed"), { code });
    await assert.rejects(f.verify(), { code });
    await assert.rejects(f.paid.reserveAuthorizedPaidDraftRetry(f.input({ expectedFingerprint: plan.expectedFingerprint })), { code });
    assert.equal(f.observed.schemaSetups, 0); assert.equal((await f.audits()).length, 0);
    assert.equal((await f.rows()).find(row => row.id === f.leafId).status, "UNCERTAIN");
  });
});

for (const mode of ["payload", "expired", "date", "identity", "actor", "site", "locator", "process", "receipt", "recovery"]) {
  test(`changed ${mode} prevents the authorization without rewriting historical attempts`, async t => {
    const f = await fixture(t);
    if (mode === "payload") await f.db.exec(`UPDATE "CreditoBorrador" SET "payload"="payload"||'{"changed":true}'::jsonb`);
    if (mode === "expired") await f.db.exec(`UPDATE "CreditoBorrador" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '1 day'`);
    if (mode === "date") f.dates.dateKey = "2099-03-01";
    if (mode === "identity") await f.db.exec(`INSERT INTO "VeriffIdentityValidation" VALUES(92,81,NULL,'approved','100000001')`);
    if (mode === "actor") await f.db.exec(`UPDATE "Usuario" SET "activo"=false WHERE "id"=8`);
    if (mode === "site") await f.db.exec(`UPDATE "Sede" SET "activa"=false WHERE "id"=1`);
    if (mode === "locator") await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "processUuid"=$2 WHERE "id"=$1', [f.leafId, randomUUID()]);
    if (mode === "process") await f.db.query('INSERT INTO "FirmaSeguroProcess"("processUuid","draftId") VALUES($1,81)', [randomUUID()]);
    if (mode === "receipt") await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt"("dispatchId","processUuid","providerStatus","createPayload","source","actorUserId","actorName","evidence") VALUES($1,$2,'CREATED','{}','provider_reconciliation',8,'Administrador autorizado','{"kind":"provider_tag"}')`, [f.leafId, randomUUID()]);
    if (mode === "recovery") await f.db.query(`INSERT INTO "FirmaSeguroDraftRecovery"("id","dedupeKey","processUuid","dispatchId","payloadSha256","lastDeliverySha256","source") VALUES($1,$4,$2,$3,$4,$4,'CALLBACK')`, [randomUUID(), randomUUID(), f.leafId, "a".repeat(64)]);
    await assert.rejects(f.verify()); assert.equal((await f.audits()).length, 0); assert.equal((await f.rows()).length, 2);
  });
}

for (const field of ["firstError", "leafError"]) {
  test(`only the exact known balance diagnostic is eligible (${field})`, async t => {
    const f = await fixture(t, { [field]: "provider_dispatch [UNKNOWN]: provider timeout; saldo insuficiente" });
    await assert.rejects(f.verify(), { code: "DRAFT_PAID_RETRY_SOURCE_INVALID" });
    await assert.rejects(f.rawGrant(), /DRAFT_PAID_RETRY_FROZEN_SOURCE_INVALID/);
  });
}

test("SQL independently rejects forged actors, ancestry and fingerprints", async t => {
  const f = await fixture(t);
  for (const patch of [{ actorId: 9, actorName: "Asesor original" }, { actorName: "Spoofed" },
    { firstId: randomUUID() }, { originalFingerprint: "0".repeat(32) }, { firstFingerprint: "0".repeat(32) }])
    await assert.rejects(f.rawGrant(patch));
  assert.equal((await f.audits()).length, 0);
});

test("a failed reservation rolls back both the paid grant and leaf abandonment", async t => {
  const f = await fixture(t), before = await f.rows(), plan = await f.verify(); f.observed.failReservation = true;
  await assert.rejects(f.paid.reserveAuthorizedPaidDraftRetry(f.input({ expectedFingerprint: plan.expectedFingerprint })));
  assert.deepEqual(await f.rows(), before); assert.equal((await f.audits()).length, 0);
});

test("another uncertain result cannot authorize a fourth dispatch or bypass exact provider tags", async t => {
  const f = await fixture(t), result = await f.reserve();
  await f.db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='DISPATCHING',"dispatchedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [result.replacementDispatchId]);
  const receipt = (dispatchId, kind) => f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt"
    ("dispatchId","processUuid","providerStatus","createPayload","source","evidence") VALUES($1,$2,'CREATED','{}','provider_reconciliation',$3)`, [dispatchId, randomUUID(), { kind }]);
  await assert.rejects(receipt(result.replacementDispatchId, "original_pdf_sha256"), /DRAFT_ADMINISTRATIVE_EXACT_TAG_REQUIRED/);
  await assert.rejects(receipt(f.firstId, "provider_tag"), /ABANDONED_DISPATCH_RECEIPT_FORBIDDEN/);
  await assert.rejects(receipt(f.leafId, "provider_tag"), /ABANDONED_DISPATCH_RECEIPT_FORBIDDEN/);
  await f.db.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='UNCERTAIN',"lastError"=$2 WHERE "id"=$1`, [result.replacementDispatchId, f.paid.PAID_DRAFT_RETRY_BALANCE_ERROR]);
  await assert.rejects(f.verify({ dispatchId: result.replacementDispatchId }), { code: "DRAFT_PAID_RETRY_LINEAGE_INVALID" });
  await assert.rejects(f.admin.recoverUncertainDraftDispatch({ draftId: 81, dispatchId: result.replacementDispatchId,
    actor, reason, providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true }), { code: "DRAFT_ADMINISTRATIVE_EVIDENCE_CHANGED" });
  assert.equal((await f.rows()).length, 3); assert.equal((await f.audits()).length, 1);
});
