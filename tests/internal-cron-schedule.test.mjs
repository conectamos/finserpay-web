import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const schedule = loadReissueModule("lib/internal-cron-schedule.ts");
const campaigns = ["credit-due-reminders", "credit-due-today-reminders", "credit-overdue-data"];
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function cronFixture({ now = "2026-10-07T21:00:00Z", hold = false, failData = false, initialBatchDate } = {}) {
  let clock = new Date(now);
  let timerCallback;
  let paused = hold;
  const calls = [];
  const releases = [];
  const logs = [];
  const errors = [];
  const scope = {};
  const report = { enabled: true, configured: true, inWindow: true, summary: { accepted: 0 } };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.getTime()])); }
    static now() { return clock.getTime(); }
  }
  const runCampaign = async (name, options) => {
    calls.push({ name, options: plain(options) });
    if (name === "credit-overdue-data" && failData) throw new Error("private phone webhook credential");
    if (paused) await new Promise(resolve => releases.push(resolve));
    return report;
  };
  const cron = loadReissueModule("lib/internal-cron.ts", {
    "@/lib/credit-mora-sync": { syncAllCreditMora: async () => ({ ok: true }) },
    "@/lib/credit-due-reminders": {
      runCreditDueReminders: options => runCampaign(options.campaign === "due_today" ? "credit-due-today-reminders" : "credit-due-reminders", options),
    },
    "@/lib/credit-overdue-data-campaign": {
      runCreditOverdueDataCampaign: options => runCampaign("credit-overdue-data", options),
    },
    "@/lib/device-unlock-queue": {
      processPendingDeviceUnlockCommands: async () => ({ processed: 0 }),
      recoverRecentApprovedWompiUnlockCommands: async () => ({ recovered: 0 }),
    },
    "@/lib/efecty-recaudos": { syncEfectyRecaudosFromSftp: async () => ({ ok: true }) },
    "@/lib/wompi-reconciliation": { reconcilePendingWompiPayments: async () => ({ ok: true }) },
    "@/lib/merchant-applications": { getMerchantMailConfig: () => null },
    "@/lib/merchant-applications-storage": { retryMerchantApplications: async () => ({ selected: 0 }) },
    "@/lib/internal-cron-schedule": schedule,
  }, {
    Date: Clock, Intl, globalThis: scope,
    process: { env: { FINSERPAY_INTERNAL_CRON: "true", ...(initialBatchDate ? { DAPTA_DATOS_INITIAL_BATCH_DATE: initialBatchDate } : {}) } },
    setInterval: callback => { timerCallback = callback; return { unref() {} }; },
    console: { log: (...args) => logs.push(args), error: (...args) => errors.push(args) },
  });
  return {
    start: () => cron.startInternalCron(),
    tick: () => timerCallback(),
    setClock: value => { clock = new Date(value); },
    release: () => { paused = false; releases.splice(0).forEach(resolve => resolve()); },
    calls, logs, errors, state: () => scope.__finserpayInternalCron,
  };
}

test("Datos joins the existing campaigns only in the 10:00-10:59 Colombia window", () => {
  for (const time of ["10:00", "10:01", "10:59"]) {
    assert.deepEqual(plain(schedule.getDueInternalCronTasks(time).filter(schedule.isCreditCampaignTask)), campaigns);
    assert.deepEqual(plain(schedule.getStartupRecoveryTasks(time).filter(schedule.isCreditCampaignTask)), campaigns);
  }
  for (const time of ["09:59", "11:00", "16:00", "23:40"]) {
    assert.deepEqual(plain(schedule.getDueInternalCronTasks(time).filter(schedule.isCreditCampaignTask)), []);
    assert.deepEqual(plain(schedule.getStartupRecoveryTasks(time).filter(schedule.isCreditCampaignTask)), []);
  }
  assert.deepEqual(plain(schedule.getStartupRecoveryTasks("23:40")), ["wompi", "efecty", "mora"]);
  assert.equal(schedule.isCreditReminderTask("credit-overdue-data"), false);
  assert.equal(schedule.isCreditCampaignTask("credit-overdue-data"), true);
});

test("a live tick starts Datos and both reminders concurrently with independent daily keys", async () => {
  const f = cronFixture({ hold: true });
  f.start();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  f.setClock("2026-10-08T15:00:00Z");
  f.tick();
  await nextTurn();
  assert.deepEqual(f.calls.map(call => call.name), campaigns);
  assert.equal(f.state().running.size, 3);
  assert.deepEqual(f.calls.map(call => call.options), [
    { dryRun: false, campaign: "before_due" }, { dryRun: false, campaign: "due_today" }, { dryRun: false },
  ]);
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 3);
  f.release();
  await nextTurn();
  for (const task of campaigns) assert.ok(f.state().completed.has(task + ":2026-10-08"));
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 3);
  f.setClock("2026-10-09T15:00:00Z");
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 6);
});

test("startup recovery starts all campaigns together and shares daily dedupe with timer ticks", async () => {
  const f = cronFixture({ now: "2026-10-07T15:59:00Z", hold: true });
  f.start();
  await nextTurn();
  assert.deepEqual(f.calls.map(call => call.name), campaigns);
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 3);
  f.release();
  await nextTurn();
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 3);
  for (const task of campaigns) assert.ok(f.state().completed.has(task + ":2026-10-07"));
});

test("a Datos failure stays sanitized and cannot prevent the other campaigns from completing", async () => {
  const f = cronFixture({ now: "2026-10-07T15:00:00Z", failData: true });
  f.start();
  await nextTurn();
  assert.deepEqual(f.calls.map(call => call.name), campaigns);
  assert.ok(f.state().completed.has("credit-due-reminders:2026-10-07"));
  assert.ok(f.state().completed.has("credit-due-today-reminders:2026-10-07"));
  assert.equal(f.state().completed.has("credit-overdue-data:2026-10-07"), false);
  assert.equal(f.state().running.size, 0);
  assert.equal(f.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(f.errors), /private|phone|webhook|credential/);
  f.tick();
  await nextTurn();
  assert.equal(f.calls.filter(call => call.name === "credit-overdue-data").length, 2);
  assert.equal(f.calls.filter(call => call.name !== "credit-overdue-data").length, 2);
});

test("the explicit first-batch date recovers only Datos after the regular window", async () => {
  const f = cronFixture({ now: "2026-10-07T16:30:00Z", initialBatchDate: "2026-10-07" });
  f.start();
  await nextTurn();
  assert.deepEqual(f.calls, [{ name: "credit-overdue-data", options: { dryRun: false } }]);
  assert.ok(f.state().completed.has("credit-overdue-data:2026-10-07"));
  f.start();
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 1);
  f.setClock("2026-10-08T16:30:00Z");
  f.tick();
  await nextTurn();
  assert.equal(f.calls.length, 1);
});

test("a past first-batch date cannot recover Datos or other campaigns outside their window", async () => {
  const f = cronFixture({ now: "2026-10-07T16:30:00Z", initialBatchDate: "2026-10-06" });
  f.start();
  await nextTurn();
  assert.deepEqual(f.calls, []);
});

test("first-batch recovery inside the usual window does not add Datos twice", async () => {
  const f = cronFixture({ now: "2026-10-07T15:30:00Z", initialBatchDate: "2026-10-07" });
  f.start();
  await nextTurn();
  assert.deepEqual(f.calls.map(call => call.name), campaigns);
});
