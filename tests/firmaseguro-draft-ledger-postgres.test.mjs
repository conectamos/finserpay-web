import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";

const operationalCore = loadReissueModule("lib/approval-operations-core.ts");

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
      "clienteTelefono" TEXT,
      "plataforma" TEXT,
      "imei" TEXT,
      "estado" TEXT NOT NULL DEFAULT 'ABIERTO', "creditoId" INTEGER,
      "currentStep" INTEGER NOT NULL DEFAULT 3,
      "expiresAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "ApprovalOperationalAction" (
      "id" UUID PRIMARY KEY, "targetKind" TEXT NOT NULL, "targetId" INTEGER NOT NULL,
      "creditId" INTEGER, "eventType" TEXT NOT NULL, "actorUserId" INTEGER NOT NULL,
      "actorName" TEXT NOT NULL, "previousImei" TEXT, "newImei" TEXT, "reason" TEXT NOT NULL,
      "evidenceMime" TEXT, "evidenceName" TEXT, "evidenceData" BYTEA, "evidenceSha256" CHAR(64),
      "beforeContact" JSONB, "afterContact" JSONB, "status" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "@/lib/approval-operations-core": operationalCore,
    "@/lib/prisma": { default: prisma },
    "@/lib/firmaseguro-storage": storage,
    "@/lib/firmaseguro-credit": {
      prepareFirmaSeguroReissue: async (_credit, document, id) => {
        const selectedProcessUuid = id === operationId ? processUuid
          : id === options.redirectOperationId ? options.redirectProcessUuid
            : id === options.retryOperationId ? options.retryProcessUuid : null;
        assert.ok(selectedProcessUuid, `Unexpected operation id ${id}`);
        assert.equal(document.subarray(0, 5).toString(), "%PDF-");
        if ((id === options.redirectOperationId && options.redirectPreparationError)
          || (id === options.retryOperationId && options.retryPreparationError)) {
          throw new Error("injected preparation failure");
        }
        const selectedStatus = id === operationId ? options.providerStatus
          : id === options.redirectOperationId ? options.redirectProviderStatus
            : id === options.retryOperationId ? options.retryProviderStatus : null;
        const selectedRequestPayload = { document: "fixture.pdf", tags: { reissue: id } };
        const selectedCreatePayload = { uuid: selectedProcessUuid,
          status: selectedStatus || "CREATED", tags: { reissue: id } };
        return {
          requestPayload: selectedRequestPayload,
          sendOnce: async () => {
            sends += 1;
            await options.onSend?.({ database, operationId: id, processUuid: selectedProcessUuid });
            if (options.providerError) throw options.providerError;
            return { processUuid: selectedProcessUuid, status: selectedCreatePayload.status,
              createPayload: selectedCreatePayload };
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
    "@/lib/firmaseguro-draft-frozen": {
      readFrozenCorrectionDateSource: () => null,
      verifiesFrozenCorrectionDateSource: () => false,
    },
    "@/lib/ventas-utils": { getTodayBogotaDateKey: () => "2026-10-07" },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
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
  await database.query(`INSERT INTO "CreditoBorrador"
    ("id", "payload", "clienteTelefono", "plataforma", "imei")
    VALUES ($1, $2::jsonb, $3, $4, $5)`,
  [input.draftId, JSON.stringify(sourcePayload), options.initialPhone || "3218928117",
    options.platform || "IPHONE", source.credit.imei]);
  await ledger.ensureDraftDispatchSchema();
  await ledger.reserveDraftDispatch(input);
  const row = async () => ledger.getDraftDispatch(operationId);
  const processes = async () => (await database.query('SELECT * FROM "FirmaSeguroProcess" ORDER BY "id"')).rows;
  const receipts = async () => (await database.query('SELECT * FROM "FirmaSeguroDraftDispatchReceipt" ORDER BY "dispatchId"')).rows;
  const reconciliations = async () => (await database.query(
    'SELECT * FROM "FirmaSeguroDraftDispatchReconciliation" ORDER BY "id"')).rows;
  const events = async () => (await database.query('SELECT "status" FROM "FirmaSeguroDraftDispatchEvent" WHERE "dispatchId"=$1::uuid ORDER BY "id"', [operationId])).rows.map((event) => event.status);
  const draft = async () => (await database.query(
    'SELECT "payload","clienteTelefono","plataforma" FROM "CreditoBorrador" WHERE "id"=$1', [input.draftId])).rows[0];
  const actions = async () => (await database.query(
    'SELECT * FROM "ApprovalOperationalAction" WHERE "targetKind"=\'DRAFT\' AND "targetId"=$1 ORDER BY "createdAt","id"',
  [input.draftId])).rows;
  const verifiedReceipt = (overrides = {}) => ledger.recordVerifiedDraftDispatchReceipt({
    dispatchId: operationId,
    processUuid,
    providerStatus: createPayload.status,
    createPayload,
    actor: input.actor,
    evidence: { operationId, processUuid, verifiedAt: "2026-10-04T00:00:00Z", providerResponse: createPayload },
    ...overrides,
  });
  return { database, ledger, storage, input, operationId, processUuid, requestPayload, createPayload,
    failures, row, processes, receipts, reconciliations, events, draft, actions, verifiedReceipt,
    sends: () => sends };
}

async function redirectReservation(f, { id, phone, expectedProcessUuid = f.processUuid,
  reason = "Número anterior sin WhatsApp", draftPayload = f.input.draftPayload,
  allowTerminalFailedActive = false } = {}) {
  const sourcePayload = (await f.draft()).payload;
  return {
    ...f.input,
    id,
    reason,
    expectedProcessUuid,
    sourcePayload,
    updatedPayload: {
      ...sourcePayload,
      clienteTelefono: phone,
      firmaSeguroContactCorrectionPending: true,
      firmaSeguroPendingContactRedirectId: id,
      firmaSeguroPendingContactRedirectSourceProcessUuid: expectedProcessUuid,
      firmaSeguroPendingContactRedirectSourceChecksum: f.input.draftPayload.financialTermsSeal.checksum,
      firmaSeguroPendingContactRedirectIntentSha256: "b".repeat(64),
    },
    draftPayload,
    frozenCredit: { ...f.input.frozenCredit, clienteTelefono: phone },
    supersedeActive: true,
    options: { requireUnsignedActive: true, allowTerminalFailedActive, updatedPhone: phone },
  };
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

test("PostgreSQL: redirección archiva el pendiente, crea uno activo y un callback viejo queda histórico", async (t) => {
  const redirectOperationId = randomUUID();
  const redirectProcessUuid = randomUUID();
  const f = await fixture(t, { redirectOperationId, redirectProcessUuid });
  await f.ledger.dispatchReservedDraft(f.operationId);
  const currentPayload = (await f.database.query(
    'SELECT "payload" FROM "CreditoBorrador" WHERE "id"=$1', [f.input.draftId])).rows[0].payload;
  const redirectedPayload = {
    ...currentPayload,
    clienteTelefono: "3119876543",
    firmaSeguroContactCorrectionPending: true,
    firmaSeguroPendingContactRedirectId: redirectOperationId,
    firmaSeguroPendingContactRedirectSourceProcessUuid: f.processUuid,
    firmaSeguroPendingContactRedirectSourceChecksum: f.input.draftPayload.financialTermsSeal.checksum,
    firmaSeguroPendingContactRedirectIntentSha256: "b".repeat(64),
  };
  const redirectInput = {
    ...f.input,
    id: redirectOperationId,
    reason: "Número anterior sin WhatsApp",
    expectedProcessUuid: f.processUuid,
    sourcePayload: currentPayload,
    updatedPayload: redirectedPayload,
    frozenCredit: { ...f.input.frozenCredit, clienteTelefono: "3119876543" },
    supersedeActive: true,
    options: { requireUnsignedActive: true, updatedPhone: "3119876543" },
  };

  await f.ledger.reserveDraftDispatch(redirectInput);
  let processes = await f.processes();
  assert.equal(processes.length, 1);
  assert.equal(processes[0].supersededAt, null,
    "reservar aún no archiva la firma mientras pueden fallar sello, preparación o Veriff");
  assert.equal((await f.database.query(
    'SELECT "clienteTelefono" FROM "CreditoBorrador" WHERE "id"=$1', [f.input.draftId])).rows[0].clienteTelefono,
  "3218928117");
  assert.equal((await f.actions()).length, 0);

  const sent = await f.ledger.dispatchReservedDraft(redirectOperationId);
  assert.equal(sent.status, "AWAITING_SIGNATURE");
  assert.equal(sent.processUuid, redirectProcessUuid);
  await f.ledger.dispatchReservedDraft(redirectOperationId);
  assert.equal(f.sends(), 2, "cada operación envía una vez aunque se repita");
  processes = await f.processes();
  const oldProcess = processes.find(row => row.processUuid === f.processUuid);
  const newProcess = processes.find(row => row.processUuid === redirectProcessUuid);
  assert.ok(oldProcess.supersededAt);
  assert.equal(oldProcess.supersededByUserId, 7);
  assert.equal(oldProcess.supersededReason, redirectInput.reason);
  assert.equal(newProcess.supersededAt, null);
  assert.equal((await f.draft()).clienteTelefono, "3119876543");
  assert.equal((await f.actions()).length, 1);
  assert.equal(newProcess.draftPayload.financialTermsSeal.snapshot.valorVenta,
    f.input.draftPayload.financialTermsSeal.snapshot.valorVenta);

  await f.ledger.reserveDraftDispatch(redirectInput);
  assert.equal((await f.database.query(
    'SELECT COUNT(*)::integer count FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1', [f.input.draftId])).rows[0].count, 2);
  const signedPdf = Buffer.from("%PDF-1.7\nlate old signature").toString("base64");
  await f.storage.updateFirmaSeguroProcess(f.processUuid, {
    status: "SIGNED", signedDocumentBase64: signedPdf, signedDocumentFileName: "old.pdf",
    completedAt: new Date(),
  });
  const active = (await f.database.query(
    'SELECT "processUuid" FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "supersededAt" IS NULL',
    [f.input.draftId])).rows;
  assert.deepEqual(active.map(row => row.processUuid), [redirectProcessUuid],
    "un resultado tardío del enlace anterior no desplaza la solicitud nueva");

  await f.storage.updateFirmaSeguroProcess(redirectProcessUuid, {
    status: "SIGNED", signedDocumentBase64: Buffer.from("%PDF-1.7\ncurrent signature").toString("base64"),
    signedDocumentFileName: "current.pdf", completedAt: new Date(),
  });
  const finalPayload = (await f.database.query(
    'SELECT "payload" FROM "CreditoBorrador" WHERE "id"=$1', [f.input.draftId])).rows[0].payload;
  const blockedId = randomUUID();
  await assert.rejects(f.ledger.reserveDraftDispatch({
    ...redirectInput,
    id: blockedId,
    expectedProcessUuid: redirectProcessUuid,
    sourcePayload: finalPayload,
    updatedPayload: { ...finalPayload, clienteTelefono: "3100000000" },
    options: { requireUnsignedActive: true, updatedPhone: "3100000000" },
  }), error => error.code === "DRAFT_SIGNATURE_ALREADY_COMPLETED");
  assert.equal((await f.database.query(
    'SELECT COUNT(*)::integer count FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1', [f.input.draftId])).rows[0].count, 2);
  assert.equal((await f.database.query(
    'SELECT "supersededAt" FROM "FirmaSeguroProcess" WHERE "processUuid"=$1', [redirectProcessUuid])).rows[0].supersededAt,
  null, "si el cliente ya firmó, el proceso actual no se archiva");
});

for (const scenario of [
  { name: "preparación", code: "DRAFT_DISPATCH_PREPARATION_FAILED", fixture: { redirectPreparationError: true } },
  { name: "sello", code: "DRAFT_DISPATCH_TERMS_CHANGED", invalidSeal: true },
  { name: "Veriff", code: "DRAFT_DISPATCH_CHANGED", fixture: { veriffRequired: true }, revokeVeriff: true },
]) {
  test(`PostgreSQL: fallo de ${scenario.name} antes del claim conserva proceso, contacto y auditoría`, async (t) => {
    const failedId = randomUUID();
    const failedProcessUuid = randomUUID();
    const retryId = randomUUID();
    const retryProcessUuid = randomUUID();
    const f = await fixture(t, {
      redirectOperationId: failedId,
      redirectProcessUuid: failedProcessUuid,
      retryOperationId: retryId,
      retryProcessUuid,
      ...scenario.fixture,
    });
    await f.ledger.dispatchReservedDraft(f.operationId);
    const originalDraft = structuredClone(await f.draft());
    assert.equal((await f.actions()).length, 0);
    const failed = await redirectReservation(f, {
      id: failedId,
      phone: "3119876543",
      ...(scenario.invalidSeal ? { draftPayload: { financialTermsSeal: null } } : {}),
    });
    await f.ledger.reserveDraftDispatch(failed);
    if (scenario.revokeVeriff) {
      await f.database.query(`UPDATE "VeriffIdentityValidation" SET "status"='declined' WHERE "id"=91`);
    }

    await assert.rejects(f.ledger.dispatchReservedDraft(failedId), error => error.code === scenario.code);
    assert.equal((await f.ledger.getDraftDispatch(failedId)).status, "FAILED_SAFE");
    assert.deepEqual(await f.draft(), originalDraft,
      "un fallo anterior al claim no cambia payload, teléfono indexado ni plataforma");
    assert.equal((await f.actions()).length, 0, "no queda una auditoría de contacto que nunca se envió");
    let processes = await f.processes();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].processUuid, f.processUuid);
    assert.equal(processes[0].supersededAt, null, "la firma anterior continúa vigente");
    assert.equal(f.sends(), 1, "el fallo previo al claim no contacta al proveedor");

    if (scenario.revokeVeriff) {
      await f.database.query(`UPDATE "VeriffIdentityValidation" SET "status"='approved' WHERE "id"=91`);
    }
    const retry = await redirectReservation(f, { id: retryId, phone: "3119876543" });
    await f.ledger.reserveDraftDispatch(retry);
    const sent = await f.ledger.dispatchReservedDraft(retryId);
    assert.equal(sent.status, "AWAITING_SIGNATURE");
    assert.equal(sent.processUuid, retryProcessUuid);
    await f.ledger.dispatchReservedDraft(retryId);
    assert.equal(f.sends(), 2, "el nuevo intento envía exactamente una vez");
    const actions = await f.actions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].id, retryId);
    assert.equal(actions[0].eventType, "CONTACT_UPDATED");
    processes = await f.processes();
    assert.ok(processes.find(row => row.processUuid === f.processUuid).supersededAt);
    assert.equal(processes.find(row => row.processUuid === retryProcessUuid).supersededAt, null);
  });
}

