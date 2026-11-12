import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/datacredito/liberaciones/tx06-release-console.tsx", import.meta.url), "utf8");
const jsx = (type, props) => ({ type, props: props || {} });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";
const lookupPath = "/api/creditos/datacredito/admin/liberaciones/buscar";
const candidate = (overrides = {}) => ({
  assessmentId: "00000000-0000-4000-8000-000000000001", documentLabel: "•••• 1234",
  eligible: true, eligibilityMessage: "Puede autorizarse un nuevo intento.", alreadyAuthorized: false,
  status: "NO_EVALUADO", errorCode: "PROVIDER_OUTCOME_AMBIGUOUS", providerStatus: "HTTP 500",
  transactionCode: null, platform: "IPHONE", createdAt: "2026-11-12T20:00:00Z",
  expiresAt: "2026-11-27T20:00:00Z", actor: {userName: "Administrador de prueba"},
  draftId: 12, authorizedAt: null, requiresNewSolicitud: true, retryKind: "AMBIGUOUS_PROVIDER", ...overrides,
});

function mount({ result = candidate(), mode = "admin", failAuthorization = false } = {}) {
  const slots = [], requests = [];
  let cursor = 0, dirty = true, tree;
  const react = {
    useState(initial) {
      const position = cursor++;
      slots[position] ??= {value: initial};
      return [slots[position].value, next => {
        slots[position].value = typeof next === "function" ? next(slots[position].value) : next;
        dirty = true;
      }];
    },
    useRef(initial) { const position = cursor++; return slots[position] ??= {current: initial}; },
    useEffect() {},
  };
  const controls = new Proxy({}, {get: (_, key) => String(key)});
  const loaded = {exports: {}};
  const compiled = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Intl, Date, Error, AbortController,
    crypto: {randomUUID: () => "00000000-0000-4000-8000-000000000002"},
    document: {getElementById: () => ({focus() {}})},
    window: {setTimeout, clearTimeout},
    fetch: async (url, options) => {
      assert.ok(url === lookupPath || url.endsWith("/autorizar-reintento"), "Only administrative endpoints may be called");
      const body = JSON.parse(options.body);
      requests.push({url, body});
      if (url === lookupPath) return Response.json({ok: true, result});
      if (failAuthorization) return Response.json({ok: false, error: "Servicio temporalmente no disponible"}, {status: 503});
      return Response.json({ok: true, result: {...result, authorizedAt: "2026-11-12T20:10:00Z", alreadyAuthorized: false}});
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return {jsx, jsxs: jsx};
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return controls;
      if (name.endsWith(".module.css")) return {default: controls};
      if (name === "next/link") return {default: "Link"};
      if (name === "@/app/_components/finser-confirm-dialog") return {default: "ConfirmDialog"};
      throw new Error("Unexpected dependency " + name);
    },
  });
  function render() { cursor = 0; dirty = false; tree = loaded.exports.default({mode}); }
  const api = {
    requests,
    async flush() {
      for (let count = 0; count < 20; count++) {
        if (dirty) render();
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty) return;
      }
      throw new Error("Release UI did not settle");
    },
    all: predicate => nodes(tree).filter(predicate),
    find(predicate) { const found = nodes(tree).find(predicate); assert.ok(found, "Expected release control"); return found; },
    text: () => text(tree),
    async search() {
      api.find(n => n.props.id === "tx06-document").props.onChange({target: {value: "001234"}});
      await api.flush();
      await api.find(n => n.type === "form").props.onSubmit({preventDefault() {}});
      await api.flush();
    },
  };
  return api;
}
const authorizationForm = ui => ui.find(n => n.type === "form" && nodes(n).some(child => text(child) === "Revisar liberación"));
const confirm = ui => ui.find(n => n.type === "ConfirmDialog" && n.props.title === "Autorizar nuevo intento DataCrédito");

