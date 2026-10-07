import assert from "node:assert/strict";
import test from "node:test";
import { overdueDataFixture, sampleOverdueDataCredit } from "./credit-overdue-data-fixture.mjs";

const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const live = { dryRun: false };

// PGlite serializes transactions. The overlap tests exercise production SQL
// locks and constraints through that scheduler, not separate database servers.
test("preview scans 501 credits, excludes invalid and under-20-day rows, and exposes no PII or writes", async t => {
  const credits = Array.from({ length: 501 }, (_, index) => sampleOverdueDataCredit(index + 1));
  credits[0].clienteTelefono = "1111";
  credits[1].estado = "ANULADO";
  credits[2].fechaPrimerPago = "2026-09-18";
  const f = await overdueDataFixture(t, { credits, enabled: false });
  const report = await f.run();
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.scanned, 501);
  assert.equal(report.summary.eligibleCredits, 498);
  assert.equal(report.summary.eligibleClients, 1);
  assert.equal(report.summary.excluded, 3);
  assert.equal(report.summary.ready, 1);
  assert.equal(f.counts.pages, 4);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients()).length, 0);
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
  assert.equal(preview.summary.eligibleClients, 1);
  env.DAPTA_DATOS_START_DATE = "2026-02-30";
  assert.equal((await f.run(live)).configured, false);
  assert.equal((await f.run()).summary.eligibleClients, 1);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);
  env.DAPTA_DATOS_START_DATE = "2026-10-08";
  f.setClock("2026-10-08T15:00:00Z");
  const started = await f.run(live);
  assert.equal(started.summary.accepted, 1);
  assert.deepEqual(f.webhooks, [validUrl]);
});

test("multiple eligible credits on one mobile choose maximum mora and send one client message", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1), sampleOverdueDataCredit(2, { fechaPrimerPago: "2026-09-01" }),
    sampleOverdueDataCredit(3, { fechaPrimerPago: "2026-09-18" }),
    sampleOverdueDataCredit(4, { clienteTelefono: "3000000004" }),
  ] });
  const report = await f.run(live);
  assert.equal(report.summary.eligibleCredits, 3);
  assert.equal(report.summary.eligibleClients, 2);
  assert.equal(report.summary.excluded, 1);
  assert.equal(report.summary.accepted, 2);
  assert.equal(f.counts.sends, 2);
  assert.deepEqual(f.payloads, [
    { credito_id: "2", telefono: "573000000001", nombre: "CLIENTE PRUEBA", dias_mora: "36" },
    { credito_id: "4", telefono: "573000000004", nombre: "CLIENTE PRUEBA", dias_mora: "20" },
  ]);
  assert.deepEqual((await f.rows()).map(row => [row.creditoId, row.daysPastDue, row.status]), [
    [2, 36, "ACCEPTED"], [4, 20, "ACCEPTED"],
  ]);
  const serialized = JSON.stringify({ report, recipients: await f.recipients(), attempts: await f.rows() });
  assert.doesNotMatch(serialized, /CLIENTE PRUEBA|573000000001|telefono|nombre/);
});

test("three-day cooldown is a Bogotá calendar date: October 7 at 10:30 permits October 10 at 10:00", async t => {
  const f = await overdueDataFixture(t, { now: "2026-10-07T15:30:00Z" });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(day((await f.recipients())[0].nextEligibleDate), "2026-10-10");
  for (const date of ["2026-10-08", "2026-10-09"]) {
    f.setClock(date + "T15:00:00Z");
    assert.equal((await f.run(live)).summary.waiting, 1);
    assert.equal(f.counts.sends, 1);
  }
  f.setClock("2026-10-10T14:59:59.999Z");
  assert.equal((await f.run(live)).inWindow, false);
  assert.equal(f.counts.sends, 1);
  f.setClock("2026-10-10T15:00:00Z");
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 2);
  assert.deepEqual((await f.rows()).map(row => day(row.campaignDate)), ["2026-10-07", "2026-10-10"]);
  assert.equal(day((await f.recipients())[0].nextEligibleDate), "2026-10-13");
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

test("transaction failure rolls back both claim and cooldown, permitting a later retry", async t => {
  const f = await overdueDataFixture(t, { failTransactionOnce: true });
  await assert.rejects(f.run(live));
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients()).length, 0);
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

test("payment after claiming releases a known-unsent claim and its cooldown", async t => {
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

test("a window closing during active-claim verification prevents HTTP and releases cooldown", async t => {
  const f = await overdueDataFixture(t, { afterActiveClaim: async ({ setClock }) => setClock("2026-10-07T16:00:00Z") });
  const report = await f.run(live);
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.unknown, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.recipients())[0].nextEligibleDate, null);
});

test("fresh winning credit and mora are persisted in the attempt before its HTTP payload", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1, { fechaPrimerPago: "2026-09-01" }), sampleOverdueDataCredit(2),
  ], afterClaim: async ({ updateCredit }) => updateCredit(1, { abonos: [{ valor: 300 }] }) });
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
  assert.equal(f.payloads[0].credito_id, "2");
  assert.equal(f.payloads[0].dias_mora, "20");
  const [attempt] = await f.rows();
  assert.equal(attempt.creditoId, 2);
  assert.equal(attempt.daysPastDue, 20);
});

test("cooldown follows the mobile even when its greatest-arrears credit is paid and another wins", async t => {
  const f = await overdueDataFixture(t, { credits: [
    sampleOverdueDataCredit(1, { fechaPrimerPago: "2026-09-01" }), sampleOverdueDataCredit(2),
  ] });
  await f.run(live);
  await f.updateCredit(1, { abonos: [{ valor: 300 }] });
  f.setClock("2026-10-08T15:00:00Z");
  assert.equal((await f.run(live)).summary.waiting, 1);
  assert.equal(f.counts.sends, 1);
  f.setClock("2026-10-10T15:00:00Z");
  assert.equal((await f.run(live)).summary.accepted, 1);
  assert.deepEqual(f.payloads.map(payload => payload.credito_id), ["1", "2"]);
  assert.equal((await f.recipients()).length, 1);
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

test("FAILED and UNKNOWN outcomes wait three calendar days and do not retry on their campaign day", async t => {
  const settings = { providerError: true };
  const f = await overdueDataFixture(t, settings);
  for (const status of ["UNKNOWN", "FAILED"]) {
    await f.database.query('DELETE FROM "CreditOverdueDataAttempt"');
    await f.database.query('DELETE FROM "CreditOverdueDataRecipient"');
    settings.providerError = status === "UNKNOWN";
    settings.status = status === "FAILED" ? 503 : 200;
    f.setClock("2026-10-07T15:00:00Z");
    const before = f.counts.sends;
    await f.run(live);
    assert.equal((await f.rows())[0].status, status);
    for (const date of ["2026-10-07", "2026-10-08", "2026-10-09"]) {
      f.setClock(date + "T15:00:00Z");
      assert.equal((await f.run(live)).summary.waiting, 1);
      assert.equal(f.counts.sends, before + 1);
    }
    f.setClock("2026-10-10T15:00:00Z");
    await f.run(live);
    assert.equal(f.counts.sends, before + 2);
    assert.equal((await f.rows()).length, 2);
  }
});

test("a process restart expires an ambiguous claim at 90 seconds and retains its three-day cooldown", async t => {
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
  assert.equal((await restarted(live)).summary.accepted, 1);
  assert.equal(f.counts.sends, 1);
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
