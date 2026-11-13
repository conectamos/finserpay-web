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

// Behavioral fixtures for the observed portal DOM. No real Chromium, HTTP, account or notification is used.
function fixture(options = {}) {
  const state = { phase: "email", url: ORIGIN + "/Login", authenticated: false, editor: null, modal: false,
    ack: false, edits: 0, resends: 0, browserClosed: 0, contextClosed: 0, fills: [], navigations: [], launches: [],
    route: null, contextOptions: null, ...options };
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
      return state.phase === "list" ? [leaf(selector)] : [];
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
    filter({ has }) { return new Locator(() => this.resolve().filter(node => nodes(node, has.selector).length)); }
    first() { return this.nth(0); }
    nth(index) { return new Locator(() => this.resolve().slice(index, index + 1)); }
    async count() { return this.resolve().length; }
    async isVisible() { return this.resolve().length > 0; }
    async waitFor() { if (!this.resolve().length) throw new Error("fixture DOM timeout"); }
    async getAttribute(name) {
      const n = this.resolve()[0];
      if (!n) throw new Error("fixture missing node");
      if (n.kind === "passwordEntry" && name === "formaction") return options.loginAction || "/Login?returnUrl=.%2FSignInPassword";
      if (n.kind === "loginForm" && name === "action") return options.passwordAction || "/SignInPassword";
      if (n.kind === "passwordSubmit" && name === "formaction") return options.passwordSubmitAction || null;
      if (n.kind === "row" && name === "data-process-id") return "244008";
      if (n.kind === "document" && name === "data-bs-original-title") return `TALONARIO_FINSERPAY_${n.folio}.pdf`;
      if (n.kind === "resendLink") return ({ href: "", title: "Reenviar correo", "data-bs-target": "#resend_modal", "data-bs-toggle": "modal" })[name] ?? null;
      return null;
    }
    async innerText() {
      const n = this.resolve()[0];
      if (n?.kind === "body") return `Asunto: ${options.detailFolio || input.folio}\nEstado del proceso: ${options.rejected ? "Rechazado" : "Pendiente"}\n${options.otherRejected ? "Firmante diferente Rechazado" : ""}`;
      if (n?.kind === "card") return n.card.id === input.signatureId ? (options.signerRejected ? "Rechazado" : "Pendiente") : "Rechazado";
      if (n?.kind === "document") return `TALONARIO_FINSERPAY_${n.folio}.pdf`;
      if (n?.kind === "confirm") return "Reenviar";
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
      }
    }
    async click() {
      const n = this.resolve()[0];
      if (!n) throw new Error("fixture missing control");
      if (n.kind === "passwordEntry") { state.phase = "password"; state.url = ORIGIN + "/SignInPassword"; }
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
        if (options.editTimeout) throw new Error("fixture update timeout; password=fixture-secret");
      }
      if (n.kind === "resendLink") {
        state.modal = true;
        if (options.contactChangedAtModal) target.phone = "3112223333";
      }
      if (n.kind === "confirm") {
        state.resends++;
        if (!options.noResendAck) state.ack = true;
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
  const chromium = { async launch(value) { state.launches.push(value); return browser; } };
  const cleaned = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const api = runInNewContext(stripTypeScriptTypes(cleaned, { mode: "transform" }) +
    "\n({ openFirmaSeguroPortalRecipient, FirmaSeguroPortalError });", {
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
  assert.equal(f.state.contextOptions.ignoreHTTPSErrors, false);
  assert.equal(f.state.contextOptions.serviceWorkers, "block");
  assert.equal(f.state.launches[0].headless, true);
  assert.equal(f.state.edits, 0); assert.equal(f.state.resends, 0);
  assert.ok(!f.state.navigations.some(url => url.includes(input.processUuid)));
  await session.close(); await session.close();
  assert.equal(f.state.contextClosed, 1); assert.equal(f.state.browserClosed, 1);
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
  const f = fixture(), session = await f.open();
  for (const [url, navigation, resourceType, expectedAction] of [
    [ORIGIN + "/Signature/ActualJsRoute", false, "xhr", "continue"],
    [ORIGIN + "/Login?ReturnUrl=%2FProcess", true, "document", "continue"],
    [ORIGIN + "/Login?ReturnUrl=%2FProcess%2FList", true, "document", "continue"],
    [ORIGIN + "/Login?returnUrl=.%2FSignInPassword", true, "document", "continue"],
    [ORIGIN + "/Login?returnUrl=./SignInPassword", true, "document", "continue"],
    [ORIGIN + "/Process/", true, "document", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", false, "script", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/es.js", false, "script", "continue"],
    ["https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js", false, "script", "continue"],
    ["https://cdn.jsdelivr.net/npm/flatpickr?anything", false, "script", "abort"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", false, "xhr", "abort"],
    ["https://untrusted.example.test/file.js", false, "script", "abort"],
    [ORIGIN + "/Login?ReturnUrl=https%3A%2F%2Funtrusted.example.test", true, "document", "abort"],
    ["https://cdn.jsdelivr.net/npm/flatpickr", true, "document", "abort"],
    [ORIGIN + "/Process/Delete/244008", true, "document", "abort"],
  ]) {
    let action;
    await f.state.route({ request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => f.frame, resourceType: () => resourceType }),
      continue: async () => { action = "continue"; }, abort: async () => { action = "abort"; } });
    assert.equal(action, expectedAction);
  }
  await assert.rejects(session.inspect(), error => error.code === "PORTAL_NAVIGATION_BLOCKED");
  await session.close();
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
