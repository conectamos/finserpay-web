import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../lib/firmaseguro-portal.ts", import.meta.url), "utf8");
const input = {
  processUuid: "provider-process-uuid-not-a-numeric-id", folio: "FC-20261113-EXAMPLE", signatureId: 285406,
  identity: { identification: "1234567890", firstName: "María", firstLastName: "Pérez" },
};
const ORIGIN = "https://app.firmaseguro.co";
const originalContact = { phone: "3001234567", email: "original@example.test" };
const whatsappOnlyIndicators = () => [
  { label: "Notificación por Email", title: "No se envía Email", classes: "fas fa-times text-danger" },
  { label: "Notificación por WhatsApp", title: "Notificaciones por WhatsApp", classes: "fas fa-check text-success" },
];

async function routedRequest(f, { url = ORIGIN + "/Process/List", method = "GET", navigation = true,
  resourceType = navigation ? "document" : "xhr", status = 200, headers = [], fetchError = false } = {}) {
  const calls = { fetches: [], fulfilled: [], aborted: [], disposed: 0 };
  const response = { status: () => status, headersArray: () => headers,
    dispose: async () => { calls.disposed++; } };
  await f.state.route({
    request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation,
      frame: () => f.frame, resourceType: () => resourceType }),
    fetch: async options => {
      calls.fetches.push(JSON.parse(JSON.stringify(options)));
      if (fetchError) throw new Error("synthetic connection reset; private detail");
      return response;
    },
    fulfill: async options => { calls.fulfilled.push(options); },
    abort: async reason => { calls.aborted.push(reason); },
    continue: async () => assert.fail("Browser redirects must never bypass the one-hop request guard"),
  });
  return calls;
}

