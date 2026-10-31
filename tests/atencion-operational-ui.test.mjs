import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/atencion/attention-operational.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : ["string", "number"].includes(typeof tree) ? String(tree) : "";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const inbound = n => ({ id: id(n), direction: "inbound", text: "Mensaje sintético", sentAt: "2026-10-30T15:00:00Z" });
const detail = { conversation: { id: id(1) }, messages: [inbound(10), { ...inbound(11), direction: "outbound" }] };
function mount(component, initial = {}) {
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, uuid = 20, props;
  const slots = [], timers = new Map(), requests = [], events = new Map();
  const environment = { visibilityState: "visible", onLine: true, modal: false };
  const target = name => ({ addEventListener(event, fn) { events.set(`${name}:${event}`, fn); }, removeEventListener(event) { events.delete(`${name}:${event}`); } });
  const element = { clientHeight: 400, scrollHeight: 1000, scrollTop: 600, ...target("log"), getBoundingClientRect: () => ({ top: 120, bottom: 520, left: 350, right: 1000 }) };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[n].value, next => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; dirty = true; }]; },
    useRef(value) { const n = cursor++; slots[n] ??= { current: value }; return slots[n]; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || deps.some((value, i) => !Object.is(value, slots[n].deps[i]))) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!slots[n] || deps.some((value, i) => !Object.is(value, slots[n].deps[i]))) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: fn() }; }); },
  };
  const loaded = { exports: {} };
  const schedule = (fn, delay, interval = 0) => { const key = ++timerId; timers.set(key, { fn, at: now + delay, interval }); return key; };
  runInNewContext(outputText, { module: loaded, exports: loaded.exports, URLSearchParams, AbortController,
    crypto: { randomUUID: () => id(++uuid) },
    document: { get visibilityState() { return environment.visibilityState; }, querySelector: () => environment.modal ? {} : null, ...target("document") },
    navigator: { get onLine() { return environment.onLine; } }, window: { innerHeight: 900, innerWidth: 1440, ...target("window") },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: key => timers.delete(key), setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: key => timers.delete(key),
    require(name) { if (name === "react") return react; if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props: props || {} }), jsxs: (type, props) => ({ type, props: props || {} }) }; if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) }; return new Proxy({}, { get: (_, key) => key }); },
  });
  props = { request: (url, init = {}) => new Promise((resolve, reject) => requests.push({ url, init, respond: resolve, fail: reject })), detail, active: true, log: { current: element }, onRead() {}, onError() {}, disabled: false, revision: 0, openChat() {}, busyChanged() {}, saved() {}, accessDenied: () => false, ...initial };
  function render() { cursor = 0; effects = []; dirty = false; tree = loaded.exports[component](props); for (const effect of effects) effect(); }
  async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [key, timer] = next; now = timer.at; if (timer.interval) timer.at += timer.interval; else timers.delete(key); timer.fn(); await flush(); } now = until; await flush(); }
  render();
  return { requests, environment, element, flush, advance, all: () => nodes(tree), text: () => text(tree), exports: loaded.exports,
    button: label => nodes(tree).find(node => node.type === "button" || node.type === "Button" ? text(node).startsWith(label) : false),
    setProps(patch) { props = { ...props, ...patch }; render(); }, dispatch(name, event) { events.get(`${name}:${event}`)?.(); }, unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("ACK envía solo IDs inbound observados al fondo y no un reloj ni un mensaje concurrente", async () => {
  let reads = 0; const f = mount("AttentionObservedRead", { onRead: () => reads++ });
  await f.advance(200); assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { messageIds: [id(10)] });
  assert.equal(f.requests[0].url, `/api/atencion/${id(1)}/read`);
  f.requests[0].respond({ changed: true, unreadCount: 1 }); await f.flush(); assert.equal(reads, 1);
  f.dispatch("log", "scroll"); await f.advance(200); assert.equal(f.requests.length, 1);
  f.setProps({ detail: { ...detail, messages: [...detail.messages, inbound(12)] } }); await f.advance(200);
  assert.deepEqual(JSON.parse(f.requests[1].init.body), { messageIds: [id(12)] }); f.unmount();
});

