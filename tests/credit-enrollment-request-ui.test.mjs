import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const caseId = "00000000-0000-4000-8000-000000000081";
const caseFor = (target = "D-12", overrides = {}) => ({ item: { id: caseId, conversationId: "00000000-0000-4000-8000-000000000091", kind: "enrollment", target, state: "pending", callMode: "undecided", name: "Solicitud artificial de prueba", advisor: "Asesor de prueba", ally: "Aliado de prueba", branch: "Sede de prueba", assignee: null, assigneeKey: null, version: 1, createdAt: "2026-10-31T15:00:00Z", updatedAt: "2026-10-31T15:00:00Z", ...overrides }, messages: [], notes: [], events: [], team: [], canManage: false, canAssign: false, canWrite: true, historyTruncated: false, document: null, imei: null, operationHref: null });

function mount(options = {}) {
  let cursor = 0, dirty = false, effects = [], tree, uuidCounter = 0, timerId = 0, saveImpl = options.beforeCreate;
  const slots = [], requests = [], saves = [], busy = [], timers = new Map();
  let props = { draftId: 12, contextKey: "actor-de-prueba:D-12:IMEI-A", ready: true, approved: false, disabled: false, onBusyChange: value => busy.push(value), ...options };
  props.beforeCreate = () => { saves.push({ draftId: props.draftId, contextKey: props.contextKey }); return saveImpl ? saveImpl() : Promise.resolve(props.draftId); };
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, index) => !Object.is(value, a[index]));
  const react = {
    useState(value) { const index = cursor++; slots[index] ??= { value: typeof value === "function" ? value() : value }; return [slots[index].value, next => { slots[index].value = typeof next === "function" ? next(slots[index].value) : next; dirty = true; }]; },
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
  };
  const component = name => Object.defineProperty(() => null, "name", { value: name });
  const source = readFileSync(new URL("../app/dashboard/creditos/credit-enrollment-request.tsx", import.meta.url), "utf8"), loaded = { exports: {} }, validator = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/atencion-notification-links.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: validator, exports: validator.exports, URL });
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module: loaded, exports: loaded.exports, Error, AbortController, URLSearchParams, document: { body: {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}` },
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, done: false, respond(body, status = 200) { this.done = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); }, fail(error = new Error("Conexión de prueba interrumpida")) { this.done = true; reject(error); } })),
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-dom") return { createPortal: children => children };
      if (name === "@/lib/atencion-notification-links") return validator.exports;
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      return { default: component(name) };
    },
  });
  function render() { cursor = 0; dirty = false; effects = []; tree = loaded.exports.default(props); for (const run of effects) run(); }
  async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (dirty) render(); } }
  const all = () => nodes(tree), button = label => all().find(node => (node.type === "button" || node.type?.name === "Button") && (typeof label === "string" ? text(node) === label || node.props["aria-label"] === label : label.test(text(node))));
  render();
  return { requests, saves, busy, all, button, flush, get tree() { return tree; }, setProps(patch) { props = { ...props, ...patch }; render(); }, setSave(fn) { saveImpl = fn; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

const requestButton = f => f.button(/^Solicitar enrolamiento$/);
const retryButton = f => f.button(/reintentar/i);
const panel = f => f.all().find(node => /finser-side-panel$/.test(node.type?.name || ""));
const chat = f => f.all().find(node => /attention-work-queues$/.test(node.type?.name || ""));
async function create(f, result = caseFor()) { requestButton(f).props.onClick(); await f.flush(); assert.equal(f.requests.length, 1); f.requests[0].respond(result); await f.flush(); }

test("solicitar enrolamiento exige clic y guardado exitoso antes de un único POST vinculado", async () => {
  const save = deferred(), f = mount({ beforeCreate: () => save.promise }); await f.flush();
  assert.equal(f.saves.length, 0); assert.equal(f.requests.length, 0); assert.equal(chat(f), undefined);
  const click = requestButton(f).props.onClick; click(); click(); await f.flush();
  assert.equal(f.saves.length, 1); assert.equal(f.requests.length, 0); assert.ok(f.busy.includes(true));
  save.resolve(12); await f.flush(); assert.equal(f.requests.length, 1);
  const request = f.requests[0], body = JSON.parse(request.init.body);
  assert.equal(request.url, "/api/ventas/atencion"); assert.equal(request.init.method, "POST"); assert.equal(request.init.credentials, "same-origin");
  assert.equal(request.init.headers["Content-Type"], "application/json"); assert.equal(body.kind, "enrollment"); assert.equal(body.target, "D-12"); assert.match(body.requestId, /^[0-9a-f-]{36}$/); assert.equal(typeof body.text, "string");
  click(); await f.flush(); assert.equal(f.requests.length, 1, "el bloqueo también cubre el POST pendiente");
  request.respond(caseFor()); await f.flush(); assert.equal(panel(f).props.open, true); assert.equal(chat(f).props.initialId, caseId); assert.equal(chat(f).props.expectedTarget, "D-12"); assert.equal(chat(f).props.singleCase, true); assert.equal(chat(f).props.allowCreate, false); assert.equal(f.busy.at(-1), false); f.unmount();
});

test("un guardado rechazado no crea casos y permite corregir la solicitud", async () => {
  const f = mount({ beforeCreate: () => Promise.reject(new Error("Revisa el IMEI de la solicitud de prueba")) });
  requestButton(f).props.onClick(); await f.flush(); assert.equal(f.requests.length, 0); assert.match(text(f.tree), /Revisa el IMEI/); assert.equal(f.busy.at(-1), false);
  f.setSave(() => Promise.resolve(12)); requestButton(f).props.onClick(); await f.flush(); assert.equal(f.saves.length, 2); assert.equal(f.requests.length, 1); f.unmount();
});

test("el administrador central solicita y abre el chat con su API nominal de Atención", async () => {
  const f = mount({ mode: "attention" }); await create(f);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/atencion/solicitudes");
  assert.equal(chat(f).props.mode, "attention"); assert.equal(chat(f).props.singleCase, true);
  assert.equal(chat(f).props.expectedTarget, "D-12"); assert.equal(panel(f).props.open, true); f.unmount();
});

test("cambiar entre perfil comercial y central descarta la respuesta del actor anterior", async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const old = f.requests[0];
  f.setProps({ mode: "attention" }); await f.flush(); old.respond(caseFor()); await f.flush();
  assert.equal(chat(f), undefined); requestButton(f).props.onClick(); await f.flush();
  assert.equal(f.requests[1].url, "/api/atencion/solicitudes");
  f.requests[1].respond(caseFor()); await f.flush(); assert.equal(chat(f).props.mode, "attention"); f.unmount();
});

test("un guardado que devuelve otro borrador no permite solicitar su enrolamiento", async () => {
  const f = mount({ beforeCreate: () => Promise.resolve(13) }); requestButton(f).props.onClick(); await f.flush();
  assert.equal(f.requests.length, 0); assert.match(text(f.tree), /solicitud cambió/); assert.equal(chat(f), undefined); f.unmount();
});

for (const failure of ["network", "500"]) test(`el fallo ${failure} conserva la intención y reintenta sin repetir el guardado`, async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const original = f.requests[0], body = original.init.body;
  if (failure === "network") original.fail(); else original.respond({ error: "Error temporal de prueba" }, 500);
  await f.flush(); assert.equal(chat(f), undefined); assert.ok(retryButton(f)); retryButton(f).props.onClick(); await f.flush();
  assert.equal(f.saves.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].init.body, body);
  f.requests[1].respond(caseFor()); await f.flush(); assert.equal(panel(f).props.open, true); assert.equal(chat(f).props.initialId, caseId); f.unmount();
});

test("una confirmación pendiente se puede resolver aunque llegue la aprobación mientras tanto", async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const body = f.requests[0].init.body;
  f.requests[0].fail(); await f.flush(); f.setProps({ approved: true, ready: false }); await f.flush();
  assert.equal(retryButton(f).props.disabled, false); retryButton(f).props.onClick(); await f.flush();
  assert.equal(f.requests[1].init.body, body); assert.equal(f.saves.length, 1);
  f.requests[1].respond(caseFor()); await f.flush(); assert.equal(panel(f).props.open, true); f.unmount();
});

test("un rechazo definitivo descarta el intento y exige guardar antes de una nueva solicitud", async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const original = JSON.parse(f.requests[0].init.body);
  f.requests[0].respond({ error: "Solicitud no disponible para el asesor de prueba" }, 409); await f.flush();
  assert.equal(retryButton(f), undefined); assert.match(text(f.tree), /Solicitud no disponible/);
  requestButton(f).props.onClick(); await f.flush(); assert.equal(f.saves.length, 2); assert.notEqual(JSON.parse(f.requests[1].init.body).requestId, original.requestId); f.unmount();
});

test("cambiar de contexto durante el guardado impide crear el caso anterior", async () => {
  const save = deferred(), f = mount({ beforeCreate: () => save.promise }); requestButton(f).props.onClick(); await f.flush();
  f.setProps({ draftId: 13, contextKey: "actor-de-prueba:D-13:IMEI-B" }); await f.flush(); save.resolve(12); await f.flush();
  assert.equal(f.requests.length, 0); assert.equal(chat(f), undefined); assert.equal(Boolean(panel(f)?.props.open), false);
  f.setSave(() => Promise.resolve(13)); requestButton(f).props.onClick(); await f.flush(); assert.equal(JSON.parse(f.requests[0].init.body).target, "D-13"); f.unmount();
});

for (const lateStatus of [200, 403, 500]) test(`una respuesta tardía ${lateStatus} no abre ni bloquea otro contexto`, async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const old = f.requests[0];
  f.setProps({ draftId: 13, contextKey: "actor-de-prueba:D-13:IMEI-B" }); await f.flush();
  old.respond(lateStatus === 200 ? caseFor() : { error: "Error privado del contexto anterior" }, lateStatus); await f.flush();
  assert.equal(chat(f), undefined); assert.doesNotMatch(text(f.tree), /Error privado/); assert.equal(Boolean(panel(f)?.props.open), false);
  requestButton(f).props.onClick(); await f.flush(); assert.equal(f.requests.length, 2); assert.equal(JSON.parse(f.requests[1].init.body).target, "D-13");
  f.requests[1].respond(caseFor("D-13")); await f.flush(); assert.equal(panel(f).props.open, true); assert.equal(chat(f).props.expectedTarget, "D-13"); f.unmount();
});

for (const [label, result] of [["otro borrador", caseFor("D-13")], ["otra gestión", caseFor("D-12", { kind: "welcome" })], ["identificador inválido", caseFor("D-12", { id: "no-es-un-id-real" })]]) test(`un caso con ${label} nunca se presenta en el chat de la venta`, async () => {
  const f = mount(); requestButton(f).props.onClick(); await f.flush(); const body = f.requests[0].init.body; f.requests[0].respond(result); await f.flush();
  assert.equal(chat(f), undefined); assert.equal(Boolean(panel(f)?.props.open), false); assert.ok(f.all().some(node => node.props.role === "alert"));
  retryButton(f).props.onClick(); await f.flush(); assert.equal(f.requests[1].init.body, body); assert.equal(f.saves.length, 1); f.unmount();
});

test("equipo ya aprobado, solicitud no lista o control deshabilitado no crean casos", async () => {
  for (const props of [{ approved: true }, { ready: false }, { disabled: true }, { draftId: null }]) {
    const f = mount(props); await f.flush(); const button = requestButton(f); assert.ok(!button || button.props.disabled);
    button?.props.onClick?.(); await f.flush(); assert.equal(f.saves.length, 0); assert.equal(f.requests.length, 0); f.unmount();
  }
});

test("cerrar el panel conserva el chat vinculado y al reabrir no repite solicitud ni guardado", async () => {
  const f = mount(); await create(f); const initial = chat(f), stableKey = initial.key;
  assert.equal(initial.props.active, true); assert.equal(panel(f).props.keepMounted, true);
  panel(f).props.onClose(); await f.flush(); assert.equal(panel(f).props.open, false); assert.equal(chat(f).props.active, false);
  assert.equal(chat(f).props.initialId, caseId); assert.equal(chat(f).key, stableKey, "conserva la instancia que contiene el borrador del chat");
  f.button(/(?:Abrir|Ver|Continuar).*chat/i).props.onClick(); await f.flush();
  assert.equal(panel(f).props.open, true); assert.equal(chat(f).props.active, true); assert.equal(chat(f).key, stableKey); assert.equal(f.requests.length, 1); assert.equal(f.saves.length, 1); f.unmount();
});