test("ambiguous release requires explicit risk acceptance and final confirmation without surname input", async () => {
  const ui = mount(); await ui.flush(); await ui.search();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.all(n => n.props.id === "tx06-first-surname").length, 0);
  authorizationForm(ui).props.onSubmit({preventDefault() {}}); await ui.flush();
  assert.match(ui.text(), /Acepta el posible nuevo cobro/);
  assert.equal(confirm(ui).props.open, false);
  assert.equal(ui.requests.length, 1);
  ui.find(n => n.props.id === "dc-retry-risk").props.onChange({target: {checked: true}}); await ui.flush();
  authorizationForm(ui).props.onSubmit({preventDefault() {}}); await ui.flush();
  assert.equal(confirm(ui).props.open, true);
  assert.match(confirm(ui).props.description, /posible nuevo cobro/);
  assert.match(confirm(ui).props.description, /solicitud nueva/);
  assert.equal(ui.requests.length, 1, "Opening confirmation never authorizes or queries provider");
  await confirm(ui).props.onConfirm(); await ui.flush();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].body.riskAcknowledged, true);
  assert.equal(ui.requests[1].body.firstSurname, undefined);
  assert.match(ui.text(), /Cree una solicitud nueva/);
});

test("TX06 surname correction keeps its form and does not send ambiguous-risk authorization", async () => {
  const ui = mount({result: candidate({retryKind: "TX06_SURNAME", errorCode: "NO_EVALUABLE_INFORMATION", providerStatus: "ACCEPTED", transactionCode: "06", requiresNewSolicitud: false})});
  await ui.flush(); await ui.search();
  assert.equal(ui.all(n => n.props.id === "dc-retry-risk").length, 0);
  authorizationForm(ui).props.onSubmit({preventDefault() {}}); await ui.flush();
  assert.match(ui.text(), /Ingresa el primer apellido correcto/);
  ui.find(n => n.props.id === "tx06-first-surname").props.onChange({target: {value: "Prueba"}}); await ui.flush();
  authorizationForm(ui).props.onSubmit({preventDefault() {}}); await ui.flush();
  assert.match(confirm(ui).props.description, /TX06/);
  await confirm(ui).props.onConfirm(); await ui.flush();
  assert.equal(ui.requests[1].body.firstSurname, "Prueba");
  assert.equal(ui.requests[1].body.riskAcknowledged, undefined);
});

test("risk acceptance resets when another document is searched and analysts cannot release ambiguous cases", async () => {
  const ui = mount(); await ui.flush(); await ui.search();
  ui.find(n => n.props.id === "dc-retry-risk").props.onChange({target: {checked: true}}); await ui.flush();
  await ui.search();
  assert.equal(ui.find(n => n.props.id === "dc-retry-risk").props.checked, false);
  const analyst = mount({mode: "analyst"}); await analyst.flush(); await analyst.search();
  assert.equal(analyst.all(n => n.props.id === "dc-retry-risk").length, 0);
  assert.equal(analyst.all(n => n.type === "Button" && text(n) === "Revisar liberación").length, 0);
});

test("failed authorization reuses the same mutation identifier after explicit retry", async () => {
  const ui = mount({failAuthorization: true}); await ui.flush(); await ui.search();
  ui.find(n => n.props.id === "dc-retry-risk").props.onChange({target: {checked: true}}); await ui.flush();
  for (let attempt = 0; attempt < 2; attempt++) {
    authorizationForm(ui).props.onSubmit({preventDefault() {}}); await ui.flush();
    await confirm(ui).props.onConfirm(); await ui.flush();
  }
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests[1].body.mutationId, ui.requests[2].body.mutationId);
  assert.equal(ui.requests[1].body.riskAcknowledged, true);
  assert.equal(ui.requests[2].body.riskAcknowledged, true);
});

test("an existing ambiguous authorization is shown as released without offering another release", async () => {
  const ui = mount({result: candidate({eligible: false, alreadyAuthorized: true,
    authorizedAt: "2026-11-12T20:10:00Z", eligibilityMessage: "Esta consulta ya fue liberada para un nuevo intento."})});
  await ui.flush(); await ui.search();
  assert.match(ui.text(), /Liberación autorizada/);
  assert.equal(ui.all(n => n.props.id === "dc-retry-risk").length, 0);
  assert.equal(ui.requests.length, 1);
});