// Behavioral fixtures for the observed portal DOM. No real Chromium, HTTP, account or notification is used.
function fixture(options = {}) {
  const state = { phase: "email", url: ORIGIN + "/Login", authenticated: false, editor: null, modal: false,
    ack: false, edits: 0, resends: 0, browserClosed: 0, contextClosed: 0, fills: [], clicks: [], navigations: [], launches: [],
    route: null, contextOptions: null, notificationIndicators: whatsappOnlyIndicators(),
    notificationHeading: "Notificaciones", notificationSections: 1, ...options };
  const target = { id: input.signatureId, cc: input.identity.identification, firstName: "MARIA", firstLastName: "PEREZ",
    ...originalContact, indicative: "57", authentication: "4", signed: false,
    ...options.target };
  const other = { ...target, id: 999999, cc: "9999999999", phone: "3119999999", email: "other@example.test" };
  const cards = options.duplicateCards ? [target, { ...target }, other] : [other, target];
  const frame = {};
  const leaf = (kind, extra = {}) => ({ kind, ...extra });
  function nodes(parent, selector) {
    if (selector.startsWith("iframe[")) return options.captcha ? [leaf("captcha")] : [];
    if (parent?.kind === "password" && selector === "xpath=ancestor::form") return [leaf("loginForm")];
    if (parent?.kind === "loginForm") return [leaf("passwordSubmit")];
    if (selector === "h4") return state.phase === "detail"
      ? Array.from({ length: state.notificationSections }, () => leaf("notificationHeading", { text: state.notificationHeading })) : [];
    if (parent?.kind === "notificationHeading" && selector === "xpath=..") return [leaf("notificationContainer")];
    if (parent?.kind === "notificationContainer" && selector === ":scope > .signature_item > .box.from")
      return state.missingNotificationBox ? [] : [leaf("notificationBox")];
    if (parent?.kind === "notificationBox") {
      if (selector === ":scope > span") return state.notificationIndicators.map(indicator => leaf("notificationIndicator", { indicator }));
      if (selector === "i") return state.notificationIndicators.map(indicator => leaf("notificationIcon", { indicator }));
    }
    if (parent?.kind === "notificationIndicator" && selector === ":scope > i")
      return [leaf("notificationIcon", { indicator: parent.indicator })];
    if (parent?.kind === "row") {
      if (selector === ".pdfTrigger") return [leaf("document", { folio: options.rowFolio || input.folio })];
      if (selector === 'a[href="/Process/Details/244008"]') return [leaf("detailLink")];
    }
    if (parent?.kind === "card") {
      if (selector === "li") return [leaf("cardFields", { card: parent.card })];
      if (selector === `#edit-signature-${parent.card.id}`) return [leaf("editLink", { card: parent.card })];
      if (selector === `a#aResend[data-id="${parent.card.id}"]`) return [leaf("resendLink", { card: parent.card })];
    }
    if (parent?.kind === "editor") {
      if (selector === "button#update-signature") return [leaf("update")];
      const match = /^(?:input|select)#(\w+)$/.exec(selector);
      if (match && Object.hasOwn(state.editor || {}, match[1])) return [leaf("field", { key: match[1] })];
    }
    if (parent?.kind === "modal") {
      if (selector === "input#signatureId") return [leaf("modalId")];
      if (selector === "a#confirm-resend") return options.missingConfirmation ? [] : [leaf("confirm")];
    }
    if (parent?.kind === "body" && selector === ".pdfTrigger")
      return [leaf("document", { folio: options.detailFolio || input.folio })];
    if (selector === "body") return [leaf("body")];
    if (selector === "input#Input_Email") return state.phase === "email" ? [leaf("emailLogin")] : [];
    if (selector === 'input[type="submit"][value="Ingresar con Contraseña"]') return state.phase === "email" ? [leaf("passwordEntry")] : [];
    if (selector === 'input[type="password"]') return state.phase === "password" ? [leaf("password")] : [];
    if (["#SearchIdentification", "#SearchFileName", "#btnFilterProcess"].includes(selector))
      return state.phase === "list" && options.missingFilter !== selector ? [leaf(selector)] : [];
    if (selector === "#myTable tr[data-process-id]") return state.phase === "list"
      ? Array.from({ length: options.rows ?? 1 }, () => leaf("row")) : [];
    if (selector === ".box.signer") return state.phase === "detail" ? cards.map(card => leaf("card", { card })) : [];
    if (selector === "#EditSigner") return state.editor ? [leaf("editor")] : [];
    if (selector === "#resend_modal") return state.modal ? [leaf("modal")] : [];
    return [];
  }
  function textNodes(parent, text) {
    if (text === "Solicitud reenviada") return state.ack || options.staleAck ? [leaf("ack")] : [];
    if (parent?.kind === "modal" && text === "¿Reenviar solicitud de firma?") return [leaf("question")];
    return [];
  }
  class Locator {
    constructor(resolve, selector = "") { this.resolve = resolve; this.selector = selector; }
    locator(selector) { return new Locator(() => this.resolve().flatMap(parent => nodes(parent, selector)), selector); }
    getByText(text) { return new Locator(() => this.resolve().flatMap(parent => textNodes(parent, text))); }
    filter({ has, hasText }) { return new Locator(() => this.resolve().filter(node => has
      ? nodes(node, has.selector).length : hasText.test(node.text || ""))); }
    first() { return this.nth(0); }
    nth(index) { return new Locator(() => this.resolve().slice(index, index + 1)); }
    async count() { return this.resolve().length; }
    async isVisible() { return this.resolve().some(node => node.indicator?.visible !== false &&
      !(node.kind === "notificationHeading" && state.hiddenNotificationHeading)); }
    async waitFor() { if (!this.resolve().length) throw new Error("fixture DOM timeout"); }
    async getAttribute(name) {
      const n = this.resolve()[0];
      if (!n) throw new Error("fixture missing node");
      if (n.kind === "passwordEntry" && name === "formaction") return options.loginAction || "/Login?returnUrl=.%2FSignInPassword";
      if (n.kind === "loginForm" && name === "action") return options.passwordAction || "/Identity/Account/SignInPassword";
      if (n.kind === "passwordSubmit" && name === "formaction") return options.passwordSubmitAction || null;
      if (n.kind === "row" && name === "data-process-id") return "244008";
      if (n.kind === "document" && name === "data-bs-original-title") return `TALONARIO_FINSERPAY_${n.folio}.pdf`;
      if (n.kind === "resendLink") return ({ href: "", title: "Reenviar correo", "data-bs-target": "#resend_modal", "data-bs-toggle": "modal" })[name] ?? null;
      if (n.kind === "notificationIcon") {
        if (state.notificationReadError) throw new Error("fixture notification read failed: private detail");
        return name === "title" ? n.indicator.title : name === "class" ? n.indicator.classes : null;
      }
      return null;
    }
    async innerText() {
      const n = this.resolve()[0];
      if (n?.kind === "body") return `Asunto: ${options.detailFolio || input.folio}\nEstado del proceso: ${options.rejected ? "Rechazado" : "Pendiente"}\n${options.otherRejected ? "Firmante diferente Rechazado" : ""}`;
      if (n?.kind === "card") return n.card.id === input.signatureId ? (options.signerRejected ? "Rechazado" : "Pendiente") : "Rechazado";
      if (n?.kind === "document") return `TALONARIO_FINSERPAY_${n.folio}.pdf`;
      if (n?.kind === "confirm") return "Reenviar";
      if (n?.kind === "notificationIndicator") return n.indicator.label;
      return "";
    }
    async allTextContents() {
      return this.resolve().flatMap(n => n.kind !== "cardFields" ? [] : [
        `CC: ${n.card.cc}`, `Email: ${n.card.email}`, `Número Celular: +57 ${n.card.phone}`,
        `Fecha de Firma: ${n.card.signed ? "13/11/2026" : "Aún no"}`,
      ]);
    }
    async inputValue() {
      const n = this.resolve()[0];
      if (n?.kind === "modalId") return String(options.modalSignatureId ?? input.signatureId);
      if (n?.kind === "field") return state.editor[n.key];
      return "";
    }
    async fill(value) {
      const n = this.resolve()[0];
      state.fills.push({ kind: n.kind, key: n.key, value });
      if (n.kind === "field") {
        state.editor[n.key] = value;
        if (options.formTampering && n.key === "MobileNumber") state.editor[options.tamperedField || "CostType"] = "changed";
        if (options.notificationChangedDuringFill && n.key === "MobileNumber") state.notificationIndicators = [];
      }
    }
    async click() {
      const n = this.resolve()[0];
      if (!n) throw new Error("fixture missing control");
      state.clicks.push(n.kind);
      if (n.kind === "passwordEntry") { state.phase = "password"; state.url = ORIGIN + "/Identity/Account/SignInPassword"; }
      if (n.kind === "passwordSubmit") {
        if (options.loginFailure) throw new Error("fixture portal password=fixture-secret should never escape");
        state.authenticated = true; state.phase = "list"; state.url = ORIGIN + "/Process/List";
      }
      if (n.kind === "detailLink") { state.phase = "detail"; state.url = ORIGIN + "/Process/Details/244008"; }
      if (n.kind === "editLink") {
        state.editor = { Id: String(n.card.id), Identification: n.card.cc, FirstName: n.card.firstName,
          FirstLastName: n.card.firstLastName, Email: n.card.email, MobileNumber: n.card.phone,
          SecondLastName: "GOMEZ", ContactByUserId: "fixture-owner-id",
          Indicative: n.card.indicative, CostType: n.card.authentication };
      }
      if (n.kind === "update") {
        state.edits++;
        if (!options.editNotApplied) { target.phone = state.editor.MobileNumber; target.email = state.editor.Email; }
        if (options.mutationRedirect || options.mutationNetworkError) {
          state.mutationTransport = await routedRequest({ state, frame }, { url: ORIGIN + "/synthetic-fixture-submit",
            method: "POST", navigation: false, status: 307,
            headers: [{ name: "Location", value: "https://untrusted.example.test/collect" }], fetchError: options.mutationNetworkError });
        }
        if (options.editTimeout) throw new Error("fixture update timeout; password=fixture-secret");
      }
      if (n.kind === "resendLink") {
        state.modal = true;
        if (options.contactChangedAtModal) target.phone = "3112223333";
        if (options.notificationChangedAtModal) state.notificationIndicators = [];
      }
      if (n.kind === "confirm") {
        state.resends++;
        if (options.mutationRedirect || options.mutationNetworkError) {
          state.mutationTransport = await routedRequest({ state, frame }, { url: ORIGIN + "/synthetic-fixture-submit",
            method: "POST", navigation: false, status: 307,
            headers: [{ name: "Location", value: "https://untrusted.example.test/collect" }], fetchError: options.mutationNetworkError });
        }
        if (!options.noResendAck && !state.mutationTransport?.aborted.length) state.ack = true;
        if (options.resendTimeout) throw new Error("fixture resend response lost");
      }
    }
  }
  const page = {
    locator: selector => new Locator(() => nodes(null, selector), selector),
    getByText: text => new Locator(() => textNodes(null, text)),
    mainFrame: () => frame, url: () => state.url, on() {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    async goto(url) {
      state.navigations.push(url);
      state.url = state.authenticated ? url : ORIGIN + "/Login?ReturnUrl=%2FProcess%2FList";
      state.phase = state.authenticated ? "list" : "email";
    },
    async reload() { state.editor = null; state.modal = false; state.ack = false; },
    async waitForLoadState() {},
    async waitForURL(url) { assert.equal(state.url, url); },
  };
  const context = {
    async route(_pattern, callback) { state.route = callback; },
    async newPage() { return page; },
    async close() { state.contextClosed++; },
  };
  const browser = {
    async newContext(value) { state.contextOptions = value; return context; },
    async close() { state.browserClosed++; },
  };
  const chromium = { async launch(value) {
    state.launches.push(value);
    if (options.browserLaunchFailure) throw new Error("fixture sandbox unavailable; private launch detail");
    return browser;
  } };
  const cleaned = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const api = runInNewContext(stripTypeScriptTypes(cleaned, { mode: "transform" }) +
    "\n({ openFirmaSeguroPortalRecipient, verifyFirmaSeguroPortalAccess, FirmaSeguroPortalError });", {
    chromium, URL, process: { env: options.env ?? { FIRMASEGURO_EMAIL: "fixture@example.test", FIRMASEGURO_PASSWORD: "fixture-secret" } },
  });
  return { ...api, state, target, page, frame, open: () => api.openFirmaSeguroPortalRecipient(input) };
}

test("inspecciona exclusivamente el firmante esperado, con identidad y documento, en sesión efímera", async () => {
  const f = fixture(), session = await f.open();
  const contact = await session.inspect();
  assert.equal(contact.signatureId, input.signatureId);
  assert.equal(contact.phone, "3001234567");
  assert.equal(contact.email, "original@example.test");
  assert.equal(contact.contactVerification, "PROVIDER_READBACK");
  assert.equal(contact.contactSource, "PORTAL_READBACK");
  assert.deepEqual(JSON.parse(JSON.stringify(contact.notificationChannels)), { whatsApp: true, email: false });
  assert.equal(f.state.contextOptions.ignoreHTTPSErrors, false);
  assert.equal(f.state.contextOptions.serviceWorkers, "block");
  assert.equal(f.state.launches[0].headless, true);
  assert.equal(f.state.launches[0].chromiumSandbox, true);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  assert.ok(!f.state.navigations.some(url => url.includes(input.processUuid)));
  await session.close(); await session.close();
  assert.equal(f.state.contextClosed, 1); assert.equal(f.state.browserClosed, 1);
});

test("Chromium recibe solo entorno del SO permitido, sin secretos de aplicación ni del portal", async () => {
  const allowed = {
    PATH: "fixture-bin", HOME: "/fixture-home", USERPROFILE: "fixture-user", SYSTEMROOT: "fixture-system",
    WINDIR: "fixture-windows", TEMP: "fixture-temp", TMP: "fixture-tmp", TMPDIR: "fixture-tmpdir",
    LANG: "es_CO.UTF-8", LC_ALL: "C.UTF-8", DISPLAY: ":fixture", PLAYWRIGHT_BROWSERS_PATH: "/fixture-browser",
  };
  const f = fixture({ env: { ...allowed, FIRMASEGURO_PORTAL_EMAIL: "portal@example.test",
    FIRMASEGURO_PORTAL_PASSWORD: "portal-fixture-secret", FIRMASEGURO_EMAIL: "fallback@example.test",
    FIRMASEGURO_PASSWORD: "fallback-fixture-secret", DATABASE_URL: "postgresql://fixture-secret",
    SESSION_SECRET: "session-fixture-secret", NODE_OPTIONS: "--inspect", UNRELATED_CONFIG: "private" } });
  await f.verifyFirmaSeguroPortalAccess();
  assert.equal(f.state.launches.length, 1);
  assert.equal(f.state.launches[0].chromiumSandbox, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.launches[0].env)), allowed);
  const minimal = fixture();
  await minimal.verifyFirmaSeguroPortalAccess();
  assert.deepEqual(JSON.parse(JSON.stringify(minimal.state.launches[0].env)), {});
});

