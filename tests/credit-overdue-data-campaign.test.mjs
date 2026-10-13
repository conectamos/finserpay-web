import assert from "node:assert/strict";
import test from "node:test";
import { overdueDataFixture, sampleOverdueDataCredit } from "./credit-overdue-data-fixture.mjs";

const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const live = { dryRun: false };

// PGlite serializes transactions. The overlap tests exercise production SQL
// locks and constraints through that scheduler, not separate database servers.
test("preview scans 501 credits, excludes invalid and non-exact-20-day rows, and exposes no PII or writes", async t => {
  const credits = Array.from({ length: 501 }, (_, index) => sampleOverdueDataCredit(index + 1));
  credits[0].clienteTelefono = "1111";
  credits[1].estado = "ANULADO";
  credits[2].fechaPrimerPago = "2026-09-18";
  credits[3].fechaPrimerPago = "2026-09-16";
  const f = await overdueDataFixture(t, { credits, enabled: false });
  const report = await f.run();
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.scanned, 501);
  assert.equal(report.summary.eligibleCredits, 497);
  assert.equal(report.summary.eligibleClients, 1);
  assert.equal(report.summary.excluded, 4);
  assert.equal(report.summary.ready, 1);
  assert.equal(f.counts.pages, 4);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients()).length, 0);
  assert.equal((await f.coverages()).length, 0);
  assert.doesNotMatch(JSON.stringify(report), /CLIENTE PRUEBA|3000000001|telefono|nombre|https:\/\//);
});

test("live delivery requires exact true, exact HTTPS Dapta host, Bogotá hour and valid start date", async t => {
  const env = {};
  const f = await overdueDataFixture(t, { useEnvironmentConfig: true, env });
  const validUrl = "https://api.dapta.ai/api/test-only-datos";
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    if (flag === undefined) delete env.DAPTA_DATOS_ENABLED;
    else env.DAPTA_DATOS_ENABLED = flag;
    env.DAPTA_DATOS_WEBHOOK_URL = validUrl;
    const report = await f.run(live);
    assert.equal(report.enabled, false);
    assert.equal(report.summary.scanned, 0);
  }
  env.DAPTA_DATOS_ENABLED = "true";
  for (const url of ["", "http://api.dapta.ai/test", "https://attacker.invalid/test",
    "https://api.dapta.ai.attacker.invalid/test", "https://user:password@api.dapta.ai/test", "https://api.dapta.ai:444/test"]) {
    env.DAPTA_DATOS_WEBHOOK_URL = url;
    const report = await f.run(live);
    assert.equal(report.configured, false, url);
    assert.equal(report.summary.scanned, 0);
  }
  env.DAPTA_DATOS_WEBHOOK_URL = validUrl;
  for (const now of ["2026-10-07T14:59:59.999Z", "2026-10-07T16:00:00.000Z"]) {
    f.setClock(now);
    const report = await f.run(live);
    assert.equal(report.inWindow, false);
    assert.equal(report.summary.scanned, 0);
  }
  f.setClock("2026-10-07T15:00:00Z");
  env.DAPTA_DATOS_START_DATE = "2026-10-08";
  const beforeStart = await f.run(live);
  assert.equal(beforeStart.startsOn, "2026-10-08");
  assert.equal(beforeStart.configured, true);
  assert.equal(beforeStart.inWindow, false);
  assert.equal(beforeStart.summary.scanned, 0);
  const preview = await f.run({ dryRun: true, previewDate: "2026-10-08" });
  assert.equal(preview.summary.eligibleClients, 0);
  env.DAPTA_DATOS_START_DATE = "2026-02-30";
  assert.equal((await f.run(live)).configured, false);
  assert.equal((await f.run()).summary.eligibleClients, 1);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);
  env.DAPTA_DATOS_START_DATE = "2026-10-08";
  f.setClock("2026-10-08T15:00:00Z");
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-18" });
  const started = await f.run(live);
  assert.equal(started.summary.accepted, 1);
  assert.deepEqual(f.webhooks, [validUrl]);
});

