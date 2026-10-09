import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { firmaSeguroRecipientDeliverySchemaStatements } from "../scripts/firmaseguro-recipient-delivery-schema.mjs";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

class ProviderError extends Error { constructor(status) { super("Provider request rejected"); this.status = status; } }
async function fixture(t) {
  const database = new PGlite();
  t.after(() => database.close());
  const processUuid = randomUUID();
  const sourcePayload = { clienteTelefono: "3000000001", clienteCorreo: "old@example.invalid", financialTermsSeal: { checksum: "original" }, immutable: true };
  const requestPayload = { uuid: processUuid, pdf: "ORIGINAL-PDF-BYTES", signatures: [{ contact_information: {
    first_name: "Ana", first_last_name: "Pérez", mobile_number: "3000000001", email: "old@example.invalid" }, authmethod: 1 }] };
  await database.exec(`CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (7),(8);
    CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT,"creditoId" INTEGER,"currentStep" INTEGER,
      "expiresAt" TIMESTAMP,"createdAt" TIMESTAMP,"plataforma" TEXT,"payload" JSONB);
    CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER PRIMARY KEY,"processUuid" TEXT UNIQUE,"draftId" INTEGER,"creditoId" INTEGER,
      "status" TEXT,"supersededAt" TIMESTAMP,"signedDocumentBase64" TEXT,"completedAt" TIMESTAMP,"lastError" TEXT,
      "createdAt" TIMESTAMP,"requestPayload" JSONB,"draftPayload" JSONB);
    INSERT INTO "CreditoBorrador" VALUES (22,'ABIERTO',NULL,4,'2100-01-01',CURRENT_TIMESTAMP,'IPHONE','{}');`);
  await database.query(`UPDATE "CreditoBorrador" SET "payload"=$1 WHERE "id"=22`, [sourcePayload]);
  await database.query(`INSERT INTO "FirmaSeguroProcess" VALUES (1,$1,22,NULL,'CREATED',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,$2,$3)`,
    [processUuid, requestPayload, sourcePayload]);
  function adapter(connection) {
    return { $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
      $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows };
  }
  const prisma = { ...adapter(database), $transaction: work => database.transaction(connection => work(adapter(connection))) };
  const calls = { edit: [], resend: [], inspect: 0, auth: 0 };
  const provider = { phone: "3000000001", email: "old@example.invalid", signatureId: 901, status: "PENDING", editError: null,
    resendError: null, editAppliedBeforeFailure: false, lockBusy: false, unresolved: false };
  const core = loadReissueModule("lib/approval-operations-core.ts");
  const ledger = loadReissueModule("lib/firmaseguro-recipient-delivery.ts", {
    "@/lib/prisma": { default: prisma },
    "@/scripts/firmaseguro-recipient-delivery-schema.mjs": { firmaSeguroRecipientDeliverySchemaStatements },
    "@/lib/approval-operations-core": core,
    "@/lib/firmaseguro-storage": { tryAcquireSolicitudOperationLock: async () => {
      if (provider.lockBusy) return null;
      provider.lockBusy = true;
      return { release: async () => { provider.lockBusy = false; } };
    } },
    "@/lib/firmaseguro-draft-dispatch-ledger": { getUnresolvedDraftDispatch: async () => provider.unresolved ? { id: "other" } : null },
    "@/lib/firmaseguro-recipient-provider": { FirmaSeguroRecipientProviderError: class extends Error {}, inspectPendingFirmaSeguroRecipient: async (_token, process) => {
      calls.inspect += 1;
      if (provider.status !== "PENDING") throw Object.assign(new Error("Not pending"), { code: "SIGNATURE_NOT_PENDING" });
      return { signatureId: provider.signatureId, phone: provider.phone, email: provider.email,
        editPayload: { uuid: process.processUuid, signature_id: provider.signatureId, authmethod: 1,
          contact_information: { ...requestPayload.signatures[0].contact_information,
            mobile_number: provider.phone, email: provider.email } } };
    } },
    "@/lib/firmaseguro": { FirmaSeguroApiError: ProviderError, isFirmaSeguroCompletedStatus: value => value === "COMPLETED",
      firmaSeguroSignIn: async () => { calls.auth += 1; return { token: "fixture-token" }; },
      firmaSeguroEditSignature: async (_token, payload) => {
        calls.edit.push(payload);
        if (!provider.editError || provider.editAppliedBeforeFailure) {
          provider.phone = payload.contact_information.mobile_number;
          provider.email = payload.contact_information.email;
        }
        if (provider.editError) throw provider.editError;
        return { success: true };
      },
      firmaSeguroResendSignature: async (_token, id) => {
        calls.resend.push(id); if (provider.resendError) throw provider.resendError; return { success: true };
      } },
  });
  const input = { id: randomUUID(), draftId: 22, processUuid, actor: { id: 7, nombre: "Analista QA" },
    reason: "Número anterior sin WhatsApp", phone: "3119876543", email: null, hasPhone: true, hasEmail: false };
  const run = (overrides = {}) => ledger.deliverExistingFirmaSeguroSignature({ ...input, ...overrides });
  return { database, calls, provider, input, run, ledger, requestPayload, sourcePayload };
}

