import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { firmaSeguroRecipientDeliverySchemaStatements } from "../scripts/firmaseguro-recipient-delivery-schema.mjs";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

class ProviderError extends Error { constructor(status) { super("Provider request rejected"); this.status = status; } }
class RecipientProviderError extends Error {
  constructor(code) { super("Provider signer cannot be verified"); this.code = code; this.status = 409; }
}
class PortalError extends Error {
  constructor(code, stage = "READ", uncertain = false, status = 409) {
    super("Portal action cannot be verified"); Object.assign(this, { code, stage, uncertain, status });
  }
}
function portalMockError(error, stage) {
  return error instanceof ProviderError ? new PortalError("PORTAL_REJECTED", stage, false, error.status) : error;
}
async function fixture(t, platform = "IPHONE") {
  const database = new PGlite();
  t.after(() => database.close());
  const processUuid = randomUUID();
  const sourcePayload = { clienteTelefono: "3000000001", clienteCorreo: "old@example.invalid", financialTermsSeal: { checksum: "original" }, immutable: true };
  const requestPayload = { uuid: processUuid, pdf: "ORIGINAL-PDF-BYTES", signatures: [{ contact_information: {
    first_name: "Ana", first_last_name: "Pérez", identification: "1000000001",
    mobile_number: "3000000001", email: "old@example.invalid" }, authmethod: 1 }] };
  await database.exec(`CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (7),(8);
    CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT,"creditoId" INTEGER,"currentStep" INTEGER,
      "expiresAt" TIMESTAMP,"createdAt" TIMESTAMP,"plataforma" TEXT,"payload" JSONB);
    CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER PRIMARY KEY,"processUuid" TEXT UNIQUE,"draftId" INTEGER,"creditoId" INTEGER,
      "status" TEXT,"supersededAt" TIMESTAMP,"signedDocumentBase64" TEXT,"completedAt" TIMESTAMP,"lastError" TEXT,
      "createdAt" TIMESTAMP,"requestPayload" JSONB,"draftPayload" JSONB,"draftFolio" TEXT);
    INSERT INTO "CreditoBorrador" VALUES (22,'ABIERTO',NULL,4,'2100-01-01',CURRENT_TIMESTAMP,'IPHONE','{}');`);
  await database.query(`UPDATE "CreditoBorrador" SET "payload"=$1 WHERE "id"=22`, [sourcePayload]);
  await database.query(`UPDATE "CreditoBorrador" SET "plataforma"=$1 WHERE "id"=22`, [platform]);
  await database.query(`INSERT INTO "FirmaSeguroProcess" VALUES (1,$1,22,NULL,'CREATED',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,$2,$3,'FNS-22')`,
    [processUuid, requestPayload, sourcePayload]);
  function adapter(connection) {
    return { $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
      $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows };
  }
  const prisma = { ...adapter(database), $transaction: work => database.transaction(connection => work(adapter(connection))) };
  const calls = { edit: [], resend: [], inspect: 0, bindings: [], auth: 0,
    apiEdit: [], apiResend: [], portalOpen: [], portalInspect: 0, portalClose: 0, portalResendContacts: [] };
  const provider = { phone: "3000000001", email: "old@example.invalid", signatureId: 901, status: "PENDING", editError: null,
    resendError: null, editAppliedBeforeFailure: false, lockBusy: false, unresolved: false,
    contactVerification: "PROVIDER_READBACK", afterEdit: null, openError: null,
    portalInspectError: null, beforePortalInspect: null, portalReadbacks: [], beforeResend: null };
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
      frozenFirmaSeguroRecipientIdentity: process => {
        const contact = process.requestPayload.signatures[0].contact_information;
        return { identification: contact.identification, firstName: contact.first_name, firstLastName: contact.first_last_name };
      },
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
    "@/lib/firmaseguro-portal": { FirmaSeguroPortalError: PortalError,
      openFirmaSeguroPortalRecipient: async options => {
        calls.portalOpen.push(options);
        if (provider.openError) throw provider.openError;
        return {
          inspect: async () => {
            calls.portalInspect += 1;
            if (provider.beforePortalInspect) await provider.beforePortalInspect(calls.portalInspect);
            if (provider.portalInspectError) throw provider.portalInspectError;
            if (provider.status !== "PENDING") throw new PortalError("FIRMASEGURO_SIGNATURE_NOT_PENDING");
            return { signatureId: provider.signatureId, phone: provider.phone, email: provider.email,
              contactVerification: "PROVIDER_READBACK", contactSource: "PORTAL_READBACK",
              ...provider.portalReadbacks.shift() };
          },
          edit: async contact => {
            calls.edit.push({ uuid: options.processUuid, signature_id: options.signatureId,
              contact_information: { ...requestPayload.signatures[0].contact_information,
                mobile_number: contact.phone, email: contact.email } });
            if (!provider.editError || provider.editAppliedBeforeFailure) Object.assign(provider, contact);
            if (provider.editError) throw portalMockError(provider.editError, "EDIT");
            if (provider.afterEdit) await provider.afterEdit();
          },
          resend: async contact => {
            calls.portalResendContacts.push({ phone: contact.phone, email: contact.email });
            calls.resend.push(options.signatureId);
            if (provider.beforeResend) await provider.beforeResend();
            if (provider.resendError) throw portalMockError(provider.resendError, "RESEND");
          },
          close: async () => { calls.portalClose += 1; },
        };
      } },
    "@/lib/firmaseguro": { FirmaSeguroApiError: ProviderError, isFirmaSeguroCompletedStatus: value => value === "COMPLETED",
      firmaSeguroSignIn: async () => { calls.auth += 1; return { token: "fixture-token" }; },
      firmaSeguroEditSignature: async (_token, payload) => {
        calls.apiEdit.push(payload);
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
        calls.apiResend.push(id);
        calls.resend.push(id); if (provider.resendError) throw provider.resendError; return { success: true };
      } },
  });
  const input = { id: randomUUID(), draftId: 22, processUuid, actor: { id: 7, nombre: "Analista QA" },
    reason: "Número anterior sin WhatsApp", phone: "3119876543", email: null, hasPhone: true, hasEmail: false };
  const run = (overrides = {}) => ledger.deliverExistingFirmaSeguroSignature({ ...input, ...overrides });
  const seedHistorical = async (overrides = {}, status = "PREPARING", source = "PROVIDER_READBACK") => {
    const intent = { ...input, ...overrides };
    await ledger.ensureFirmaSeguroRecipientDeliverySchema();
    const intentSha256 = createHash("sha256").update(JSON.stringify({ version: 2, draftId: intent.draftId,
      processUuid: intent.processUuid, actorId: intent.actor.id, reason: intent.reason,
      phone: { present: intent.hasPhone, value: intent.phone }, email: { present: intent.hasEmail, value: intent.email } })).digest("hex");
    await database.query(`INSERT INTO "FirmaSeguroRecipientDelivery" ("id","draftId","processUuid","signatureId",
      "actorUserId","actorName","reason","intentSha256","beforeContact","afterContact","status")
      VALUES ($1,22,$2,901,7,'Analista QA',$3,$4,$5,$6,$7)`, [intent.id, intent.processUuid, intent.reason, intentSha256,
      { phone: "3000000001", email: "old@example.invalid", source },
      { phone: intent.hasPhone ? intent.phone : "3000000001", email: intent.hasEmail ? intent.email : "old@example.invalid" }, status]);
  };
  return { database, calls, provider, input, run, ledger, requestPayload, sourcePayload, seedHistorical };
}