test("one mobile receives one message and every exact-20-day credit in its group is covered", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1), sampleOverdueDataCredit(2),
    sampleOverdueDataCredit(3, { fechaPrimerPago: "2026-09-18" }),
    sampleOverdueDataCredit(4, { clienteTelefono: "3000000004" }),
    sampleOverdueDataCredit(5, { fechaPrimerPago: "2026-09-01" }),
  ] });
  const report = await f.run(live);
  assert.equal(report.summary.eligibleCredits, 3);
  assert.equal(report.summary.eligibleClients, 2);
  assert.equal(report.summary.excluded, 2);
  assert.equal(report.summary.accepted, 2);
  assert.equal(f.counts.sends, 2);
  assert.deepEqual(f.payloads, [
    { credito_id: "1", telefono: "573000000001", nombre: "CLIENTE PRUEBA", dias_mora: "20" },
    { credito_id: "4", telefono: "573000000004", nombre: "CLIENTE PRUEBA", dias_mora: "20" },
  ]);
  assert.deepEqual((await f.rows()).map(row => [row.creditoId, row.daysPastDue, row.status]), [
    [1, 20, "ACCEPTED"], [4, 20, "ACCEPTED"],
  ]);
  const coverage = await f.coverages();
  assert.deepEqual(coverage.map(row => row.creditoId), [1, 2, 4]);
  assert.equal(coverage[0].attemptId, coverage[1].attemptId);
  const serialized = JSON.stringify({ report, recipients: await f.recipients(), attempts: await f.rows(), coverage });
  assert.doesNotMatch(serialized, /CLIENTE PRUEBA|573000000001|telefono|nombre/);
});

test("a credit is notified once even if it later returns to exactly 20 days or changes mobile", async t => {
  const f = await overdueDataFixture(t, { now: "2026-10-07T15:30:00Z" });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal((await f.coverages()).length, 1);
  await f.updateCredit(1, { clienteTelefono: "3000000002" });
  assert.equal((await f.run(live)).summary.waiting, 1);
  for (const date of ["2026-10-08", "2026-10-09"]) {
    f.setClock(date + "T15:00:00Z");
    const report = await f.run(live);
    assert.equal(report.summary.eligibleCredits, 0);
    assert.equal(f.counts.sends, 1);
  }
  f.setClock("2026-10-10T14:59:59.999Z");
  assert.equal((await f.run(live)).inWindow, false);
  assert.equal(f.counts.sends, 1);
  f.setClock("2026-10-10T15:00:00Z");
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-20" });
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 1);
  assert.deepEqual((await f.rows()).map(row => day(row.campaignDate)), ["2026-10-07"]);
});

test("a new credit on the same mobile has no three-day cooldown, while old coverage remains permanent", async t => {
  const f = await overdueDataFixture(t, { credits: [sampleOverdueDataCredit(1),
    sampleOverdueDataCredit(2, { fechaPrimerPago: "2026-09-18" })] });
  assert.equal((await f.run(live)).summary.accepted, 1);
  await f.database.query('UPDATE "CreditOverdueDataRecipient" SET "nextEligibleDate"=$1::date', ["2026-10-10"]);
  f.setClock("2026-10-08T15:00:00Z");
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.deepEqual(f.payloads.map(payload => payload.credito_id), ["1", "2"]);
  assert.deepEqual((await f.coverages()).map(row => row.creditoId), [1, 2]);
  assert.equal((await f.recipients()).length, 1);
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 2);
});

test("a legacy attempt without Coverage blocks the same credit in every status but not tomorrow's new credit", async t => {
  for (const status of ["ACCEPTED", "FAILED", "UNKNOWN", "CLAIMED"]) {
    await t.test(status, async legacy => {
      const f = await overdueDataFixture(legacy, { credits: [sampleOverdueDataCredit(1),
        sampleOverdueDataCredit(2, { fechaPrimerPago: "2026-09-18" })] });
      await f.seedClaim({ status, withCoverage: false, daysPastDue: 36, nextEligibleDate: "2026-10-10" });
      assert.equal((await f.run(live)).summary.waiting, 1);
      assert.equal(f.counts.sends, 0);
      assert.deepEqual(await f.coverages(), []);
      await f.updateCredit(1, { clienteTelefono: "3000000003" });
      const before = { ...f.counts };
      const preview = await f.run();
      assert.equal(preview.summary.waiting, 1);
      assert.equal(preview.summary.ready, 0);
      assert.equal(f.counts.writes, before.writes);
      assert.equal(f.counts.sends, 0);
      assert.equal((await f.run(live)).summary.waiting, 1);
      f.setClock("2026-10-08T15:00:00Z");
      assert.equal((await f.run(live)).summary.accepted, 1);
      assert.deepEqual(f.payloads.map(payload => [payload.credito_id, payload.telefono]), [["2", "573000000001"]]);
      assert.deepEqual((await f.coverages()).map(row => row.creditoId), [2]);
      assert.equal(f.counts.sends, 1);
      assert.equal((await f.rows()).length, 2);
    });
  }
});