test("edita y reenvía el mismo firmante; conserva proceso, documento y todos los snapshots", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "RESENT");
  assert.equal(result.processUuid, f.input.processUuid);
  assert.equal(result.sentPhone, "3119876543");
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].signature_id, 901);
  assert.equal(f.calls.edit[0].uuid, f.input.processUuid);
  assert.equal(f.calls.edit[0].contact_information.first_name, "Ana");
  assert.deepEqual(f.calls.resend, [901]);
  const process = (await f.database.query(`SELECT * FROM "FirmaSeguroProcess"`)).rows[0];
  assert.equal(process.supersededAt, null);
  assert.deepEqual(process.requestPayload, f.requestPayload);
  assert.deepEqual(process.draftPayload, f.sourcePayload);
  assert.deepEqual((await f.database.query(`SELECT "payload" FROM "CreditoBorrador" WHERE "id"=22`)).rows[0].payload, f.sourcePayload);
  const events = (await f.database.query(`SELECT "status" FROM "FirmaSeguroRecipientDeliveryEvent" ORDER BY "id"`)).rows.map(x => x.status);
  assert.deepEqual(events, ["PREPARING", "EDITING", "RECIPIENT_UPDATED", "RESENDING", "RESENT"]);
});

test("el replay durable no vuelve a editar ni reenviar incluso si el cliente ya firmó", async t => {
  const f = await fixture(t);
  await f.run();
  f.provider.status = "COMPLETED";
  await f.database.exec(`UPDATE "FirmaSeguroProcess" SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP`);
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 1); assert.equal(f.calls.auth, 1);
  for (const overrides of [{ phone: "3122222222" }, { email: "new@example.invalid", hasEmail: true },
    { actor: { id: 8, nombre: "Otro" } }, { reason: "Motivo diferente" }, { processUuid: "other" }])
    await assert.rejects(f.run(overrides), { code: "IDEMPOTENCY_CONFLICT" });
});

test("el reenvío rechazado después de editar se recupera sin editar otra vez ni recrear firma", async t => {
  const f = await fixture(t);
  f.provider.resendError = new ProviderError(400);
  const partial = await f.run();
  assert.equal(partial.status, "RESEND_FAILED"); assert.equal(partial.retryable, true);
  assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).editedAt instanceof Date, true);
  await assert.rejects(f.run({ id: randomUUID() }), { code: "SIGNATURE_PENDING" });
  f.provider.resendError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 2);
});

test("un timeout de reenvío queda incierto y ningún replay duplica la entrega", async t => {
  const f = await fixture(t);
  f.provider.resendError = new Error("timeout");
  assert.equal((await f.run()).status, "RESEND_UNCERTAIN");
  assert.equal((await f.run()).retryable, false);
  assert.equal(f.calls.resend.length, 1);
  await assert.rejects(f.run({ id: randomUUID() }), { code: "SIGNATURE_PENDING" });
});

test("una entrega incierta de un proceso archivado no bloquea el contacto de la nueva firma vigente", async t => {
  const f = await fixture(t);
  f.provider.resendError = new Error("timeout");
  assert.equal((await f.run()).status, "RESEND_UNCERTAIN");
  const newProcessUuid = randomUUID();
  await f.database.exec(`UPDATE "FirmaSeguroProcess" SET "supersededAt"=CURRENT_TIMESTAMP WHERE "id"=1`);
  await f.database.query(`INSERT INTO "FirmaSeguroProcess" ("id","processUuid","draftId","creditoId","status","createdAt","requestPayload","draftPayload")
    VALUES (2,$1,22,NULL,'CREATED',CURRENT_TIMESTAMP,$2,$3)`,
    [newProcessUuid, { ...f.requestPayload, uuid: newProcessUuid }, f.sourcePayload]);
  f.provider.resendError = null;
  f.provider.signatureId = 902;
  const result = await f.run({ id: randomUUID(), processUuid: newProcessUuid, phone: "3122222222" });
  assert.equal(result.status, "RESENT");
  assert.equal(result.processUuid, newProcessUuid);
  assert.deepEqual(f.calls.resend, [901, 902]);
  assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).status, "RESEND_UNCERTAIN");
  assert.equal((await f.run()).status, "RESEND_UNCERTAIN");
  assert.deepEqual(f.calls.resend, [901, 902], "el proceso anterior no se vuelve a reenviar ni se desbloquea");
});

