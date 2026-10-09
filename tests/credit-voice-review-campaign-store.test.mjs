import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditWelcomeVoiceSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const [core, plan, snapshot, cartera, phone, speech, policy] = await Promise.all([
  jiti.import("../lib/credit-welcome-voice-core.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/credit-factory-snapshot.ts"), jiti.import("../lib/cartera-export.ts"),
  jiti.import("../lib/dapta-welcome.ts"), jiti.import("../lib/credit-welcome-voice-speech.ts"),
  jiti.import("../lib/credit-voice-review-campaign-core.ts"),
]);
const sample = id => ({ id, folio: `FC-FIXTURE-${id}`, clienteNombre: "ANA MARIA PRUEBA",
  clienteDocumento: "00123456", clienteTelefono: "3000000001", referenciaEquipo: null, equipoMarca: null, equipoModelo: null,
  estado: "INSCRITO", pazYSalvoEmitidoAt: null, cuotaInicial: 200, montoCredito: 300, valorCuota: 100,
  plazoMeses: 3, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17", fechaProximoPago: "2026-10-17",
  contratoSnapshot: null, planCapitalVigente: null, abonos: [],
  amortizacion: { numeroCuotas: 3, cuotaComercial: "100.00", frecuenciaPago: "QUINCENAL", cuotas: [
    { numero: 1, fechaVencimiento: "2026-10-17", cuotaCobro: "100.00" },
    { numero: 2, fechaVencimiento: "2026-11-02", cuotaCobro: "100.00" },
    { numero: 3, fechaVencimiento: "2026-11-17", cuotaCobro: "100.00" },
  ] } });