test("edita y reenvía el mismo firmante; conserva proceso, documento y todos los snapshots", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "RESENT");
  assert.equal(result.transport, "PORTAL");
  assert.equal(result.notificationChannel, "UNCONFIRMED");
  assert.equal(result.deliveryStatus, "UNCONFIRMED");
  assert.match(result.message, /canal y la entrega al cliente no están confirmados/);
  assert.equal(f.calls.apiEdit.length, 0); assert.equal(f.calls.apiResend.length, 0);
  assert.equal(f.calls.portalClose, 1);
  assert.equal(f.calls.portalOpen[0].folio, "FNS-22");
  assert.equal(f.calls.portalOpen[0].identity.identification, "1000000001");
  assert.equal(result.processUuid, f.input.processUuid);
  assert.equal(result.sentPhone, "3119876543");
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].signature_id, 901);
  assert.equal(f.calls.edit[0].uuid, f.input.processUuid);
  assert.equal(f.calls.edit[0].contact_information.first_name, "Ana");
  assert.deepEqual(f.calls.resend, [901]);
  assert.deepEqual(f.calls.portalResendContacts, [{ phone: "3119876543", email: "old@example.invalid" }]);
  const process = (await f.database.query(`SELECT * FROM "FirmaSeguroProcess"`)).rows[0];
  assert.equal(process.supersededAt, null);
  assert.deepEqual(process.requestPayload, f.requestPayload);
  assert.deepEqual(process.draftPayload, f.sourcePayload);
  assert.deepEqual((await f.database.query(`SELECT "payload" FROM "CreditoBorrador" WHERE "id"=22`)).rows[0].payload, f.sourcePayload);
  const events = (await f.database.query(`SELECT "status" FROM "FirmaSeguroRecipientDeliveryEvent" ORDER BY "id"`)).rows.map(x => x.status);
  assert.deepEqual(events, ["PREPARING", "EDITING", "RECIPIENT_UPDATED", "RESENDING", "RESENT"]);
});