test("a credit first seen at 21-plus days never creates a catch-up notice", async t => {
  const f = await overdueDataFixture(t, { credits: [sampleOverdueDataCredit(1, { fechaPrimerPago: "2026-09-16" }),
    sampleOverdueDataCredit(2, { fechaPrimerPago: "2026-08-01" })] });
  const report = await f.run(live);
  assert.equal(report.summary.scanned, 2);
  assert.equal(report.summary.eligibleCredits, 0);
  assert.equal(report.summary.excluded, 2);
  assert.equal(f.counts.sends, 0);
  assert.deepEqual(await f.rows(), []);
  assert.deepEqual(await f.coverages(), []);
});

test("a newly added credit cannot cause a second message to the same mobile on the same Bogotá date", async t => {
  const f = await overdueDataFixture(t);
  assert.equal((await f.run(live)).summary.accepted, 1);
  await f.insertCredit(sampleOverdueDataCredit(2));
  const replay = await f.run(live);
  assert.equal(replay.summary.accepted, 0);
  assert.equal(replay.summary.waiting + replay.summary.duplicates, 1);
  assert.equal(f.counts.sends, 1);
  assert.deepEqual((await f.coverages()).map(row => row.creditoId), [1]);
  f.setClock("2026-10-08T15:00:00Z");
  assert.equal((await f.run(live)).summary.eligibleCredits, 0);
  assert.equal(f.counts.sends, 1);
});

test("the legacy initial batch date is informational and never bypasses the Bogotá sending hour", async t => {
  const env = {
    DAPTA_DATOS_ENABLED: "true", DAPTA_DATOS_WEBHOOK_URL: "https://api.dapta.ai/api/test-only-datos",
    DAPTA_DATOS_START_DATE: "2026-10-07", DAPTA_DATOS_INITIAL_BATCH_DATE: "2026-02-30",
  };
  const f = await overdueDataFixture(t, { useEnvironmentConfig: true, env, now: "2026-10-07T17:30:00Z" });
  const invalidLegacyDate = await f.run(live);
  assert.equal(invalidLegacyDate.configured, true);
  assert.equal(invalidLegacyDate.inWindow, false);
  assert.equal(f.counts.pages, 0);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);

  env.DAPTA_DATOS_INITIAL_BATCH_DATE = "2026-10-06";
  const oldException = await f.run(live);
  assert.equal(oldException.inWindow, false);
  assert.equal(f.counts.pages, 0);
  assert.equal(f.counts.writes, 0);

  env.DAPTA_DATOS_INITIAL_BATCH_DATE = "2026-10-07";
  const late = await f.run(live);
  assert.equal(late.initialBatchDate, "2026-10-07");
  assert.equal(late.inWindow, false);
  assert.equal(late.summary.accepted, 0);
  assert.equal(f.counts.sends, 0);

  f.setClock("2026-10-07T15:00:00Z");
  assert.equal((await f.run(live)).summary.accepted, 1);

  f.setClock("2026-10-08T17:30:00Z");
  const before = { ...f.counts };
  const nextDayLate = await f.run(live);
  assert.equal(nextDayLate.inWindow, false);
  assert.equal(nextDayLate.summary.scanned, 0);
  assert.deepEqual(f.counts, before);
  assert.equal(f.counts.sends, 1);

  f.setClock("2026-10-10T15:00:00Z");
  const regular = await f.run(live);
  assert.equal(regular.inWindow, true);
  assert.equal(regular.summary.eligibleCredits, 0);
  assert.equal(regular.summary.accepted, 0);
  assert.equal(f.counts.sends, 1);
  assert.deepEqual((await f.rows()).map(row => day(row.campaignDate)), ["2026-10-07"]);
});