test("chat oculto, lectura anterior, modal y scroll lejos del fondo jamás marcan leído", async () => {
  for (const block of [f => { f.environment.visibilityState = "hidden"; }, f => { f.element.scrollTop = 200; }, f => { f.element.clientHeight = 0; }, f => { f.environment.modal = true; }, f => f.setProps({ active: false })]) {
    const f = mount("AttentionObservedRead"); block(f); await f.advance(500); assert.equal(f.requests.length, 0); f.unmount();
  }
  const f = mount("AttentionObservedRead"); f.element.scrollTop = 200; await f.advance(200); f.element.scrollTop = 600; f.dispatch("log", "scroll"); await f.advance(200); assert.equal(f.requests.length, 1); f.unmount();
});

test("ACK tardío no actualiza otro chat y cleanup cancela peticiones y listeners", async () => {
  let reads = 0; const f = mount("AttentionObservedRead", { onRead: () => reads++ }); await f.advance(200);
  f.unmount(); assert.equal(f.requests[0].init.signal.aborted, true); f.requests[0].respond({ changed: true }); await f.flush(); assert.equal(reads, 0);
  f.dispatch("log", "scroll"); await f.advance(1000); assert.equal(f.requests.length, 1);
});

test("filtros ofrecen Sin asignar solo a central y conservan etiqueta al cambiar cola", () => {
  const changes = []; const inbox = { operational: { unread: 3, unanswered: 4, unassigned: 2 }, availableTags: ["FINSERPAY", "Seguimiento"] };
  const f = mount("AttentionWorkFilters", { inbox, central: true, filter: "all", tag: "Seguimiento", change: (...args) => changes.push(args) });
  f.button("No leídos").props.onClick(); assert.deepEqual(changes[0], ["unread", "Seguimiento"]); assert.ok(f.button("Sin asignar"));
  f.setProps({ central: false }); assert.equal(f.button("Sin asignar"), undefined); assert.ok(f.all().some(node => node.props.value === "FINSERPAY")); f.unmount();
});

test("filtros compactos alternan Clientes sin perder colas ni filtros avanzados", () => {
  const changes = []; const inbox = { operational: { unread: 3, unanswered: 4, unassigned: 2 }, availableTags: ["FINSERPAY", "Seguimiento"] };
  const f = mount("AttentionWorkFilters", { inbox, central: true, compact: true, filter: "all", tag: "", change: (...args) => changes.push(args) });
  assert.equal(f.button("Todos").props["aria-pressed"], true); assert.ok(f.button("No leídos3")); assert.ok(f.all().some(node => node.type === "details"));
  f.button("Clientes").props.onClick(); assert.deepEqual(changes.at(-1), ["all", "FINSERPAY"]);
  f.setProps({ filter: "unread", tag: "FINSERPAY" }); assert.equal(f.button("Clientes").props["aria-pressed"], true);
  f.button("No leídos").props.onClick(); assert.deepEqual(changes.at(-1), ["all", "FINSERPAY"]);
  f.button("Sin responder").props.onClick(); assert.deepEqual(changes.at(-1), ["unanswered", "FINSERPAY"]);
  f.button("Sin asignar").props.onClick(); assert.deepEqual(changes.at(-1), ["unassigned", "FINSERPAY"]);
  f.button("Clientes").props.onClick(); assert.deepEqual(changes.at(-1), ["all", ""]);
  f.setProps({ filter: "closed", tag: "Seguimiento" });
  assert.ok(f.all().some(node => node.props["aria-label"] === "Filtros adicionales activos"));
  f.all().find(node => node.props["aria-label"] === "Estado de conversaciones").props.onChange({ target: { value: "mine" } }); assert.deepEqual(changes.at(-1), ["mine", "Seguimiento"]);
  f.all().find(node => node.props["aria-label"] === "Filtrar por etiqueta").props.onChange({ target: { value: "FINSERPAY" } }); assert.deepEqual(changes.at(-1), ["closed", "FINSERPAY"]);
  f.button("Todos").props.onClick(); assert.deepEqual(changes.at(-1), ["all", ""]);
  f.setProps({ central: false }); assert.equal(f.button("Sin asignar"), undefined); assert.equal(f.requests.length, 0); f.unmount();
});

