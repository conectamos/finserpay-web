import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";

// PGlite executes the production PostgreSQL statements and triggers in memory.
// It serializes transactions: the overlap tests below cover the public claim /
// replay protocol, not contention between independent PostgreSQL connections.
async function fixture(t, options = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "payload" JSONB NOT NULL,
      "estado" TEXT NOT NULL DEFAULT 'ABIERTO', "creditoId" INTEGER,
      "currentStep" INTEGER NOT NULL DEFAULT 3,
      "expiresAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "Usuario" VALUES (7);
  `);
  if (options.veriffRequired) {
    await database.exec(`
      CREATE TABLE "VeriffIdentityValidation" (
        "id" INTEGER PRIMARY KEY, "draftId" INTEGER, "creditoId" INTEGER,
        "status" TEXT, "clienteDocumento" TEXT
      );
      INSERT INTO "VeriffIdentityValidation"
        VALUES (91, 81, NULL, 'approved', '100000001');
    `);
  }
  const failures = { processInserts: 0, receiptInserts: 0 };
  function adapter(connection) {
    async function query(sql, values) {
      if (failures.processInserts > 0 && /INSERT INTO "FirmaSeguroProcess"/.test(sql)) {
        failures.processInserts -= 1;
        // An actual SQL failure aborts the materialization transaction.
        return connection.query("SELECT 'injected process write failure'::integer");
      }
      if (failures.receiptInserts > 0 && /INSERT INTO "FirmaSeguroDraftDispatchReceipt"/.test(sql)) {
        failures.receiptInserts -= 1;
        return connection.query("SELECT 'injected receipt write failure'::integer");
      }
      return connection.query(sql, values);
    }
    return {
      $queryRawUnsafe: async (sql, ...values) => (await query(sql, values)).rows,
      $executeRawUnsafe: async (sql, ...values) => (await query(sql, values)).affectedRows,
    };
  }
  const prisma = {
    ...adapter(database),
    $transaction: (work) => database.transaction((connection) => work(adapter(connection))),
  };
  const storage = loadReissueModule("lib/firmaseguro-storage.ts", {
    "@/lib/prisma": { default: prisma },
    pg: { Client: class { constructor() { throw new Error("Unexpected external database connection"); } } },
  }, { Error });
  const statuses = loadReissueModule("lib/firmaseguro-status.ts");
  const source = createReissueFixture(81);
  const operationId = randomUUID();
  const processUuid = randomUUID();
  let sends = 0;
  const requestPayload = { document: "fixture.pdf", tags: { reissue: operationId } };
  const createPayload = { uuid: processUuid, status: options.providerStatus || "CREATED", tags: { reissue: operationId } };
  const ledger = loadReissueModule("lib/firmaseguro-draft-dispatch-ledger.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/firmaseguro-storage": storage,
    "@/lib/firmaseguro-credit": {
      prepareFirmaSeguroReissue: async (_credit, document, id) => {
        assert.equal(id, operationId);
        assert.equal(document.subarray(0, 5).toString(), "%PDF-");
        return {
          requestPayload,
          sendOnce: async () => {
            sends += 1;
            await options.onSend?.({ database, operationId, processUuid });
            if (options.providerError) throw options.providerError;
            return { processUuid, status: createPayload.status, createPayload };
          },
        };
      },
    },
    "@/lib/firmaseguro": { isFirmaSeguroCompletedStatus: statuses.isFirmaSeguroSuccessfulStatus },
    "@/lib/firmaseguro-status": statuses,
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: false }) },
    "@/lib/veriff": { isVeriffRequired: () => Boolean(options.veriffRequired) },
    "@/lib/veriff-storage": {
      ensureVeriffSchema: async () => assert.ok(options.veriffRequired, "Unexpected Veriff schema request"),
      isVeriffApproved: (validation) => validation?.status === "approved",
    },
    "@/lib/credit-amortization-contract": seals,
    "@/lib/credit-factory": {
      resolveActivationFirstPaymentDate: () => ({ dateKey: source.seal.snapshot.fechaPrimerPago }),
    },
  }, { Error });
  const sourcePayload = { clienteDocumento: "100000001", fixture: "source",
    ...(options.veriffRequired ? { veriffValidationId: 91 } : {}) };
  const updatedPayload = { ...sourcePayload, fixture: "reserved", firmaSeguroContactCorrectionPending: true };
  const input = {
    id: operationId,
    draftId: 81,
    actor: { id: 7, nombre: "Operador de prueba" },
    reason: "Envío de contrato de prueba",
    expectedProcessUuid: null,
    sourcePayload,
    updatedPayload,
    draftPayload: { financialTermsSeal: source.seal },
    draftFolio: source.credit.folio,
    frozenCredit: source.credit,
    document: Buffer.from("%PDF-1.4\nContract test\n%%EOF"),
    supersedeActive: false,
  };
  await database.query('INSERT INTO "CreditoBorrador" ("id", "payload") VALUES ($1, $2::jsonb)',
    [input.draftId, JSON.stringify(sourcePayload)]);
  await ledger.ensureDraftDispatchSchema();
  await ledger.reserveDraftDispatch(input);
  const row = async () => ledger.getDraftDispatch(operationId);
  const processes = async () => (await database.query('SELECT * FROM "FirmaSeguroProcess" ORDER BY "id"')).rows;
  const receipts = async () => (await database.query('SELECT * FROM "FirmaSeguroDraftDispatchReceipt" ORDER BY "dispatchId"')).rows;
  const events = async () => (await database.query('SELECT "status" FROM "FirmaSeguroDraftDispatchEvent" WHERE "dispatchId"=$1::uuid ORDER BY "id"', [operationId])).rows.map((event) => event.status);
  const verifiedReceipt = (overrides = {}) => ledger.recordVerifiedDraftDispatchReceipt({
    dispatchId: operationId,
    processUuid,
    providerStatus: createPayload.status,
    createPayload,
    actor: input.actor,
    evidence: { operationId, processUuid, verifiedAt: "2026-10-04T00:00:00Z", providerResponse: createPayload },
    ...overrides,
  });
  return { database, ledger, input, operationId, processUuid, requestPayload, createPayload,
    failures, row, processes, receipts, events, verifiedReceipt, sends: () => sends };
}

test("PostgreSQL: reserva, ACK y repetición conservan un solo envío y sus datos JSONB", async (t) => {
  const f = await fixture(t);
  const completed = await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal(completed.status, "AWAITING_SIGNATURE");
  assert.equal(completed.processUuid, f.processUuid);
  const [process] = await f.processes();
  assert.equal(process.processUuid, f.processUuid);
  assert.equal(process.supersededByUserId, null);
  assert.equal(process.supersededAt, null);
  assert.deepEqual(process.requestPayload, f.requestPayload);
  assert.deepEqual(process.createPayload, f.createPayload);
  assert.deepEqual(process.draftPayload, JSON.parse(JSON.stringify(f.input.draftPayload)));
  const [receipt] = await f.receipts();
  assert.equal(receipt.source, "send_response");
  assert.equal(receipt.dispatchId, f.operationId);
  assert.equal(receipt.processUuid, f.processUuid);
  assert.deepEqual(receipt.createPayload, f.createPayload);
  await f.ledger.reserveDraftDispatch(f.input);
  await f.ledger.dispatchReservedDraft(f.operationId);
  await f.ledger.finalizeDraftDispatch(f.operationId);
  assert.equal(f.sends(), 1);
  assert.equal((await f.processes()).length, 1);
  assert.equal((await f.receipts()).length, 1);
  assert.deepEqual(await f.events(), ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE"]);
  const draft = (await f.database.query('SELECT "payload" FROM "CreditoBorrador" WHERE "id"=81')).rows[0];
  assert.equal(draft.payload.firmaSeguroContactCorrectionPending, undefined);
});

test("PostgreSQL: el ACK sobrevive al fallo SQL y se finaliza sin reenviar", async (t) => {
  const f = await fixture(t);
  f.failures.processInserts = 1;
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId), { code: "DRAFT_DISPATCH_PERSISTENCE_FAILED" });
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.equal((await f.processes()).length, 0);
  const [receipt] = await f.receipts();
  assert.equal(receipt.processUuid, f.processUuid);
  assert.deepEqual(receipt.createPayload, f.createPayload);
  assert.match((await f.row()).lastError, /injected process write failure/);
  const recovered = await f.ledger.finalizeDraftDispatch(f.operationId);
  assert.equal(recovered.status, "AWAITING_SIGNATURE");
  assert.equal(recovered.processUuid, f.processUuid);
  assert.equal((await f.processes()).length, 1);
  await f.ledger.finalizeDraftDispatch(f.operationId);
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal(f.sends(), 1);
  assert.deepEqual(await f.events(), ["PREPARING", "DISPATCHING", "UNCERTAIN", "AWAITING_SIGNATURE"]);
});

for (const [label, mutation] of [
  ["borrador vencido", `UPDATE "CreditoBorrador" SET "expiresAt"='2000-01-01' WHERE "id"=81`],
  ["borrador fuera del paso de firma", `UPDATE "CreditoBorrador" SET "currentStep"=2 WHERE "id"=81`],
  ["aprobación Veriff revocada", `UPDATE "VeriffIdentityValidation" SET "status"='declined' WHERE "id"=91`],
]) {
  test(`PostgreSQL: recuperación tardía con ${label} archiva el ACK sin reenviar`, async (t) => {
    const f = await fixture(t, { veriffRequired: label.includes("Veriff") });
    f.failures.processInserts = 1;
    await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId), { code: "DRAFT_DISPATCH_PERSISTENCE_FAILED" });
    const [receipt] = await f.receipts();
    assert.equal(receipt.processUuid, f.processUuid);
    assert.equal((await f.processes()).length, 0);
    await f.database.query(mutation);
    const recovered = await f.ledger.finalizeDraftDispatch(f.operationId);
    assert.equal(recovered.status, "UNCERTAIN");
    assert.equal(recovered.processUuid, f.processUuid);
    const [process] = await f.processes();
    assert.equal(process.processUuid, f.processUuid);
    assert.ok(process.supersededAt);
    assert.equal(process.supersededByUserId, 7);
    assert.deepEqual((await f.receipts())[0], receipt);
    await f.ledger.dispatchReservedDraft(f.operationId);
    await f.ledger.finalizeDraftDispatch(f.operationId);
    assert.equal((await f.row()).status, "UNCERTAIN");
    assert.equal((await f.processes()).length, 1);
    assert.equal(f.sends(), 1);
    assert.deepEqual(await f.events(), ["PREPARING", "DISPATCHING", "UNCERTAIN"]);
  });
}

test("PostgreSQL: timeout sin ACK conserva UNCERTAIN y bloquea un segundo envío", async (t) => {
  const f = await fixture(t, { providerError: new Error("Provider timeout") });
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId), { code: "DRAFT_DISPATCH_UNCERTAIN" });
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.equal((await f.receipts()).length, 0);
  await assert.rejects(f.ledger.finalizeDraftDispatch(f.operationId));
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.equal((await f.processes()).length, 0);
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: un fallo al guardar el ACK conserva su UUID para conciliación", async (t) => {
  const f = await fixture(t);
  f.failures.receiptInserts = 1;
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId), { code: "DRAFT_DISPATCH_ACK_PERSISTENCE_FAILED" });
  const failed = await f.row();
  assert.equal(failed.status, "UNCERTAIN");
  assert.equal(failed.processUuid, f.processUuid);
  assert.equal((await f.receipts()).length, 0);
  assert.equal((await f.processes()).length, 0);
  await assert.rejects(f.ledger.finalizeDraftDispatch(f.operationId), { code: "DRAFT_DISPATCH_RECEIPT_REQUIRED" });
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal(f.sends(), 1);
  await f.verifiedReceipt();
  assert.equal((await f.ledger.finalizeDraftDispatch(f.operationId)).status, "AWAITING_SIGNATURE");
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: llamadas solapadas reclaman el despacho una sola vez", async (t) => {
  let entered;
  let release;
  const sending = new Promise((resolve) => { entered = resolve; });
  const holdProvider = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { onSend: async () => { entered(); await holdProvider; } });
  const original = f.ledger.dispatchReservedDraft(f.operationId);
  const concurrentReplay = f.ledger.dispatchReservedDraft(f.operationId);
  // Attach a rejection handler while the provider promise is held, including
  // during teardown if another assertion fails before the release below.
  const settled = original.then((value) => ({ value }), (error) => ({ error }));
  const replaySettled = concurrentReplay.then((value) => ({ value }), (error) => ({ error }));
  try {
    await Promise.race([sending, original]);
    assert.equal((await concurrentReplay).status, "DISPATCHING");
    const replay = await f.ledger.dispatchReservedDraft(f.operationId);
    assert.equal(replay.status, "DISPATCHING");
    await assert.rejects(f.ledger.finalizeDraftDispatch(f.operationId));
    assert.equal(f.sends(), 1);
  } finally {
    release();
    await settled;
    await replaySettled;
  }
  assert.equal((await original).status, "AWAITING_SIGNATURE");
  await Promise.all([
    f.ledger.finalizeDraftDispatch(f.operationId),
    f.ledger.dispatchReservedDraft(f.operationId),
    f.ledger.finalizeDraftDispatch(f.operationId),
  ]);
  assert.equal(f.sends(), 1);
  assert.equal((await f.processes()).length, 1);
});

test("PostgreSQL: un borrador cambiado conserva el proceso archivado y el ACK", async (t) => {
  const f = await fixture(t, {
    onSend: ({ database }) => database.query(`UPDATE "CreditoBorrador" SET "payload"='{"changedDuringSend":true}'::jsonb WHERE "id"=81`),
  });
  const result = await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.processUuid, f.processUuid);
  const [process] = await f.processes();
  assert.ok(process.supersededAt);
  assert.equal(process.supersededByUserId, 7);
  assert.match(process.supersededReason, /cambió/);
  assert.equal((await f.receipts())[0].processUuid, f.processUuid);
  await f.ledger.finalizeDraftDispatch(f.operationId);
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.equal((await f.processes()).length, 1);
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: el rechazo confirmado del proveedor conserva el proceso sin anunciar firma pendiente", async (t) => {
  const f = await fixture(t, { providerStatus: "REJECTED" });
  assert.equal((await f.ledger.dispatchReservedDraft(f.operationId)).status, "UNCERTAIN");
  assert.equal((await f.processes())[0].status, "REJECTED");
  assert.equal((await f.receipts())[0].providerStatus, "REJECTED");
  await assert.rejects(f.database.query(`UPDATE "FirmaSeguroDraftDispatch"
    SET "status"='AWAITING_SIGNATURE' WHERE "id"=$1::uuid`, [f.operationId]),
  (error) => error.code === "23514");
  await f.ledger.finalizeDraftDispatch(f.operationId);
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.equal((await f.processes()).length, 1);
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: conciliación verificada exige actor y evidencia y no vuelve a contactar al proveedor", async (t) => {
  const f = await fixture(t, { providerError: new Error("Lost ACK") });
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId));
  for (const invalid of [
    { actor: undefined },
    { actor: { id: 0, nombre: "Operador" } },
    { actor: { id: 7, nombre: " " } },
    { evidence: undefined },
    { evidence: {} },
  ]) {
    await assert.rejects(f.verifiedReceipt(invalid));
    assert.equal((await f.receipts()).length, 0);
  }
  const receipt = await f.verifiedReceipt();
  assert.equal(receipt.source, "provider_reconciliation");
  assert.equal(receipt.actorUserId, 7);
  assert.equal(receipt.actorName, f.input.actor.nombre);
  assert.equal(receipt.evidence.operationId, f.operationId);
  assert.equal((await f.ledger.finalizeDraftDispatch(f.operationId)).status, "AWAITING_SIGNATURE");
  assert.equal((await f.processes())[0].processUuid, f.processUuid);
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: no se puede registrar una confirmación antes de despachar", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.verifiedReceipt());
  assert.equal((await f.row()).status, "PREPARING");
  assert.equal((await f.receipts()).length, 0);
  assert.equal(f.sends(), 0);
});

test("PostgreSQL: la evidencia es inmutable y una conciliación conflictiva no sustituye el ACK", async (t) => {
  const f = await fixture(t, { providerError: new Error("Lost ACK") });
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId));
  await f.verifiedReceipt();
  const before = await f.receipts();
  await f.verifiedReceipt();
  await assert.rejects(f.verifiedReceipt({ processUuid: randomUUID() }));
  // A later provider lookup can include updated status/payload. A replay of the
  // same dispatch and process returns the original ACK, never rewrites history.
  assert.deepEqual(await f.verifiedReceipt({ createPayload: { updatedResponse: true } }), before[0]);
  assert.deepEqual(await f.verifiedReceipt({ providerStatus: "COMPLETED" }), before[0]);
  await assert.rejects(f.database.query('UPDATE "FirmaSeguroDraftDispatchReceipt" SET "providerStatus"=$2 WHERE "dispatchId"=$1::uuid', [f.operationId, "REJECTED"]));
  await assert.rejects(f.database.query('DELETE FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1::uuid', [f.operationId]));
  assert.deepEqual(await f.receipts(), before);
  assert.equal(f.sends(), 1);
});

test("PostgreSQL: dos despachos no pueden apropiarse del mismo UUID del proveedor", async (t) => {
  const f = await fixture(t, { providerError: new Error("Lost ACK") });
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId));
  await f.verifiedReceipt();
  const secondId = randomUUID();
  await f.database.query('INSERT INTO "CreditoBorrador" ("id", "payload") VALUES (82, $1::jsonb)',
    [JSON.stringify(f.input.sourcePayload)]);
  await f.ledger.reserveDraftDispatch({ ...f.input, id: secondId, draftId: 82 });
  await f.database.query(`UPDATE "FirmaSeguroDraftDispatch"
    SET "status"='DISPATCHING', "requestPayload"=$2::jsonb, "dispatchedAt"=CURRENT_TIMESTAMP
    WHERE "id"=$1::uuid`, [secondId, JSON.stringify({ tags: { reissue: secondId } })]);
  await f.database.query(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='UNCERTAIN' WHERE "id"=$1::uuid`, [secondId]);
  await assert.rejects(f.verifiedReceipt({ dispatchId: secondId }));
  assert.equal((await f.receipts()).length, 1);
  assert.equal((await f.receipts())[0].dispatchId, f.operationId);
  assert.equal((await f.ledger.getDraftDispatch(secondId)).processUuid, null);
});

test("PostgreSQL: el trigger impide recuperar UNCERTAIN sin receipt y proceso coincidentes", async (t) => {
  const f = await fixture(t, { providerError: new Error("Lost ACK") });
  await assert.rejects(f.ledger.dispatchReservedDraft(f.operationId));
  const promote = () => f.database.query(`UPDATE "FirmaSeguroDraftDispatch"
    SET "status"='AWAITING_SIGNATURE', "processUuid"=$2 WHERE "id"=$1::uuid`, [f.operationId, f.processUuid]);
  await assert.rejects(promote(), (error) => error.code === "23514");
  await f.verifiedReceipt();
  await assert.rejects(promote(), (error) => error.code === "23514");
  assert.equal((await f.row()).status, "UNCERTAIN");
  assert.deepEqual(await f.events(), ["PREPARING", "DISPATCHING", "UNCERTAIN"]);
  await assert.rejects(f.database.query('DELETE FROM "FirmaSeguroDraftDispatchEvent" WHERE "dispatchId"=$1::uuid', [f.operationId]));
  assert.equal((await f.ledger.finalizeDraftDispatch(f.operationId)).status, "AWAITING_SIGNATURE");
});