test("an overlapping HTTP dispatch and same-day replay cannot reserve or send twice", async t => {
  let started;
  let release;
  const sending = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await overdueDataFixture(t, { onFetch: async () => { started(); await blocked; } });
  const first = f.run(live);
  await sending;
  const overlapping = await f.run(live);
  assert.equal(overlapping.summary.waiting + overlapping.summary.duplicates, 1);
  assert.equal(f.counts.sends, 1);
  release();
  assert.equal((await first).summary.accepted, 1);
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 1);
  assert.equal((await f.rows()).length, 1);
});

test("transaction failure rolls back the claim and all credit coverage, permitting a later retry", async t => {
  const f = await overdueDataFixture(t, { failTransactionOnce: true });
  await assert.rejects(f.run(live));
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients()).length, 0);
  assert.equal((await f.coverages()).length, 0);
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
});

test("a payment between scan and claim excludes the client before a reservation", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterScanPage: async ({ rows, updateCredit }) => {
    if (!rows.length || changed) return;
    changed = true;
    await updateCredit(1, { abonos: [{ valor: 300 }] });
  } });
  const report = await f.run(live);
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.claimed, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
});

test("payment after claiming releases a known-unsent claim and its credit coverage", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterClaim: async ({ updateCredit }) => {
    if (changed) return;
    changed = true;
    await updateCredit(1, { abonos: [{ valor: 300 }] });
  } });
  const report = await f.run(live);
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.unknown, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.coverages()).length, 0);
  assert.equal((await f.recipients())[0].nextEligibleDate, null);
  await f.updateCredit(1, { abonos: [] });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
});

test("dropping below 20 days after claim suppresses HTTP and allows later re-entry", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterClaim: async ({ updateCredit }) => {
    if (changed) return;
    changed = true;
    await updateCredit(1, { fechaPrimerPago: "2026-09-18" });
  } });
  assert.equal((await f.run(live)).summary.revalidatedOut, 1);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-17" });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
});

test("moving above 20 days after claim suppresses HTTP and releases only a known-unsent reservation", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterClaim: async ({ updateCredit }) => {
    if (changed) return;
    changed = true;
    await updateCredit(1, { fechaPrimerPago: "2026-09-16" });
  } });
  assert.equal((await f.run(live)).summary.revalidatedOut, 1);
  assert.equal(f.counts.sends, 0);
  assert.deepEqual(await f.rows(), []);
  assert.deepEqual(await f.coverages(), []);
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-17" });
  assert.equal((await f.run(live)).summary.accepted, 1);
});

test("a phone change after reservation releases unsent coverage and revalidates the new destination", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterClaim: async ({ updateCredit }) => {
    if (changed) return;
    changed = true;
    await updateCredit(1, { clienteTelefono: "3000000002" });
  } });
  assert.equal((await f.run(live)).summary.revalidatedOut, 1);
  assert.equal(f.counts.sends, 0);
  assert.deepEqual(await f.rows(), []);
  assert.deepEqual(await f.coverages(), []);
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.deepEqual(f.payloads.map(payload => payload.telefono), ["573000000002"]);
});

test("a competing UNKNOWN transition is never erased by known-unsent cleanup", async t => {
  const f = await overdueDataFixture(t, { afterActiveClaim: async ({ database }) => {
    await database.query('UPDATE "CreditOverdueDataAttempt" SET "status"=\'UNKNOWN\',"resultCode"=\'CLAIM_EXPIRED\' WHERE "status"=\'CLAIMED\'');
  } });
  const report = await f.run(live);
  assert.equal(report.summary.accepted, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows())[0].status, "UNKNOWN");
  assert.equal((await f.coverages()).length, 1);
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 0);
});

test("an owner's claim expiring at 90 seconds before HTTP is released instead of becoming UNKNOWN", async t => {
  let changed = false;
  const f = await overdueDataFixture(t, { afterClaimTransaction: async ({ setClock }) => {
    if (changed) return;
    changed = true;
    setClock("2026-10-07T15:01:30.000Z");
  } });
  const report = await f.run(live);
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.unknown, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients())[0].nextEligibleDate, null);
  assert.equal((await f.run(live)).summary.accepted, 1);
});