test("PostgreSQL: un ACK REJECTED queda recuperable y el reintento no duplica envíos", async (t) => {
  const retryId = randomUUID();
  const retryProcessUuid = randomUUID();
  const f = await fixture(t, {
    providerStatus: "REJECTED",
    redirectOperationId: retryId,
    redirectProcessUuid: retryProcessUuid,
    redirectProviderStatus: "CREATED",
  });
  assert.equal((await f.ledger.dispatchReservedDraft(f.operationId)).status, "FAILED_SAFE");
  assert.equal((await f.processes())[0].status, "REJECTED");
  assert.equal((await f.processes())[0].supersededAt, null);
  assert.equal((await f.receipts())[0].providerStatus, "REJECTED");
  assert.equal(await f.ledger.getUnresolvedDraftDispatch(f.input.draftId), null,
    "un rechazo confirmado no deja conciliación UNCERTAIN permanente");
  await f.ledger.finalizeDraftDispatch(f.operationId);
  await f.ledger.dispatchReservedDraft(f.operationId);
  assert.equal((await f.row()).status, "FAILED_SAFE");
  assert.equal(f.sends(), 1);

  const retry = await redirectReservation(f, {
    id: retryId, phone: "3119876543", allowTerminalFailedActive: true,
  });
  await f.ledger.reserveDraftDispatch(retry);
  const sent = await f.ledger.dispatchReservedDraft(retryId);
  assert.equal(sent.status, "AWAITING_SIGNATURE");
  assert.equal(sent.processUuid, retryProcessUuid);
  await f.ledger.dispatchReservedDraft(retryId);
  assert.equal(f.sends(), 2, "el retry explícito envía una vez y su replay no vuelve a enviar");
  const processes = await f.processes();
  assert.ok(processes.find(row => row.processUuid === f.processUuid).supersededAt);
  assert.equal(processes.find(row => row.processUuid === retryProcessUuid).supersededAt, null);
});

