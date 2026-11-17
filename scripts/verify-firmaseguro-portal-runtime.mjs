import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const readErrorCodes = new Set([
  "PORTAL_NOT_CONFIGURED", "PORTAL_NAVIGATION_BLOCKED", "PORTAL_NETWORK_FAILED",
  "PORTAL_CHALLENGE", "PORTAL_LOGIN_CHANGED", "PORTAL_LOGIN_FAILED",
  "PORTAL_STRUCTURE_CHANGED", "PORTAL_UNAVAILABLE",
]);

export class FirmaSeguroPortalRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = "FirmaSeguroPortalRuntimeError";
    this.code = code;
  }
}

/** Read-only access check. Importing this module never launches a browser or authenticates. */
export async function verifyFirmaSeguroPortalRuntime() {
  if (process.platform !== "linux") throw new FirmaSeguroPortalRuntimeError("PORTAL_RUNTIME_LINUX_REQUIRED");
  let uid;
  try { uid = process.getuid?.(); } catch { /* Do not expose operating-system errors. */ }
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new FirmaSeguroPortalRuntimeError("PORTAL_RUNTIME_NON_ROOT_REQUIRED");

  let playwrightVersion;
  try { playwrightVersion = require("playwright/package.json").version; } catch { /* Report a stable code only. */ }
  if (playwrightVersion !== "1.65.0")
    throw new FirmaSeguroPortalRuntimeError("PORTAL_RUNTIME_PACKAGE_UNAVAILABLE");

  let driver;
  try { driver = await import("./generated/firmaseguro-portal.mjs"); } catch {
    throw new FirmaSeguroPortalRuntimeError("PORTAL_RUNTIME_DRIVER_UNAVAILABLE");
  }
  if (typeof driver.verifyFirmaSeguroPortalAccess !== "function")
    throw new FirmaSeguroPortalRuntimeError("PORTAL_RUNTIME_DRIVER_UNAVAILABLE");
  try {
    // The exact application driver enforces its sandbox, minimal child environment,
    // TLS and redirect policy, verifies the three list filters, and always closes.
    // Do not call recipient functions, inspect rows, apply customer filters or retry.
    await driver.verifyFirmaSeguroPortalAccess();
  } catch (error) {
    const code = error?.name === "FirmaSeguroPortalError" && readErrorCodes.has(error.code)
      ? error.code : "PORTAL_RUNTIME_ACCESS_FAILED";
    throw new FirmaSeguroPortalRuntimeError(code);
  }
  return { ok: true, code: "PORTAL_RUNTIME_ACCESS_VERIFIED", platform: "linux", uid, playwrightVersion };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await verifyFirmaSeguroPortalRuntime())); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof FirmaSeguroPortalRuntimeError
      ? error.code : "PORTAL_RUNTIME_ACCESS_FAILED" }));
    process.exitCode = 1;
  }
}