test("Android cambia solo el destinatario y reenvía el documento pendiente con un único acuse durable", async t => {
  const f = await fixture(t, " android ");
  const beforeProcess = (await f.database.query('SELECT * FROM "FirmaSeguroProcess"')).rows;
  const beforeDraft = (await f.database.query('SELECT * FROM "CreditoBorrador"')).rows;
  const result = await f.run();
  assert.equal(result.status, "RESENT");
  assert.equal(result.processUuid, f.input.processUuid);
  assert.equal(result.transport, "PORTAL");
  assert.equal(result.notificationChannel, "UNCONFIRMED");
  assert.equal(result.deliveryStatus, "UNCONFIRMED");
  assert.equal(result.sentPhone, f.input.phone);
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].uuid, f.input.processUuid);
  assert.equal(f.calls.edit[0].signature_id, 901);
  assert.deepEqual(f.calls.resend, [901]);
  assert.deepEqual((await f.database.query('SELECT * FROM "FirmaSeguroProcess"')).rows, beforeProcess);
  assert.deepEqual((await f.database.query('SELECT * FROM "CreditoBorrador"')).rows, beforeDraft);
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
  assert.deepEqual(f.calls.resend, [901]);
  const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(row.actorUserId, f.input.actor.id);
  assert.equal(row.reason, f.input.reason);
  assert.equal(row.processUuid, f.input.processUuid);
  assert.equal(row.signatureId, 901);
});

