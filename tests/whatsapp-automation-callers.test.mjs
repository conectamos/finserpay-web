import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { reminderFixture } from "./credit-due-reminders-fixture.mjs";
import { overdueDataFixture, sampleOverdueDataCredit } from "./credit-overdue-data-fixture.mjs";
import { fixture as portfolioFixture } from "./cuotavencida-whatsapp-fixture.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1") } });
const { sendDaptaWelcome } = await jiti.import("../lib/dapta-welcome.ts");
const { whatsAppAutomationProvider } = await jiti.import("../lib/whatsapp-automation-provider.ts");
export const metaEnv = () => ({
  WHATSAPP_AUTOMATIONS_PROVIDER: "meta", WHATSAPP_ATTENTION_SEND_ENABLED: "true",
  WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true", WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "1162059967000416", WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "2148284059050848",
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "synthetic-test-credential-never-used-on-network",
  WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/2dias.png",
  WHATSAPP_AUTOMATIONS_CUOTAVENCIDA_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/cuotavencida.png",
  WHATSAPP_AUTOMATIONS_BLOQUEO_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/bloqueo.png",
});
const accepted = { status: "accepted", code: "META_ACCEPTED", providerMessageId: "wamid.synthetic-native" };

test("provider is explicit, defaults to Dapta and disables an unrecognized value", () => {
  assert.equal(whatsAppAutomationProvider({}), "dapta");
  assert.equal(whatsAppAutomationProvider({ WHATSAPP_AUTOMATIONS_PROVIDER: "meta" }), "meta");
  assert.equal(whatsAppAutomationProvider({ WHATSAPP_AUTOMATIONS_PROVIDER: "META" }), null);
});

test("welcome uses one stable per-credit native intent without a Dapta URL or fallback", async () => {
  const intents = [];
  const options = { enabled: true, env: metaEnv(), fetcher: () => assert.fail("No Dapta fallback"),
    sendMeta: async input => { intents.push(input); return { status: "unknown", code: "UNCONFIRMED" }; } };
  const credit = { creditId: 42, phone: "3001234567", name: "CLIENTE SINTETICO" };
  assert.equal(await sendDaptaWelcome(credit, options), "unknown");
  assert.equal(await sendDaptaWelcome(credit, options), "unknown");
  assert.equal(intents[0].operationKey, "bienvenida:credito:42");
  assert.equal(intents[1].operationKey, intents[0].operationKey, "the native durable store must see the same idempotent intent");
  assert.deepEqual(intents[0], { operationKey: "bienvenida:credito:42", template: "bienvenida", phone: "573001234567", body: ["CLIENTE SINTETICO"] });
  assert.equal(await sendDaptaWelcome(credit, { ...options, enabled: false }), "disabled");
  assert.equal(intents.length, 2);
});

for (const [campaign, template, now, bodyCount] of [
  ["before_due", "1_dia_falta", "2026-10-07T15:00:00Z", 2],
  ["due_today", "hoyvence", "2026-10-08T15:00:00Z", 2],
  ["two_days_before_due", "2dias", "2026-10-06T18:00:00Z", 1],
]) test(`native ${campaign} keeps its original installment ledger and exact template shape`, async t => {
  const sent = [];
  const f = await reminderFixture(t, { env: metaEnv(), now, url: "", sendMeta: async (input, options) => {
    assert.equal(f.inTransaction(), false);
    await options.withSendGuard(async () => { assert.equal(f.inTransaction(), true); sent.push(input); }); return accepted;
  } });
  const result = await f.run({ campaign, dryRun: false });
  assert.equal(result.provider, "meta"); assert.equal(result.configured, true); assert.equal(result.summary.accepted, 1);
  assert.equal(f.counts.sends, 0); assert.equal(sent.length, 1); assert.equal(sent[0].template, template);
  assert.equal(sent[0].body.length, bodyCount); assert.equal(sent[0].body[0], "CLIENTE PRUEBA");
  if (bodyCount === 2) assert.equal(sent[0].body[1], "FINSER PAY");
  const rows = await f.rows(); assert.equal(sent[0].operationKey, `reminder:${rows[0].id}`);
  assert.equal((await f.run({ campaign, dryRun: false })).summary.duplicates, 1); assert.equal(sent.length, 1);
});

