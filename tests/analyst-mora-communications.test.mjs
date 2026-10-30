import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { analystMoraSchemaStatements } from "../scripts/analyst-mora-schema.mjs";
import { creditDueReminderSchemaStatements } from "../scripts/credit-due-reminders-schema.mjs";
import { automationProtectionFixture } from "./whatsapp-automation-protection-fixture.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1") } });
const reminderPolicy = await jiti.import("../lib/credit-due-reminder-policy.ts");
const datePolicy = await jiti.import("../lib/colombia-date.ts");
const collectionPolicy = await jiti.import("../lib/collection-voice-policy.ts");
const automation = await jiti.import("../lib/whatsapp-automation-provider.ts");
const normalize = value => typeof value === "string" && /^(?:57)?3\d{9}$/.test(value) ? value.length === 10 ? "57" + value : value : null;
class BusinessError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const key = "00000000-0000-4000-8000-000000000081";
const actor = { id: 51, nombre: "Analista sintético", centralAdmin: false };
const environment = {
  DAPTA_RECORDATORIO_1_DIA_ENABLED: "true", DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL: "https://api.dapta.ai/api/test-reminder-only",
  DAPTA_COBRANZA_ENABLED: "true", DAPTA_COBRANZA_LIVE_READY: "true", FINSERPAY_COBRANZA_API_TOKEN: "synthetic-test-secret-with-32-characters",
  FINSERPAY_COBRANZA_AGENT_ID: "synthetic-agent", FINSERPAY_COBRANZA_ACTOR_ID: "51", DAPTA_COBRANZA_CALL_WEBHOOK_URL: "https://api.dapta.ai/api/test-call-only",
};
async function fixture(t, options = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY,"clienteDocumento" TEXT,"data" JSONB NOT NULL);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (51);
    CREATE TABLE "CollectionVoiceAttempt" ("id" uuid PRIMARY KEY,"creditoId" integer,"debtorKey" text,"status" text,"providerCallId" text,"optOut" boolean DEFAULT false,"contactedAt" timestamptz,"outcome" jsonb,"managementId" uuid);
    CREATE TABLE "CreditOverdueDataAttempt" ("creditoId" integer,"status" text,"claimedAt" timestamptz);
    CREATE TABLE "CreditWelcomeVoiceEvent" ("creditoId" integer,"status" text,"identityVerifiedAt" timestamptz);`);
  for (const sql of analystMoraSchemaStatements()) await db.exec(sql);
  for (const sql of creditDueReminderSchemaStatements) await db.exec(sql);
  const initial = { id: 81, clienteNombre: "CLIENTE SINTETICO", clienteDocumento: "100000081", clienteTelefono: "3001234567", folio: "TEST-81", estado: "INSCRITO",
    montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-10-14", fechaProximoPago: "2026-10-14", abonos: [], ...options.credit };
  for (const credit of [initial, { ...initial, id: 82, clienteDocumento: "100000082", clienteTelefono: "3007654321", folio: "TEST-82" }])
    await db.query(`INSERT INTO "Credito" VALUES($1,$2,$3::jsonb)`, [credit.id, credit.clienteDocumento, JSON.stringify(credit)]);
  let clock = new Date("2026-10-13T17:30:00Z"), active = true, extensionReads = 0;
  const sends = [], calls = [], assertions = [];
  function adapter(connection) {
    return {
      $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
      $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows,
      credito: { findUnique: async ({ where }) => (await connection.query(`SELECT "data" FROM "Credito" WHERE "id"=$1`, [where.id])).rows[0]?.data || null },
    };
  }
  let transactions = 0, transactionDepth = 0;
  const database = { ...adapter(db), $transaction: async work => {
    transactions++;
    if (options.revokeAtTransaction === transactions) active = false;
    return db.transaction(async tx => {
      transactionDepth++;
      try { return await work(adapter(tx)); } finally { transactionDepth--; }
    });
  } };
  const transport = loadReissueModule("lib/credit-due-reminders.ts", {
    "@/lib/prisma": { default: database }, "@/lib/colombia-date": datePolicy,
    "@/lib/dapta-welcome": { normalizeColombianMobile: normalize }, "@/lib/credit-due-reminder-policy": reminderPolicy,
    "@/lib/whatsapp-automation-provider": automation,
    "@/lib/mora-message-protection": automationProtectionFixture(database),
  }, { AbortSignal, fetch: () => assert.fail("No real network in tests") });
  const modules = {
    "@/lib/prisma": { default: database },
    "@/lib/analyst-mora-access": { assertMoraActor: async (_db, candidate) => { assertions.push(candidate.id); if (!active) throw new BusinessError("FORBIDDEN", "Permiso revocado", 403); return candidate; } },
    "@/lib/analyst-mora-credit": { moraCreditSelect: {} },
    "@/lib/analyst-mora-management": { getCreditManagement: async id => {
      const credit = await database.credito.findUnique({ where: { id } });
      if (!credit) throw new BusinessError("CREDIT_NOT_FOUND", "No encontrado", 404);
      return { credit: { ...credit, numeroCreditoVisible: credit.folio,
        estadoCartera: credit.pazYSalvoEmitidoAt ? "PAGADO" : credit.estado === "ANULADO" ? "ANULADO" : options.overdue ? "EN_MORA" : "AL_DIA",
        enMora: options.overdue === true, prorrogaActiva: options.extension ? { id: "extension" } : null }, history: [] };
    } },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-extension": { readActiveMoraExtensions: async ids => {
      extensionReads++; return new Map(options.extensionAtRead && extensionReads >= options.extensionAtRead ? ids.map(id => [id, { id: "extension" }]) : []);
    } },
    "@/lib/credit-approval-errors": { CreditApprovalError: BusinessError },
    "@/lib/dapta-welcome": { normalizeColombianMobile: normalize },
    "@/lib/credit-due-reminder-policy": reminderPolicy,
    "@/lib/credit-due-reminders": transport,
    "@/lib/collection-voice-policy": collectionPolicy,
    "@/lib/collection-voice-runtime": { ensureCollectionVoiceSchema: async () => {}, runCollectionVoice: async input => {
      calls.push(input); await input.beforeDispatch();
      await db.query(`INSERT INTO "CollectionVoiceAttempt"("id","creditoId","status","providerCallId") VALUES($1,$2,'ACCEPTED','synthetic-provider-call')`, [input.requestId, input.creditId]);
      return { accepted: 1 };
    } },
  };
  const loaded = loadReissueModule("lib/credit-collection-communications.ts", modules, { AbortSignal, fetch: () => assert.fail("No real network in tests") });
  const service = loaded.createCreditCommunicationService({ database, env: { ...environment, ...options.env }, sendMeta: options.sendMeta, now: () => new Date(clock), schema: async () => {}, fetcher: async (url, init) => {
    sends.push({ url: String(url), body: JSON.parse(init.body), assertions: assertions.length });
    if (options.networkError) throw new Error("private transport detail must not leak");
    return new Response(options.rawResponse ?? JSON.stringify(options.providerResponse ?? { ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  return { db, service, loaded, sends, calls, assertions, inTransaction: () => transactionDepth > 0, setClock: value => { clock = new Date(value); },
    update: (id, values) => db.query(`UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1`, [id, JSON.stringify(values)]),
    rows: () => db.query(`SELECT * FROM "CreditCollectionCommunicationEvent" ORDER BY "createdAt","id"`) };
}
const input = (overrides = {}) => ({ action: "REMINDER", expectedPhone: "573001234567", idempotencyKey: key, ...overrides });
const nativeEnvironment = { WHATSAPP_AUTOMATIONS_PROVIDER: "meta", WHATSAPP_ATTENTION_SEND_ENABLED: "true",
  WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true", WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "1162059967000416", WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "2148284059050848",
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "synthetic-not-a-real-token", DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL: "" };

test("selected-credit native reminder keeps the same ledger and guards only HTTP under finance locks", async t => {
  const native = []; let f;
  f = await fixture(t, { env: nativeEnvironment, sendMeta: async (request, options) => {
    assert.equal(f.inTransaction(), false);
    await options.withSendGuard(async () => { assert.equal(f.inTransaction(), true); native.push(request); });
    return { status: "accepted", code: "META_ACCEPTED", providerMessageId: "wamid.synthetic-selected" };
  } });
  const response = await f.service.dispatch(81, input(), actor);
  assert.equal(response.state.history[0].status, "ACCEPTED");
  assert.match(response.state.history[0].message, /Meta aceptó/);
  assert.equal(native.length, 1); assert.equal(native[0].template, "1_dia_falta");
  assert.equal(native[0].phone, input().expectedPhone); assert.match(native[0].operationKey, /^reminder:/);
  assert.equal(f.sends.length, 0); assert.equal(f.calls.length, 0);
  await f.service.dispatch(81, input(), actor); assert.equal(native.length, 1);
});

test("selected-credit native guard stops a prórroga approved after the claim", async t => {
  let posts = 0;
  const f = await fixture(t, { env: nativeEnvironment, extensionAtRead: 2, sendMeta: async (_request, options) => {
    try { await options.withSendGuard(async () => { posts++; }); return { status: "accepted", code: "META_ACCEPTED" }; }
    catch { return { status: "failed", code: "REVALIDATION_FAILED" }; }
  } });
  await f.service.dispatch(81, input(), actor); assert.equal(posts, 0); assert.equal(f.sends.length, 0);
});

test("manual reminder sends exactly selected credit outside cron hour and preserves audit when paid", async t => {
  const f = await fixture(t);
  const state = await f.service.state(81);
  assert.equal(state.capabilities.reminder.available, true);
  assert.match(state.capabilities.whatsappHref, /^https:\/\/wa\.me\/573001234567\?text=/);
  assert.equal(reminderPolicy.isCreditDueReminderWindow(new Date("2026-10-13T17:30:00Z")), false);
  const result = await f.service.dispatch(81, input(), actor);
  assert.equal(result.state.history[0].status, "ACCEPTED");
  assert.match(result.state.history[0].message, /no confirma entrega/);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].body.credito_id, "81");
  assert.equal(f.sends[0].body.telefono, "573001234567");
  assert.ok(f.sends[0].assertions >= 4, "actor revalidated before outbound side effect");
  await f.update(81, { pazYSalvoEmitidoAt: "2026-10-13T18:00:00Z" });
  const afterPayment = await f.service.state(81);
  assert.equal(afterPayment.capabilities.reminder.available, false);
  assert.equal(afterPayment.history[0].requestId, key);
  assert.equal(afterPayment.history[0].status, "ACCEPTED");
  assert.equal((await f.service.list(82)).length, 0);
  await assert.rejects(f.db.exec(`DELETE FROM "CreditCollectionCommunicationEvent"`), /inmutable/);
  await assert.rejects(f.db.exec(`UPDATE "CreditCollectionCommunicationEvent" SET "message"='changed'`), /inmutable/);
});
test("same idempotency key never resends including unknown network outcome", async t => {
  const f = await fixture(t, { networkError: true });
  const first = await f.service.dispatch(81, input(), actor);
  assert.equal(first.state.history[0].status, "UNKNOWN");
  const second = await f.service.dispatch(81, input(), actor);
  assert.equal(second.unchanged, true); assert.equal(f.sends.length, 1);
  const third = await f.service.dispatch(81, input({ idempotencyKey: "00000000-0000-4000-8000-000000000082" }), actor);
  assert.equal(third.state.history[0].status, "SKIPPED"); assert.equal(f.sends.length, 1);
  await assert.rejects(f.service.dispatch(82, input({ expectedPhone: "573007654321" }), actor), error => error.code === "IDEMPOTENCY_CONFLICT");
});
test("role revoked immediately before network prevents provider call", async t => {
  const f = await fixture(t, { revokeAtTransaction: 4 });
  const result = await f.service.dispatch(81, input(), actor);
  assert.equal(f.sends.length, 0); assert.equal(result.state.history[0].status, "SKIPPED");
});
test("extension approved after claim is checked under credit lock before HTTP", async t => {
  const f = await fixture(t, { extensionAtRead: 2 });
  const result = await f.service.dispatch(81, input(), actor);
  assert.equal(result.state.history[0].status, "SKIPPED"); assert.equal(f.sends.length, 0);
  assert.equal((await f.db.query(`SELECT * FROM "CreditDueReminder"`)).rows.length, 0);
});
test("another campaign's unknown attempt suppresses manual reminder", async t => {
  const f = await fixture(t);
  await f.db.exec(`INSERT INTO "CreditOverdueDataAttempt" VALUES(81,'UNKNOWN','2026-10-13T17:00:00Z')`);
  const result = await f.service.dispatch(81, input(), actor);
  assert.equal(result.state.history[0].status, "SKIPPED"); assert.equal(f.sends.length, 0);
});
test("paid, cancelled, wrong date, outside hours and disabled template never send", async t => {
  for (const options of [{ credit: { pazYSalvoEmitidoAt: "2026-10-12T18:00:00Z" } }, { credit: { estado: "ANULADO" } },
    { credit: { fechaPrimerPago: "2026-10-24", fechaProximoPago: "2026-10-24" } }, { env: { DAPTA_RECORDATORIO_1_DIA_ENABLED: "false" } }]) {
    const f = await fixture(t, options); await f.service.dispatch(81, input(), actor); assert.equal(f.sends.length, 0);
  }
  const f = await fixture(t); f.setClock("2026-10-13T02:00:00Z");
  await f.service.dispatch(81, input(), actor); assert.equal(f.sends.length, 0);
});
test("tampered destination is rejected and old provider rejection is never called delivery", async t => {
  const f = await fixture(t, { providerResponse: { ok: false, error: "synthetic provider rejected" } });
  await assert.rejects(f.service.dispatch(81, input({ expectedPhone: "573007654321" }), actor), error => error.code === "CONTACT_CHANGED");
  assert.equal(f.sends.length, 0);
  const result = await f.service.dispatch(81, input(), actor);
  assert.equal(result.state.history[0].status, "FAILED"); assert.equal(f.sends.length, 1);
  assert.equal(JSON.stringify(result).includes("private transport detail"), false);
});
test("call delegates exact credit and durable request id, never a full portfolio dispatch", async t => {
  const f = await fixture(t, { overdue: true });
  const result = await f.service.dispatch(81, input({ action: "CALL" }), actor);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].creditId, 81); assert.equal(f.calls[0].requestId, key); assert.equal(f.calls[0].limit, 1);
  assert.equal(result.state.history[0].status, "ACCEPTED"); assert.equal(result.state.history[0].providerReference, "synthetic-provider-call");
  assert.equal(f.sends.length, 0);
});
test("body cannot inject financial values, arbitrary URL, actor or phone overrides", async t => {
  const f = await fixture(t);
  for (const value of [null, [], input({ montoCredito: 1 }), input({ url: "https://attacker.test" }), input({ actorUserId: 99 }), input({ expectedPhone: "+573001234567" }), input({ action: "BULK" })])
    assert.throws(() => f.loaded.parseCreditCommunication(value));
});
