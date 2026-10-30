import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const actor = { key: "admin:1", name: "Central", central: true };
const chat = { id: "00000000-0000-4000-8000-000000000001", name: "Contacto de prueba", phone: "+573001234567",
  channel: "whatsapp", externalId: "provider-chat", status: "pending", mode: "unknown", version: 1,
  tags: [], assigneeKey: null, assigneeName: null, lastContactAt: "2026-10-30T10:00:00Z" };
const inbox = { actor, schemaReady: true, conversations: [chat], total: 1, pageSize: 40, team: [], quickReplies: [],
  metrics: { pending: 1, open: 0, closed: 0, mine: 0 }, integration: { configured: true, canSync: true },
  dashboard: { daily: [], activity: [], activeConversations: [chat], team: [] } };
const detail = { conversation: chat, permissions: { manage: true, assign: true }, customer: {}, notes: [], tasks: [],
  messages: [{ id: "message-1", text: "Primer mensaje", direction: "inbound", sentAt: "2026-10-30T10:00:00Z" }] };
const jsx = (type, props, key) => ({ type, props: props || {}, key });
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";
}

// Run the actual component. Simulate only React lifecycle, browser events/time,
// and network responses so races are deterministic and never contact a service.
function mount() {
  let now = 0, timerId = 0, cursor = 0, dirty = false, effects = [], tree;
  const slots = [], timers = new Map(), requests = [];
  const listeners = { document: new Map(), window: new Map() };
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const add = (target, name, fn) => { if (!listeners[target].has(name)) listeners[target].set(name, new Set()); listeners[target].get(name).add(fn); };
  const remove = (target, name, fn) => listeners[target].get(name)?.delete(fn);
  const schedule = (fn, delay, interval = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const document = { visibilityState: "visible", addEventListener: (name, fn) => add("document", name, fn), removeEventListener: (name, fn) => remove("document", name, fn) };
  const navigator = { onLine: true };
  const window = { addEventListener: (name, fn) => add("window", name, fn), removeEventListener: (name, fn) => remove("window", name, fn) };
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, value => {
      slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true;
    }]; },
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(effect, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => {
      slots[index]?.cleanup?.(); slots[index] = { deps, effect, cleanup: effect() };
    }); },
  };
  const component = name => Object.defineProperty(() => null, "name", { value: name });
  const ui = Object.fromEntries(["Badge", "Button", "Card", "EmptyState", "Input", "LoadingState", "ProgressBar", "Select", "StatusPill"].map(name => [name, component(name)]));
  const loaded = { exports: {} };
  const source = readFileSync(new URL("../app/dashboard/atencion/attention-console.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, document, navigator, window, AbortController, URLSearchParams,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000009" }, sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => schedule(fn, 0), cancelAnimationFrame: id => timers.delete(id),
    fetch: (url, init) => new Promise(resolve => { requests.push({ url, init, done: false, respond(body, status = 200) {
      this.done = true; resolve({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
    } }); }),
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "@/app/_components/finser-ui") return ui;
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      return { default: component(name) };
    },
  });
  function render() { cursor = 0; effects = []; dirty = false; tree = loaded.exports.default({ actor }); for (const effect of effects) effect(); }
  async function flush() { for (let i = 0; i < 14; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn(); await flush();
    }
    now = until; await flush();
  }
  function dispatch(target, name) { for (const fn of listeners[target].get(name) || []) fn(); }
  const all = () => nodes(tree);
  const button = label => all().find(node => ["button", "Button"].includes(typeof node.type === "string" ? node.type : node.type?.name) && (text(node) === label || node.props["aria-label"] === label));
  render();
  return { requests, document, navigator, advance, flush, all, button, dispatch,
    async ready(payload = inbox) { await advance(250); requests.at(-1).respond(payload); await flush(); },
    async select() {
      all().find(node => node.type === "button" && text(node).includes(chat.name)).props.onClick(); await flush(); await advance(0);
      requests.at(-1).respond(detail); await flush();
      const log = all().find(node => node.props.role === "log");
      if (log) log.props.ref.current = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
      await advance(0);
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    text: () => text(tree), timers: () => timers.size,
  };
}

