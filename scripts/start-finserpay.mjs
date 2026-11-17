import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 120_000;
const PROBE_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH", "FIRMASEGURO_EMAIL", "FIRMASEGURO_PASSWORD",
  "FIRMASEGURO_PORTAL_EMAIL", "FIRMASEGURO_PORTAL_PASSWORD", "FIRMASEGURO_BROWSER_ENDPOINT", "FIRMASEGURO_BROWSER_TOKEN"];
function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z_]{1,80}$/.test(value) ? value : fallback;
}
function safeFailureDetails(value) {
  const details = {};
  if (["BROWSER_LAUNCH", "CONTEXT", "FIRST_NAVIGATION", "LOGIN_EMAIL", "LOGIN_PASSWORD", "LIST_VERIFICATION"].includes(value?.readPhase))
    details.readPhase = value.readPhase;
  if (["SANDBOX", "BINARY", "DEPENDENCY", "FILESYSTEM", "OTHER"].includes(value?.runtimeCategory))
    details.runtimeCategory = value.runtimeCategory;
  return details;
}
function validReceipt(value) {
  return value?.ok === true && value.code === "PORTAL_RUNTIME_ACCESS_VERIFIED" && value.platform === "linux"
    && Number.isSafeInteger(value.uid) && value.uid > 0 && value.playwrightVersion === "1.65.0";
}

export function verifyPortalInChild(env = process.env, run = execFile) {
  const childEnv = Object.fromEntries(PROBE_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  return new Promise((fulfill, reject) => {
    run(process.execPath, [fileURLToPath(new URL("./verify-firmaseguro-portal-runtime.mjs", import.meta.url))],
      { env: childEnv, timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 8192, windowsHide: true }, (error, stdout, stderr) => {
        let receipt;
        try { receipt = JSON.parse(String(stdout || "").trim() || String(stderr || "").trim()); } catch { /* Never expose child output. */ }
        if (error || !validReceipt(receipt)) {
          const code = error?.killed ? "PORTAL_RUNTIME_TIMEOUT"
            : receipt?.ok === false ? safeCode(receipt.code, "PORTAL_RUNTIME_VERIFICATION_FAILED")
              : "PORTAL_RUNTIME_VERIFICATION_FAILED";
          reject(Object.assign(new Error("Portal runtime verification failed"), { code, ...safeFailureDetails(receipt) }));
        } else fulfill(receipt);
      });
  });
}

export function needsFirmaSeguroPortalVerification(env = process.env) {
  return env.FIRMASEGURO_PORTAL_RESEND_ENABLED === "true"
    || env.FIRMASEGURO_PORTAL_VERIFY_ACCESS_ON_START === "true";
}

export async function startFinserpay({
  env = process.env,
  verify = async () => verifyPortalInChild(env),
  start = async () => import("../server.js"),
  report = event => console.info(JSON.stringify(event)),
} = {}) {
  // A provider/browser outage closes only the portal gate; the rest of FINSERPAY
  // remains available. Every enabled container verifies its own runtime first.
  if (needsFirmaSeguroPortalVerification(env)) {
    try {
      const receipt = await verify();
      if (!validReceipt(receipt)) throw Object.assign(new Error("Invalid verification receipt"), { code: "PORTAL_RUNTIME_RECEIPT_INVALID" });
      report({ event: "firmaseguro_portal_runtime_verified", code: receipt.code,
        platform: receipt.platform, uid: receipt.uid, playwrightVersion: receipt.playwrightVersion,
        browserTransport: receipt.browserTransport === "PRIVATE" ? "PRIVATE" : "LOCAL",
        resendEnabled: env.FIRMASEGURO_PORTAL_RESEND_ENABLED === "true" });
    } catch (error) {
      env.FIRMASEGURO_PORTAL_RESEND_ENABLED = "false";
      report({ event: "firmaseguro_portal_runtime_failed", resendEnabled: false,
        code: safeCode(error?.code, "PORTAL_RUNTIME_VERIFICATION_FAILED"), ...safeFailureDetails(error) });
    }
  }
  await start();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startFinserpay().catch(error => {
    const code = typeof error?.code === "string" && /^[A-Z][A-Z_]{1,80}$/.test(error.code)
      ? error.code : "STARTUP_VERIFICATION_FAILED";
    console.error(JSON.stringify({ event: "finserpay_startup_failed", code }));
    process.exitCode = 1;
  });
}
