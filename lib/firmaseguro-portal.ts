import "server-only";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const ORIGIN = "https://app.firmaseguro.co";
const PRIVATE_BROWSER_ENDPOINT = "ws://firma-portal-browser.railway.internal:3010/connect";
const TIMEOUT = 20_000;
const BROWSER_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH",
] as const;
// Exact public scripts observed on the portal, with no credentials or arbitrary CDN paths.
const EXTERNAL_SCRIPTS = new Set([
  "https://cdn.jsdelivr.net/npm/flatpickr",
  "https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/es.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js",
]);
type Stage = "READ" | "EDIT" | "RESEND";
type ReadPhase = "BROWSER_LAUNCH" | "CONTEXT" | "FIRST_NAVIGATION" | "LOGIN_EMAIL" | "LOGIN_PASSWORD" | "LIST_VERIFICATION";
type RuntimeCategory = "SANDBOX" | "BINARY" | "DEPENDENCY" | "FILESYSTEM" | "OTHER";
export type FirmaSeguroPortalRecipientInput = {
  processUuid: string;
  folio: string;
  signatureId: number;
  identity: { identification: string; firstName: string; firstLastName: string };
};
export type FirmaSeguroPortalRecipient = {
  signatureId: number;
  phone: string;
  email: string;
  contactVerification: "PROVIDER_READBACK";
  contactSource: "PORTAL_READBACK";
  notificationChannels: { whatsApp: boolean; email: boolean };
};
export type FirmaSeguroPortalSession = {
  inspect(): Promise<FirmaSeguroPortalRecipient>;
  edit(contact: { phone: string; email: string | null }): Promise<void>;
  resend(expectedContact: { phone: string; email: string | null }): Promise<void>;
  close(): Promise<void>;
};

export class FirmaSeguroPortalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly stage: Stage = "READ",
    readonly uncertain = false,
    readonly readPhase?: ReadPhase,
    readonly runtimeCategory?: RuntimeCategory,
  ) {
    super(message);
    this.name = "FirmaSeguroPortalError";
  }
}

function failure(code: string, message: string): never {
  throw new FirmaSeguroPortalError(code, message);
}
function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim().toUpperCase();
}
function phone(value: string) {
  const raw = value.trim();
  if (!/^[+\d\s().-]+$/.test(raw)) failure("PORTAL_PHONE_INVALID", "El celular del firmante no es válido.");
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("57") ? digits.slice(2) : digits;
  if (!/^3\d{9}$/.test(local)) failure("PORTAL_PHONE_INVALID", "El celular del firmante no es válido.");
  return local;
}
function email(value: string) {
  const clean = value.trim().toLowerCase();
  if (clean.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean))
    failure("PORTAL_EMAIL_INVALID", "El correo del firmante no es válido.");
  return clean;
}
function positiveId(value: string | null) {
  return value !== null && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}