for (const providerStatus of ["ERROR", "FAILED", "FAILURE"]) {
  test(`PostgreSQL: un ACK ${providerStatus} sigue incierto y no habilita un retry`, async (t) => {
    const retryId = randomUUID();
    const retryProcessUuid = randomUUID();
    const f = await fixture(t, {
      providerStatus,
      redirectOperationId: retryId,
      redirectProcessUuid: retryProcessUuid,
    });
    const result = await f.ledger.dispatchReservedDraft(f.operationId);
    assert.equal(result.status, "UNCERTAIN");
    assert.equal((await f.processes())[0].status, providerStatus);
    assert.equal((await f.row()).status, "UNCERTAIN");
    assert.equal((await f.receipts())[0].providerStatus, providerStatus);
    assert.equal((await f.draft()).payload.firmaSeguroContactCorrectionPending, true,
      "un ACK ambiguo conserva el marcador para que la conciliación pueda terminar la redirección");
    assert.equal((await f.ledger.getUnresolvedDraftDispatch(f.input.draftId)).id, f.operationId,
      "un estado ambiguo conserva el bloqueo hasta conciliación inequívoca");

    const retry = await redirectReservation(f, {
      id: retryId, phone: "3119876543", allowTerminalFailedActive: true,
    });
    await assert.rejects(f.ledger.reserveDraftDispatch(retry),
      "ni siquiera el flag interno permite saltar un ACK ambiguo no conciliado");
    assert.equal(f.sends(), 1);
    assert.equal((await f.processes()).length, 1);
    assert.equal((await f.actions()).length, 0);
  });
}