test("retomar la UUID de otro usuario identifica claramente al responsable original", async t => {
  const f = await fixture(t);
  f.provider.resendError = new ProviderError(400);
  assert.equal((await f.run()).status, "RESEND_FAILED");
  await assert.rejects(f.run({ actor: { id: 8, nombre: "Otro analista" } }), error =>
    error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409 && /Analista QA/.test(error.message));
  assert.equal(f.calls.resend.length, 1);
});

test("PUT aplicado con respuesta perdida concilia el contacto y solo reenvía el documento vigente", async t => {
  const f = await fixture(t);
  f.provider.editError = new Error("lost response"); f.provider.editAppliedBeforeFailure = true;
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 1);
});

test("PUT incierto no aplicado puede reintentarse idempotentemente después de verificar el firmante", async t => {
  const f = await fixture(t);
  f.provider.editError = new Error("network failure");
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 2); assert.equal(f.calls.resend.length, 1);
});

test("permite reenviar al mismo contacto sin PUT ni nueva solicitud", async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ phone: "3000000001" })).status, "RESENT");
  assert.equal(f.calls.edit.length, 0); assert.deepEqual(f.calls.resend, [901]);
});

test("bloquea firma completada, terminal, ambigua, envío sin conciliar y operación concurrente", async t => {
  const f = await fixture(t);
  for (const status of ["REJECTED", "CANCELLED", "EXPIRED", "ERROR"]) {
    await f.database.query(`UPDATE "FirmaSeguroProcess" SET "status"=$1`, [status]);
    await assert.rejects(f.run(), { code: "SIGNATURE_NOT_PENDING" });
  }
  await f.database.exec(`UPDATE "FirmaSeguroProcess" SET "status"='COMPLETED'`);
  await assert.rejects(f.run(), { code: "SIGNATURE_ALREADY_COMPLETED" });
  await f.database.exec(`UPDATE "FirmaSeguroProcess" SET "status"='CREATED'`);
  f.provider.unresolved = true;
  await assert.rejects(f.run(), { code: "SIGNATURE_PENDING" }); f.provider.unresolved = false;
  f.provider.lockBusy = true;
  await assert.rejects(f.run(), { code: "SIGNATURE_BUSY" }); f.provider.lockBusy = false;
  await f.database.query(`INSERT INTO "FirmaSeguroProcess"("id","processUuid","draftId","status","createdAt") VALUES (2,$1,22,'CREATED',CURRENT_TIMESTAMP)`, [randomUUID()]);
  await assert.rejects(f.run(), { code: "PROCESS_CHANGED" });
  assert.equal(f.calls.edit.length, 0); assert.equal(f.calls.resend.length, 0);
});

test("el ledger conserva actor, fecha, motivo y contactos e impide alterar o borrar trazas", async t => {
  const f = await fixture(t);
  await f.run();
  const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(row.actorUserId, 7); assert.equal(row.actorName, "Analista QA");
  assert.equal(row.reason, f.input.reason); assert.equal(row.beforeContact.phone, "3000000001");
  assert.equal(row.afterContact.phone, "3119876543"); assert.ok(row.createdAt); assert.ok(row.resentAt);
  await assert.rejects(f.database.query(`UPDATE "FirmaSeguroRecipientDelivery" SET "reason"='Otro motivo' WHERE "id"=$1`, [f.input.id]), /IMMUTABLE/);
  await assert.rejects(f.database.query(`DELETE FROM "FirmaSeguroRecipientDelivery" WHERE "id"=$1`, [f.input.id]), /IMMUTABLE/);
  await assert.rejects(f.database.exec(`TRUNCATE "FirmaSeguroRecipientDeliveryEvent"`), /IMMUTABLE/);
});