function allowedNavigation(value: string) {
  try {
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
    if (!/^\/(?:Login|SignInPassword|Identity\/Account\/SignInPassword|Process|Process\/List|Process\/Details\/[1-9]\d*)?\/?$/i.test(url.pathname)) return false;
    for (const [key, redirect] of url.searchParams) {
      if (/returnurl|redirect|redirecturi|redirecturl|next/i.test(key)) {
        const destination = new URL(redirect, ORIGIN + "/");
        if (destination.origin !== ORIGIN || destination.username || destination.password || destination.hash ||
          !/^\/(?:SignInPassword|Process|Process\/List)?\/?$/i.test(destination.pathname)) return false;
      }
    }
    return true;
  } catch { return false; }
}
function hasFolio(value: string, folio: string) {
  const haystack = normalized(value), needle = normalized(folio);
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    const before = haystack[position - 1] || "", after = haystack[position + needle.length] || "";
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
    position = haystack.indexOf(needle, position + 1);
  }
  return false;
}
async function one(locator: Locator, message = "La estructura del portal cambió. Requiere revisión técnica.") {
  if (await locator.count() !== 1) failure("PORTAL_STRUCTURE_CHANGED", message);
  return locator;
}
async function visibleOne(locator: Locator) {
  await locator.first().waitFor({ state: "visible", timeout: TIMEOUT });
  return one(locator);
}
function safeError(error: unknown, stage: Stage, uncertain: boolean, readPhase?: ReadPhase, runtimeCategory?: RuntimeCategory) {
  if (error instanceof FirmaSeguroPortalError) {
    return new FirmaSeguroPortalError(error.code, error.message, error.status, stage, uncertain || error.uncertain,
      error.readPhase ?? readPhase, error.runtimeCategory ?? runtimeCategory);
  }
  return new FirmaSeguroPortalError(uncertain ? "PORTAL_RESULT_UNCERTAIN" : "PORTAL_UNAVAILABLE",
    uncertain ? "No se confirmó el resultado en FirmaSeguro. No repitas el envío; requiere revisión."
      : "No se pudo verificar la firma en el portal de FirmaSeguro.", 502, stage, uncertain, readPhase, runtimeCategory);
}
function launchFailureCategory(error: unknown): RuntimeCategory {
  // Match known launcher diagnostics internally; never attach their text, paths, URLs or cause.
  const message = error !== null && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : "";
  if (/No usable sandbox|Failed to move to new namespace|Failed to unshare|Running as root without --no-sandbox|sandbox[^\r\n]{0,80}(?:unavailable|not supported|failed|disabled)/i.test(message)) return "SANDBOX";
  if (/Executable doesn't exist|spawn [^\r\n]+ ENOENT|browser executable[^\r\n]{0,80}(?:not found|missing)/i.test(message)) return "BINARY";
  if (/error while loading shared libraries|Host system is missing dependencies|Missing libraries:|cannot open shared object file/i.test(message)) return "DEPENDENCY";
  if (/\b(?:EACCES|EPERM|EROFS|ENOSPC|EDQUOT)\b|Permission denied|Read-only file system|No space left on device/i.test(message)) return "FILESYSTEM";
  return "OTHER";
}

// Shared by recipient operations and the read-only credential check. No customer filters are applied here.
async function openPortalAccess() {
  // Prefer a complete credential pair; never combine accounts from the two namespaces.
  const specific = process.env.FIRMASEGURO_PORTAL_EMAIL || process.env.FIRMASEGURO_PORTAL_PASSWORD;
  const account = specific ? process.env.FIRMASEGURO_PORTAL_EMAIL : process.env.FIRMASEGURO_EMAIL;
  const password = specific ? process.env.FIRMASEGURO_PORTAL_PASSWORD : process.env.FIRMASEGURO_PASSWORD;
  if (!account?.trim() || !password) {
    throw new FirmaSeguroPortalError("PORTAL_NOT_CONFIGURED", "Falta configurar el acceso al portal de FirmaSeguro.", 503);
  }
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page;
  let closed = false, blockedNavigation = false, networkFailed = false, navigationRedirects = 0;
  let readPhase: ReadPhase = "BROWSER_LAUNCH";
  async function close() {
    if (closed) return;
    closed = true;
    try { await context?.close(); } catch { /* Never expose browser errors or credentials. */ }
    // For chromium.connect(), close disconnects this client; it does not stop the remote BrowserServer.
    try { await browser?.close(); } catch { /* Best effort after a crashed context. */ }
  }
  async function guardPage() {
    if (blockedNavigation || !allowedNavigation(page.url()))
      failure("PORTAL_NAVIGATION_BLOCKED", "El portal intentó abrir un destino no autorizado.");
    if (networkFailed)
      throw new FirmaSeguroPortalError("PORTAL_NETWORK_FAILED", "No se pudo completar una solicitud del portal de FirmaSeguro.", 502);
    const captcha = page.locator('iframe[src*="captcha" i], .g-recaptcha, .h-captcha, input[name*="captcha" i]');
    for (let i = 0; i < await captcha.count(); i++) {
      if (await captcha.nth(i).isVisible()) failure("PORTAL_CHALLENGE", "El portal requiere una verificación humana.");
    }
  }
  async function settle() {
    // Waiting is not an ACK. Mutations are acknowledged only by the subsequent UI readback / success text.
    await page.waitForLoadState("networkidle", { timeout: TIMEOUT });
    await guardPage();
  }
  try {
    const remoteEndpoint = process.env.FIRMASEGURO_BROWSER_ENDPOINT;
    const remoteToken = process.env.FIRMASEGURO_BROWSER_TOKEN;
    if (remoteEndpoint !== undefined || remoteToken !== undefined) {
      // Exact private destination only: no URL normalization, credentials, query, fragment or alternate host.
      if (remoteEndpoint !== PRIVATE_BROWSER_ENDPOINT || !remoteToken || !/^[A-Za-z0-9_-]{32,256}$/.test(remoteToken))
        throw new FirmaSeguroPortalError("PORTAL_NOT_CONFIGURED", "La conexión privada del navegador no está configurada correctamente.", 503);
      browser = await chromium.connect(remoteEndpoint, {
        headers: { Authorization: `Bearer ${remoteToken}` }, timeout: TIMEOUT,
      });
    } else {
      const browserEnv: Record<string, string> = {};
      for (const key of BROWSER_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) browserEnv[key] = value;
      }
      // The local browser retains its sandbox and minimal environment. A remote failure never falls back here.
      browser = await chromium.launch({ headless: true, chromiumSandbox: true, env: browserEnv });
    }
    readPhase = "CONTEXT";
    context = await browser.newContext({ acceptDownloads: false, ignoreHTTPSErrors: false, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      if (blockedNavigation || networkFailed) { await route.abort("blockedbyclient"); return; }
      const request = route.request();
      const mainNavigation = request.isNavigationRequest() && request.frame() === page?.mainFrame();
      let permitted = false;
      try {
        const url = new URL(request.url());
        permitted = !url.username && !url.password && (url.origin === ORIGIN ||
          (!request.isNavigationRequest() && request.resourceType() === "script" && EXTERNAL_SCRIPTS.has(url.href)));
      } catch { /* Block unknown schemes. */ }
      if (mainNavigation) {
        permitted &&= allowedNavigation(request.url());
        if (!permitted) blockedNavigation = true;
      }
      if (!permitted) { await route.abort("blockedbyclient"); return; }
      let response: Awaited<ReturnType<typeof route.fetch>> | undefined;
      try {
        // Routing is not invoked for later HTTP redirect hops. Fetch exactly one hop so neither a redirect
        // nor a connection retry can forward a credential/edit/resend body before its destination is checked.
        response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: TIMEOUT });
        const status = response.status();
        const headers = response.headersArray();
        const locations = headers.filter(header => header.name.toLowerCase() === "location");
        let destination: URL | undefined;
        if (locations.length === 1 && locations[0].value.trim()) {
          try { destination = new URL(locations[0].value, request.url()); } catch { /* Reject malformed redirects. */ }
        }
        if (headers.some(header => header.name.toLowerCase() === "refresh") ||
          (locations.length > 0 && (!destination || destination.origin !== ORIGIN || destination.username || destination.password))) {
          blockedNavigation = true;
          await route.abort("blockedbyclient");
          return;
        }
        if (status >= 300 && status < 400 && status !== 304) {
          const method = request.method();
          const safeGet = method === "GET" && [301, 302, 303, 307, 308].includes(status);
          const postToGet = method === "POST" && [302, 303].includes(status);
          if (!mainNavigation || (!safeGet && !postToGet) || !destination ||
            !allowedNavigation(destination.href) || ++navigationRedirects > 10) {
            blockedNavigation = true;
            await route.abort("blockedbyclient");
            return;
          }
          // A synthetic 200 creates a fresh GET navigation, which must pass through this handler again.
          // Preserve login cookies but never forward the POST body, Location/Refresh headers, or redirect body.
          const escaped = destination.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const replacementHeaders: Record<string, string> = {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
          };
          const cookies = headers.filter(header => header.name.toLowerCase() === "set-cookie");
          if (cookies.length) replacementHeaders["set-cookie"] = cookies.map(cookie => cookie.value).join("\n");
          await route.fulfill({ status: 200, headers: replacementHeaders,
            body: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${escaped}"></head><body></body></html>` });
          return;
        }
        if (mainNavigation) navigationRedirects = 0;
        // Same-origin AJAX emitted by observed controls is permitted, with no redirects or guessed endpoints.
        await route.fulfill({ response });
      } catch {
        networkFailed = true;
        try { await route.abort("failed"); } catch { /* The page/context may already have closed. */ }
      } finally {
        await response?.dispose().catch(() => {});
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    page.on("popup", popup => { void popup.close().catch(() => {}); });
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    readPhase = "FIRST_NAVIGATION";
    await page.goto(ORIGIN + "/Process/List", { waitUntil: "domcontentloaded" });
    await guardPage();
    readPhase = "LOGIN_EMAIL";
    const login = await visibleOne(page.locator("input#Input_Email"));
    const passwordEntry = await visibleOne(page.locator('input[type="submit"][value="Ingresar con Contraseña"]'));
    const loginAction = await passwordEntry.getAttribute("formaction");
    if (!loginAction || !allowedNavigation(loginAction) ||
      new URL(loginAction, ORIGIN).searchParams.get("returnUrl") !== "./SignInPassword")
      failure("PORTAL_LOGIN_CHANGED", "El formulario de acceso al portal cambió.");
    await login.fill(account.trim());
    await passwordEntry.click();
    await settle();
    readPhase = "LOGIN_PASSWORD";
    const secret = await visibleOne(page.locator('input[type="password"]'));
    const loginForm = await one(secret.locator("xpath=ancestor::form"));
    const action = await loginForm.getAttribute("action");
    if (action && !allowedNavigation(new URL(action, page.url()).href))
      failure("PORTAL_LOGIN_CHANGED", "El formulario de acceso al portal cambió.");
    const submit = await visibleOne(loginForm.locator('input[type="submit"], button[type="submit"]'));
    const submitAction = await submit.getAttribute("formaction");
    if (submitAction && !allowedNavigation(new URL(submitAction, page.url()).href))
      failure("PORTAL_LOGIN_CHANGED", "El formulario de acceso al portal cambió.");
    await secret.fill(password);
    await submit.click();
    await settle();
    if (/\/(?:Login|SignInPassword)\/?$/i.test(new URL(page.url()).pathname))
      failure("PORTAL_LOGIN_FAILED", "No se pudo iniciar sesión en el portal de FirmaSeguro.");
    readPhase = "LIST_VERIFICATION";
    await page.goto(ORIGIN + "/Process/List", { waitUntil: "domcontentloaded" });
    await guardPage();
    if (!/^\/Process\/List\/?$/i.test(new URL(page.url()).pathname))
      failure("PORTAL_LOGIN_FAILED", "No se pudo verificar el acceso al listado del portal.");
    for (const selector of ["#SearchIdentification", "#SearchFileName", "#btnFilterProcess"])
      await visibleOne(page.locator(selector));
    return { page, guardPage, settle, close };
  } catch (error) {
    await close();
    throw safeError(error, "READ", false, readPhase,
      readPhase === "BROWSER_LAUNCH" && !(error instanceof FirmaSeguroPortalError) ? launchFailureCategory(error) : undefined);
  }
}

/** Checks credentials through the same login and navigation policy, without filtering or opening a process. */
export async function verifyFirmaSeguroPortalAccess(): Promise<void> {
  const access = await openPortalAccess();
  try { await access.guardPage(); }
  catch (error) { throw safeError(error, "READ", false, "LIST_VERIFICATION"); }
  finally { await access.close(); }
}

/** Uses only the portal's observed UI. No persistent profile, token API, direct AJAX, or provider retries.
 * Selectors and the single-result filter must still be smoke-tested with an authorized runtime account.
 * External assets are blocked except the exact observed scripts above; do not silently broaden this.
 */
export async function openFirmaSeguroPortalRecipient(input: FirmaSeguroPortalRecipientInput): Promise<FirmaSeguroPortalSession> {
  if (!input || !/^[A-Za-z0-9_-]{1,200}$/.test(input.processUuid || "") ||
    typeof input.folio !== "string" || !input.folio.trim() || input.folio.length > 200 || /[\r\n\0]/.test(input.folio) ||
    !Number.isSafeInteger(input.signatureId) || input.signatureId < 1 || input.signatureId > 2_147_483_647 ||
    !input.identity || !/^\d{5,20}$/.test(input.identity.identification || "") ||
    typeof input.identity.firstName !== "string" || !input.identity.firstName.trim() ||
    typeof input.identity.firstLastName !== "string" || !input.identity.firstLastName.trim()) {
    throw new FirmaSeguroPortalError("PORTAL_INPUT_INVALID", "Falta una identidad de firma válida para consultar el portal.", 400);
  }
  const expected = { ...input, folio: input.folio.trim(), identity: { ...input.identity } };
  const access = await openPortalAccess();
  const { page, guardPage, settle } = access;
  let closed = false, busy = false;
  let editAttempted = false, resendAttempted = false, uncertainMutation = false;
  let detailUrl = "";

  async function close() {
    if (closed) return;
    closed = true;
    await access.close();
  }
  async function reloadDetail() {
    if (page.url() !== detailUrl) failure("PORTAL_PROCESS_CHANGED", "El proceso del portal cambió.");
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await guardPage();
    if (page.url() !== detailUrl) failure("PORTAL_PROCESS_CHANGED", "El proceso del portal cambió.");
  }
  async function verifyFolio(scope: Locator, includeSubject: boolean) {
    const documents = scope.locator(".pdfTrigger");
    let found = false;
    for (let i = 0; i < await documents.count(); i++) {
      const document = documents.nth(i);
      const candidates = [await document.getAttribute("data-bs-original-title"), await document.getAttribute("title"),
        await document.getAttribute("data-original-title"), await document.innerText()];
      found ||= candidates.some(value => value && /\.pdf\s*$/i.test(value) && hasFolio(value, expected.folio));
    }
    if (!found && includeSubject) {
      const lines = (await scope.innerText()).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const match = /^ASUNTO\s*:\s*(.*)$/.exec(normalized(lines[i]));
        if (match && hasFolio(match[1] || lines[i + 1] || "", expected.folio)) found = true;
      }
    }
    if (!found) failure("PORTAL_PROCESS_MISMATCH", "El documento del portal no corresponde al folio esperado.");
  }
  async function readNotificationChannels(): Promise<FirmaSeguroPortalRecipient["notificationChannels"]> {
    const unverifiable = () => failure("PORTAL_NOTIFICATION_CHANNELS_UNVERIFIED",
      "No se confirmó una configuración de notificaciones exclusiva por WhatsApp en este proceso.");
    // Observed process-level notification section. The signer's OTP/CostType is not evidence of this setting.
    const heading = page.locator("h4").filter({ hasText: /^\s*Notificaciones\s*$/ });
    if (await heading.count() !== 1 || !await heading.isVisible()) unverifiable();
    const box = heading.locator("xpath=..").locator(":scope > .signature_item > .box.from");
    if (await box.count() !== 1 || !await box.isVisible()) unverifiable();
    const indicators = box.locator(":scope > span");
    if (await indicators.count() !== 2 || await box.locator("i").count() !== 2) unverifiable();
    const seen = new Set<string>();
    const channels = { whatsApp: false, email: false };
    for (let index = 0; index < 2; index++) {
      const indicator = indicators.nth(index);
      const label = normalized(await indicator.innerText());
      if (seen.has(label) || !await indicator.isVisible()) unverifiable();
      seen.add(label);
      const icon = indicator.locator(":scope > i");
      if (await icon.count() !== 1 || !await icon.isVisible()) unverifiable();
      const title = await icon.getAttribute("title");
      const classes = new Set((await icon.getAttribute("class") || "").split(/\s+/));
      if (label === "NOTIFICACION POR EMAIL" && title === "No se envía Email" &&
        classes.has("fas") && classes.has("fa-times") && classes.has("text-danger") &&
        !classes.has("fa-check") && !classes.has("text-success")) {
        channels.email = false;
      } else if (label === "NOTIFICACION POR WHATSAPP" && title === "Notificaciones por WhatsApp" &&
        classes.has("fas") && classes.has("fa-check") && classes.has("text-success") &&
        !classes.has("fa-times") && !classes.has("text-danger")) {
        channels.whatsApp = true;
      } else {
        // Positive email / disabled WhatsApp controls have not been observed. Never infer their meaning.
        unverifiable();
      }
    }
    if (!channels.whatsApp || channels.email || !seen.has("NOTIFICACION POR EMAIL")) unverifiable();
    return channels;
  }
  async function readCard() {
    await guardPage();
    if (page.url() !== detailUrl) failure("PORTAL_PROCESS_CHANGED", "El proceso del portal cambió.");
    await verifyFolio(page.locator("body"), true);
    // Never use another signer's contact, labels or controls.
    const card = await visibleOne(page.locator(".box.signer").filter({ has: page.locator(`#edit-signature-${expected.signatureId}`) }));
    const fields = new Map<string, string[]>();
    for (const text of await card.locator("li").allTextContents()) {
      const separator = text.indexOf(":");
      if (separator < 0) continue;
      const key = normalized(text.slice(0, separator));
      fields.set(key, [...(fields.get(key) || []), text.slice(separator + 1).trim()]);
    }
    const read = (key: string) => {
      const values = fields.get(key);
      if (values?.length !== 1) failure("PORTAL_STRUCTURE_CHANGED", "No se pudo leer el firmante esperado.");
      return values[0];
    };
    if (read("CC").replace(/[.\s]/g, "") !== expected.identity.identification)
      failure("PORTAL_IDENTITY_MISMATCH", "La identificación del firmante no coincide.");
    if (normalized(read("FECHA DE FIRMA")) !== "AUN NO")
      failure("PORTAL_SIGNATURE_NOT_PENDING", "La firma ya no está pendiente.");
    const unavailable = /\b(?:RECHAZAD[OA]|CANCELAD[OA]|EXPIRAD[OA])\b/;
    const signerText = normalized(await card.innerText());
    // A rejected unrelated signer must not be interpreted as the target's status.
    // Without a dedicated global status selector, accept only an explicit process-state label.
    const processState = (await page.locator("body").innerText()).split(/\r?\n/)
      .map(normalized).filter(line => /^ESTADO DEL PROCESO\s*:/.test(line));
    if (unavailable.test(signerText) || processState.some(line => unavailable.test(line)))
      failure("PORTAL_SIGNATURE_NOT_PENDING", "El proceso ya no permite editar o reenviar la firma.");
    const notificationChannels = await readNotificationChannels();
    return { card, phone: phone(read("NUMERO CELULAR")), email: email(read("EMAIL")), notificationChannels };
  }
  async function readForm() {
    const form = await visibleOne(page.locator("#EditSigner"));
    const value = async (selector: string) => (await one(form.locator(selector))).inputValue();
    const optionalValue = async (selector: string) => {
      const field = form.locator(selector);
      const count = await field.count();
      if (count > 1) failure("PORTAL_STRUCTURE_CHANGED", "El formulario del firmante tiene campos duplicados.");
      return count === 1 ? field.inputValue() : null;
    };
    const snapshot = {
      id: await value("input#Id"), identification: await value("input#Identification"),
      firstName: await value("input#FirstName"), firstLastName: await value("input#FirstLastName"),
      // Preserve optional identity/ownership fields, including their presence, without filling them.
      secondLastName: await optionalValue("input#SecondLastName"), contactByUserId: await optionalValue("input#ContactByUserId"),
      indicative: await value("select#Indicative"), authentication: await value("select#CostType"),
    };
    if (positiveId(snapshot.id) !== String(expected.signatureId) || snapshot.identification !== expected.identity.identification ||
      normalized(snapshot.firstName) !== normalized(expected.identity.firstName) ||
      normalized(snapshot.firstLastName) !== normalized(expected.identity.firstLastName) ||
      !["57", "+57"].includes(snapshot.indicative) || !snapshot.authentication) {
      failure("PORTAL_IDENTITY_MISMATCH", "Los datos del firmante no corresponden a la firma esperada.");
    }
    return { form, snapshot, phone: phone(await value("input#MobileNumber")), email: email(await value("input#Email")) };
  }
  function assertContact(actual: { phone: string; email: string }, authorized: { phone: string; email: string }) {
    if (actual.phone !== authorized.phone || actual.email !== authorized.email)
      failure("PORTAL_CONTACT_CHANGED", "El contacto del firmante cambió antes del reenvío.");
  }
  async function inspectInternal(reload: boolean, leaveEditorOpen = false, authorized?: { phone: string; email: string }) {
    if (reload) await reloadDetail();
    const before = await readCard();
    if (authorized) assertContact(before, authorized);
    await (await visibleOne(before.card.locator(`#edit-signature-${expected.signatureId}`))).click();
    const editor = await readForm();
    if (authorized) assertContact(editor, authorized);
    if (editor.phone !== before.phone || editor.email !== before.email)
      failure("PORTAL_CONTACT_CHANGED", "El contacto del firmante cambió durante la consulta.");
    if (!leaveEditorOpen) {
      await reloadDetail();
      const after = await readCard();
      if (authorized) assertContact(after, authorized);
      if (after.phone !== editor.phone || after.email !== editor.email)
        failure("PORTAL_CONTACT_CHANGED", "El contacto del firmante cambió durante la consulta.");
    }
    return { editor, contact: { signatureId: expected.signatureId, phone: editor.phone, email: editor.email,
      contactVerification: "PROVIDER_READBACK" as const, contactSource: "PORTAL_READBACK" as const,
      notificationChannels: before.notificationChannels } };
  }
  async function operation<T>(stage: Stage, task: (markMutation: () => void) => Promise<T>) {
    if (closed || busy) throw new FirmaSeguroPortalError("PORTAL_SESSION_UNAVAILABLE", "La sesión del portal no está disponible.", 409, stage);
    if (uncertainMutation && stage !== "READ")
      throw new FirmaSeguroPortalError("PORTAL_RETRY_FORBIDDEN", "El resultado anterior requiere revisión antes de otra acción.", 409, stage, true);
    busy = true;
    let mutation = false;
    try { return await task(() => { mutation = true; }); }
    catch (error) { uncertainMutation ||= mutation; throw safeError(error, stage, mutation); }
    finally { busy = false; }
  }

  try {
    await (await visibleOne(page.locator("#SearchIdentification"))).fill(expected.identity.identification);
    await (await visibleOne(page.locator("#SearchFileName"))).fill(expected.folio);
    await (await visibleOne(page.locator("#btnFilterProcess"))).click();
    await settle();
    const row = await one(page.locator("#myTable tr[data-process-id]"), "La búsqueda no identifica un único proceso de firma.");
    const processId = positiveId(await row.getAttribute("data-process-id"));
    if (!processId) failure("PORTAL_PROCESS_MISMATCH", "No se pudo identificar el proceso del portal.");
    await verifyFolio(row, false);
    const detail = await one(row.locator(`a[href="/Process/Details/${processId}"]`));
    detailUrl = ORIGIN + `/Process/Details/${processId}`;
    await detail.click();
    await page.waitForURL(detailUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    // UUID remains the caller's operation binding. The portal's numeric process ID is discovered from its unique row.
    // The exact signature ID, folio and identity below establish the portal-to-caller binding; never substitute UUID into a URL.
    await inspectInternal(false);
  } catch (error) {
    await close();
    throw safeError(error, "READ", false);
  }

  return {
    inspect: () => operation("READ", async () => (await inspectInternal(true)).contact),
    edit: contact => operation("EDIT", async markMutation => {
      if (editAttempted || resendAttempted) failure("PORTAL_RETRY_FORBIDDEN", "Esta sesión ya intentó modificar o reenviar la firma.");
      const nextPhone = phone(contact.phone);
      const nextEmail = contact.email === null ? null : email(contact.email);
      const current = await inspectInternal(true, true);
      const effectiveEmail = nextEmail ?? current.contact.email;
      if (nextPhone === current.contact.phone && effectiveEmail === current.contact.email) {
        await reloadDetail();
        return;
      }
      await (await one(current.editor.form.locator("input#MobileNumber"))).fill(nextPhone);
      await (await one(current.editor.form.locator("input#Email"))).fill(effectiveEmail);
      const verified = await readForm();
      if (JSON.stringify(verified.snapshot) !== JSON.stringify(current.editor.snapshot) ||
        verified.phone !== nextPhone || verified.email !== effectiveEmail)
        failure("PORTAL_FORM_CHANGED", "El formulario del firmante cambió antes de actualizar.");
      const update = await visibleOne(verified.form.locator("button#update-signature"));
      await readNotificationChannels();
      editAttempted = true;
      markMutation();
      await update.click();
      await settle();
      const after = await inspectInternal(true);
      if (after.contact.phone !== nextPhone || after.contact.email !== effectiveEmail)
        failure("PORTAL_EDIT_UNCONFIRMED", "FirmaSeguro no confirmó el contacto actualizado.");
    }),
    resend: expectedContact => operation("RESEND", async markMutation => {
      if (resendAttempted) failure("PORTAL_RETRY_FORBIDDEN", "Esta sesión ya intentó reenviar la firma.");
      if (!expectedContact || expectedContact.email === null)
        failure("PORTAL_CONTACT_REQUIRED", "Falta el contacto completo autorizado para el reenvío.");
      const authorized = { phone: phone(expectedContact.phone), email: email(expectedContact.email) };
      await inspectInternal(true, false, authorized);
      const current = await readCard();
      assertContact(current, authorized);
      const acknowledgement = page.getByText("Solicitud reenviada", { exact: true });
      if (await acknowledgement.count() && await acknowledgement.first().isVisible())
        failure("PORTAL_STALE_ACK", "El portal muestra un resultado anterior; consulta nuevamente el proceso.");
      const trigger = await visibleOne(current.card.locator(`a#aResend[data-id="${expected.signatureId}"]`));
      if (await trigger.getAttribute("href") !== "" || await trigger.getAttribute("title") !== "Reenviar correo" ||
        await trigger.getAttribute("data-bs-target") !== "#resend_modal" || await trigger.getAttribute("data-bs-toggle") !== "modal")
        failure("PORTAL_STRUCTURE_CHANGED", "El control de reenvío del portal cambió.");
      await trigger.click(); // Opens the observed confirmation only; never treat it as the sending action.
      const modal = await visibleOne(page.locator("#resend_modal"));
      await (await visibleOne(modal.getByText("¿Reenviar solicitud de firma?", { exact: true }))).waitFor({ state: "visible" });
      if (await (await one(modal.locator("input#signatureId"))).inputValue() !== String(expected.signatureId))
        failure("PORTAL_IDENTITY_MISMATCH", "La confirmación de reenvío pertenece a otro firmante.");
      const confirm = await visibleOne(modal.locator("a#confirm-resend"));
      if (normalized(await confirm.innerText()) !== "REENVIAR")
        failure("PORTAL_STRUCTURE_CHANGED", "La confirmación de reenvío del portal cambió.");
      assertContact(await readCard(), authorized);
      if (await (await one(modal.locator("input#signatureId"))).inputValue() !== String(expected.signatureId))
        failure("PORTAL_IDENTITY_MISMATCH", "La confirmación de reenvío cambió de firmante.");
      resendAttempted = true;
      markMutation();
      await confirm.click();
      // This ACK confirms only acceptance of the resend request, not its emitted channel or delivery.
      await visibleOne(page.getByText("Solicitud reenviada", { exact: true }));
      await guardPage();
    }),
    close,
  };
}