test("un sandbox no disponible detiene el acceso sin volver a lanzar Chromium sin aislamiento", async () => {
  const f = fixture({ browserLaunchFailure: true });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_UNAVAILABLE" &&
    error.stage === "READ" && !error.uncertain && !error.message.includes("private launch detail"));
  assert.equal(f.state.launches.length, 1);
  assert.equal(f.state.launches[0].chromiumSandbox, true);
  assert.deepEqual(f.state.fills, []);
  assert.deepEqual(f.state.clicks, []);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
});

test("edita solo celular y correo, conserva identidad/autenticación y confirma mediante recarga", async () => {
  const f = fixture(), session = await f.open();
  await session.edit({ phone: "+57 301 234 5678", email: "nuevo@example.test" });
  assert.equal(f.state.edits, 1);
  assert.deepEqual(f.state.fills.filter(fill => fill.kind === "field").map(fill => fill.key), ["MobileNumber", "Email"]);
  const contact = await session.inspect();
  assert.equal(contact.phone, "3012345678"); assert.equal(contact.email, "nuevo@example.test");
  assert.equal(f.target.authentication, "4"); assert.equal(f.target.cc, input.identity.identification);
  await session.resend(contact);
  assert.equal(f.state.resends, 1);
  await assert.rejects(session.resend(contact), error => error.code === "PORTAL_RETRY_FORBIDDEN");
  assert.equal(f.state.resends, 1);
  await session.close();
});

