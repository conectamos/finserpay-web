import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../scripts/authorize-paid-firmaseguro-draft-retry.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replaceAll("import.meta.url", "'file:///fixture/scripts/operator.mjs'");
const requested = { draftId: 81, dispatchId: "synthetic-leaf", actorId: 7,
  actor: { id: 999, nombre: "Untrusted actor" }, reason: "Explicit authorization of one new paid attempt",
  providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true, newChargeAccepted: true };

async function invoke(flags = [], options = {}) {
  const calls = [];
  const output = [];
  const process = { argv: ["node", "operator", "--input-file", "private.json", ...flags], exitCode: 0 };
  class DraftDispatchError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const prisma = { $queryRawUnsafe: async () => options.actors ?? [{ id: 7, nombre: "Resolved administrator", role: "ADMIN", ally: "CENTRAL" }],
    $disconnect: async () => calls.push(["disconnect"]) };
  const modules = {
    "../lib/prisma.ts": { default: prisma },
    "../lib/roles.ts": { isAdminRole: value => value === "ADMIN" },
    "../lib/aliados.ts": { isFinserPayCentralAlly: value => value === "CENTRAL" },
    "../lib/firmaseguro-draft-paid-retry.ts": {
      verifyAuthorizedPaidDraftRetry: async input => {
        calls.push(["verify", input]);
        if (options.verifyError) throw options.verifyError;
        return { draftId: 81, status: "ELIGIBLE", expectedFingerprint: "verified-fingerprint" };
      },
      reserveAuthorizedPaidDraftRetry: async input => {
        calls.push(["reserve", input]);
        if (options.reserveError) throw options.reserveError;
        return { replacementDispatchId: "one-reservation", status: "PREPARING" };
      },
    },
    "../lib/firmaseguro-draft-dispatch-ledger.ts": { DraftDispatchError,
      dispatchReservedDraft: async id => { calls.push(["send", id]); return { status: options.status || "AWAITING_SIGNATURE", processUuid: "one-process" }; } },
  };
  const require = Object.assign(() => {}, { resolve: () => "server-only-fixture" });
  const promise = runInNewContext(`(async()=>{${source}\n})()`, {
    process, URL, console: { log: value => output.push(value), error: value => output.push(value) },
    readFile: async () => JSON.stringify({ ...requested, ...options.input }), fileURLToPath: () => "/fixture/", createRequire: () => require,
    createJiti: () => ({ import: async name => { assert.ok(modules[name], name); return modules[name]; } }),
  });
  await promise;
  return { calls, output, exitCode: process.exitCode };
}

test("operator defaults to verification only and resolves the real administrator", async () => {
  const result = await invoke();
  assert.deepEqual(result.calls.map(call => call[0]), ["verify", "disconnect"]);
  assert.equal(result.calls[0][1].actor.id, 7);
  assert.equal(result.calls[0][1].actor.nombre, "Resolved administrator");
  assert.match(result.output[0], /verified_read_only/);
});

test("apply reserves the reviewed fingerprint without implicitly sending", async () => {
  const result = await invoke(["--apply"]);
  assert.deepEqual(result.calls.map(call => call[0]), ["verify", "reserve", "disconnect"]);
  assert.equal(result.calls[1][1].expectedFingerprint, "verified-fingerprint");
  assert.equal(result.exitCode, 0);
});

test("a fingerprint saved in the reviewed input is checked by verification", async () => {
  const result = await invoke([], { input: { expectedFingerprint: "a".repeat(64) } });
  assert.equal(result.calls[0][1].expectedFingerprint, "a".repeat(64));
  assert.deepEqual(result.calls.map(call => call[0]), ["verify", "disconnect"]);
});

test("explicit apply and send use exactly the returned reservation once", async () => {
  const result = await invoke(["--apply", "--send"]);
  assert.deepEqual(result.calls.map(call => call[0]), ["verify", "reserve", "send", "disconnect"]);
  assert.equal(result.calls[2][1], "one-reservation");
  assert.match(result.output[0], /AWAITING_SIGNATURE/);
});

test("non-central or inactive operators cannot verify, reserve or send", async () => {
  for (const actors of [[], [{ id: 7, nombre: "Seller", role: "ADMIN", ally: "EXTERNAL" }],
    [{ id: 7, nombre: "Seller", role: "SELLER", ally: "CENTRAL" }]]) {
    const result = await invoke(["--apply", "--send"], { actors });
    assert.deepEqual(result.calls.map(call => call[0]), ["disconnect"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output[0], /PAID_RETRY_ACTOR_FORBIDDEN/);
  }
});

test("failed reservation cannot send and private diagnostics never cross output", async () => {
  const result = await invoke(["--apply", "--send"], { reserveError: new Error("private@example.test token=PRIVATE_TOKEN") });
  assert.deepEqual(result.calls.map(call => call[0]), ["verify", "reserve", "disconnect"]);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output.join(""), /private@example|PRIVATE_TOKEN/);
});

test("an ambiguous send is reported for review and is never automatically retried", async () => {
  const result = await invoke(["--apply", "--send"], { status: "UNCERTAIN" });
  assert.equal(result.calls.filter(call => call[0] === "send").length, 1);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output[0]).requiresReview, true);
});

test("send without apply is rejected before accessing the service", async () => {
  await assert.rejects(invoke(["--send"]), /--send requiere --apply/);
});