async function fixture(t, { count = 1, enabled = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "data" JSONB NOT NULL);
    CREATE TABLE "CreditApprovalReview" ("creditoId" INTEGER PRIMARY KEY, "status" VARCHAR(16), "revision" INTEGER, "reviewHash" VARCHAR(64));`);
  for (let id = 1; id <= count; id++) {
    await db.query('INSERT INTO "Credito" VALUES ($1,$2::jsonb)', [id, JSON.stringify(sample(id))]);
    await db.query('INSERT INTO "CreditApprovalReview" VALUES ($1,\'PENDING\',1,$2)', [id, "a".repeat(64)]);
  }
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  let time = new Date("2026-10-09T13:00:00Z"), queries = 0;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).affectedRows; },
    credito: { findUnique: async ({ where }) => (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null },
  });
  const client = { ...adapter(db), $transaction: (callback, options) => {
    if (options) assert.equal(options.timeout, 30_000);
    return db.transaction(connection => callback(adapter(connection)));
  } };
  const loaded = loadReissueModule("lib/credit-welcome-voice-store.ts", {
    "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
    "@/lib/prisma": { default: client }, "@/lib/credit-payment-plan": plan,
    "@/lib/credit-factory-snapshot": snapshot, "@/lib/cartera-export": cartera,
    "@/lib/dapta-welcome": phone, "@/lib/credit-welcome-voice-core": core,
    "@/lib/credit-welcome-voice-speech": speech, "@/lib/credit-voice-review-campaign-core": policy,
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  }, { process: { env: {} } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => enabled, now: () => time });
  const config = { id: "pending-fixture", startDate: "2026-10-09", creditIds: Array.from({ length: count }, (_, i) => i + 1) };
  const ensure = () => store.ensureVoiceReviewCampaign(config);
  const claim = (slot = "2026-10-09T08:00", limit = 25) => store.claimVoiceReviewCampaign({ campaignId: config.id, slot, limit });
  const rows = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId","attemptNumber"').then(r => r.rows);
  const members = () => db.query('SELECT * FROM "VoiceReviewCampaignMember" ORDER BY "creditoId"').then(r => r.rows);
  const update = (id, fields) => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(fields)]);
  const save = (event, fields = {}) => store.saveCreditWelcomeVoiceResult({ eventId: event.eventId, creditId: event.creditId,
    providerCallId: `call-fixture-${event.eventId}`, status: "COMPLETED", communicationOutcome: "NO_ANSWER", disconnectionReason: "dial_no_answer", ...fields });
  return { db, client, store, config, ensure, claim, rows, members, update, save,
    queries: () => queries, time: value => { time = new Date(value); } };
}

test("campaign creation freezes cohort, date and review revision; reconfiguration never refreshes them", async t => {
  const f = await fixture(t, { count: 3 });
  assert.equal((await f.ensure()).created, true);
  assert.equal((await f.store.ensureVoiceReviewCampaign({ ...f.config, creditIds: [3, 1, 2] })).created, false);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "revision"=2 WHERE "creditoId"=1');
  await f.ensure();
  assert.equal((await f.members())[0].reviewRevision, 1);
  await assert.rejects(f.store.ensureVoiceReviewCampaign({ ...f.config, creditIds: [1] }), e => e.code === "CAMPAIGN_CONFLICT");
  await assert.rejects(f.store.ensureVoiceReviewCampaign({ ...f.config, startDate: "2026-10-10" }), e => e.code === "CAMPAIGN_CONFLICT");
  await assert.rejects(f.db.exec('UPDATE "VoiceReviewCampaign" SET "creditIds"=\'[1]\'::jsonb'));
  await assert.rejects(f.db.exec('UPDATE "VoiceReviewCampaignMember" SET "reviewRevision"=2'));
});

test("disabled campaign performs no database access, and only the current Colombia slot can claim", async t => {
  const disabled = await fixture(t, { enabled: false });
  await assert.rejects(disabled.ensure(), e => e.code === "CAMPAIGN_DISABLED");
  assert.equal((await disabled.claim()).length, 0);
  assert.equal(disabled.queries(), 0);
  const f = await fixture(t);
  await f.ensure();
  assert.equal((await f.claim("2026-10-09T10:00")).length, 0);
  f.time("2026-10-09T13:10:00Z");
  assert.equal((await f.claim()).length, 0);
  f.time("2026-10-10T13:00:00Z");
  assert.equal((await f.claim("2026-10-10T08:00")).length, 0);
  assert.equal((await f.rows()).length, 0);
});

test("claims use frozen pending members only, max attempt plus one, and one event per slot", async t => {
  const f = await fixture(t, { count: 3 });
  f.config.creditIds = [1, 2];
  const previous = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "3000000001" });
  await f.save(previous, { communicationOutcome: "HUMAN_CONTACT", disconnectionReason: "user_hangup" });
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'APPROVED\' WHERE "creditoId"=2');
  await f.ensure();
  const results = await Promise.all([f.claim(), f.claim()]);
  assert.equal(results.flat().length, 1);
  const event = (await f.rows()).find(row => row.source === "SCHEDULED_CAMPAIGN");
  assert.equal(event.creditoId, 1);
  assert.equal(event.attemptNumber, 1);
  assert.equal(event.repeatOf, null);
  assert.equal(event.campaignSlot, "2026-10-09T08:00");
  assert.equal((await f.members()).find(row => row.creditoId === 2).state, "STOPPED");
  assert.equal((await f.rows()).some(row => row.creditoId === 3), false);
  assert.equal((await f.claim()).length, 0);
});

test("inflight uncertainty skips without permanently holding; an authenticated no-answer permits the next slot", async t => {
  const f = await fixture(t);
  await f.ensure();
  const first = (await f.claim())[0];
  await f.store.markCreditWelcomeVoiceDispatchUnknown(first.eventId);
  f.time("2026-10-09T15:00:00Z");
  assert.equal((await f.claim("2026-10-09T10:00")).length, 0);
  assert.equal((await f.members())[0].state, "ACTIVE");
  await f.save(first);
  const second = (await f.claim("2026-10-09T10:00"))[0];
  assert.ok(second && second.eventId !== first.eventId);
  assert.deepEqual(JSON.parse(JSON.stringify(second.snapshot)), JSON.parse(JSON.stringify(first.snapshot)));
  assert.equal((await f.rows())[1].attemptNumber, 2);
});

test("a non-test call already in flight blocks campaign redial", async t => {
  const f = await fixture(t);
  await f.client.$transaction(tx => f.store.enqueueCreditWelcomeVoice(tx, { creditId: 1, source: "NORMAL" }));
  const queued = (await f.store.claimPendingCreditWelcomeVoice())[0];
  await f.store.markCreditWelcomeVoiceDispatchAccepted(queued.eventId, "call-other");
  await f.ensure();
  assert.equal((await f.claim()).length, 0);
  assert.equal((await f.members())[0].state, "ACTIVE");
  assert.equal((await f.rows()).length, 1);
});

test("real communication stops retries, opt-out takes priority over identity, uncertain terminal results hold", async t => {
  const f = await fixture(t, { count: 4 });
  await f.ensure();
  const events = await f.claim();
  await f.save(events[0], { communicationOutcome: "HUMAN_CONTACT" });
  await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: events[1].eventId, creditId: 2, customerName: "Ana Maria Prueba", customerDocument: "00123456" });
  await f.save(events[1], { communicationOutcome: "UNCERTAIN" });
  await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: events[2].eventId, creditId: 3, customerName: "Ana Maria Prueba", customerDocument: "00123456" });
  await f.save(events[2], { communicationOutcome: "OPT_OUT" });
  await f.save(events[3], { communicationOutcome: "UNCERTAIN" });
  f.time("2026-10-09T15:00:00Z");
  assert.equal((await f.claim("2026-10-09T10:00")).length, 0);
  assert.deepEqual((await f.members()).map(row => row.state), ["CONTACTED", "CONTACTED", "STOPPED", "HELD"]);
});

test("review, contact, financial changes and paid credits are revalidated before retry", async t => {
  const f = await fixture(t, { count: 4 });
  await f.ensure();
  const events = await f.claim();
  for (const event of events) await f.save(event);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "revision"=2 WHERE "creditoId"=1');
  await f.update(2, { clienteTelefono: "3000000002" });
  await f.update(3, { cuotaInicial: 201 });
  await f.update(4, { estado: "PAGADO" });
  f.time("2026-10-09T15:00:00Z");
  assert.equal((await f.claim("2026-10-09T10:00")).length, 0);
  assert.deepEqual((await f.members()).map(row => [row.state, row.stopReason]), [
    ["HELD", "REVIEW_CHANGED"], ["HELD", "CONTACT_CHANGED"], ["HELD", "CONDITIONS_CHANGED"], ["STOPPED", "CREDIT_CLOSED"],
  ]);
});

test("prepare rechecks pending review and window, and a local window rejection can retry without a provider request", async t => {
  const f = await fixture(t, { count: 2 });
  await f.ensure();
  const events = await f.claim();
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'APPROVED\' WHERE "creditoId"=1');
  assert.equal(await f.store.prepareVoiceReviewCampaign(events[0].eventId), null);
  f.time("2026-10-09T13:10:00Z");
  assert.equal(await f.store.prepareVoiceReviewCampaign(events[1].eventId), null);
  assert.equal((await f.rows())[1].resultCode, "WINDOW_CLOSED_BEFORE_DISPATCH");
  f.time("2026-10-09T15:00:00Z");
  const retry = await f.claim("2026-10-09T10:00");
  assert.equal(retry.length, 1);
  assert.equal(retry[0].creditId, 2);
  assert.ok(await f.store.prepareVoiceReviewCampaign(retry[0].eventId));
});

test("callback outcomes and reasons persist with duplicate protection; legacy omitted fields keep the same result hash", async t => {
  const f = await fixture(t, { count: 2 });
  await f.ensure();
  const [first, second] = await f.claim();
  assert.equal((await f.save(first)).unchanged, false);
  assert.equal((await f.save(first)).unchanged, true);
  const row = (await f.rows())[0];
  assert.equal(row.communicationOutcome, "NO_ANSWER");
  assert.equal(row.disconnectionReason, "dial_no_answer");
  await assert.rejects(f.save(first, { communicationOutcome: "HUMAN_CONTACT" }), e => e.code === "RESULT_CONFLICT");
  await assert.rejects(f.save(second, { communicationOutcome: "YES" }), e => e.code === "INVALID_RESULT");
  await assert.rejects(f.save(second, { disconnectionReason: "unsafe reason" }), e => e.code === "INVALID_RESULT");
  const legacy = { eventId: second.eventId, creditId: second.creditId, providerCallId: "call-legacy", status: "COMPLETED" };
  assert.equal((await f.store.saveCreditWelcomeVoiceResult(legacy)).unchanged, false);
  assert.equal((await f.store.saveCreditWelcomeVoiceResult(legacy)).unchanged, true);
  assert.equal((await f.rows())[1].communicationOutcome, null);
});

test("database rejects campaign attempts without their frozen member and forbids mutable cohort expansion", async t => {
  const f = await fixture(t, { count: 2 });
  f.config.creditIds = [1];
  await f.ensure();
  await assert.rejects(f.db.exec(`INSERT INTO "VoiceReviewCampaignMember" ("campaignId","creditoId") VALUES ('pending-fixture',2)`));
  await assert.rejects(f.db.exec(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","status")
    VALUES ('11111111-1111-4111-8111-111111111111',1,'SCHEDULED_CAMPAIGN',1,'DISPATCHING')`));
  await assert.rejects(f.db.exec(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","campaignId","campaignSlot","status")
    VALUES ('11111111-1111-4111-8111-111111111111',2,'SCHEDULED_CAMPAIGN',1,'pending-fixture','2026-10-09T08:00','DISPATCHING')`));
  assert.equal((await f.rows()).length, 0);
});