for (const reconciledStatus of ["REJECTED", "CANCELLED", "EXPIRED"]) {
  test(`PostgreSQL: ACK ERROR conciliado como ${reconciledStatus} conserva historia y habilita un retry único`, async (t) => {
    const retryId = randomUUID();
    const retryProcessUuid = randomUUID();
    const f = await fixture(t, {
      providerStatus: "ERROR",
      redirectOperationId: retryId,
      redirectProcessUuid: retryProcessUuid,
      redirectProviderStatus: "CREATED",
    });
    assert.equal((await f.ledger.dispatchReservedDraft(f.operationId)).status, "UNCERTAIN");
    const originalAck = structuredClone((await f.receipts())[0]);
    const providerPayload = { uuid: f.processUuid, status: reconciledStatus, verified: true };
    const evidence = {
      operationId: f.operationId,
      processUuid: f.processUuid,
      verifiedAt: "2026-10-05T12:00:00.000Z",
      providerResponse: providerPayload,
    };

    const reconciliation = await f.verifiedReceipt({
      providerStatus: reconciledStatus, createPayload: providerPayload, evidence,
    });
    assert.equal(reconciliation.providerStatus, reconciledStatus);
    assert.deepEqual(await f.receipts(), [originalAck],
      "la conciliación nunca reescribe el ACK original del POST");
    const reconciliations = await f.reconciliations();
    assert.equal(reconciliations.length, 1);
    assert.equal(reconciliations[0].dispatchId, f.operationId);
    assert.equal(reconciliations[0].processUuid, f.processUuid);
    assert.equal(reconciliations[0].providerStatus, reconciledStatus);
    assert.deepEqual(reconciliations[0].providerPayload, providerPayload);
    assert.deepEqual(reconciliations[0].evidence, evidence);

    const finalized = await f.ledger.finalizeDraftDispatch(f.operationId);
    assert.equal(finalized.status, "FAILED_SAFE");
    assert.equal((await f.processes())[0].status, reconciledStatus,
      "la fuente activa refleja el fallo terminal verificado antes del retry");
    assert.equal(await f.ledger.getUnresolvedDraftDispatch(f.input.draftId), null);

    const retry = await redirectReservation(f, {
      id: retryId, phone: "3119876543", allowTerminalFailedActive: true,
    });
    await f.ledger.reserveDraftDispatch(retry);
    const source = (await f.processes()).find((row) => row.processUuid === f.processUuid);
    assert.equal(source.status, reconciledStatus);
    assert.equal(source.lastError, null);
    assert.equal(source.draftFolio, retry.draftFolio);
    assert.equal(source.draftPayload.financialTermsSeal.checksum,
      retry.updatedPayload.firmaSeguroPendingContactRedirectSourceChecksum);
    assert.equal((await f.ledger.dispatchReservedDraft(retryId)).status, "AWAITING_SIGNATURE");
    await f.ledger.dispatchReservedDraft(retryId);
    assert.equal(f.sends(), 2,
      "el envío original y el retry conciliado contactan al proveedor exactamente una vez cada uno");
    assert.equal((await f.actions()).length, 1);
  });
}

