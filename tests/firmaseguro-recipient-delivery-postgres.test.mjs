import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { firmaSeguroRecipientDeliverySchemaStatements } from "../scripts/firmaseguro-recipient-delivery-schema.mjs";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

class ProviderError extends Error { constructor(status) { super("Provider request rejected"); this.status = status; } }
class RecipientProviderError extends Error {
  constructor(code) { super("Provider signer cannot be verified"); this.code = code; this.status = 409; }
}
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
  const calls = { edit: [], resend: [], inspect: 0, bindings: [], auth: 0 };
  const provider = { phone: "3000000001", email: "old@example.invalid", signatureId: 901, status: "PENDING", editError: null,
    resendError: null, editAppliedBeforeFailure: false, lockBusy: false, unresolved: false,
    contactVerification: "PROVIDER_READBACK", afterEdit: null };
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
    "@/lib/firmaseguro-recipient-provider": { FirmaSeguroRecipientProviderError: RecipientProviderError,
      inspectPendingFirmaSeguroRecipient: async (_token, process, knownRecipient) => {
      calls.inspect += 1;
      calls.bindings.push(knownRecipient);
      if (provider.status !== "PENDING") throw new RecipientProviderError("FIRMASEGURO_SIGNATURE_NOT_PENDING");
      const metadataOnly = provider.contactVerification === "BOUND_METADATA";
      const originalContact = requestPayload.signatures[0].contact_information;
      if (metadataOnly && ((knownRecipient && (knownRecipient.processUuid !== process.processUuid
        || knownRecipient.signatureId !== provider.signatureId || !knownRecipient.confirmedAt))
        || provider.email !== (knownRecipient?.email ?? originalContact.email)))
        throw new RecipientProviderError("FIRMASEGURO_RECIPIENT_UNVERIFIED");
      const phone = metadataOnly ? knownRecipient?.phone ?? originalContact.mobile_number : provider.phone;
      return { signatureId: provider.signatureId, phone, email: provider.email,
        contactVerification: provider.contactVerification,
        contactSource: metadataOnly ? knownRecipient ? "ACKNOWLEDGED_EDIT" : "FROZEN_REQUEST" : "PROVIDER_READBACK",
        editPayload: { uuid: process.processUuid, signature_id: provider.signatureId, authmethod: 1,
          contact_information: { ...requestPayload.signatures[0].contact_information,
            mobile_number: phone, email: provider.email } } };
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
        if (provider.afterEdit) await provider.afterEdit();
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

test("un GET de metadatos ligado al proceso permite editar y reenviar el mismo id tras el ACK del PUT", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  const result = await f.run();
  assert.equal(result.status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].uuid, f.input.processUuid);
  assert.equal(f.calls.edit[0].signature_id, 901);
  assert.deepEqual(f.calls.resend, [901]);
  assert.equal(f.calls.bindings[0], undefined);
  const binding = f.calls.bindings[1];
  assert.equal(binding.processUuid, f.input.processUuid);
  assert.equal(binding.signatureId, 901);
  assert.equal(binding.phone, f.input.phone);
  assert.equal(binding.email, "old@example.invalid");
  assert.ok(binding.confirmedAt instanceof Date);
  const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(row.beforeContact.source, "FROZEN_REQUEST");
  assert.ok(row.editedAt);
  assert.equal(row.afterContact.phone, f.input.phone);
  const process = (await f.database.query(`SELECT * FROM "FirmaSeguroProcess"`)).rows[0];
  assert.deepEqual(process.requestPayload, f.requestPayload);
  assert.deepEqual(process.draftPayload, f.sourcePayload);
  assert.deepEqual((await f.database.query(`SELECT "payload" FROM "CreditoBorrador"`)).rows[0].payload, f.sourcePayload);
});

test("el celular congelado no demuestra coincidencia actual: con metadatos siempre se hace el PUT", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.phone = "3009999999";
  assert.equal((await f.run({ phone: "3000000001" })).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].contact_information.mobile_number, "3000000001");
  assert.deepEqual(f.calls.resend, [901]);
});