test("Android rechaza firma completada, solicitud cerrada, proceso ambiguo y plataforma desconocida sin enviar", async t => {
  const f = await fixture(t, "ANDROID");
  await f.database.exec('UPDATE "FirmaSeguroProcess" SET "completedAt"=CURRENT_TIMESTAMP');
  await assert.rejects(f.run(), { code: "SIGNATURE_ALREADY_COMPLETED" });
  await f.database.exec('UPDATE "FirmaSeguroProcess" SET "completedAt"=NULL,"signedDocumentBase64"=\'JVBERi0=\'');
  await assert.rejects(f.run(), { code: "SIGNATURE_ALREADY_COMPLETED" });
  await f.database.exec('UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=NULL,"status"=\'REJECTED\'');
  await assert.rejects(f.run(), { code: "SIGNATURE_NOT_PENDING" });
  await f.database.exec('UPDATE "FirmaSeguroProcess" SET "status"=\'CREATED\'');
  await f.database.exec('UPDATE "CreditoBorrador" SET "estado"=\'CERRADO\'');
  await assert.rejects(f.run(), { code: "DRAFT_NOT_AVAILABLE" });
  await f.database.exec('UPDATE "CreditoBorrador" SET "estado"=\'ABIERTO\',"currentStep"=5');
  await assert.rejects(f.run(), { code: "DRAFT_NOT_AVAILABLE" });
  await f.database.exec('UPDATE "CreditoBorrador" SET "currentStep"=4,"creditoId"=101');
  await assert.rejects(f.run(), { code: "DRAFT_NOT_AVAILABLE" });
  await f.database.exec('UPDATE "CreditoBorrador" SET "creditoId"=NULL,"plataforma"=\'DESCONOCIDA\'');
  await assert.rejects(f.run(), { code: "PLATFORM_NOT_SUPPORTED" });
  await f.database.exec('UPDATE "CreditoBorrador" SET "plataforma"=\'ANDROID\'');
  f.provider.unresolved = true;
  await assert.rejects(f.run(), { code: "SIGNATURE_PENDING" });
  f.provider.unresolved = false;
  await f.database.query('INSERT INTO "FirmaSeguroProcess" ("id","processUuid","draftId","status","createdAt") VALUES (2,$1,22,\'CREATED\',CURRENT_TIMESTAMP)', [randomUUID()]);
  await assert.rejects(f.run(), { code: "PROCESS_CHANGED" });
  assert.equal(f.calls.edit.length, 0);
  assert.equal(f.calls.resend.length, 0);
  assert.equal(f.calls.auth, 0);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM "FirmaSeguroRecipientDelivery"')).rows[0].count, 0);
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
  await f.database.query(`INSERT INTO "FirmaSeguroProcess" ("id","processUuid","draftId","creditoId","status","createdAt","requestPayload","draftPayload","draftFolio")
    VALUES (2,$1,22,NULL,'CREATED',CURRENT_TIMESTAMP,$2,$3,'FNS-22-NEW')`,
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

test("una edición aplicada con respuesta perdida concilia el contacto y solo reenvía el documento vigente", async t => {
  const f = await fixture(t);
  f.provider.editError = new Error("lost response"); f.provider.editAppliedBeforeFailure = true;
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 1);
});

test("una edición incierta no aplicada puede reintentarse después de verificar el firmante", async t => {
  const f = await fixture(t);
  f.provider.editError = new Error("network failure");
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 2); assert.equal(f.calls.resend.length, 1);
});

test("permite reenviar al mismo contacto sin edición ni nueva solicitud", async t => {
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

test("el contacto anterior procede del portal aunque la API solo lea metadatos congelados", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.phone = "3009999999";
  assert.equal((await f.run()).status, "RESENT");
  const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(row.beforeContact.phone, "3009999999");
  assert.equal(row.beforeContact.source, "PORTAL_READBACK");
  assert.equal(row.afterContact.transport, "PORTAL");
  assert.equal(f.calls.apiEdit.length, 0); assert.equal(f.calls.apiResend.length, 0);
  await assert.rejects(f.database.query(`UPDATE "FirmaSeguroRecipientDelivery" SET "afterContact"=$2 WHERE "id"=$1`,
    [f.input.id, { ...row.afterContact, transport: "API" }]), /IMMUTABLE/);
});

test("un fallo al abrir el portal no recurre a mutaciones API ni crea una operación", async t => {
  const f = await fixture(t);
  f.provider.openError = new PortalError("PORTAL_LOGIN_FAILED", "READ", false, 502);
  await assert.rejects(f.run(), { code: "PORTAL_LOGIN_FAILED", status: 502 });
  assert.equal(f.calls.edit.length, 0); assert.equal(f.calls.resend.length, 0);
  assert.equal(f.calls.apiEdit.length, 0); assert.equal(f.calls.apiResend.length, 0);
  assert.equal(f.provider.lockBusy, false);
  assert.equal(await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id), null);
});

test("un fallo de lectura del portal cierra su sesión y no altera contactos", async t => {
  const f = await fixture(t);
  f.provider.portalInspectError = new PortalError("PORTAL_READ_FAILED");
  await assert.rejects(f.run(), { code: "PORTAL_READ_FAILED" });
  assert.equal(f.calls.portalClose, 1); assert.equal(f.provider.lockBusy, false);
  assert.equal(f.calls.edit.length, 0); assert.equal(f.calls.resend.length, 0);
});

test("un correo editado sin acuse se concilia por el portal sin depender del correo de la API", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  f.provider.editError = new PortalError("PORTAL_EDIT_TIMEOUT", "EDIT", true);
  f.provider.editAppliedBeforeFailure = true;
  const change = { email: "next@example.invalid", hasEmail: true };
  assert.equal((await f.run(change)).status, "EDIT_UNCERTAIN");
  assert.equal(f.calls.auth, 1);
  f.provider.editError = null;
  const result = await f.run(change);
  assert.equal(result.status, "RESENT"); assert.equal(result.transport, "PORTAL");
  assert.equal(f.calls.auth, 1, "el replay no se liga al correo congelado de la API");
  assert.equal(f.calls.edit.length, 1); assert.deepEqual(f.calls.resend, [901]);
  assert.equal(f.calls.portalClose, 2);
});