test("correo null conserva el actual y el mismo contacto no dispara actualización", async () => {
  const f = fixture(), session = await f.open();
  await session.edit({ phone: "3001234567", email: null });
  assert.equal(f.state.edits, 0);
  await session.edit({ phone: "3021234567", email: null });
  assert.equal(f.target.email, "original@example.test"); assert.equal(f.state.edits, 1);
  await session.close();
});

for (const [label, options] of [
  ["sección ausente", { notificationSections: 0 }],
  ["sección duplicada", { notificationSections: 2 }],
  ["título oculto", { hiddenNotificationHeading: true }],
  ["contenedor desconocido", { missingNotificationBox: true }],
  ["solo OTP WhatsApp", { notificationHeading: "Autenticación OTP WhatsApp" }],
  ["indicador WhatsApp ausente", { notificationIndicators: whatsappOnlyIndicators().slice(0, 1) }],
  ["indicadores duplicados", { notificationIndicators: [whatsappOnlyIndicators()[1], whatsappOnlyIndicators()[1]] }],
  ["WhatsApp contradice su icono", { notificationIndicators: whatsappOnlyIndicators().map(indicator =>
    indicator.label.endsWith("WhatsApp") ? { ...indicator, classes: "fas fa-times text-danger" } : indicator) }],
  ["correo contradice su icono", { notificationIndicators: whatsappOnlyIndicators().map(indicator =>
    indicator.label.endsWith("Email") ? { ...indicator, classes: "fas fa-check text-success" } : indicator) }],
  ["notificación mixta con título no verificado", { notificationIndicators: whatsappOnlyIndicators().map(indicator =>
    indicator.label.endsWith("Email") ? { ...indicator, title: "Configuración de correo desconocida", classes: "fas fa-check text-success" } : indicator) }],
  ["ambas marcas en un icono", { notificationIndicators: whatsappOnlyIndicators().map(indicator =>
    ({ ...indicator, classes: indicator.classes + " fa-check fa-times" })) }],
  ["indicador oculto", { notificationIndicators: whatsappOnlyIndicators().map(indicator => ({ ...indicator, visible: false })) }],
]) test(`notificaciones: rechaza ${label} sin abrir edición ni confirmar acciones`, async () => {
  const f = fixture(options);
  await assert.rejects(f.open(), error => error.code === "PORTAL_NOTIFICATION_CHANNELS_UNVERIFIED" &&
    error.stage === "READ" && !error.uncertain);
  assert.equal(f.target.authentication, "4", "un método OTP no prueba la configuración de notificaciones");
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  assert.ok(!f.state.clicks.some(kind => ["editLink", "update", "resendLink", "confirm"].includes(kind)));
  assert.equal(f.state.browserClosed, 1); assert.equal(f.state.contextClosed, 1);
});

test("un error al leer notificaciones falla cerrado y no expone el detalle del navegador", async () => {
  const f = fixture({ notificationReadError: true });
  await assert.rejects(f.open(), error => error.code === "PORTAL_UNAVAILABLE" && !error.uncertain &&
    !error.message.includes("private detail"));
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  assert.ok(!f.state.clicks.includes("editLink"));
  assert.equal(f.state.browserClosed, 1);
});

