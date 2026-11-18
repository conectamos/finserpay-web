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
const PRIVATE_BROWSER_ENDPOINT = "ws://firma-portal-browser.railway.internal:3010/connect";
const remoteEnv = () => ({ FIRMASEGURO_EMAIL: "fixture@example.test", FIRMASEGURO_PASSWORD: "fixture-secret",
  FIRMASEGURO_BROWSER_ENDPOINT: PRIVATE_BROWSER_ENDPOINT, FIRMASEGURO_BROWSER_TOKEN: "fixture_private_browser_token_1234567890" });
const originalContact = { phone: "3001234567", email: "original@example.test" };
const dataTablesScript = "https://cdn.datatables.net/v/bs5/dt-1.13.8/datatables.min.js";
function filterBody(identification = input.identity.identification, folio = input.folio) {
  return new URLSearchParams({ "FilterVM[0][Column]": "Identification", "FilterVM[0][Value]": identification,
    "FilterVM[1][Column]": "FileName", "FilterVM[1][Value]": folio, "FilterVM[2][Column]": "ProcessStatus",
    "FilterVM[2][Value]": "0", pagina: "1", registrosByPage: "50", requestId: "" }).toString();
}
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
    connections: [], remoteDisconnected: 0, closeOrder: [], filterValues: {}, filterWaiter: null,
    rowIds: options.initialRowIds ?? Array.from({ length: options.rows ?? 1 }, (_, index) => String(244008 + index)),
    tableDrawn: false, drawWaits: 0, readinessWaits: 0, filterObserved: false,
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
      ? state.rowIds.map(id => leaf("row", { id })) : [];
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
      if (n.kind === "row" && name === "data-process-id") return n.id;
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
      if (n?.kind === "#SearchIdentification" || n?.kind === "#SearchFileName") return state.filterValues[n.kind] ?? "";
      return "";
    }
    async fill(value) {
      const n = this.resolve()[0];
      state.fills.push({ kind: n.kind, key: n.key, value });
      if (n.kind === "#SearchIdentification" || n.kind === "#SearchFileName") state.filterValues[n.kind] = value;
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
      if (n.kind === "passwordEntry") {
        if (options.emailLoginFailure) throw new Error("fixture email private detail");
        state.phase = "password"; state.url = ORIGIN + "/Identity/Account/SignInPassword";
      }
      if (n.kind === "passwordSubmit") {
        if (options.loginFailure) throw new Error("fixture portal password=fixture-secret should never escape");
        state.authenticated = true; state.phase = "list"; state.url = ORIGIN + "/Process/List";
      }
      if (n.kind === "#btnFilterProcess") {
        assert.ok(state.filterWaiter, "response waiter must be armed before clicking Buscar");
        if (options.filterClickError) throw new Error("fixture filter click failed");
        void Promise.resolve(options.filterResponseDeferred).then(async () => {
          if (options.filterNoResponse) { state.filterWaiter.reject(new Error("fixture response timeout")); return; }
          const response = { url: () => options.filterUrl ?? ORIGIN + "/Process/Filter",
            request: () => ({ method: () => options.filterMethod ?? "POST", frame: () => options.filterOtherFrame ? {} : frame,
              postData: () => options.filterBody ?? filterBody() }),
            status: () => options.filterStatus ?? 200, finished: async () => options.filterFinishedError ? new Error("private failure") : null,
            json: async () => {
              if (options.filterBadJson) throw new Error("fixture invalid JSON with private data");
              return options.filterResult ?? { lista: Array.from({ length: options.rows ?? 1 }, (_, index) => ({ id: 244008 + index })) };
            } };
          if (!await state.filterWaiter.predicate(response)) { state.filterWaiter.reject(new Error("fixture unmatched response timeout")); return; }
          state.filterObserved = true;
          state.filterWaiter.resolve(response);
          await options.filterDrawDeferred;
          state.rowIds = options.renderedRowIds ?? Array.from({ length: options.rows ?? 1 }, (_, index) => String(244008 + index));
          state.tableDrawn = !options.missingDataTables;
          if (options.changedFilter) state.filterValues[options.changedFilter] = "changed";
        });
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
      if (options.firstNavigationFailure && state.navigations.length === 1)
        throw new Error("fixture No usable sandbox: private navigation detail");
      state.url = state.authenticated ? url : ORIGIN + "/Login?ReturnUrl=%2FProcess%2FList";
      state.phase = state.authenticated ? "list" : "email";
    },
    async reload() { state.editor = null; state.modal = false; state.ack = false; },
    async waitForLoadState() {},
    waitForResponse(predicate) {
      return new Promise((resolve, reject) => { state.filterWaiter = { predicate, resolve, reject }; });
    },
    async waitForFunction(predicate, argument) {
      if (argument === undefined) {
        state.readinessWaits++;
        const jQuery = options.missingSearchLibrary ? undefined : { fn: { DataTable: options.invalidSearchLibrary ? {} : () => {} } };
        if (!runInNewContext(`(${predicate.toString()})()`, { jQuery })) throw new Error("fixture library readiness timeout");
        return;
      }
      state.drawWaits++;
      assert.equal(state.filterObserved, true);
      const document = { querySelectorAll: selector => {
        assert.equal(selector, "#myTable");
        return [{ classList: { contains: name => name === "dataTable" && state.tableDrawn },
          querySelectorAll: rowSelector => {
            assert.equal(rowSelector, "tr[data-process-id]");
            return state.rowIds.map(id => ({ getAttribute: name => name === "data-process-id" ? id : null }));
          } }];
      } };
      const matches = () => runInNewContext(`(${predicate.toString()})(argument)`, { document, argument });
      if (!matches()) { await options.filterDrawDeferred; await Promise.resolve(); }
      if (!matches()) throw new Error("fixture rendered result timeout");
    },
    async waitForURL(url) { assert.equal(state.url, url); },
  };
  const context = {
    async route(_pattern, callback) { state.route = callback; },
    async newPage() { return page; },
    async close() {
      state.contextClosed++; state.closeOrder.push("context");
      if (options.contextCloseFailure) throw new Error("fixture private context close failure");
    },
  };
  const browser = {
    async newContext(value) {
      if (state.contextError) throw state.contextError;
      if (options.contextFailure) throw new Error("fixture No usable sandbox: private context detail");
      state.contextOptions = value; return context;
    },
    async close() { state.browserClosed++; state.closeOrder.push("local-browser"); },
  };
  const chromium = { async launch(value) {
    state.launches.push(value);
    if (state.browserLaunchError) throw state.browserLaunchError;
    if (options.browserLaunchFailure) throw new Error(typeof options.browserLaunchFailure === "string"
      ? options.browserLaunchFailure : "fixture sandbox unavailable; private launch detail");
    return browser;
  }, async connect(endpoint, settings) {
    state.connections.push({ endpoint, settings });
    if (options.connectionFailure) throw new Error(`fixture private connection failure ${endpoint} ${settings.headers.Authorization}`);
    return { newContext: browser.newContext,
      async close() { state.remoteDisconnected++; state.closeOrder.push("remote-disconnect"); } };
  } };
  const cleaned = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const api = runInNewContext(stripTypeScriptTypes(cleaned, { mode: "transform" }) +
    "\n({ openFirmaSeguroPortalRecipient, verifyFirmaSeguroPortalAccess, FirmaSeguroPortalError });", {
    chromium, URL, URLSearchParams, process: { env: options.env ?? { FIRMASEGURO_EMAIL: "fixture@example.test", FIRMASEGURO_PASSWORD: "fixture-secret" } },
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

test("conecta únicamente al navegador privado autenticado, sin exponer la red ni lanzar Chromium local", async () => {
  const env = remoteEnv(), f = fixture({ env });
  await f.verifyFirmaSeguroPortalAccess();
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.connections)), [{ endpoint: PRIVATE_BROWSER_ENDPOINT,
    settings: { headers: { Authorization: `Bearer ${env.FIRMASEGURO_BROWSER_TOKEN}` }, timeout: 20000 } }]);
  assert.equal(f.state.launches.length, 0);
  assert.equal(f.state.contextOptions.ignoreHTTPSErrors, false);
  assert.equal(f.state.contextOptions.serviceWorkers, "block");
  assert.deepEqual(f.state.closeOrder, ["context", "remote-disconnect"]);
  assert.equal(f.state.remoteDisconnected, 1); assert.equal(f.state.browserClosed, 0);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
});