test("una edición sin lectura posterior confirmada no autoriza el reenvío", async t => {
  const f = await fixture(t);
  f.provider.afterEdit = () => { f.provider.portalInspectError = new PortalError("PORTAL_READ_FAILED"); };
  const result = await f.run();
  assert.equal(result.status, "EDIT_UNCERTAIN"); assert.equal(result.retryable, true);
  assert.equal(f.calls.resend.length, 0);
  assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).editedAt, null);
  f.provider.portalInspectError = null; f.provider.afterEdit = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.edit.length, 1);
});

test("un contacto externo tras una edición incierta no se sobrescribe ni reenvía", async t => {
  const f = await fixture(t);
  f.provider.editError = new PortalError("PORTAL_EDIT_TIMEOUT", "EDIT", true);
  assert.equal((await f.run()).status, "EDIT_UNCERTAIN");
  f.provider.editError = null; f.provider.phone = "3125555555";
  await assert.rejects(f.run(), { code: "SIGNATURE_RECIPIENT_CHANGED" });
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 0);
  assert.equal(f.calls.portalClose, 2);
});

test("un rechazo definitivo de la edición conserva el fallo seguro sin reenvío", async t => {
  const f = await fixture(t);
  f.provider.editError = new PortalError("PORTAL_EDIT_REJECTED", "EDIT", false);
  assert.equal((await f.run()).status, "FAILED_SAFE");
  assert.equal((await f.run()).status, "FAILED_SAFE");
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 0);
  assert.equal(f.calls.portalOpen.length, 1);
});

test("la firma se revalida en base de datos antes de reenviar desde el portal", async t => {
  const f = await fixture(t);
  f.provider.afterEdit = async () => f.database.exec(`UPDATE "FirmaSeguroProcess" SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP`);
  await assert.rejects(f.run(), { code: "SIGNATURE_ALREADY_COMPLETED" });
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.resend.length, 0);
  assert.equal(f.calls.portalClose, 1);
  assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).status, "RECIPIENT_UPDATED");
});

test("la última lectura del portal bloquea un firmante completado o contacto cambiado", async t => {
  for (const mutation of [{ status: "COMPLETED" }, { signatureId: 902 }, { phone: "3125555555" }]) {
    const f = await fixture(t);
    f.provider.beforePortalInspect = count => { if (count === 3) Object.assign(f.provider, mutation); };
    await assert.rejects(f.run(), error => ["FIRMASEGURO_SIGNATURE_NOT_PENDING", "SIGNATURE_RECIPIENT_CHANGED"].includes(error.code));
    assert.equal(f.calls.resend.length, 0); assert.equal(f.calls.portalClose, 1);
  }
});