test("a window closing during active-claim verification prevents HTTP and releases coverage", async t => {
  const f = await overdueDataFixture(t, { afterActiveClaim: async ({ setClock }) => setClock("2026-10-07T16:00:00Z") });
  const report = await f.run(live);
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.unknown, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.coverages()).length, 0);
  assert.equal((await f.recipients())[0].nextEligibleDate, null);
});

test("a paid representative is replaced only by its still-eligible covered credit before HTTP", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1), sampleOverdueDataCredit(2),
  ], afterClaim: async ({ updateCredit }) => updateCredit(1, { abonos: [{ valor: 300 }] }) });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
  assert.equal(f.payloads[0].credito_id, "2");
  assert.equal(f.payloads[0].dias_mora, "20");
  const [attempt] = await f.rows();
  assert.equal(attempt.creditoId, 2);
  assert.equal(attempt.daysPastDue, 20);
  assert.deepEqual((await f.coverages()).map(row => row.creditoId), [2]);
});

test("non-representative covered credits cannot be sent again after the representative is paid", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1), sampleOverdueDataCredit(2),
  ] });
  await f.run(live);
  await f.updateCredit(1, { abonos: [{ valor: 300 }] });
  await f.updateCredit(2, { clienteTelefono: "3000000002" });
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 1);
  f.setClock("2026-10-10T15:00:00Z");
  await f.updateCredit(2, { fechaPrimerPago: "2026-09-20" });
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.deepEqual(f.payloads.map(payload => payload.credito_id), ["1"]);
  assert.equal((await f.recipients()).length, 1);
  assert.deepEqual((await f.coverages()).map(row => row.creditoId), [1, 2]);
});

test("provider success needs explicit confirmation; node errors, non-ok HTTP and timeouts are recorded safely", async t => {
  const settings = {};
  const f = await overdueDataFixture(t, settings);
  for (const [label, responseOptions, expectedStatus, expectedCode] of [
    ["direct success", { response: { ok: true } }, "ACCEPTED", "FLOW_ACCEPTED"],
    ["wrapped success", { response: { response: { ok: true } } }, "ACCEPTED", "FLOW_ACCEPTED"],
    ["nested node error", { response: { response: { ok: true, enviar_datos: { error: "private credential and phone" } } } }, "FAILED", "FLOW_REJECTED"],
    ["object node error", { response: { ok: true, nodes: [{ error: { detail: "private phone" } }] } }, "FAILED", "FLOW_REJECTED"],
    ["explicit failure", { response: { ok: false } }, "FAILED", "FLOW_REJECTED"],
    ["HTTP rejected", { status: 429 }, "FAILED", "HTTP_REJECTED"],
    ["unconfirmed result", { response: { response: { ok: "true" } } }, "UNKNOWN", "UNCONFIRMED_RESPONSE"],
    ["request reflection", { response: { request: { ok: true } } }, "UNKNOWN", "UNCONFIRMED_RESPONSE"],
    ["unreadable result", { rawResponse: "not JSON" }, "UNKNOWN", "UNREADABLE_RESPONSE"],
    ["timeout", { onFetch: async () => { throw new DOMException("private timeout detail", "TimeoutError"); } }, "UNKNOWN", "NETWORK_OUTCOME_UNKNOWN"],
  ]) {
    await t.test(label, async () => {
      await f.database.query('DELETE FROM "CreditOverdueDataCoverage"');
      await f.database.query('DELETE FROM "CreditOverdueDataAttempt"');
      await f.database.query('DELETE FROM "CreditOverdueDataRecipient"');
      for (const key of ["response", "rawResponse", "status", "onFetch"]) delete settings[key];
      Object.assign(settings, responseOptions);
      const before = f.counts.sends;
      const report = await f.run(live);
      const [attempt] = await f.rows();
      assert.equal(attempt.status, expectedStatus);
      assert.equal(attempt.resultCode, expectedCode);
      assert.equal(report.ok, expectedStatus === "ACCEPTED");
      assert.equal((await f.run(live)).summary.waiting, 1);
      assert.equal(f.counts.sends, before + 1);
      assert.doesNotMatch(JSON.stringify({ report, attempt }), /private|credential|573000000001/);
    });
  }
});

