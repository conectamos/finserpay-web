import assert from "node:assert/strict";
import test from "node:test";
import { needsFirmaSeguroPortalVerification, startFinserpay, verifyPortalInChild } from "../scripts/start-finserpay.mjs";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
const receipt = { ok: true, code: "PORTAL_RUNTIME_ACCESS_VERIFIED", platform: "linux", uid: 1000, playwrightVersion: "1.65.0" };

test("startup checks portal access before serving whenever verification or resend is enabled", async () => {
  for (const env of [
    { FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" },
    { FIRMASEGURO_PORTAL_VERIFY_ACCESS_ON_START: "true" },
  ]) {
    const calls = [];
    await startFinserpay({ env, verify: async () => { calls.push("verify"); return receipt; },
      start: async () => calls.push("serve"), report: () => {} });
    assert.deepEqual(calls, ["verify", "serve"]);
  }
});
test("failed verification closes the portal gate, preserves application availability and never retries", async () => {
  const calls = [];
  const env = { FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" }, events = [];
  await startFinserpay({ env,
    verify: async () => { calls.push("verify"); throw Object.assign(new Error("private fixture failure"), { code: "PORTAL_LOGIN_FAILED" }); },
    start: async () => calls.push("serve"),
    report: event => events.push(event),
  });
  assert.deepEqual(calls, ["verify", "serve"]);
  assert.equal(env.FIRMASEGURO_PORTAL_RESEND_ENABLED, "false");
  assert.deepEqual(events, [{ event: "firmaseguro_portal_runtime_failed", resendEnabled: false, code: "PORTAL_LOGIN_FAILED" }]);
});
test("child probe has a bounded timeout, minimal environment and no exposed stderr", async () => {
  const env = { PATH: "fixture-bin", HOME: "/fixture", FIRMASEGURO_EMAIL: "fixture@example.test",
    FIRMASEGURO_PASSWORD: "fixture-password", DATABASE_URL: "private-db", SESSION_SECRET: "private-session", NODE_OPTIONS: "--inspect" };
  let options;
  const result = await verifyPortalInChild(env, (_binary, args, config, callback) => {
    options = config;
    assert.ok(args[0].endsWith("verify-firmaseguro-portal-runtime.mjs"));
    callback(null, JSON.stringify(receipt), "private stderr");
  });
  assert.deepEqual(result, receipt);
  assert.equal(options.timeout, 120000);
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.maxBuffer, 8192);
  assert.deepEqual(Object.keys(options.env).sort(), ["FIRMASEGURO_EMAIL", "FIRMASEGURO_PASSWORD", "HOME", "PATH"]);
  await assert.rejects(verifyPortalInChild(env, (_binary, _args, _config, callback) =>
    callback(Object.assign(new Error("private stderr"), { killed: true }), "private stdout")), error =>
    error.code === "PORTAL_RUNTIME_TIMEOUT" && !error.message.includes("private"));
});
test("the watchdog terminates a real child that ignores SIGTERM", { timeout: 5000 }, async () => {
  const started = Date.now();
  await assert.rejects(verifyPortalInChild({}, (binary, _args, config, callback) => execFile(binary,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { ...config, timeout: 250 }, callback)),
  error => error.code === "PORTAL_RUNTIME_TIMEOUT");
  assert.ok(Date.now() - started < 4000);
});
test("a verification-only deployment never enables the resend gate", async () => {
  const env = { FIRMASEGURO_PORTAL_VERIFY_ACCESS_ON_START: "true", FIRMASEGURO_PORTAL_RESEND_ENABLED: "false" }, events = [];
  await startFinserpay({ env, verify: async () => receipt, start: async () => {}, report: event => events.push(event) });
  assert.equal(events[0].resendEnabled, false);
  assert.equal(env.FIRMASEGURO_PORTAL_RESEND_ENABLED, "false");
});
test("only fixed diagnostic phases and categories reach startup logs", async () => {
  for (const details of [
    { readPhase: "BROWSER_LAUNCH", runtimeCategory: "BINARY" },
    { readPhase: "private customer data", runtimeCategory: "private filesystem path" },
  ]) {
    let failure;
    try {
      await verifyPortalInChild({}, (_binary, _args, _config, callback) => callback(new Error("private error"), "",
        JSON.stringify({ ok: false, code: "PORTAL_UNAVAILABLE", ...details })));
    } catch (error) { failure = error; }
    const events = [];
    await startFinserpay({ env: { FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" },
      verify: async () => { throw failure; }, start: async () => {}, report: event => events.push(event) });
    assert.equal(JSON.stringify(events).includes("private"), false);
    assert.equal(events[0].readPhase, details.readPhase === "BROWSER_LAUNCH" ? "BROWSER_LAUNCH" : undefined);
    assert.equal(events[0].runtimeCategory, details.runtimeCategory === "BINARY" ? "BINARY" : undefined);
  }
});
test("an unknown verification receipt cannot open the portal gate", async () => {
  const env = { FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" };
  await startFinserpay({ env, verify: async () => ({ ok: true, platform: "windows" }), start: async () => {}, report: () => {} });
  assert.equal(env.FIRMASEGURO_PORTAL_RESEND_ENABLED, "false");
});
test("Docker and Railway start the verified wrapper and package its compiled driver", () => {
  const root = new URL("../", import.meta.url);
  const docker = readFileSync(new URL("Dockerfile", root), "utf8");
  const railway = readFileSync(new URL("railway.toml", root), "utf8");
  assert.match(docker, /RUN node scripts\/build-firmaseguro-portal-probe\.mjs/);
  for (const name of ["generated/firmaseguro-portal.mjs", "verify-firmaseguro-portal-runtime.mjs", "start-finserpay.mjs"])
    assert.ok(docker.includes("/app/scripts/" + name));
  assert.match(docker, /CMD \["node", "scripts\/start-finserpay\.mjs"\]/);
  assert.match(railway, /startCommand = "node scripts\/start-finserpay\.mjs"/);
});
test("disabled portal starts the existing application without credentials or browser access", async () => {
  const calls = [];
  await startFinserpay({ env: {}, verify: async () => calls.push("verify"), start: async () => calls.push("serve") });
  assert.deepEqual(calls, ["serve"]);
  for (const value of [undefined, "false", "TRUE", "1", " true "])
    assert.equal(needsFirmaSeguroPortalVerification({ FIRMASEGURO_PORTAL_RESEND_ENABLED: value }), false);
});