test("RESEND_UNCERTAIN persistido nunca vuelve a accionar el portal ni API", async t => {
  const f = await fixture(t);
  f.provider.resendError = new PortalError("PORTAL_RESEND_TIMEOUT", "RESEND", true);
  assert.equal((await f.run()).status, "RESEND_UNCERTAIN");
  const callsBefore = { portal: f.calls.portalOpen.length, auth: f.calls.auth, resend: f.calls.resend.length };
  assert.equal((await f.run()).retryable, false);
  assert.deepEqual({ portal: f.calls.portalOpen.length, auth: f.calls.auth, resend: f.calls.resend.length }, callsBefore);
  assert.equal(f.calls.apiResend.length, 0);
});

test("un replay RESENDING en vuelo devuelve el estado sin una segunda acción", async t => {
  const f = await fixture(t);
  let acknowledge, reachedResend;
  const waitingForAck = new Promise(resolve => { acknowledge = resolve; });
  const resending = new Promise(resolve => { reachedResend = resolve; });
  f.provider.beforeResend = async () => { reachedResend(); await waitingForAck; };
  const first = f.run();
  await resending;
  try {
    const replay = await f.run();
    assert.equal(replay.status, "RESENDING"); assert.equal(replay.retryable, false);
    assert.equal(f.calls.portalOpen.length, 1); assert.equal(f.calls.auth, 1);
    assert.deepEqual(f.calls.resend, [901]); assert.equal(f.calls.apiResend.length, 0);
  } finally { acknowledge(); }
  assert.equal((await first).status, "RESENT");
  assert.equal(f.calls.portalClose, 1);
});

test("las operaciones API históricas sin marcador conservan exclusivamente su replay", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  await f.seedHistorical({}, "PREPARING", "FROZEN_REQUEST");
  const result = await f.run();
  assert.equal(result.status, "RESENT"); assert.equal(result.transport, "API");
  assert.equal(result.notificationChannel, "EMAIL");
  assert.equal(f.calls.portalOpen.length, 0);
  assert.equal(f.calls.apiEdit.length, 1); assert.deepEqual(f.calls.apiResend, [901]);
  const row = await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id);
  assert.equal(row.afterContact.transport, undefined);
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.apiEdit.length, 1); assert.deepEqual(f.calls.apiResend, [901]);
});

test("el fallo de reenvío API histórico se reintenta sin migrar de medio ni repetir edición", async t => {
  const f = await fixture(t);
  await f.seedHistorical();
  f.provider.resendError = new ProviderError(400);
  assert.equal((await f.run()).status, "RESEND_FAILED");
  f.provider.resendError = null;
  assert.equal((await f.run()).status, "RESENT");
  assert.equal(f.calls.apiEdit.length, 1); assert.deepEqual(f.calls.apiResend, [901, 901]);
  assert.equal(f.calls.portalOpen.length, 0);
});

test("una edición API histórica incierta con metadatos no se reintenta por el portal", async t => {
  const f = await fixture(t);
  f.provider.contactVerification = "BOUND_METADATA";
  await f.seedHistorical({}, "EDIT_UNCERTAIN", "FROZEN_REQUEST");
  const result = await f.run();
  assert.equal(result.status, "EDIT_UNCERTAIN"); assert.equal(result.retryable, false);
  assert.equal(result.transport, "API");
  assert.equal(f.calls.portalOpen.length, 0); assert.equal(f.calls.edit.length, 0); assert.equal(f.calls.resend.length, 0);
});

test("otra operación no duplica la edición del portal mientras llega su confirmación", async t => {
  const f = await fixture(t);
  let acknowledge, reachedEdit;
  const waitingForAck = new Promise(resolve => { acknowledge = resolve; });
  const edited = new Promise(resolve => { reachedEdit = resolve; });
  f.provider.afterEdit = async () => { reachedEdit(); await waitingForAck; };
  const first = f.run();
  await edited;
  try {
    await assert.rejects(f.run({ id: randomUUID() }), { code: "SIGNATURE_BUSY" });
    assert.equal((await f.ledger.getFirmaSeguroRecipientDelivery(f.input.id)).status, "EDITING");
  } finally { acknowledge(); }
  assert.equal((await first).status, "RESENT");
  assert.equal(f.calls.edit.length, 1); assert.deepEqual(f.calls.resend, [901]);
  assert.equal(f.calls.portalClose, 1);
});