test("FAILED and UNKNOWN outcomes permanently block the credit instead of retrying three days later", async t => {
  const settings = { providerError: true };
  const f = await overdueDataFixture(t, settings);
  for (const status of ["UNKNOWN", "FAILED"]) {
    await f.database.query('DELETE FROM "CreditOverdueDataCoverage"');
    await f.database.query('DELETE FROM "CreditOverdueDataAttempt"');
    await f.database.query('DELETE FROM "CreditOverdueDataRecipient"');
    settings.providerError = status === "UNKNOWN";
    settings.status = status === "FAILED" ? 503 : 200;
    f.setClock("2026-10-07T15:00:00Z");
    await f.updateCredit(1, { fechaPrimerPago: "2026-09-17" });
    const before = f.counts.sends;
    await f.run(live);
    assert.equal((await f.rows())[0].status, status);
    for (const date of ["2026-10-07", "2026-10-08", "2026-10-09"]) {
      f.setClock(date + "T15:00:00Z");
      await f.updateCredit(1, { fechaPrimerPago: ({ "2026-10-07": "2026-09-17", "2026-10-08": "2026-09-18", "2026-10-09": "2026-09-19" })[date] });
      assert.equal((await f.run(live)).summary.waiting, 1);
      assert.equal(f.counts.sends, before + 1);
    }
    f.setClock("2026-10-10T15:00:00Z");
    await f.updateCredit(1, { fechaPrimerPago: "2026-09-20" });
    await f.run(live);
    assert.equal(f.counts.sends, before + 1);
    assert.equal((await f.rows()).length, 1);
  }
});

test("a process restart expires an ambiguous claim at 90 seconds and retains permanent credit coverage", async t => {
  const f = await overdueDataFixture(t);
  await f.seedClaim();
  const restarted = f.restart();
  f.setClock("2026-10-07T15:01:29.999Z");
  assert.equal((await restarted(live)).summary.staleClaims, 0);
  assert.equal((await f.rows())[0].status, "CLAIMED");
  f.setClock("2026-10-07T15:01:30.000Z");
  const expired = await restarted(live);
  assert.equal(expired.summary.staleClaims, 1);
  assert.equal(expired.summary.waiting, 1);
  assert.equal((await f.rows())[0].status, "UNKNOWN");
  assert.equal((await f.rows())[0].resultCode, "CLAIM_EXPIRED");
  assert.equal(f.counts.sends, 0);
  f.setClock("2026-10-10T15:00:00Z");
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-20" });
  assert.equal((await restarted(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.coverages()).length, 1);
});

test("an HTTP success followed by failed finalization remains ambiguous across restart", async t => {
  const f = await overdueDataFixture(t, { failFinalizeOnce: true });
  await assert.rejects(f.run(live));
  assert.equal(f.counts.sends, 1);
  assert.equal((await f.rows())[0].status, "CLAIMED");
  f.setClock("2026-10-07T15:02:00Z");
  const restarted = f.restart();
  assert.equal((await restarted(live)).summary.staleClaims, 1);
  assert.equal((await f.rows())[0].status, "UNKNOWN");
  assert.equal(f.counts.sends, 1);
  f.setClock("2026-10-08T15:00:00Z");
  await f.updateCredit(1, { fechaPrimerPago: "2026-09-18" });
  assert.equal((await restarted(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 1);
});

test("preview may select another date but never expires claims or changes the live dispatch date", async t => {
  const f = await overdueDataFixture(t, { now: "2026-10-06T15:00:00Z" });
  const preview = await f.run({ dryRun: true, previewDate: "2026-10-07" });
  assert.equal(preview.today, "2026-10-07");
  assert.equal(preview.summary.eligibleClients, 1);
  assert.equal(f.counts.writes, 0);
  assert.equal((await f.run({ ...live, previewDate: "2026-10-07" })).summary.eligibleClients, 0);
  assert.equal(f.counts.sends, 0);
  await f.seedClaim();
  f.setClock("2026-10-07T15:02:00Z");
  const before = f.counts.writes;
  const expiredPreview = await f.run();
  assert.equal(expiredPreview.summary.staleClaims, 0);
  assert.equal((await f.rows())[0].status, "CLAIMED");
  assert.equal(f.counts.writes, before);
});
