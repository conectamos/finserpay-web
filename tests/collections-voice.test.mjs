import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { analystMoraSchemaStatements } from "../scripts/analyst-mora-schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const [core, plan, dates, numbers, errors, phone, identity, speech, document, moraTypes, collectionsHttp] = await Promise.all([
  jiti.import("../lib/collections-voice-core.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/colombia-date.ts"), jiti.import("../lib/credit-display-number.ts"),
  jiti.import("../lib/credit-approval-errors.ts"), jiti.import("../lib/dapta-welcome.ts"),
  jiti.import("../lib/credit-welcome-voice-core.ts"), jiti.import("../lib/credit-welcome-voice-speech.ts"),
  jiti.import("../lib/credit-welcome-voice-document.ts"),
  jiti.import("../lib/analyst-mora-types.ts"), jiti.import("../lib/dapta-collections-http.ts"),
]);
const mora = loadReissueModule("lib/analyst-mora-credit.ts", { "@/lib/prisma": { default: {} },
  "@/lib/credit-payment-plan": plan, "@/lib/colombia-date": dates, "@/lib/credit-display-number": numbers, "@/lib/credit-approval-errors": errors });
const management = loadReissueModule("lib/analyst-mora-management.ts", { "@/lib/prisma": { default: {} },
  "@/lib/credit-approval-errors": errors, "@/lib/analyst-mora-access": {}, "@/lib/analyst-mora-credit": mora,
  "@/lib/analyst-mora-schema": {}, "@/lib/analyst-mora-types": moraTypes, "@/lib/colombia-date": dates });
const receiptModule = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": identity, "@/lib/credit-welcome-voice-speech": speech, "@/lib/credit-welcome-voice-store": {},
});
const campaign = { id: "synthetic-mora", startDate: "2026-10-09", endDate: "2026-11-30", creditIds: [1], maxAttempts: 100 };
const secret = "s".repeat(40), flowSecret = "f".repeat(40), agentId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222", fixed = new Date("2026-10-09T15:00:00Z");
const environment = changes => ({ FINSERPAY_COLLECTIONS_VOICE_ENABLED: "true", FINSERPAY_COLLECTIONS_VOICE_CAMPAIGN_JSON: JSON.stringify(campaign),
  FINSERPAY_COLLECTIONS_VOICE_WEBHOOK_URL: "https://api.dapta.ai/synthetic-test", FINSERPAY_COLLECTIONS_VOICE_TOKEN_SECRET: secret,
  FINSERPAY_COLLECTIONS_VOICE_FLOW_TOKEN: flowSecret, FINSERPAY_COLLECTIONS_VOICE_FROM_NUMBER: "+573124085562",
  FINSERPAY_COBRANZA_AGENT_ID: agentId, FINSERPAY_COBRANZA_ACTOR_ID: "51", ...changes });
const sample = (id = 1, changes = {}) => ({ id, folio: "SYNTHETIC-" + id, clienteNombre: "ANA MARIA PRUEBA", clienteDocumento: "00123456" + id,
  clienteTelefono: "300000" + String(id).padStart(4, "0"), estado: "INSCRITO", pazYSalvoEmitidoAt: null, montoCredito: 477450,
  valorCuota: 159150, plazoMeses: 3, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-09-17", fechaProximoPago: null,
  createdAt: "2026-09-01T12:00:00Z", fechaCredito: "2026-09-01T12:00:00Z", planCapitalVigente: null, abonos: [],
  sede: { aliado: { id: 1, nombre: "Synthetic" } }, registroSadmin: null, ...changes });

