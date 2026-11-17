import assert from "node:assert/strict";
import test from "node:test";
import { fixture, credit } from "./cuotavencida-whatsapp-fixture.mjs";
import { reminderFixture, sampleCredit } from "./credit-due-reminders-fixture.mjs";
import { overdueDataFixture, sampleOverdueDataCredit } from "./credit-overdue-data-fixture.mjs";

// Synthetic customer documents only; every transport below is intercepted locally.
const restricted = "990000001";
const allowed = "9900000011";
const live = { dryRun: false };
const accepted = { status: "accepted", code: "META_ACCEPTED", providerMessageId: "wamid.synthetic-restriction" };
const providerEnv = provider => ({
  WHATSAPP_AUTOMATIONS_PROVIDER: provider, WHATSAPP_ATTENTION_SEND_ENABLED: "true",
  WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true", WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "1162059967000416", WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "2148284059050848",
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "synthetic-test-token",
  WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/2dias.png",
  WHATSAPP_AUTOMATIONS_CUOTAVENCIDA_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/cuotavencida.png",
  WHATSAPP_AUTOMATIONS_BLOQUEO_HEADER_IMAGE_URL: "https://finserpay.com/whatsapp/templates/bloqueo.png",
});
const reminderCampaigns = [
  ["before_due", "2026-10-07T15:00:00Z"],
  ["due_today", "2026-10-08T15:00:00Z"],
  ["two_days_before_due", "2026-10-06T18:00:00Z"],
];