test("la sesión remota conserva inspección y cierra únicamente su contexto y conexión una vez", async () => {
  const f = fixture({ env: remoteEnv() }), session = await f.open();
  const recipient = await session.inspect();
  assert.equal(recipient.signatureId, input.signatureId);
  assert.equal(recipient.contactSource, "PORTAL_READBACK");
  await session.close(); await session.close();
  assert.deepEqual(f.state.closeOrder, ["context", "remote-disconnect"]);
  assert.equal(f.state.connections.length, 1); assert.equal(f.state.launches.length, 0);
  assert.equal(f.state.browserClosed, 0);
});

for (const endpoint of [
  undefined, "", "ws://127.0.0.1:3010/connect", "ws://untrusted.example.test:3010/connect",
  "wss://firma-portal-browser.railway.internal:3010/connect",
  "ws://private:secret@firma-portal-browser.railway.internal:3010/connect",
  PRIVATE_BROWSER_ENDPOINT + "?token=private", PRIVATE_BROWSER_ENDPOINT + "#private",
  PRIVATE_BROWSER_ENDPOINT + "/", "ws://firma-portal-browser.railway.internal:3011/connect",
  "ws://firma-portal-browser.railway.internal:3010/a/../connect",
  " " + PRIVATE_BROWSER_ENDPOINT,
]) test("rechaza destino privado ausente o diferente sin conexión, SSRF ni fallback", async () => {
  const f = fixture({ env: { ...remoteEnv(), FIRMASEGURO_BROWSER_ENDPOINT: endpoint } });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => {
    assert.equal(error.code, "PORTAL_NOT_CONFIGURED"); assert.equal(error.status, 503);
    assert.equal(error.readPhase, "BROWSER_LAUNCH"); assert.equal(error.runtimeCategory, undefined);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /fixture_private_browser_token|private:secret|\?token=|untrusted\.example/);
    return true;
  });
  assert.equal(f.state.connections.length, 0); assert.equal(f.state.launches.length, 0);
  assert.deepEqual(f.state.fills, []); assert.deepEqual(f.state.clicks, []);
});