async function fixture(t, credits = [sample()]) {
  const sql = new PGlite(); t.after(() => sql.close()); let clock = new Date(fixed), testPhone = "573000009999", failTx = false;
  await sql.exec(`CREATE TABLE "Credito" ("id" integer PRIMARY KEY,"clienteDocumento" text,"clienteTelefono" text,"data" jsonb);
    CREATE TABLE "Usuario" ("id" integer PRIMARY KEY); INSERT INTO "Usuario" VALUES(10),(51);
    CREATE TABLE "CreditDueReminder" ("creditoId" integer,"claimedAt" timestamptz,"status" text);
    CREATE TABLE "CreditOverdueDataAttempt" ("creditoId" integer,"claimedAt" timestamptz,"status" text);
    CREATE TABLE "CreditWelcomeVoiceEvent" ("creditoId" integer,"source" text,"createdAt" timestamptz,"status" text,"communicationOutcome" text);`);
  for (const statement of analystMoraSchemaStatements()) await sql.exec(statement);
  for (const credit of credits) await sql.query('INSERT INTO "Credito" VALUES($1,$2,$3,$4::jsonb)', [credit.id, credit.clienteDocumento, credit.clienteTelefono, JSON.stringify(credit)]);
  const hydrated = data => ({ ...data, fechaCredito: new Date(data.fechaCredito), createdAt: new Date(data.createdAt),
    abonos: data.abonos.map(a => ({ ...a, fechaAbono: new Date(a.fechaAbono) })) });
  const adapter = connection => ({
    $queryRawUnsafe: async (query, ...values) => (await connection.query(query, values)).rows,
    $executeRawUnsafe: async (query, ...values) => (await connection.query(query, values)).affectedRows,
    credito: { findUnique: async ({ where }) => {
      const row = (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]; return row ? hydrated(row.data) : null;
    } },
  });
  const database = { ...adapter(sql), $transaction: callback => sql.transaction(async tx => {
    const result = await callback(adapter(tx)); if (failTx) { failTx = false; throw new Error("Synthetic rollback"); } return result;
  }) };
  const mod = loadReissueModule("lib/collections-voice-store.ts", {
    "@/lib/prisma": { default: database }, "@/lib/analyst-mora-credit": mora,
    "@/lib/analyst-mora-access": { assertMoraActor: async (_db, actor, centralOnly) => { if (centralOnly && !actor.centralAdmin) throw new Error("Forbidden"); return actor; } },
    "@/lib/analyst-mora-management": management, "@/lib/analyst-mora-types": moraTypes,
    "@/lib/dapta-collections-http": collectionsHttp, "@/lib/dapta-welcome": phone,
    "@/lib/credit-welcome-voice-core": identity, "@/lib/credit-welcome-voice-speech": speech, "@/lib/collections-voice-core": core,
  });
  for (const statement of mod.collectionsVoiceSchemaStatements) await sql.exec(statement);
  const store = mod.createCollectionsVoiceStore({ database, now: () => new Date(clock), testPhone: () => testPhone, agentId: () => agentId });
  const consent = async (id = 1) => {
    const credit = credits.find(c => c.id === id);
    return store.recordConsent({ creditId: id, phone: credit.clienteTelefono, sourceType: "CUSTOMER_MESSAGE", sourceReference: "Synthetic real-source reference", grantedAt: "2026-10-09T13:00:00Z" }, { id: 10, nombre: "Synthetic Admin", centralAdmin: true });
  };
  const config = { ...campaign, creditIds: credits.map(c => c.id) };
  const enroll = async () => { await store.ensureCampaign(config); for (const c of credits) await consent(c.id); };
  const update = (id, changes) => sql.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(changes)]);
  return { sql, mod, store, config, consent, enroll, update,
    clock: value => { clock = new Date(value); }, testPhone: value => { testPhone = value; }, failNext: () => { failTx = true; },
    events: () => sql.query('SELECT * FROM "CollectionsVoiceEvent" ORDER BY "createdAt","id"').then(r => r.rows),
    members: () => sql.query('SELECT * FROM "CollectionsVoiceMember" ORDER BY "creditoId"').then(r => r.rows),
  };
}