const task = { id: id(30), title: "Llamar al contacto sintético", dueAt: "2026-10-30T15:00:00Z", author: "Analista QA", conversation: { id: id(1), name: "Contacto QA", phone: null, version: 7 } };
const agenda = { items: [task], counts: { today: 1, overdue: 2, upcoming: 3, undated: 1, total: 7 }, page: 1, pageSize: 40, total: 1, today: "2026-10-30" };
test("Agenda abre chat y completa con versión y UUID; doble clic nunca duplica la intención", async () => {
  const opens = [], busy = []; let saved = 0;
  const f = mount("AttentionAgendaView", { openChat: id => opens.push(id), busyChanged: value => busy.push(value), saved: () => saved++ });
  await f.advance(0); assert.match(f.requests[0].url, /filter=today&page=1$/); f.requests[0].respond(agenda); await f.flush();
  f.button("Abrir chat").props.onClick(); assert.deepEqual(opens, [id(1)]);
  f.button("Completar").props.onClick(); f.button("Completar").props.onClick(); await f.flush(); assert.equal(f.requests.length, 2);
  const body = JSON.parse(f.requests[1].init.body); assert.equal(body.version, 7); assert.equal(body.taskId, task.id); assert.equal(body.action, "complete_task"); assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  f.requests[1].respond({}); await f.flush(); f.requests[2].respond({ ...agenda, items: [], total: 0 }); await f.flush();
  assert.equal(saved, 1); assert.deepEqual(busy, [true, false]); assert.match(f.text(), /Tarea completada/); f.unmount();
});

test("409 de agenda refresca datos y requiere otro clic con versión revisada", async () => {
  const f = mount("AttentionAgendaView"); await f.advance(0); f.requests[0].respond(agenda); await f.flush(); f.button("Completar").props.onClick(); await f.flush();
  const firstId = JSON.parse(f.requests[1].init.body).requestId;
  f.requests[1].fail(Object.assign(new Error("Versión cambió"), { status: 409 })); await f.flush(); assert.equal(f.requests.length, 3);
  f.requests[2].respond({ ...agenda, items: [{ ...task, conversation: { ...task.conversation, version: 8 } }] }); await f.flush();
  assert.match(f.text(), /revísala antes de completarla nuevamente/); assert.equal(f.requests.length, 3);
  f.button("Completar").props.onClick(); await f.flush(); const next = JSON.parse(f.requests[3].init.body); assert.equal(next.version, 8); assert.notEqual(next.requestId, firstId); f.unmount();
});

test("cambio de filtro y SSE conserva la página y descarta respuestas viejas de Agenda", async () => {
  const f = mount("AttentionAgendaView"); await f.advance(0); f.requests[0].respond({ ...agenda, total: 81 }); await f.flush();
  f.all().find(node => node.props["aria-label"] === "Página siguiente de agenda").props.onClick(); await f.flush(); await f.advance(0); assert.match(f.requests[1].url, /page=2$/);
  f.setProps({ revision: 1 }); await f.advance(0); assert.equal(f.requests[1].init.signal.aborted, true); assert.match(f.requests[2].url, /page=2$/);
  f.requests[2].respond({ ...agenda, page: 2, total: 81 }); await f.flush(); f.requests[1].respond({ ...agenda, items: [{ ...task, title: "RESPUESTA VIEJA" }] }); await f.flush(); assert.doesNotMatch(f.text(), /RESPUESTA VIEJA/);
  f.button("Vencidas").props.onClick(); await f.flush(); await f.advance(0); assert.match(f.requests[3].url, /filter=overdue&page=1$/); f.unmount();
});

test("respuesta rápida solo inserta el texto aprobado y espera muestra tiempo real sin SLA inventado", () => {
  const inserts = []; const f = mount("AttentionQuickReplies", { replies: [{ id: "qa", title: "Saludos", text: "Mensaje aprobado" }], disabled: false, insert: value => inserts.push(value) });
  f.all().find(node => node.type === "Select").props.onChange({ target: { value: "qa" } }); assert.deepEqual(inserts, ["Mensaje aprobado"]); assert.equal(f.requests.length, 0);
  assert.equal(f.exports.waitingDuration("2026-10-30T12:00:00Z", Date.parse("2026-10-30T14:35:00Z")), "2 h 35 min"); assert.equal(f.exports.waitingDuration(null, Date.now()), null); f.unmount();
});