for (const reconciledStatus of ["FAILED", "UNKNOWN_PROVIDER_STATE"]) {
  test(`PostgreSQL: conciliación posterior ${reconciledStatus} mantiene el ACK ERROR como UNCERTAIN`, async (t) => {
    const retryId = randomUUID();
    const f = await fixture(t, {
      providerStatus: "ERROR", redirectOperationId: retryId, redirectProcessUuid: randomUUID(),
    });
    assert.equal((await f.ledger.dispatchReservedDraft(f.operationId)).status, "UNCERTAIN");
    const originalAck = structuredClone((await f.receipts())[0]);
    const providerPayload = { uuid: f.processUuid, status: reconciledStatus, verified: true };
    await f.verifiedReceipt({
      providerStatus: reconciledStatus,
      createPayload: providerPayload,
      evidence: {
        operationId: f.operationId,
        processUuid: f.processUuid,
        verifiedAt: "2026-10-05T12:01:00.000Z",
        providerResponse: providerPayload,
      },
    });
    assert.deepEqual(await f.receipts(), [originalAck]);
    assert.equal((await f.reconciliations()).length, 1);
    assert.equal((await f.ledger.finalizeDraftDispatch(f.operationId)).status, "UNCERTAIN");
    assert.equal((await f.draft()).payload.firmaSeguroContactCorrectionPending, true);
    assert.equal((await f.ledger.getUnresolvedDraftDispatch(f.input.draftId)).id, f.operationId);

    const retry = await redirectReservation(f, {
      id: retryId, phone: "3119876543", allowTerminalFailedActive: true,
    });
    await assert.rejects(f.ledger.reserveDraftDispatch(retry));
    assert.equal(f.sends(), 1);
    assert.equal((await f.actions()).length, 0);
  });
}

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
  assert.equal((await f.verifiedReceipt()).providerStatus, f.createPayload.status);
  await assert.rejects(f.verifiedReceipt({ processUuid: randomUUID() }));
  // A later provider lookup can include updated status/payload. Each observation
  // is append-only and the original ACK remains byte-for-byte unchanged.
  assert.deepEqual((await f.verifiedReceipt({ createPayload: { updatedResponse: true } })).providerPayload,
    { updatedResponse: true });
  assert.equal((await f.verifiedReceipt({ providerStatus: "COMPLETED" })).providerStatus, "COMPLETED");
  await assert.rejects(f.database.query('UPDATE "FirmaSeguroDraftDispatchReceipt" SET "providerStatus"=$2 WHERE "dispatchId"=$1::uuid', [f.operationId, "REJECTED"]));
  await assert.rejects(f.database.query('DELETE FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1::uuid', [f.operationId]));
  const reconciliations = await f.reconciliations();
  assert.equal(reconciliations.length, 3);
  assert.deepEqual(reconciliations.map((row) => row.providerStatus), ["CREATED", "CREATED", "COMPLETED"]);
  await assert.rejects(f.database.query(
    'UPDATE "FirmaSeguroDraftDispatchReconciliation" SET "providerStatus"=$2 WHERE "id"=$1',
    [reconciliations[0].id, "REJECTED"]));
  await assert.rejects(f.database.query(
    'DELETE FROM "FirmaSeguroDraftDispatchReconciliation" WHERE "id"=$1', [reconciliations[0].id]));
  assert.deepEqual(await f.receipts(), before);
  assert.deepEqual(await f.reconciliations(), reconciliations);
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