test("configuration defaults off, binds exact origin/actor/host, and blocks active WhatsApp workers", () => {
  assert.equal(core.getCollectionsVoiceConfig({}), null);
  assert.ok(core.getCollectionsVoiceConfig(environment()));
  for (const changes of [{ FINSERPAY_COLLECTIONS_VOICE_FROM_NUMBER: "+573000000000" }, { FINSERPAY_COBRANZA_ACTOR_ID: "52" },
    { FINSERPAY_COLLECTIONS_VOICE_WEBHOOK_URL: "https://api.dapta.ai.evil.invalid/test" }, { DAPTA_DATOS_ENABLED: "true" },
    { DAPTA_RECORDATORIO_1_DIA_ENABLED: "true" }, { DAPTA_HOYVENCE_ENABLED: "true" }]) assert.equal(core.getCollectionsVoiceConfig(environment(changes)), null);
});
test("Colombia calendar rejects Sundays, national holidays and Saturday17; initial batch obeys legal time", () => {
  for (const instant of ["2026-10-11T15:00:00Z", "2026-10-12T15:00:00Z", "2026-10-10T22:00:00Z", "2026-04-02T15:00:00Z", "2026-04-03T15:00:00Z", "2026-06-15T15:00:00Z"]) assert.equal(core.isCollectionsVoiceLegalTime(new Date(instant)), false, instant);
  assert.equal(core.getCollectionsVoiceSlot(campaign, new Date("2026-10-09T15:29:59Z")), "2026-10-09T10:00");
  assert.equal(core.getCollectionsVoiceSlot(campaign, new Date("2026-10-09T15:30:00Z")), null);
  assert.equal(core.getCollectionsVoiceSlot(campaign, new Date("2026-10-10T19:00:00Z")), "2026-10-10T14:00");
  const initial = { ...campaign, initialWindow: { startsAt: "2026-10-09T17:01:00Z", endsAt: "2026-10-09T17:21:00Z" } };
  assert.equal(core.getCollectionsVoiceSlot(initial, new Date("2026-10-09T17:05:00Z")), "2026-10-09TINITIAL");
  assert.equal(core.getCollectionsVoiceSlot(initial, new Date("2026-10-09T17:22:00Z")), null);
});
test("event tokens contain only scoped identifiers and reject tamper/expiry/welcome purpose", () => {
  const token = core.createCollectionsVoiceToken({ eventId, creditId: 1, snapshot: sample(), destination: "573000000001" }, secret, fixed);
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  assert.deepEqual(Object.keys(payload).sort(), ["creditId", "eventId", "expiresAt", "issuedAt", "purpose"]);
  assert.deepEqual(core.verifyCollectionsVoiceToken(token, secret, fixed), { eventId, creditId: 1 });
  assert.equal(core.verifyCollectionsVoiceToken(token + "x", secret, fixed), null);
  assert.equal(core.verifyCollectionsVoiceToken(token, secret, new Date("2026-10-10T15:00:00Z")), null);
  assert.equal(core.verifyCollectionsVoiceToken(identity.createWelcomeVoiceToken({ eventId, creditId: 1 }, { secret, now: fixed }), secret, fixed), null);
});
test("no consent means no dispatchable claims, no fabricated authorization", async t => {
  const f = await fixture(t); await f.store.ensureCampaign(f.config);
  assert.equal((await f.store.claim(f.config, "2026-10-09T10:00")).length, 0);
  assert.equal((await f.events()).length, 0); assert.equal((await f.members())[0].state, "ACTIVE");
  await f.consent(); assert.equal((await f.store.claim(f.config, "2026-10-09T10:00")).length, 1);
});
test("immutable cohort, consent audit and batches progress beyond first three without replay", async t => {
  const f = await fixture(t, [1, 2, 3, 4].map(id => sample(id))); await f.enroll();
  await f.store.ensureCampaign(f.config);
  await assert.rejects(f.store.ensureCampaign({ ...f.config, maxAttempts: 99 }), /CAMPAIGN_CHANGED/);
  assert.equal((await f.store.claim(f.config, "2026-10-09T10:00", 3)).length, 3);
  assert.equal((await f.store.claim(f.config, "2026-10-09T10:00", 3)).length, 1);
  assert.equal((await f.store.claim(f.config, "2026-10-09T10:00", 3)).length, 0);
  const consent = (await f.sql.query('SELECT * FROM "CollectionsVoiceConsent" LIMIT 1')).rows[0];
  assert.equal(consent.recordedBy, 10); assert.equal(consent.sourceType, "CUSTOMER_MESSAGE");
});
test("temporarily ineligible first members do not starve later consented members", async t => {
  const f = await fixture(t, [1, 2, 3, 4].map(id => sample(id))); await f.store.ensureCampaign(f.config); await f.consent(4);
  const claims = await f.store.claim(f.config, "2026-10-09T10:00", 3);
  assert.deepEqual(Array.from(claims, c => c.creditId), [4]);
  assert.deepEqual((await f.members()).slice(0, 3).map(m => m.state), ["ACTIVE", "ACTIVE", "ACTIVE"]);
});
test("shared normalized phone is reserved once and human contact prevents calling its second credit", async t => {
  const f = await fixture(t, [sample(1), sample(2, { clienteTelefono: "+57 300 000 0001" })]); await f.enroll();
  const claims = (await Promise.all([f.store.claim(f.config, "2026-10-09T10:00"), f.store.claim(f.config, "2026-10-09T10:00")])).flat();
  assert.equal(claims.length, 1); assert.equal((await f.events()).length, 1);
  await f.store.saveResult({ eventId: claims[0].eventId, creditId: claims[0].creditId, providerCallId: "call-shared", outcome: "HUMAN_CONTACT", resultCode: "HUMAN_CONTACT", completedAt: null });
  f.clock("2026-10-09T19:00:00Z"); assert.equal((await f.store.claim(f.config, "2026-10-09T14:00")).length, 0);
});
test("only proven no-answer retries later; inflight and unknown remain held without corrupting member", async t => {
  const f = await fixture(t); await f.enroll(); const [first] = await f.store.claim(f.config, "2026-10-09T10:00");
  await f.store.accepted(first.eventId, "call-synthetic-1"); f.clock("2026-10-09T19:00:00Z");
  assert.equal((await f.store.claim(f.config, "2026-10-09T14:00")).length, 0); assert.equal((await f.members())[0].state, "ACTIVE");
  await f.store.saveResult({ eventId: first.eventId, creditId: 1, providerCallId: "call-synthetic-1", outcome: "NO_ANSWER", resultCode: "NO_ANSWER", completedAt: null });
  const [retry] = await f.store.claim(f.config, "2026-10-09T14:00"); assert.notEqual(retry.eventId, first.eventId);
  await f.store.unknown(retry.eventId); f.clock("2026-10-09T22:00:00Z");
  assert.equal((await f.store.claim(f.config, "2026-10-09T17:00")).length, 0);
});
test("a closed dispatch window releases only the known unsent event for the next slot", async t => {
  const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
  f.clock("2026-10-09T15:30:00Z"); assert.equal(await f.store.prepare(claim.eventId, f.config), null);
  const first = (await f.events())[0]; assert.equal(first.status, "CANCELLED"); assert.equal(first.resultCode, "WINDOW_CLOSED_BEFORE_DISPATCH");
  f.clock("2026-10-09T19:00:00Z"); const [retry] = await f.store.claim(f.config, "2026-10-09T14:00"); assert.notEqual(retry.eventId, claim.eventId);
  await f.store.unknown(retry.eventId); await f.store.windowClosedBeforeDispatch(retry.eventId);
  assert.equal((await f.events()).find(e => e.id === retry.eventId).status, "UNKNOWN");
});
test("payment/contact/consent changes after claim prevent preparation", async t => {
  for (const change of [{ abonos: [{ valor: 477450, fechaAbono: "2026-10-09T15:00:00Z" }] }, { clienteTelefono: "3000009999" }, { clienteDocumento: "00999999" }, { estado: "ANULADO" }]) {
    const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
    await f.update(1, change); assert.equal(await f.store.prepare(claim.eventId, f.config), null); assert.equal((await f.events())[0].status, "CANCELLED");
  }
});
test("same-week WhatsApp, reported payment and latest agreement exclude calls", async t => {
  for (const kind of ["whatsapp", "payment", "agreement"]) {
    const f = await fixture(t); await f.enroll();
    if (kind === "whatsapp") await f.sql.query('INSERT INTO "CreditOverdueDataAttempt" VALUES(1,$1,\'ACCEPTED\')', [fixed]);
    else await f.sql.query(`INSERT INTO "CreditMoraManagementEvent" ("id","creditoId","action","managementStatus","resultCode","actedAt","responsibleUserId","responsibleName","result","comment","nextFollowUpAt","actorUserId","actorName","idempotencyKey","requestHash","agreementDate","agreementAmount")
      VALUES($1,1,'LLAMADA',$2,$3,$4,51,'Synthetic','Synthetic','Synthetic',$5,51,'Synthetic',$1,$6,$7,$8)`,
      [eventId, kind === "agreement" ? "ACUERDO_PAGO" : "SEGUIMIENTO", kind === "payment" ? "PAGO_REALIZADO" : "ACUERDO_PAGO", fixed, new Date("2026-10-10T15:00:00Z"), "a".repeat(64), kind === "agreement" ? "2026-10-10" : null, kind === "agreement" ? 100 : null]);
    assert.equal((await f.store.claim(f.config, "2026-10-09T10:00")).length, 0, kind);
  }
});
test("weekly contact block expires without permanently holding an otherwise eligible member", async t => {
  const f = await fixture(t); await f.enroll();
  await f.sql.query('INSERT INTO "CreditOverdueDataAttempt" VALUES(1,$1,\'ACCEPTED\')', [fixed]);
  assert.equal((await f.store.claim(f.config, "2026-10-09T10:00")).length, 0); assert.equal((await f.members())[0].state, "ACTIVE");
  f.clock("2026-10-13T15:00:00Z"); assert.equal((await f.store.claim(f.config, "2026-10-13T10:00")).length, 1);
});
test("backend identity requires exact document and registered name, returns fresh exact spoken amount", async t => {
  const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
  const wrong = await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "ANA MARIA PRUEBA", customerDocument: "001234562" });
  assert.equal(wrong.verificado, false); assert.equal(wrong.credito, undefined);
  const good = await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "Ana Maria Prueba", customerDocument: "001234561" });
  assert.equal(good.verificado, true); assert.equal(good.credito.valorVencido, 159150);
  assert.equal(good.credito.speech.valorVencido, "ciento cincuenta y nueve mil ciento cincuenta pesos");
  assert.equal(good.credito.speech.diasMora, "veintidós días");
  assert.equal(JSON.stringify(good).includes("001234561"), false);
});
test("identity limit, rollback and fast callback preserve separate exactly-once event", async t => {
  const f = await fixture(t); await f.enroll(); f.failNext(); await assert.rejects(f.store.claim(f.config, "2026-10-09T10:00"), /rollback/);
  assert.equal((await f.events()).length, 0); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
  for (let i = 0; i < 3; i++) assert.equal((await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "Wrong Name", customerDocument: "001234561" })).verificado, false);
  assert.equal((await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "Ana Maria Prueba", customerDocument: "001234561" })).verificado, false);
  const result = { eventId: claim.eventId, creditId: 1, providerCallId: "call-fast", outcome: "HUMAN_CONTACT", resultCode: "HUMAN_CONTACT", completedAt: null };
  await f.store.saveResult(result); await f.store.accepted(claim.eventId, "call-fast");
  assert.equal((await f.events())[0].status, "COMPLETED"); assert.equal((await f.members())[0].state, "CONTACTED");
  assert.equal((await f.store.saveResult(result)).unchanged, true);
  await assert.rejects(f.store.saveResult({ ...result, providerCallId: "call-wrong" }), /CALL_CONFLICT/);
});
test("controlled test targets allowlisted owner, keeps customer snapshot and cannot claim another event", async t => {
  const f = await fixture(t); await f.enroll();
  await assert.rejects(f.store.prepareControlledTest({ creditId: 1, expectedPhone: "3000000001", testPhone: "3000000002" }), /TEST_DESTINATION_NOT_ALLOWED/);
  const claim = await f.store.prepareControlledTest({ creditId: 1, expectedPhone: "3000000001", testPhone: "3000009999" });
  assert.equal(claim.destination, "573000009999"); assert.equal(claim.snapshot.phone, "573000000001");
  assert.equal((await f.store.prepare(claim.eventId)).destination, "573000009999");
  await assert.rejects(f.store.prepareControlledTest({ creditId: 1, expectedPhone: "3000000001", testPhone: "3000009999" }), /TEST_ALREADY_ATTEMPTED/);
  f.testPhone(null); assert.equal(await f.store.prepare(claim.eventId), null);
});
test("management is appended atomically as actor51, idempotent and never an agreement or applied payment", async t => {
  const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
  const input = { result: "PAGO_REALIZADO", comment: "El cliente reporta pago, pendiente de verificar.", nextFollowUpAt: "2026-10-09T20:00:00Z" };
  await assert.rejects(f.store.recordManagement({ eventId: claim.eventId }, input), /IDENTITY_REQUIRED/);
  await f.store.accepted(claim.eventId, "call-management");
  await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "Ana Maria Prueba", customerDocument: "001234561" });
  f.failNext(); await assert.rejects(f.store.recordManagement({ eventId: claim.eventId }, input), /rollback/);
  assert.equal((await f.sql.query('SELECT * FROM "CreditMoraManagementEvent"')).rows.length, 0);
  const result = await f.store.recordManagement({ eventId: claim.eventId }, input); assert.equal(result.unchanged, false);
  assert.equal((await f.store.recordManagement({ eventId: claim.eventId }, input)).unchanged, true);
  await assert.rejects(f.store.recordManagement({ eventId: claim.eventId }, { ...input, comment: "Contenido diferente del original." }), /RESULT_CONFLICT/);
  const row = (await f.sql.query('SELECT * FROM "CreditMoraManagementEvent"')).rows[0];
  assert.equal(row.actorUserId, 51); assert.equal(row.responsibleUserId, 51); assert.equal(row.resultCode, "PAGO_REALIZADO");
  assert.equal(row.managementStatus, "SEGUIMIENTO"); assert.equal(row.agreementDate, null); assert.equal(row.agreementAmount, null);
  assert.deepEqual((await f.sql.query('SELECT "data" FROM "Credito" WHERE "id"=1')).rows[0].data.abonos, []);
});
test("management refuses payment or revoked consent before its transaction commits", async t => {
  for (const change of ["paid", "revoked"]) {
    const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
    await f.store.accepted(claim.eventId, "call-revalidate");
    await f.store.verifyIdentity({ eventId: claim.eventId, customerName: "Ana Maria Prueba", customerDocument: "001234561" });
    if (change === "paid") await f.update(1, { abonos: [{ valor: 477450, fechaAbono: "2026-10-09T15:00:00Z" }] });
    else await f.sql.query('UPDATE "CollectionsVoiceConsent" SET "revokedAt"=$1', [fixed]);
    await assert.rejects(f.store.recordManagement({ eventId: claim.eventId }, { result: "MEDIOS_PAGO", comment: "Solicita medios de pago.", nextFollowUpAt: "2026-10-09T20:00:00Z" }), /CONTACT_CHANGED/);
    assert.equal((await f.sql.query('SELECT * FROM "CreditMoraManagementEvent"')).rows.length, 0);
  }
});
test("explicit opt-out revokes recorded authorization and prevents a later campaign", async t => {
  const f = await fixture(t); await f.enroll(); const [claim] = await f.store.claim(f.config, "2026-10-09T10:00");
  await f.store.saveResult({ eventId: claim.eventId, creditId: 1, providerCallId: "call-optout", outcome: "OPT_OUT", resultCode: "OPT_OUT", completedAt: null });
  assert.equal((await f.members())[0].state, "STOPPED");
  assert.ok((await f.sql.query('SELECT "revokedAt" FROM "CollectionsVoiceConsent"')).rows[0].revokedAt);
  const later = { ...f.config, id: "later-synthetic" }; await f.store.ensureCampaign(later); f.clock("2026-10-09T19:00:00Z");
  assert.equal((await f.store.claim(later, "2026-10-09T14:00")).length, 0);
});