test("consulta local cada20s solo visible/online y limpia timer y peticiones al desmontar", async () => {
  const f = mount(); await f.ready();
  await f.advance(19_749); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.url.startsWith("/api/atencion?") && !request.init.method));
  f.document.visibilityState = "hidden"; f.dispatch("document", "visibilitychange");
  assert.equal(f.requests[1].init.signal.aborted, true);
  f.requests[1].respond({ ...inbox, total: 99 }); await f.flush();
  await f.advance(40_000); assert.equal(f.requests.length, 2);
  f.document.visibilityState = "visible"; f.navigator.onLine = false;
  await f.advance(20_000); assert.equal(f.requests.length, 2);
  f.navigator.onLine = true; await f.advance(20_000); assert.equal(f.requests.length, 3);
  f.unmount(); assert.equal(f.requests.at(-1).init.signal.aborted, true); assert.equal(f.timers(), 0);
  f.requests.at(-1).respond(inbox); await f.flush(); assert.equal(f.timers(), 0);
  await f.advance(40_000); assert.equal(f.requests.length, 3);
});

test("poll silencioso conserva ficha y scroll; respuestas nuevas no desmontan formularios", async () => {
  const f = mount(); await f.ready(); await f.select();
  const before = f.all().find(node => node.type?.name === "CustomerPanel");
  const log = f.all().find(node => node.props.role === "log");
  const position = { scrollTop: 200, scrollHeight: 1000, clientHeight: 200 };
  log.props.ref.current = position; log.props.onScroll(); await f.flush();
  await f.advance(20_000);
  assert.equal(f.requests.length, 4);
  assert.ok(f.all().some(node => node.type?.name === "CustomerPanel" && node.key === before.key));
  assert.ok(!f.all().some(node => node.type?.name === "LoadingState"));
  f.requests[2].respond(inbox); f.requests[3].respond({ ...detail, messages: [...detail.messages, { ...detail.messages[0], id: "message-2", text: "Mensaje nuevo" }] });
  await f.flush(); await f.advance(0);
  assert.equal(position.scrollTop, 200);
  assert.equal(f.all().find(node => node.type?.name === "CustomerPanel").key, before.key);
  assert.ok(f.all().some(node => node.type?.name === "MessageContent" && node.props.text === "Mensaje nuevo"));
  assert.ok(f.requests.every(request => !request.url.includes("/sync") && !request.init.method));
  f.unmount();
});

test("no solapa una carga lenta; una mutación cancela el poll y no acepta su respuesta antigua", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.advance(20_000);
  const stale = f.requests.slice(2);
  await f.advance(20_000); assert.equal(f.requests.length, 4, "la lectura pendiente no genera otro poll");
  f.button("Finalizar").props.onClick(); await f.flush();
  assert.equal(f.requests[4].init.method, "PATCH");
  assert.ok(stale.every(request => request.init.signal.aborted));
  stale[0].respond(inbox); stale[1].respond({ ...detail, conversation: { ...chat, name: "Respuesta obsoleta" } }); await f.flush();
  await f.advance(20_000); assert.equal(f.requests.length, 5, "no consulta durante una mutación");
  assert.ok(!f.text().includes("Respuesta obsoleta"));
  f.requests[4].respond({}); await f.flush();
  assert.equal(f.requests.length, 7);
  await f.advance(20_000); assert.equal(f.requests.length, 7, "las cargas posteriores a guardar conservan prioridad");
  f.requests[5].respond(inbox); f.requests[6].respond({ ...detail, conversation: { ...chat, status: "closed", version: 2 } }); await f.flush();
  assert.ok(f.button("Reabrir")); f.unmount();
});