for (const provider of ["dapta", "meta"]) {
  for (const campaign of ["CUOTAVENCIDA", "BLOQUEO"]) {
    test(`${campaign}/${provider}: excludes only the complete restricted document in preview and batch`, async t => {
      const env = { ...providerEnv(provider), COLLECTION_CONTACT_EXCLUDED_DOCUMENTS: restricted, [`DAPTA_${campaign}_ENABLED`]: "true",
        [`DAPTA_${campaign}_WEBHOOK_URL`]: "https://api.dapta.ai/synthetic-restriction-test" };
      const f = await fixture(t, { campaign, restrictionEnv: env, credits: [
        credit(1, { clienteDocumento: "990.000.001" }), credit(2, { clienteDocumento: allowed }),
      ] });
      const before = (await f.db.query('SELECT "data" FROM "Credito" ORDER BY "id"')).rows;
      const preview = await f.store.previewCuotaVencidaWhatsApp();
      assert.equal(preview.stats.eligibleCredits, 1); assert.equal(preview.stats.excludedCredits, 1);
      assert.equal(preview.stats.excludedActiveMoraProtection, 0);
      assert.equal((await f.create()).batch.total, 1);
      const native = [];
      const { worker, sent } = f.run({ env, sendMeta: async (input, options) => {
        await options.withSendGuard(async () => native.push(input)); return accepted;
      } });
      assert.equal((await worker()).accepted, 1);
      assert.equal((provider === "meta" ? native : sent).length, 1);
      assert.equal((await f.events())[0].representativeCreditoId, 2);
      assert.deepEqual((await f.db.query('SELECT "data" FROM "Credito" ORDER BY "id"')).rows, before);
    });

    test(`${campaign}/${provider}: queued event is cancelled if restriction is added before HTTP`, async t => {
      const env = { ...providerEnv(provider), [`DAPTA_${campaign}_ENABLED`]: "true",
        [`DAPTA_${campaign}_WEBHOOK_URL`]: "https://api.dapta.ai/synthetic-restriction-test" };
      const f = await fixture(t, { campaign, restrictionEnv: env, credits: [credit(1, { clienteDocumento: restricted })] });
      await f.create(); let posts = 0;
      if (provider === "dapta") env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted;
      const { worker } = f.run({ env, fetcher: () => { posts++; assert.fail("Restricted document reached Dapta"); },
        sendMeta: async (_input, options) => {
          env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted;
          await options.withSendGuard(async () => { posts++; }); return accepted;
        } });
      assert.equal((await worker()).skipped, 1); assert.equal(posts, 0);
      const [event] = await f.events();
      assert.equal(event.status, "CANCELLED"); assert.equal(event.resultCode, "COLLECTION_CONTACT_RESTRICTED");
    });
  }

  for (const [campaign, now] of reminderCampaigns) {
    test(`${campaign}/${provider}: previews and sends only the unrestricted client`, async t => {
      const env = { ...providerEnv(provider), COLLECTION_CONTACT_EXCLUDED_DOCUMENTS: restricted };
      const native = [];
      const f = await reminderFixture(t, { env, now, credits: [
        sampleCredit(1, { clienteDocumento: restricted }),
        sampleCredit(2, { clienteDocumento: allowed, clienteTelefono: "3000000002" }),
      ], sendMeta: async (input, options) => { await options.withSendGuard(async () => native.push(input)); return accepted; } });
      const preview = await f.run({ campaign });
      assert.equal(preview.summary.excluded, 1); assert.equal(preview.summary.eligible, 1);
      assert.equal((await f.run({ ...live, campaign })).summary.accepted, 1);
      assert.equal((await f.rows())[0].creditoId, 2);
      assert.equal(f.counts.sends + native.length, 1);
    });

    test(`${campaign}/${provider}: rechecks live restrictions after preparing the claim`, async t => {
      const env = providerEnv(provider); let posts = 0;
      const f = await reminderFixture(t, { env, now, credits: [sampleCredit(1, { clienteDocumento: restricted })],
        beforeCreditRead: ({ reads }) => { if (provider === "dapta" && reads === 3) env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted; },
        sendMeta: async (_input, options) => {
          env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted;
          await options.withSendGuard(async () => { posts++; }); return accepted;
        } });
      const result = await f.run({ ...live, campaign });
      assert.equal(result.summary.revalidatedOut, 1); assert.equal(result.summary.accepted, 0);
      assert.equal(f.counts.sends + posts, 0); assert.equal((await f.rows()).length, 0);
    });
  }

  test(`DATOS/${provider}: excludes restricted documents without altering eligible credits`, async t => {
    const env = { ...providerEnv(provider), COLLECTION_CONTACT_EXCLUDED_DOCUMENTS: restricted };
    const native = [];
    const f = await overdueDataFixture(t, { env, credits: [
      sampleOverdueDataCredit(1, { clienteDocumento: restricted }),
      sampleOverdueDataCredit(2, { clienteDocumento: "990.000.001", clienteTelefono: "3000000002" }),
      sampleOverdueDataCredit(3, { clienteDocumento: allowed, clienteTelefono: "3000000003" }),
    ], sendMeta: async (input, options) => { await options.withSendGuard(async () => native.push(input)); return accepted; } });
    const preview = await f.run();
    assert.equal(preview.summary.excluded, 2); assert.equal(preview.summary.eligibleCredits, 1);
    assert.equal((await f.run(live)).summary.accepted, 1);
    assert.equal(f.counts.sends + native.length, 1);
    assert.deepEqual((await f.coverages()).map(row => row.creditoId), [3]);
  });

  test(`DATOS/${provider}: rechecks restricted documents after preparing coverage and releases unsent claim`, async t => {
    const env = providerEnv(provider); let posts = 0;
    const f = await overdueDataFixture(t, { env, credits: [sampleOverdueDataCredit(1, { clienteDocumento: restricted })],
      beforeCreditRead: ({ reads }) => { if (provider === "dapta" && reads === 3) env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted; },
      sendMeta: async (_input, options) => {
        env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = restricted;
        await options.withSendGuard(async () => { posts++; }); return accepted;
      } });
    const result = await f.run(live);
    assert.equal(result.summary.revalidatedOut, 1); assert.equal(result.summary.accepted, 0);
    assert.equal(f.counts.sends + posts, 0); assert.equal((await f.rows()).length, 0);
    assert.equal((await f.coverages()).length, 0);
  });
}