test("el ACK durable permite posteriores correcciones de correo sin alterar el request original", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  const firstInput = { email: "new@example.invalid", hasEmail: true };
  assert.equal((await f.run(firstInput)).status, "RESENT");
  const first = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(f.calls.bindings[1].email, "new@example.invalid");
  const secondId = randomUUID();
  assert.equal((await f.run({ id: secondId, phone: "3122222222",
    email: "next@example.invalid", hasEmail: true })).status, "RESENT");
  const second = await f.ledger.getFirmaSeguroRecipientDelivery(secondId);
  assert.equal(second.beforeContact.source, "ACKNOWLEDGED_EDIT");
  assert.equal(second.beforeContact.phone, first.afterContact.phone);
  assert.equal(second.beforeContact.email, first.afterContact.email);
  assert.equal(f.calls.bindings[2].email, "new@example.invalid");
  assert.equal(f.calls.bindings[2].signatureId, 901);
  assert.equal(f.calls.edit.length, 2);
  assert.deepEqual(f.calls.resend, [901, 901]);
  const process = (await f.database.query(`SELECT "requestPayload" FROM "FirmaSeguroProcess"`)).rows[0];
  assert.deepEqual(process.requestPayload, f.requestPayload);
});

for (const applied of [false, true]) {
  test(`PUT sin ACK con GET de metadatos (${applied ? "aplicado" : "no aplicado"}) no se repite ni reenvía`, async t => {
    const f = await fixture(t);
    f.provider.contactVerification = "BOUND_METADATA";
    f.provider.editError = new Error("lost response");
    f.provider.editAppliedBeforeFailure = applied;
    assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
    f.provider.editError = null;
    const replay = await f.run();
    assert.equal(replay.status, "EDIT_UNCERTAIN");
    assert.equal(replay.retryable, false);
    assert.match(replay.message, /consulta no muestra el celular/);
    assert.equal(f.calls.edit.length, 1);
    assert.equal(f.calls.resend.length, 0);
    assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).editedAt, null);
    await assert.rejects(f.run({ id: randomUUID() }), { code: "SIGNATURE_PENDING" });
  });
}

test("correo aplicado sin ACK tampoco se concilia a partir de los metadatos", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.editError = new Error("lost response");
  f.provider.editAppliedBeforeFailure = true;
  const overrides = { email: "new@example.invalid", hasEmail: true };
  assert.equal((await f.run(overrides)).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  const replay = await f.run(overrides);
  assert.equal(replay.status, "EDIT_UNCERTAIN");
  assert.equal(replay.retryable, false);
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.resend.length, 0);
});

test("el GET posterior debe conservar id y correo y seguir pendiente aun después del ACK", async t => {
  for (const mutation of [() => ({ signatureId: 902 }), () => ({ email: "outside@example.invalid" }),
    () => ({ status: "SIGNED" })]) {
    const f = await fixture(t);
    f.provider.contactVerification = "BOUND_METADATA";
    f.provider.afterEdit = () => Object.assign(f.provider, mutation());
    await assert.rejects(f.run(), error =>
      ["FIRMASEGURO_RECIPIENT_UNVERIFIED", "FIRMASEGURO_SIGNATURE_NOT_PENDING"].includes(error.code));
    assert.equal(f.calls.edit.length, 1);
    assert.equal(f.calls.resend.length, 0);
    const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
    assert.equal(row.status, "RECIPIENT_UPDATED");
    assert.ok(row.editedAt);
  }
});

test("un reenvío rechazado en modo metadatos conserva el ACK y no vuelve a editar", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.resendError = new ProviderError(400);
  assert.equal((await f.run()).status, "RESEND_FAILED");
  f.provider.resendError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.deepEqual(f.calls.resend, [901, 901]);
  assert.ok(f.calls.bindings.slice(1).every(binding => binding.signatureId === 901 && binding.confirmedAt));
});

test("un GET de contacto completo todavía puede conciliar un PUT incierto que empezó con metadatos", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.editError = new Error("lost response");
  f.provider.editAppliedBeforeFailure = true;
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  f.provider.contactVerification = "PROVIDER_READBACK";
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.deepEqual(f.calls.resend, [901]);
});

test("otra operación concurrente no puede duplicar la edición ni el reenvío mientras llega el ACK", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  let acknowledge;
  let reachedEdit;
  const waitingForAck = new Promise(resolve => { acknowledge = resolve; });
  const edited = new Promise(resolve => { reachedEdit = resolve; });
  f.provider.afterEdit = async () => { reachedEdit(); await waitingForAck; };
  const first = f.run();
  await edited;
  try {
    await assert.rejects(f.run({ id: randomUUID() }), { code: "SIGNATURE_BUSY" });
    const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
    assert.equal(row.status, "EDITING");
    assert.equal(row.editedAt, null);
  } finally { acknowledge(); }
  assert.equal((await first).status, "RESENT");
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.deepEqual(f.calls.resend, [901]);
});