for (const token of [undefined, "", "x".repeat(31), "x".repeat(257), "x".repeat(32) + "=", "x".repeat(32) + "+", "x".repeat(32) + "\n"]) {
  test("rechaza token remoto ausente o inválido antes del navegador", async () => {
    const f = fixture({ env: { ...remoteEnv(), FIRMASEGURO_BROWSER_TOKEN: token } });
    await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_NOT_CONFIGURED"
      && error.status === 503 && error.readPhase === "BROWSER_LAUNCH");
    assert.equal(f.state.connections.length, 0); assert.equal(f.state.launches.length, 0);
    assert.deepEqual(f.state.fills, []);
  });
}

test("ambos valores remotos vacíos se rechazan; solo su ausencia permite el navegador local", async () => {
  const absent = fixture();
  await absent.verifyFirmaSeguroPortalAccess();
  assert.equal(absent.state.launches.length, 1); assert.equal(absent.state.connections.length, 0);
  assert.equal(absent.state.launches[0].chromiumSandbox, true);
  const empty = fixture({ env: { ...remoteEnv(), FIRMASEGURO_BROWSER_ENDPOINT: "", FIRMASEGURO_BROWSER_TOKEN: "" } });
  await assert.rejects(empty.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_NOT_CONFIGURED");
  assert.equal(empty.state.launches.length, 0); assert.equal(empty.state.connections.length, 0);
});

test("fallo remoto no reintenta ni usa fallback local y elimina endpoint y token del error", async () => {
  const f = fixture({ env: remoteEnv(), connectionFailure: true });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => {
    assert.equal(error.code, "PORTAL_UNAVAILABLE"); assert.equal(error.readPhase, "BROWSER_LAUNCH");
    assert.equal(error.runtimeCategory, "OTHER"); assert.equal(error.uncertain, false);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /railway\.internal|Bearer|fixture_private_browser_token/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.state.connections.length, 1); assert.equal(f.state.launches.length, 0);
  assert.deepEqual(f.state.fills, []); assert.deepEqual(f.state.clicks, []);
});

test("fallos de contexto o de cierre remoto desconectan al cliente sin intentar cerrar el servidor", async () => {
  const failed = fixture({ env: remoteEnv(), contextFailure: true });
  await assert.rejects(failed.verifyFirmaSeguroPortalAccess(), error => error.readPhase === "CONTEXT");
  assert.deepEqual(failed.state.closeOrder, ["remote-disconnect"]);
  assert.equal(failed.state.browserClosed, 0); assert.equal(failed.state.launches.length, 0);
  const closing = fixture({ env: remoteEnv(), contextCloseFailure: true });
  await closing.verifyFirmaSeguroPortalAccess();
  assert.deepEqual(closing.state.closeOrder, ["context", "remote-disconnect"]);
  assert.equal(closing.state.remoteDisconnected, 1); assert.equal(closing.state.browserClosed, 0);
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

for (const [message, category] of [
  ["No usable sandbox!", "SANDBOX"],
  ["Failed to move to new namespace: errno = Operation not permitted", "SANDBOX"],
  ["Running as root without --no-sandbox is not supported", "SANDBOX"],
  ["Executable doesn't exist at /private/browser", "BINARY"],
  ["spawn /private/browser ENOENT", "BINARY"],
  ["error while loading shared libraries: libexample.so", "DEPENDENCY"],
  ["Host system is missing dependencies to run browsers", "DEPENDENCY"],
  ["EACCES: permission denied, mkdir /private/profile", "FILESYSTEM"],
  ["ENOSPC: no space left on device", "FILESYSTEM"],
  ["unexpected browser transport termination", "OTHER"],
]) test(`diagnóstico de lanzamiento ${category} no conserva el error crudo`, async () => {
  const raw = `${message}; credential=fixture-private-secret; https://private.example.test/?token=private`;
  const f = fixture({ browserLaunchFailure: raw });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => {
    assert.equal(error.code, "PORTAL_UNAVAILABLE");
    assert.equal(error.message, "No se pudo verificar la firma en el portal de FirmaSeguro.");
    assert.equal(error.status, 502); assert.equal(error.stage, "READ"); assert.equal(error.uncertain, false);
    assert.equal(error.readPhase, "BROWSER_LAUNCH"); assert.equal(error.runtimeCategory, category);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /fixture-private-secret|private\.example|credential=|\/private\//);
    return true;
  });
  assert.equal(f.state.launches.length, 1);
  assert.equal(f.state.launches[0].chromiumSandbox, true);
  assert.deepEqual(f.state.fills, []); assert.deepEqual(f.state.clicks, []);
});

for (const [options, phase] of [
  [{ contextFailure: true }, "CONTEXT"],
  [{ firstNavigationFailure: true }, "FIRST_NAVIGATION"],
  [{ emailLoginFailure: true }, "LOGIN_EMAIL"],
  [{ loginFailure: true }, "LOGIN_PASSWORD"],
  [{ missingFilter: "#SearchIdentification" }, "LIST_VERIFICATION"],
]) test(`diagnóstico ${phase} sin clasificar mensajes posteriores como fallo de lanzamiento`, async () => {
  const f = fixture(options);
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => {
    assert.equal(error.code, "PORTAL_UNAVAILABLE");
    assert.equal(error.readPhase, phase); assert.equal(error.runtimeCategory, undefined);
    assert.equal(error.stage, "READ"); assert.equal(error.uncertain, false);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /private detail|fixture-secret|private context|private navigation/);
    return true;
  });
  assert.equal(f.state.browserClosed, 1);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
});