const http = loadReissueModule("lib/collections-voice-http.ts", { "@/lib/credit-welcome-voice-document": document, "@/lib/collections-voice-core": core });
function callback(changes = {}) {
  return { call_id: "call-synthetic", agent_id: agentId, call_status: "ended", disconnection_reason: "agent_hangup",
    dynamic_variables: { event_id: eventId, credito_id: "1", event_token: core.createCollectionsVoiceToken({ eventId, creditId: 1 }, secret) }, ...changes };
}
test("callbacks do not mistake model recording refusal, one greeting, voicemail or failure for proof", () => {
  for (const changes of [{ transcript_object: [{ role: "user", content: "No, Ana Maria Prueba" }], call_analysis: { custom_analysis_data: { recording_accepted: false } } },
    { call_status: "failed", disconnection_reason: "concurrency_limit" }]) assert.equal(http.parseCollectionsVoiceCallback({ call: callback(changes) }, secret, agentId).outcome, "UNCERTAIN");
  assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ transcript_object: [{ role: "user", content: "Deje su mensaje" }], call_analysis: { in_voicemail: true } }) }, secret, agentId).outcome, "NO_ANSWER");
  assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ disconnection_reason: "voicemail_reached" }) }, secret, agentId).outcome, "NO_ANSWER");
  assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ transcript_object: [{ role: "user", content: "Ana Prueba" }], disconnection_reason: "voicemail_reached" }) }, secret, agentId).outcome, "UNCERTAIN");
  assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ transcript_object: [{ role: "user", content: "Ana Prueba" }, { role: "user", content: "00123456" }], call_analysis: { in_voicemail: true } }) }, secret, agentId).outcome, "UNCERTAIN");
  assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ call_status: "no_answer", disconnection_reason: "dial_no_answer" }) }, secret, agentId).outcome, "NO_ANSWER");
  for (const content of ["No me llame", "No autorizo que me graben", "No quiero que me llamen", "No acepto la grabación"]) {
    assert.equal(http.parseCollectionsVoiceCallback({ call: callback({ transcript_object: [{ role: "user", content }] }) }, secret, agentId).outcome, "OPT_OUT", content);
  }
  assert.throws(() => http.parseCollectionsVoiceCallback({ call: callback({ agent_id: eventId }) }, secret, agentId), /SCOPE/);
});
test("HTTP identity canonicalizes spoken document, never reads finances before backend verification", async () => {
  const seen = []; const handlers = http.createCollectionsVoiceHandlers({ flowSecret: () => flowSecret, tokenSecret: () => secret, agentId: () => agentId,
    verifyIdentity: async input => { seen.push(input); return { verificado: false }; }, saveResult: async () => ({}), recordManagement: async () => ({}) });
  const request = (value, auth = flowSecret) => new Request("https://example.invalid/identidad", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth }, body: JSON.stringify(value) });
  const input = { event_id: eventId, customer_name: "Ana Prueba", customer_document: "cero cero uno dos tres cuatro cinco seis" };
  assert.equal((await handlers.identity(request(input, "wrong"))).status, 401); assert.equal(seen.length, 0);
  assert.equal((await handlers.identity(request(input))).status, 200); assert.equal(seen[0].customerDocument, "00123456");
  assert.equal((await handlers.management(request({ event_id: eventId, result: "ACUERDO_PAGO", agreementConfirmed: true }))).status, 400);
});
test("dispatcher keeps only routing/scope vars, no financial or identity data; uncertain receipts never retry", async () => {
  const prepared = { eventId, creditId: 1, destination: "573000009999", snapshot: { name: "ana prueba", document: "00123456", phone: "573000000001" }, source: "CONTROLLED_TEST" };
  const calls = [], marks = [];
  const store = { prepare: async () => prepared, accepted: async (...v) => marks.push(["accepted", ...v]), unknown: async (...v) => marks.push(["unknown", ...v]) };
  const dispatch = loadReissueModule("lib/collections-voice-dispatch.ts", { "@/lib/collections-voice-core": core,
    "@/lib/collections-voice-store": { collectionsVoiceStore: store }, "@/lib/credit-welcome-voice-dispatch": receiptModule }, { AbortSignal });
  const config = core.getCollectionsVoiceConfig(environment());
  await dispatch.dispatchCollectionsVoiceEvent({ ...prepared, destination: "573000000001" }, config, { store,
    fetcher: async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ ok: true, call_id: "call-native" }); } });
  assert.equal(calls[0].to_number, "+573000009999"); assert.equal(calls[0].from_number, "+573124085562");
  assert.deepEqual(Object.keys(calls[0]).sort(), ["agent_id", "credito_id", "event_id", "event_token", "from_number", "to_number"]);
  assert.equal(JSON.stringify(calls[0]).includes("ana prueba"), false);
  await dispatch.dispatchCollectionsVoiceEvent(prepared, config, { store, fetcher: async () => Response.json({ ok: true, call_id: "call-native", sibling: { error: "failed" } }) });
  assert.equal(marks.at(-1)[0], "unknown");
  await assert.rejects(dispatch.dispatchCollectionsVoiceEvent(prepared, { ...config, fromNumber: "+573000000001" }, { store }), /INVALID_COLLECTIONS_ORIGIN/);
});
test("disabled and closed windows never query schema/cohort or provider", async () => {
  const dispatch = loadReissueModule("lib/collections-voice-dispatch.ts", { "@/lib/collections-voice-core": core,
    "@/lib/collections-voice-store": {}, "@/lib/credit-welcome-voice-dispatch": receiptModule });
  const ensureSchema = async () => assert.fail("must not touch schema");
  assert.equal((await dispatch.runCollectionsVoiceCampaign({ env: {}, ensureSchema })).enabled, false);
  assert.equal((await dispatch.runCollectionsVoiceCampaign({ env: environment(), now: () => new Date("2026-10-11T15:00:00Z"), ensureSchema })).inWindow, false);
});
test("clock crossing after revalidation releases a known unsent event without HTTP", async () => {
  let instant = new Date("2026-10-09T15:29:59Z"); const released = [];
  const claim = { eventId, creditId: 1, destination: "573000000001", snapshot: {}, source: "CAMPAIGN" };
  const store = { prepare: async () => { instant = new Date("2026-10-09T15:30:00Z"); return claim; }, windowClosedBeforeDispatch: async id => released.push(id) };
  const dispatch = loadReissueModule("lib/collections-voice-dispatch.ts", { "@/lib/collections-voice-core": core,
    "@/lib/collections-voice-store": { collectionsVoiceStore: store }, "@/lib/credit-welcome-voice-dispatch": receiptModule });
  const result = await dispatch.dispatchCollectionsVoiceEvent(claim, core.getCollectionsVoiceConfig(environment()), { store, now: () => instant,
    fetcher: async () => assert.fail("must not call provider after window closes") });
  assert.equal(result, "SKIPPED"); assert.deepEqual(released, [eventId]);
});
