import "server-only";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const ORIGIN = "https://app.firmaseguro.co";
const TIMEOUT = 20_000;
// Exact public scripts observed on the portal, with no credentials or arbitrary CDN paths.
const EXTERNAL_SCRIPTS = new Set([
  "https://cdn.jsdelivr.net/npm/flatpickr",
  "https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/es.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js",
]);
type Stage = "READ" | "EDIT" | "RESEND";
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
    if (!/^\/(?:Login|SignInPassword|Process|Process\/List|Process\/Details\/[1-9]\d*)?\/?$/i.test(url.pathname)) return false;
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
  // Prefer a complete credential pair; never combine accounts from the two namespaces.
  const specific = process.env.FIRMASEGURO_PORTAL_EMAIL || process.env.FIRMASEGURO_PORTAL_PASSWORD;
  const account = specific ? process.env.FIRMASEGURO_PORTAL_EMAIL : process.env.FIRMASEGURO_EMAIL;
  const password = specific ? process.env.FIRMASEGURO_PORTAL_PASSWORD : process.env.FIRMASEGURO_PASSWORD;
  if (!account?.trim() || !password) {
    throw new FirmaSeguroPortalError("PORTAL_NOT_CONFIGURED", "Falta configurar el acceso al portal de FirmaSeguro.", 503);
  }
  const expected = { ...input, folio: input.folio.trim(), identity: { ...input.identity } };
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page;
  let closed = false, busy = false, blockedNavigation = false;
  let editAttempted = false, resendAttempted = false, uncertainMutation = false;
  let detailUrl = "";

  async function close() {
    if (closed) return;
    closed = true;
    try { await context?.close(); } catch { /* Never expose browser errors or credentials. */ }
    try { await browser?.close(); } catch { /* Best effort after a crashed context. */ }
  }
  function safeError(error: unknown, stage: Stage, uncertain: boolean) {
    if (error instanceof FirmaSeguroPortalError) {
      return new FirmaSeguroPortalError(error.code, error.message, error.status, stage, uncertain || error.uncertain);
    }
    return new FirmaSeguroPortalError(uncertain ? "PORTAL_RESULT_UNCERTAIN" : "PORTAL_UNAVAILABLE",
      uncertain ? "No se confirmó el resultado en FirmaSeguro. No repitas el envío; requiere revisión."
        : "No se pudo verificar la firma en el portal de FirmaSeguro.", 502, stage, uncertain);
  }
  async function guardPage() {
    if (blockedNavigation || !allowedNavigation(page.url()))
      failure("PORTAL_NAVIGATION_BLOCKED", "El portal intentó abrir un destino no autorizado.");
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
    return { card, phone: phone(read("NUMERO CELULAR")), email: email(read("EMAIL")) };
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
      contactVerification: "PROVIDER_READBACK" as const, contactSource: "PORTAL_READBACK" as const } };
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
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ acceptDownloads: false, ignoreHTTPSErrors: false, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const request = route.request();
      let permitted = false;
      try {
        const url = new URL(request.url());
        permitted = !url.username && !url.password && (url.origin === ORIGIN ||
          (!request.isNavigationRequest() && request.resourceType() === "script" && EXTERNAL_SCRIPTS.has(url.href)));
      } catch { /* Block unknown schemes. */ }
      if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) {
        permitted &&= allowedNavigation(request.url());
        if (!permitted) blockedNavigation = true;
      }
      // Same-origin AJAX emitted by portal controls is permitted; no guessed private endpoint is called here.
      if (permitted) await route.continue(); else await route.abort("blockedbyclient");
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    page.on("popup", popup => { void popup.close().catch(() => {}); });
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    await page.goto(ORIGIN + "/Process/List", { waitUntil: "domcontentloaded" });
    await guardPage();
    const login = await visibleOne(page.locator("input#Input_Email"));
    const passwordEntry = await visibleOne(page.locator('input[type="submit"][value="Ingresar con Contraseña"]'));
    const loginAction = await passwordEntry.getAttribute("formaction");
    if (!loginAction || !allowedNavigation(loginAction) ||
      new URL(loginAction, ORIGIN).searchParams.get("returnUrl") !== "./SignInPassword")
      failure("PORTAL_LOGIN_CHANGED", "El formulario de acceso al portal cambió.");
    await login.fill(account.trim());
    await passwordEntry.click();
    await settle();
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
    await page.goto(ORIGIN + "/Process/List", { waitUntil: "domcontentloaded" });
    await guardPage();
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
      await visibleOne(page.getByText("Solicitud reenviada", { exact: true }));
      await guardPage();
    }),
    close,
  };
}