test("revalida la configuración después de inspeccionar y antes de editar o abrir el reenvío", async () => {
  for (const stage of ["EDIT", "RESEND"]) {
    const f = fixture(), session = await f.open();
    const authorized = await session.inspect();
    f.state.notificationIndicators = [];
    f.state.clicks = [];
    await assert.rejects(stage === "EDIT"
      ? session.edit({ phone: "3012345678", email: null }) : session.resend(authorized),
    error => error.code === "PORTAL_NOTIFICATION_CHANNELS_UNVERIFIED" && error.stage === stage && !error.uncertain);
    assert.deepEqual(f.state.clicks, []);
    assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
    await session.close();
  }
});

test("un cambio de notificaciones durante el formulario o el modal impide el clic mutante", async () => {
  for (const options of [{ notificationChangedDuringFill: true }, { notificationChangedAtModal: true }]) {
    const f = fixture(options), session = await f.open();
    await assert.rejects(options.notificationChangedDuringFill
      ? session.edit({ phone: "3012345678", email: null }) : session.resend(originalContact),
    error => error.code === "PORTAL_NOTIFICATION_CHANNELS_UNVERIFIED" && !error.uncertain);
    assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
    assert.ok(!f.state.clicks.some(kind => ["update", "confirm"].includes(kind)));
    await session.close();
  }
});

test("el acuse de reenvío no se transforma en confirmación de canal emitido o entrega", async () => {
  const f = fixture(), session = await f.open();
  const before = await session.inspect();
  assert.deepEqual(JSON.parse(JSON.stringify(before.notificationChannels)), { whatsApp: true, email: false });
  assert.equal(await session.resend(before), undefined);
  const after = await session.inspect();
  assert.deepEqual(JSON.parse(JSON.stringify(after.notificationChannels)), { whatsApp: true, email: false });
  assert.equal(Object.hasOwn(after, "deliveryStatus"), false);
  assert.equal(Object.hasOwn(after, "notificationChannel"), false);
  assert.equal(f.state.resends, 1);
  await session.close();
});

for (const [label, options] of [
  ["varios procesos", { rows: 2 }], ["ningún proceso", { rows: 0 }], ["dos tarjetas con el mismo firmante", { duplicateCards: true }],
  ["folio de otro documento", { detailFolio: input.folio + "2" }], ["identificación diferente", { target: { cc: "9876543210" } }],
  ["apellido diferente", { target: { firstLastName: "Otro" } }], ["firma completada", { target: { signed: true } }],
  ["proceso rechazado", { rejected: true }], ["firmante rechazado", { signerRejected: true }], ["captcha", { captcha: true }],
]) test(`rechaza ${label} antes de mutar y cierra Chromium`, async () => {
  const f = fixture(options);
  await assert.rejects(f.open(), error => error.name === "FirmaSeguroPortalError" && error.stage === "READ" && !error.uncertain);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  assert.equal(f.state.browserClosed, 1); assert.equal(f.state.contextClosed, 1);
});