test("reminder provider is pinned before claiming even if configuration changes during that run", async t => {
  const env = metaEnv(); let native = 0;
  const f = await reminderFixture(t, { env, afterActiveClaim: () => { env.WHATSAPP_AUTOMATIONS_PROVIDER = "dapta"; },
    sendMeta: async (_input, options) => { assert.equal(options.env.WHATSAPP_AUTOMATIONS_PROVIDER, "meta"); await options.withSendGuard(async () => { native++; }); return accepted; } });
  assert.equal((await f.run({ dryRun: false })).summary.accepted, 1); assert.equal(native, 1); assert.equal(f.counts.sends, 0);
});

for (const [response, state] of [[{ ok: true }, "ACCEPTED"], [{ error: true }, "FAILED"], [{ pending: true }, "UNKNOWN"]])
  test(`Dapta ${state} reminder is never resent after selecting Meta`, async t => {
    const env = { ...metaEnv(), WHATSAPP_AUTOMATIONS_PROVIDER: "dapta" }; let native = 0;
    const f = await reminderFixture(t, { env, response, sendMeta: async () => { native++; return accepted; } });
    await f.run({ dryRun: false }); assert.equal((await f.rows())[0].status, state);
    env.WHATSAPP_AUTOMATIONS_PROVIDER = "meta";
    assert.equal((await f.run({ dryRun: false })).summary.duplicates, 1);
    assert.equal(f.counts.sends, 1); assert.equal(native, 0);
  });

test("reminder financial eligibility is checked again after native preflight", async t => {
  let posts = 0; let f;
  f = await reminderFixture(t, { env: metaEnv(), sendMeta: async (_input, options) => {
    await f.updateCredit(1, { estado: "PAGADO" });
    try { await options.withSendGuard(async () => { posts++; }); return accepted; }
    catch { return { status: "failed", code: "REVALIDATION_FAILED" }; }
  } });
  assert.equal((await f.run({ dryRun: false })).summary.failed, 1); assert.equal(posts, 0); assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows())[0].status, "FAILED");
});

test("Datos keeps grouped credit coverage and never falls back after native uncertainty", async t => {
  const sent = [];
  const f = await overdueDataFixture(t, { env: metaEnv(), url: "", sendMeta: async (input, options) => {
    assert.equal(f.inTransaction(), false);
    await options.withSendGuard(async () => { assert.equal(f.inTransaction(), true); sent.push(input); });
    return { status: "unknown", code: "META_UNCONFIRMED" };
  } });
  const report = await f.run({ dryRun: false });
  assert.equal(report.configured, true); assert.equal(report.provider, "meta"); assert.equal(report.summary.unknown, 1);
  const rows = await f.rows(); assert.equal(sent[0].operationKey, `data:${rows[0].id}`);
  assert.equal(sent[0].template, "data"); assert.deepEqual(Array.from(sent[0].body), ["CLIENTE PRUEBA"]);
  assert.equal((await f.coverages()).length, 1);
  await f.restart()({ dryRun: false }); assert.equal(sent.length, 1); assert.equal(f.counts.sends, 0);
});

