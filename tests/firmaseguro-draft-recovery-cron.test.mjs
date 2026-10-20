import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../lib/internal-cron.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source, { mode: "transform" });
const start = code.indexOf("async function runScheduledTask(");
const end = code.indexOf("async function tick(", start);
assert.ok(start > 0 && end > start);

function fixture(recover) {
  const state = { running: new Set(), completed: new Set() };
  const logs = [];
  const errors = [];
  const context = {
    getState: () => state,
    runDraftSignatureRecovery: recover,
    logCron: (...args) => logs.push(args),
    console: { error: (...args) => errors.push(args) },
  };
  runInNewContext(`${code.slice(start, end)}; globalThis.runTask = runScheduledTask;`, context);
  return { ...context, state, logs, errors };
}

test("la conciliación se ejecuta al arrancar y cada ciclo sin depender de campañas ni del navegador", () => {
  const tick = code.slice(code.indexOf("async function tick("), code.indexOf("async function runStartupRecovery("));
  const startup = code.slice(code.indexOf("async function runStartupRecovery("), code.indexOf("export function startInternalCron("));
  assert.match(tick, /runScheduledTask\("draft-signature-recovery",\s*`draft-signature-recovery:\$\{Math\.floor\(Date\.now\(\) \/ CHECK_INTERVAL_MS\)\}`\)/);
  assert.match(startup, /runScheduledTask\("draft-signature-recovery",/);
  assert.match(code, /const CHECK_INTERVAL_MS = 30_000/);
});

test("el ciclo no solapa recuperaciones y una finalización no impide el siguiente lote", async () => {
  let finish;
  let calls = 0;
  const f = fixture(async ({ limit }) => {
    assert.equal(limit, 10);
    calls++;
    if (calls === 1) await new Promise(resolve => { finish = resolve; });
    return { selected: 1, recovered: 1, deferred: 0, needsReview: 0 };
  });
  const first = f.runTask("draft-signature-recovery", "cycle:1");
  await f.runTask("draft-signature-recovery", "cycle:2");
  assert.equal(calls, 1);
  finish();
  await first;
  await f.runTask("draft-signature-recovery", "cycle:1");
  assert.equal(calls, 1);
  await f.runTask("draft-signature-recovery", "cycle:2");
  assert.equal(calls, 2);
  assert.equal(f.state.running.size, 0);
});

test("un fallo de conciliación permite reintentar y nunca expone datos ni errores del proveedor", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) throw new Error("private provider payload token and customer data");
    return { selected: 0, recovered: 0, deferred: 0, needsReview: 0 };
  });
  await f.runTask("draft-signature-recovery", "cycle:1");
  assert.equal(f.state.completed.size, 0);
  assert.equal(f.state.running.size, 0);
  assert.equal(f.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(f.errors), /private|token|customer|payload/);
  await f.runTask("draft-signature-recovery", "cycle:1");
  assert.equal(calls, 2);
  assert.equal(f.state.completed.has("cycle:1"), true);
  assert.equal(f.logs.length, 0);
});