test("fallo temporal conserva datos y avisa;404 de reasignación elimina la ficha", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.advance(20_000);
  f.requests[2].respond({ error: "Temporal" }, 503); f.requests[3].respond({ error: "Temporal" }, 503); await f.flush();
  assert.ok(f.all().some(node => node.type?.name === "CustomerPanel"));
  assert.match(f.text(), /Conservamos los últimos datos/);
  await f.advance(20_000); f.requests[4].respond(inbox); f.requests[5].respond({ error: "No encontrada" }, 404); await f.flush();
  assert.ok(!f.all().some(node => node.type?.name === "CustomerPanel"));
  assert.ok(!f.all().some(node => node.props.role === "log"));
  assert.match(f.text(), /ya no está disponible/);
  await f.advance(20_000); f.requests[6].respond(inbox); f.requests[7].respond(detail); await f.flush();
  assert.ok(f.all().some(node => node.type?.name === "CustomerPanel"));
  assert.doesNotMatch(f.text(), /ya no está disponible|Conservamos los últimos datos/); f.unmount();
});

test("401/403 al refrescar retira datos y descarta respuestas paralelas que llegan tarde", async () => {
  for (const [status, failed] of [[401, 2], [403, 3]]) {
    const f = mount(); await f.ready(); await f.select(); await f.advance(20_000);
    f.requests[failed].respond({ error: "Acceso revocado" }, status); await f.flush();
    const late = failed === 2 ? 3 : 2;
    assert.equal(f.requests[late].init.signal.aborted, true);
    f.requests[late].respond(late === 2 ? inbox : detail); await f.flush();
    assert.ok(!f.all().some(node => node.type?.name === "CustomerPanel"));
    assert.ok(!f.text().includes(chat.name)); assert.match(f.text(), /Acceso revocado/); f.unmount();
  }
});

test("404 tardío de una mutación no retira el chat diferente que acaba de seleccionarse", async () => {
  const other = { ...chat, id: "00000000-0000-4000-8000-000000000002", name: "Otro contacto" };
  const f = mount(); await f.ready({ ...inbox, conversations: [chat, other] }); await f.select();
  f.button("Finalizar").props.onClick(); await f.flush();
  f.all().find(node => node.type === "button" && text(node).includes(other.name)).props.onClick();
  await f.flush(); await f.advance(0);
  f.requests[3].respond({ ...detail, conversation: other }); await f.flush();
  f.requests[2].respond({ error: "Conversación anterior reasignada" }, 404); await f.flush();
  assert.equal(f.all().find(node => node.type?.name === "CustomerPanel").props.detail.conversation.id, other.id);
  assert.doesNotMatch(f.text(), /Conversación anterior reasignada/); f.unmount();
});

test("sincronización manual cancela el refresco local y bloquea nuevos polls", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.advance(20_000);
  f.button("Actualizar WhatsApp").props.onClick(); await f.flush();
  assert.equal(f.requests[4].url, "/api/atencion/sync");
  assert.ok(f.requests.slice(2, 4).every(request => request.init.signal.aborted));
  f.requests[2].respond(inbox); f.requests[3].respond(detail); await f.flush();
  await f.advance(40_000); assert.equal(f.requests.length, 5);
  f.unmount(); f.requests[4].respond({ imported: 0, skipped: 0, nextCursor: null }); await f.flush();
  assert.equal(f.timers(), 0);
});

test("un poll correcto recupera errores de lectura manual sin dejar la bandeja bloqueada", async () => {
  const f = mount(); await f.ready(); await f.select();
  f.all().find(node => node.type?.name === "Button" && text(node).trim() === "Actualizar").props.onClick();
  await f.flush();
  f.requests[2].respond({ error: "Lectura manual fallida" }, 503);
  f.requests[3].respond({ error: "Detalle manual fallido" }, 503); await f.flush();
  assert.match(f.text(), /Lectura manual fallida/);
  await f.advance(20_000); f.requests[4].respond(inbox); f.requests[5].respond(detail); await f.flush();
  assert.doesNotMatch(f.text(), /Lectura manual fallida|Detalle manual fallido/);
  assert.ok(f.all().some(node => node.type?.name === "CustomerPanel")); f.unmount();
});