for (const campaign of ["reminder", "data"]) test(`${campaign} final native guard stops a prórroga committed during preflight`, async t => {
  let posts = 0; let f;
  const fixture = campaign === "reminder" ? reminderFixture : overdueDataFixture;
  f = await fixture(t, { env: metaEnv(), sendMeta: async (_input, options) => {
    assert.equal(f.inTransaction(), false);
    await f.database.query(`INSERT INTO "CreditMoraExceptionRequest" VALUES(1,'APPROVED',CURRENT_DATE + 2)`);
    try { await options.withSendGuard(async () => { posts++; }); return accepted; }
    catch { return { status: "failed", code: "REVALIDATION_FAILED" }; }
  } });
  assert.equal((await f.run({ dryRun: false })).summary.failed, 1);
  assert.equal(posts, 0); assert.equal(f.counts.sends, 0); assert.equal((await f.rows())[0].status, "FAILED");
  await f.run({ dryRun: false }); assert.equal(posts, 0, "the rejected intent must not become a new automatic attempt");
});

test("Datos final native guard checks payment on every covered credit and keeps its original coverage", async t => {
  let posts = 0; let f;
  f = await overdueDataFixture(t, { env: metaEnv(), credits: [sampleOverdueDataCredit(1), sampleOverdueDataCredit(2)], sendMeta: async (_input, options) => {
    await f.updateCredit(2, { estado: "PAGADO" });
    try { await options.withSendGuard(async () => { posts++; }); return accepted; }
    catch { return { status: "failed", code: "REVALIDATION_FAILED" }; }
  } });
  assert.equal((await f.run({ dryRun: false })).summary.failed, 1);
  assert.equal(posts, 0); assert.equal(f.counts.sends, 0); assert.equal((await f.coverages()).length, 2);
});

for (const campaign of ["CUOTAVENCIDA", "BLOQUEO"]) test(`native ${campaign} starts outside finance locks and posts only inside its existing protection guard`, async t => {
  const f = await portfolioFixture(t, { campaign }); await f.create(); const sent = [];
  const { worker } = f.run({ env: { ...metaEnv(), [`DAPTA_${campaign}_ENABLED`]: "true" },
    fetcher: () => assert.fail("No Dapta fallback"), sendMeta: async (input, options) => {
      assert.equal(f.inTransaction(), false, "native outbox must not invert CRM/credit lock order");
      await options.withSendGuard(async () => { assert.equal(f.inTransaction(), true); sent.push(input); });
      return accepted;
    } });
  assert.equal((await worker()).accepted, 1); assert.equal((await f.events())[0].status, "ACCEPTED");
  assert.equal(sent[0].template, campaign.toLowerCase()); assert.equal(sent[0].body.length, campaign === "BLOQUEO" ? 0 : 1);
  assert.equal(sent[0].operationKey, `${campaign.toLowerCase()}:${(await f.events())[0].id}`);
  assert.equal((await worker()).selected, 0); assert.equal(sent.length, 1);
});

test("native portfolio preflight cannot bypass a newly added prórroga", async t => {
  const f = await portfolioFixture(t); await f.create(); let posts = 0;
  const { worker } = f.run({ env: { ...metaEnv(), DAPTA_CUOTAVENCIDA_ENABLED: "true" },
    fetcher: () => assert.fail("No Dapta fallback"), sendMeta: async (_input, options) => {
      await f.db.query(`INSERT INTO "CreditMoraExceptionRequest" VALUES(1,'PRORROGA','APPROVED',CURRENT_DATE + 2)`);
      try { await options.withSendGuard(async () => { posts++; }); return accepted; }
      catch { return { status: "failed", code: "REVALIDATION_FAILED" }; }
    } });
  assert.equal((await worker()).skipped, 1); assert.equal(posts, 0); assert.equal((await f.events())[0].status, "CANCELLED");
});

test("unknown provider and missing native header prevent any campaign claim", async t => {
  const f = await reminderFixture(t, { env: { ...metaEnv(), WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL: "" }, now: "2026-10-06T18:00:00Z" });
  assert.equal((await f.run({ campaign: "two_days_before_due", dryRun: false })).configured, false);
  assert.equal((await f.rows()).length, 0);
  const g = await overdueDataFixture(t, { env: { WHATSAPP_AUTOMATIONS_PROVIDER: "unknown" } });
  assert.equal((await g.run({ dryRun: false })).configured, false); assert.equal((await g.rows()).length, 0);
});