test("un error conocido conserva código y diagnóstico seguro al envolverse", async () => {
  const f = fixture();
  f.state.contextError = new f.FirmaSeguroPortalError("PORTAL_NETWORK_FAILED", "Mensaje seguro", 502,
    "READ", false, "FIRST_NAVIGATION", "OTHER");
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_NETWORK_FAILED"
    && error.message === "Mensaje seguro" && error.readPhase === "FIRST_NAVIGATION" && error.runtimeCategory === "OTHER"
    && error.stage === "READ" && !error.uncertain);
  assert.equal(f.state.browserClosed, 1);
});

test("un error conocido de lanzamiento no se categoriza por su mensaje", async () => {
  const f = fixture();
  f.state.browserLaunchError = new f.FirmaSeguroPortalError("PORTAL_STRUCTURE_CHANGED", "No usable sandbox", 409);
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_STRUCTURE_CHANGED"
    && error.message === "No usable sandbox" && error.readPhase === "BROWSER_LAUNCH" && error.runtimeCategory === undefined);
});

test("la configuración incompleta sigue fallando antes de atribuir una fase de navegador", async () => {
  const f = fixture({ env: {} });
  await assert.rejects(f.verifyFirmaSeguroPortalAccess(), error => error.code === "PORTAL_NOT_CONFIGURED"
    && error.readPhase === undefined && error.runtimeCategory === undefined);
  assert.equal(f.state.launches.length, 0);
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

test("espera respuesta del filtro y su dibujo demorado aunque networkidle ya terminó y queden 50 filas anteriores", async () => {
  const response = Promise.withResolvers(), draw = Promise.withResolvers();
  const f = fixture({ initialRowIds: Array.from({ length: 50 }, (_, index) => String(10000 + index)),
    filterResponseDeferred: response.promise, filterDrawDeferred: draw.promise });
  const opened = f.open();
  await new Promise(setImmediate);
  assert.ok(f.state.clicks.includes("#btnFilterProcess"));
  assert.equal(f.state.filterObserved, false);
  assert.equal(f.state.clicks.includes("detailLink"), false);
  response.resolve();
  await new Promise(setImmediate);
  assert.equal(f.state.filterObserved, true);
  assert.equal(f.state.drawWaits, 1);
  assert.equal(f.state.clicks.includes("detailLink"), false);
  draw.resolve();
  const session = await opened;
  assert.equal(f.state.clicks.filter(click => click === "detailLink").length, 1);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  await session.close();
});

for (const [label, options] of [
  ["sin respuesta", { filterNoResponse: true }], ["HTTP fallido", { filterStatus: 500 }],
  ["respuesta incompleta", { filterFinishedError: true }], ["JSON inválido", { filterBadJson: true }],
  ["lista ausente", { filterResult: {} }], ["lista no es arreglo", { filterResult: { lista: {} } }],
  ["id cero", { filterResult: { lista: [{ id: 0 }] } }], ["id no numérico", { filterResult: { lista: [{ id: "244008junk" }] } }],
  ["id no entero", { filterResult: { lista: [{ id: 244008.5 }] } }],
  ["id no seguro", { filterResult: { lista: [{ id: Number.MAX_SAFE_INTEGER + 1 }] } }],
  ["id duplicado", { filterResult: { lista: [{ id: 244008 }, { id: 244008 }] } }],
  ["fila anterior de otro proceso", { renderedRowIds: ["244009"] }],
  ["duplicado oculto en DOM", { renderedRowIds: ["244008", "244008"] }],
  ["DataTables no cargó", { missingDataTables: true }],
  ["cédula cambió", { changedFilter: "#SearchIdentification" }], ["folio cambió", { changedFilter: "#SearchFileName" }],
  ["otra URL", { filterUrl: ORIGIN + "/Process/Filter?other=1" }], ["otro método", { filterMethod: "GET" }],
  ["otro frame", { filterOtherFrame: true }], ["otra cédula", { filterBody: filterBody("9999999999") }],
  ["otro folio", { filterBody: filterBody(input.identity.identification, input.folio + "2") }],
  ["otra página", { filterBody: filterBody().replace("pagina=1", "pagina=2") }],
  ["valor de cédula duplicado", { filterBody: filterBody() + "&FilterVM%5B0%5D%5BValue%5D=1234567890" }],
  ["columna de cédula repetida", { filterBody: filterBody() + "&FilterVM%5B3%5D%5BColumn%5D=Identification&FilterVM%5B3%5D%5BValue%5D=1234567890" }],
  ["cuerpo demasiado grande", { filterBody: filterBody() + "&extra=" + "x".repeat(16_384) }],
]) test(`búsqueda rechaza ${label} antes de abrir detalles o modificar`, async () => {
  const f = fixture(options);
  await assert.rejects(f.open(), error => error.name === "FirmaSeguroPortalError" && error.stage === "READ" &&
    !error.uncertain && !/private|fixture-secret/.test(error.message));
  assert.equal(f.state.clicks.includes("detailLink"), false);
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
    [dataTablesScript, false, "script", "continue"],
    [dataTablesScript.replace("1.13.8", "1.13.9"), false, "script", "abort"],
    [dataTablesScript + "?anything", false, "script", "abort"],
    [dataTablesScript, false, "xhr", "abort"],
    [dataTablesScript, true, "document", "abort"],
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

test("la dependencia DataTables exacta no autoriza redirects a otro destino", async () => {
  for (const location of ["https://cdn.datatables.net/another.js", "https://untrusted.example.test/collect", ORIGIN + "/Process/List"]) {
    const f = fixture(), session = await f.open();
    const calls = await routedRequest(f, { url: dataTablesScript, navigation: false, resourceType: "script", status: 302,
      headers: [{ name: "Location", value: location }] });
    assert.equal(calls.fetches.length, 1);
    assert.equal(calls.fulfilled.length, 0);
    assert.deepEqual(calls.aborted, ["blockedbyclient"]);
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

for (const [label, options] of [["ausente o bloqueada", { missingSearchLibrary: true }], ["API no disponible", { invalidSearchLibrary: true }]])
  test(`la verificación de acceso y la búsqueda rechazan DataTables ${label} aunque estén visibles los filtros`, async () => {
    for (const operation of ["verifyFirmaSeguroPortalAccess", "open"]) {
      const f = fixture(options);
      await assert.rejects(f[operation](), error => error.code === "PORTAL_STRUCTURE_CHANGED" &&
        error.message === "No se confirmó la biblioteca de búsqueda del portal." && error.stage === "READ" &&
        error.readPhase === "LIST_VERIFICATION" && !error.uncertain);
      assert.equal(f.state.readinessWaits, 1);
      assert.equal(f.state.clicks.includes("#btnFilterProcess"), false);
      assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
      assert.equal(f.state.browserClosed, 1); assert.equal(f.state.contextClosed, 1);
    }
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
          response.end('<input id="SearchIdentification"><input id="SearchFileName"><button id="btnFilterProcess">Filtrar</button><script src="/fixture-datatables.js"></script>');
        } else if (pathname === "/fixture-datatables.js") {
          response.setHeader("Content-Type", "application/javascript");
          response.end("globalThis.jQuery = { fn: { DataTable() {} } };");
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

test("Chromium sintético: la búsqueda espera el reemplazo asíncrono de 50 filas y rechaza resultados ambiguos", {
  skip: process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_TEST !== "1", timeout: 90000,
}, async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { chromium } = await import("playwright");
  const browserEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"])
    if (process.env[key] !== undefined) browserEnv[key] = process.env[key];
  const pdf = `<span class="pdfTrigger" title="TALONARIO_FINSERPAY_${input.folio}.pdf">Documento</span>`;
  const row = id => `<tr data-process-id="${id}"><td>${pdf}<a href="/Process/Details/${id}">Detalle</a></td></tr>`;
  for (const scenario of ["delayed", "empty", "multiple"]) {
    const detailIds = [], requests = [];
    let currentSession;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      requests.push({ pathname, method: request.method });
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const redirect = location => { response.statusCode = 303; response.setHeader("Location", location); response.end(); };
      if (pathname === "/Process/List") {
        if (!request.headers.cookie?.includes("signed=1")) return redirect("/Login?ReturnUrl=%2FProcess%2FList");
        response.end(`<!doctype html><script src="/fixture-datatables.js"></script><div id="controls" hidden><input id="SearchIdentification"><input id="SearchFileName"><button id="btnFilterProcess" type="button">Buscar</button></div>
          <table id="myTable"><tbody>${Array.from({ length: 50 }, (_, index) => row(10000 + index)).join("")}</tbody></table>
          <script>
            // Controls become visible after the document has already reached networkidle.
            setTimeout(() => { document.querySelector('#controls').hidden = false; }, 650);
            document.querySelector('#btnFilterProcess').addEventListener('click', async () => {
              const params = new URLSearchParams({
                'FilterVM[0][Column]':'Identification', 'FilterVM[0][Value]':document.querySelector('#SearchIdentification').value,
                'FilterVM[1][Column]':'FileName', 'FilterVM[1][Value]':document.querySelector('#SearchFileName').value,
                pagina:'1', registrosByPage:'50', requestId:''
              });
              const result = await (await fetch('/Process/Filter', { method:'POST', body:params })).json();
              // Response and rendering are distinct events; stale rows remain until the draw completes.
              setTimeout(() => {
                document.querySelector('#myTable tbody').innerHTML = result.lista.map(item => ${JSON.stringify(row("REPLACE_ID"))}.replaceAll('REPLACE_ID', item.id)).join('');
                document.querySelector('#myTable').classList.add('dataTable');
              }, 180);
            });
          </script>`);
      } else if (pathname === "/fixture-datatables.js") {
        response.setHeader("Content-Type", "application/javascript");
        response.end("globalThis.jQuery = { fn: { DataTable() {} } };");
      } else if (pathname === "/Process/Filter" && request.method === "POST") {
        assert.equal(new URLSearchParams(body).get("FilterVM[0][Value]"), input.identity.identification);
        assert.equal(new URLSearchParams(body).get("FilterVM[1][Value]"), input.folio);
        await new Promise(resolve => setTimeout(resolve, 80));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ lista: scenario === "empty" ? [] : scenario === "multiple" ? [{ id: 244008 }, { id: 244009 }] : [{ id: 244008 }] }));
      } else if (pathname === "/Login" && request.method === "GET") {
        response.end('<form method="post" action="/Login"><input id="Input_Email" name="email"><input type="submit" value="Ingresar con Contraseña" formaction="/Login?returnUrl=.%2FSignInPassword"></form>');
      } else if (pathname === "/Login" && request.method === "POST") {
        redirect("/Identity/Account/SignInPassword");
      } else if (pathname === "/Identity/Account/SignInPassword" && request.method === "GET") {
        response.end('<form method="post" action="/Identity/Account/SignInPassword"><input type="password" name="password"><button type="submit">Ingresar</button></form>');
      } else if (pathname === "/Identity/Account/SignInPassword" && request.method === "POST") {
        response.setHeader("Set-Cookie", "signed=1; Path=/; HttpOnly");
        redirect("/Process/List");
      } else if (pathname.startsWith("/Process/Details/")) {
        detailIds.push(pathname.split("/").at(-1));
        response.end(`<!doctype html>${pdf}<p>Estado del proceso: Pendiente</p>
          <div class="box signer"><ul><li>CC: ${input.identity.identification}</li><li>Email: ${originalContact.email}</li><li>Número Celular: ${originalContact.phone}</li><li>Fecha de Firma: Aún no</li></ul>
            <button id="edit-signature-${input.signatureId}" onclick="document.querySelector('#EditSigner').hidden=false">Editar</button></div>
          <section><h4>Notificaciones</h4><div class="signature_item"><div class="box from">
            <span>Notificación por Email<i title="No se envía Email" class="fas fa-times text-danger"></i></span>
            <span>Notificación por WhatsApp<i title="Notificaciones por WhatsApp" class="fas fa-check text-success"></i></span>
          </div></div></section>
          <div id="EditSigner" hidden>
            <input id="Id" value="${input.signatureId}"><input id="Identification" value="${input.identity.identification}">
            <input id="FirstName" value="MARIA"><input id="FirstLastName" value="PEREZ">
            <input id="Email" value="${originalContact.email}"><input id="MobileNumber" value="${originalContact.phone}">
            <select id="Indicative"><option value="57">57</option></select><select id="CostType"><option value="4">4</option></select>
          </div><style>i { display:inline-block; width:1px; height:1px; }</style>`);
      } else { response.statusCode = 404; response.end(); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const localOrigin = `http://127.0.0.1:${server.address().port}`;
    const rewritten = source.replace(`const ORIGIN = "${ORIGIN}";`, `const ORIGIN = "${localOrigin}";`);
    assert.notEqual(rewritten, source);
    const cleaned = rewritten.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const open = runInNewContext(stripTypeScriptTypes(cleaned, { mode: "transform" }) + "\nopenFirmaSeguroPortalRecipient;", {
      URL, URLSearchParams, process: { env: { ...browserEnv, FIRMASEGURO_PORTAL_EMAIL: "synthetic@example.test", FIRMASEGURO_PORTAL_PASSWORD: "synthetic-password" } },
      chromium: { launch: options => chromium.launch({ ...options,
        ...(process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_CHANNEL ? { channel: process.env.FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_CHANNEL } : {}) }) },
    });
    try {
      if (scenario === "delayed") {
        currentSession = await open(input);
        const contact = await currentSession.inspect();
        assert.equal(contact.signatureId, input.signatureId);
        assert.ok(detailIds.length > 0);
        assert.ok(detailIds.every(id => id === "244008"));
      } else {
        await assert.rejects(open(input), error => error.code === "PORTAL_STRUCTURE_CHANGED" && !error.uncertain);
        assert.deepEqual(detailIds, []);
      }
      assert.equal(requests.filter(request => request.pathname === "/Process/Filter").length, 1);
      assert.ok(requests.filter(request => request.method === "POST").every(request =>
        ["/Login", "/Identity/Account/SignInPassword", "/Process/Filter"].includes(request.pathname)));
    } finally {
      await currentSession?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