test("no envía la contraseña a un formulario de otro origen y sanitiza fallos del navegador", async () => {
  for (const options of [{ passwordAction: "https://untrusted.example.test/collect" }, { loginFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(f.open(), error => error.name === "FirmaSeguroPortalError" && !/fixture-secret|password=|untrusted/.test(error.message));
    if (options.passwordAction) assert.equal(f.state.fills.filter(fill => fill.kind === "password").length, 0);
    assert.equal(f.state.browserClosed, 1);
  }
});

test("rechaza navegación fuera de allowlist y solo admite scripts externos observados", async () => {
  for (const [url, navigation, resourceType, expectedAction] of [
    [ORIGIN + "/Signature/ActualJsRoute", false, "xhr", "continue"],
    [ORIGIN + "/Login?ReturnUrl=%2FProcess", true, "document", "continue"],
    [ORIGIN + "/Login?ReturnUrl=%2FProcess%2FList", true, "document", "continue"],
    [ORIGIN + "/Login?returnUrl=.%2FSignInPassword", true, "document", "continue"],
    [ORIGIN + "/Login?returnUrl=./SignInPassword", true, "document", "continue"],
    [ORIGIN + "/Identity/Account/SignInPassword", true, "document", "continue"],
    [ORIGIN + "/Process/", true, "document", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", false, "script", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/es.js", false, "script", "continue"],
    ["https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js", false, "script", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr?anything", false, "script", "abort"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", false, "xhr", "abort"],
    ["https://untrusted.example.test/file.js", false, "script", "abort"],
    [ORIGIN + "/Login?ReturnUrl=https%3A%2F%2Funtrusted.example.test", true, "document", "abort"],
    [ORIGIN + "/Identity/Account/Login", true, "document", "abort"],
    [ORIGIN + "/Identity/Account/Manage", true, "document", "abort"],
    [ORIGIN + "/Identity/Account/SignInPassword/extra", true, "document", "abort"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", true, "document", "abort"],
    [ORIGIN + "/Process/Delete/244008", true, "document", "abort"],
  ]) {
    const f = fixture(), session = await f.open();
    const calls = await routedRequest(f, { url, navigation, resourceType });
    assert.equal(calls.aborted.length ? "abort" : "continue", expectedAction);
    assert.equal(calls.fetches.length, expectedAction === "continue" ? 1 : 0);
    if (calls.fetches.length) assert.deepEqual(calls.fetches[0], { maxRedirects: 0, maxRetries: 0, timeout: 20000 });
    if (navigation && expectedAction === "abort")
      await assert.rejects(session.inspect(), error => error.code === "PORTAL_NAVIGATION_BLOCKED");
    await session.close();
  }
});

test("cada redirect permitido se transforma en un GET independiente sin Location ni cuerpo POST", async () => {
  for (const [method, status] of [["GET", 301], ["GET", 302], ["GET", 303], ["GET", 307], ["GET", 308], ["POST", 302], ["POST", 303]]) {
    const f = fixture(), session = await f.open();
    const calls = await routedRequest(f, { url: ORIGIN + "/Login", method, status,
      headers: [{ name: "Location", value: "/Identity/Account/SignInPassword" },
        { name: "Set-Cookie", value: "first=synthetic; Path=/; HttpOnly" },
        { name: "Set-Cookie", value: "second=synthetic; Path=/; HttpOnly" },
        { name: "Content-Length", value: "999999" }] });
    assert.equal(calls.fetches.length, 1);
    assert.deepEqual(calls.fetches[0], { maxRedirects: 0, maxRetries: 0, timeout: 20000 });
    assert.equal(calls.aborted.length, 0);
    const delivered = calls.fulfilled[0];
    assert.equal(delivered.status, 200);
    assert.match(delivered.body, /http-equiv="refresh"/);
    assert.ok(delivered.body.includes(ORIGIN + "/Identity/Account/SignInPassword"));
    assert.equal(delivered.headers.location, undefined);
    assert.equal(delivered.headers.refresh, undefined);
    assert.equal(delivered.headers["content-length"], undefined);
    assert.equal(delivered.headers["set-cookie"], "first=synthetic; Path=/; HttpOnly\nsecond=synthetic; Path=/; HttpOnly");
    assert.equal(delivered.headers["referrer-policy"], "no-referrer");
    assert.equal(calls.disposed, 1);
    await session.close();
  }
});

test("bloquea redirects externos, ambiguos, POST conservado y XHR sin efectuar el siguiente salto", async () => {
  for (const options of [
    { status: 200, destination: "https://untrusted.example.test/collect" },
    { status: 304, destination: "https://untrusted.example.test/collect" },
    { status: 307, method: "POST", destination: "https://untrusted.example.test/collect" },
    { status: 308, method: "POST", destination: "https://untrusted.example.test/collect" },
    { status: 302, method: "POST", destination: "https://untrusted.example.test/collect" },
    { status: 302, destination: "//untrusted.example.test/collect" },
    { status: 302, destination: "/Process/Delete/1" },
    { status: 302, destination: "/Login?ReturnUrl=https://untrusted.example.test/collect" },
    { status: 307, method: "POST" }, { status: 308, method: "POST" }, { status: 301, method: "POST" },
    { status: 302, navigation: false }, { status: 303, navigation: false, method: "POST" },
    { status: 302, duplicateLocation: true }, { status: 302, missingLocation: true },
  ]) {
    const f = fixture(), session = await f.open();
    const headers = options.missingLocation ? [] : [{ name: "Location", value: options.destination || "/Process/List" }];
    if (options.duplicateLocation) headers.push({ name: "location", value: "/Login" });
    const calls = await routedRequest(f, { ...options, headers });
    assert.equal(calls.fetches.length, 1);
    assert.deepEqual(calls.aborted, ["blockedbyclient"]);
    assert.equal(calls.fulfilled.length, 0);
    assert.equal(calls.disposed, 1);
    await assert.rejects(session.inspect(), error => error.code === "PORTAL_NAVIGATION_BLOCKED");
    const later = await routedRequest(f);
    assert.equal(later.fetches.length, 0, "a blocked session may not send any later request");
    await session.close();
  }
});

test("una cadena revalida cada destino y bloquea Refresh sin entregar redirecciones al navegador", async () => {
  const f = fixture(), session = await f.open();
  const first = await routedRequest(f, { url: ORIGIN + "/Login", status: 302,
    headers: [{ name: "Location", value: "/SignInPassword" }] });
  assert.equal(first.fulfilled[0].status, 200);
  const second = await routedRequest(f, { url: ORIGIN + "/SignInPassword", status: 307,
    headers: [{ name: "Location", value: "https://untrusted.example.test/collect" }] });
  assert.equal(second.fulfilled.length, 0); assert.equal(second.fetches.length, 1);
  assert.deepEqual(second.aborted, ["blockedbyclient"]);
  await session.close();
  for (const status of [200, 302]) {
    const refresh = fixture(), access = await refresh.open();
    const calls = await routedRequest(refresh, { status, headers: [
      { name: "Refresh", value: "0;url=https://untrusted.example.test/collect" },
      { name: "Location", value: "/Process/List" },
    ] });
    assert.equal(calls.fulfilled.length, 0); assert.deepEqual(calls.aborted, ["blockedbyclient"]);
    await access.close();
  }
});

test("redirects y errores de conexión tras edición/reenvío quedan inciertos y nunca repiten el POST", async () => {
  for (const options of [{ mutationRedirect: true }, { mutationNetworkError: true }]) {
    for (const stage of ["EDIT", "RESEND"]) {
      const f = fixture(options), session = await f.open();
      const send = () => stage === "EDIT" ? session.edit({ phone: "3012345678", email: null }) : session.resend(originalContact);
      await assert.rejects(send(), error => error.stage === stage && error.uncertain);
      await assert.rejects(send(), error => error.code === "PORTAL_RETRY_FORBIDDEN");
      assert.equal(f.state.mutationTransport.fetches.length, 1);
      assert.deepEqual(f.state.mutationTransport.fetches[0], { maxRedirects: 0, maxRetries: 0, timeout: 20000 });
      assert.equal(f.state.mutationTransport.fulfilled.length, 0);
      assert.equal(f.state.edits + f.state.resends, 1);
      await session.close();
    }
  }
});

test("una edición sin readback exacto o con respuesta perdida es incierta y nunca se repite", async () => {
  for (const options of [{ editNotApplied: true }, { editTimeout: true }]) {
    const f = fixture(options), session = await f.open();
    await assert.rejects(session.edit({ phone: "3012345678", email: null }), error => error.stage === "EDIT" && error.uncertain && !/fixture-secret/.test(error.message));
    await assert.rejects(session.edit({ phone: "3012345678", email: null }), error => error.code === "PORTAL_RETRY_FORBIDDEN");
    await assert.rejects(session.resend(originalContact), error => error.code === "PORTAL_RETRY_FORBIDDEN");
    assert.equal(f.state.edits, 1); assert.equal(f.state.resends, 0);
    await session.close();
  }
});

test("un formulario alterado no puede cambiar autenticación, identidad o propietario junto al contacto", async () => {
  for (const tamperedField of ["CostType", "SecondLastName", "ContactByUserId"]) {
    const f = fixture({ formTampering: true, tamperedField }), session = await f.open();
    await assert.rejects(session.edit({ phone: "3012345678", email: null }), error => error.code === "PORTAL_FORM_CHANGED" && !error.uncertain);
    assert.equal(f.state.edits, 0);
    await session.close();
  }
});

test("el modal debe confirmar el mismo signatureId; abrirlo no cuenta como envío", async () => {
  for (const options of [{ modalSignatureId: 999999 }, { missingConfirmation: true }]) {
    const f = fixture(options), session = await f.open();
    await assert.rejects(session.resend(originalContact), error => error.stage === "RESEND" && !error.uncertain);
    assert.equal(f.state.resends, 0);
    await session.close();
  }
});

test("solo el ACK visible exacto confirma reenvío; la falta de ACK no permite otro intento", async () => {
  for (const options of [{ noResendAck: true }, { resendTimeout: true }]) {
    const f = fixture(options), session = await f.open();
    await assert.rejects(session.resend(originalContact), error => error.stage === "RESEND" && error.uncertain);
    await assert.rejects(session.resend(originalContact), error => error.code === "PORTAL_RETRY_FORBIDDEN");
    assert.equal(f.state.resends, 1);
    await session.close();
  }
});

test("credenciales completas requeridas; fallback no mezcla cuentas ni abre navegador sin configuración", async () => {
  const f = fixture({ env: { FIRMASEGURO_PORTAL_EMAIL: "custom@example.test", FIRMASEGURO_PASSWORD: "fixture-secret" } });
  await assert.rejects(f.open(), error => error.code === "PORTAL_NOT_CONFIGURED");
  assert.equal(f.state.launches.length, 0);
});

test("no reenvía a un contacto cambiado después de la autorización o al abrir el modal", async () => {
  for (const options of [{}, { contactChangedAtModal: true }]) {
    const f = fixture(options), session = await f.open();
    const authorized = await session.inspect();
    if (!options.contactChangedAtModal) f.target.email = "external@example.test";
    await assert.rejects(session.resend(authorized), error => error.code === "PORTAL_CONTACT_CHANGED" && !error.uncertain);
    assert.equal(f.state.resends, 0);
    await session.close();
  }
});

test("el rechazo de otro firmante no se interpreta como rechazo del destinatario", async () => {
  const f = fixture({ otherRejected: true }), session = await f.open();
  await session.resend(originalContact);
  assert.equal(f.state.resends, 1);
  await session.close();
});

test("un reenvío sin correo autorizado no adopta el correo nuevo de otra lectura", async () => {
  const f = fixture(), session = await f.open();
  await assert.rejects(session.resend({ phone: originalContact.phone, email: null }), error => error.code === "PORTAL_CONTACT_REQUIRED" && !error.uncertain);
  assert.equal(f.state.resends, 0);
  await session.close();
});

test("verifica acceso usando el login compartido y cierra sin consultar ni modificar un destinatario", async () => {
  const f = fixture();
  assert.equal(await f.verifyFirmaSeguroPortalAccess(), undefined);
  assert.equal(f.state.url, ORIGIN + "/Process/List");
  assert.deepEqual(f.state.fills.map(fill => fill.kind), ["emailLogin", "password"]);
  assert.deepEqual(f.state.clicks, ["passwordEntry", "passwordSubmit"]);
  assert.equal(f.state.editor, null);
  assert.equal(f.state.modal, false);
  assert.equal(f.state.edits, 0);
  assert.equal(f.state.resends, 0);
  assert.ok(f.state.navigations.every(url => url === ORIGIN + "/Process/List"));
  assert.equal(f.state.contextClosed, 1);
  assert.equal(f.state.browserClosed, 1);
});

test("la verificación exige todos los filtros visibles y cierra también ante error de login o captcha", async () => {
  for (const options of [
    { missingFilter: "#SearchIdentification" }, { missingFilter: "#SearchFileName" },
    { missingFilter: "#btnFilterProcess" }, { loginFailure: true }, { captcha: true },
    { passwordAction: "https://untrusted.example.test/collect" },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.name === "FirmaSeguroPortalError" &&
      error.stage === "READ" && !error.uncertain && !/fixture-secret|password=/.test(error.message));
    assert.equal(f.state.edits, 0);
    assert.equal(f.state.resends, 0);
    assert.ok(!f.state.clicks.includes("#btnFilterProcess"));
    assert.equal(f.state.contextClosed, 1);
    assert.equal(f.state.browserClosed, 1);
  }
});

test("verificación y operaciones comparten selección de credenciales sin mezclar namespaces", async () => {
  const f = fixture({ env: { FIRMASEGURO_PORTAL_EMAIL: "custom@example.test", FIRMASEGURO_PASSWORD: "fixture-secret" } });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_NOT_CONFIGURED");
  assert.equal(f.state.launches.length, 0);
  const complete = fixture({ env: { FIRMASEGURO_PORTAL_EMAIL: "custom@example.test", FIRMASEGURO_PORTAL_PASSWORD: "custom-fixture",
    FIRMASEGURO_EMAIL: "fallback@example.test", FIRMASEGURO_PASSWORD: "fallback-fixture" } });
  await complete.verifyFirmaSeguroPortalAccess();
  assert.deepEqual(complete.state.fills.map(fill => fill.value), ["custom@example.test", "custom-fixture"]);
  assert.equal(complete.state.browserClosed, 1);
});

test("Chromium sintético: cookies y redirects no transmiten POST a un segundo origen", {
  skip: process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_TEST !== "1", timeout: 90000,
}, async () => {
  // Opt-in browser integration. Both HTTP origins bind only loopback; no provider, account or real notification is used.
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { chromium } = await import("playwright");
  let rejectedOriginRequests = 0;
  const rejectedOrigin = createServer((_request, response) => { rejectedOriginRequests++; response.end("unexpected"); });
  rejectedOrigin.listen(0, "127.0.0.1");
  await once(rejectedOrigin, "listening");
  const rejectedUrl = `http://127.0.0.1:${rejectedOrigin.address().port}/collect`;
  const browserEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"])
    if (process.env[key] !== undefined) browserEnv[key] = process.env[key];
  try {
    for (const scenario of ["allowed", "external307", "external308", "externalChain", "connectionReset"]) {
      const requests = [];
      let cookiesPreserved = false;
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        requests.push({ method: request.method, pathname, body });
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        const redirect = (status, location) => { response.statusCode = status; response.setHeader("Location", location); response.end(); };
        if (pathname === "/Process/List") {
          if (!request.headers.cookie?.includes("signed=1")) return redirect(302, "/Login?ReturnUrl=%2FProcess%2FList");
          cookiesPreserved = request.headers.cookie.includes("first=one") && request.headers.cookie.includes("second=two");
          response.end('<input id="SearchIdentification"><input id="SearchFileName"><button id="btnFilterProcess">Filtrar</button>');
        } else if (pathname === "/Login" && request.method === "GET") {
          response.end('<form method="post" action="/Login"><input id="Input_Email" name="email"><input type="submit" value="Ingresar con Contraseña" formaction="/Login?returnUrl=.%2FSignInPassword"></form>');
        } else if (pathname === "/Login" && request.method === "POST") {
          response.setHeader("Set-Cookie", ["first=one; Path=/; HttpOnly", "second=two; Path=/; HttpOnly"]);
          redirect(302, "/Identity/Account/SignInPassword");
        } else if (pathname === "/Identity/Account/SignInPassword" && request.method === "GET") {
          if (scenario === "externalChain") return redirect(307, rejectedUrl);
          response.end('<form method="post" action="/Identity/Account/SignInPassword"><input type="password" name="password"><button type="submit">Ingresar</button></form>');
        } else if (pathname === "/Identity/Account/SignInPassword" && request.method === "POST") {
          if (scenario === "external307") return redirect(307, rejectedUrl);
          if (scenario === "external308") return redirect(308, rejectedUrl);
          if (scenario === "connectionReset") { request.socket.destroy(); return; }
          response.setHeader("Set-Cookie", "signed=1; Path=/; HttpOnly");
          redirect(303, "/Process/List");
        } else { response.statusCode = 404; response.end(); }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const localOrigin = `http://127.0.0.1:${server.address().port}`;
      const rewritten = source.replace(`const ORIGIN = "${ORIGIN}";`, `const ORIGIN = "${localOrigin}";`);
      assert.notEqual(rewritten, source, "only the fixed portal origin is replaced for this loopback fixture");
      const cleaned = rewritten.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
      const access = runInNewContext(stripTypeScriptTypes(cleaned, { mode: "transform" }) + "\nverifyFirmaSeguroPortalAccess;", {
        URL, process: { env: { ...browserEnv, FIRMASEGURO_PORTAL_EMAIL: "synthetic@example.test", FIRMASEGURO_PORTAL_PASSWORD: "synthetic-password" } },
        chromium: { launch: options => chromium.launch({ ...options,
          ...(process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_CHANNEL ? { channel: process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_CHANNEL } : {}) }) },
      });
      try {
        if (scenario === "allowed") {
          await access();
          assert.equal(cookiesPreserved, true);
        } else {
          await assert.rejects(access(), error => error.name === "FirmaSeguroPortalError" && !error.uncertain &&
            !/synthetic-password|synthetic@example/.test(error.message));
        }
        assert.equal(rejectedOriginRequests, 0);
        assert.equal(requests.filter(request => request.method === "POST" && request.pathname === "/Login").length, 1);
        assert.equal(requests.filter(request => request.method === "POST" && request.pathname === "/Identity/Account/SignInPassword").length,
          scenario === "externalChain" ? 0 : 1);
        assert.ok(requests.filter(request => request.method === "GET").every(request => request.body === ""));
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  } finally {
    rejectedOrigin.closeAllConnections();
    await new Promise(resolve => rejectedOrigin.close(resolve));
  }
});
