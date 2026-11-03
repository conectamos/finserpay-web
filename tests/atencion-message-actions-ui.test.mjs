import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const message = { id: id(3), text: "Por favor revisar el documento", direction: "inbound", sentAt: "2026-11-03T14:00:00Z", author: null, canReplyTo: true, canForward: true };
const source = { conversationId: id(1), contactName: "Contacto origen", message };
const destination = { conversation: { id: id(2), name: "Contacto destino", phone: "+573001234567", channel: "whatsapp", version: 8 }, permissions: { canSend: true }, messaging: { canReply: true, windowExpiresAt: "2099-01-01T00:00:00Z" } };
const list = { conversations: [destination.conversation], total: 1, page: 1, pageSize: 40 };
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";
function mount(file, initial, exported = "default", saved = new Map()) {
  let props = initial, tree, cursor = 0, dirty = false, effects = [], sequence = 10, clock = 0, timerId = 0;
  const slots = [], timers = new Map(), requests = [], subscriptions = new Map();
  const changed = (left, right) => !left || !right || left.length !== right.length || right.some((value, index) => !Object.is(value, left[index]));
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }]; },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useId() { const index = cursor++; return `test-${index}`; },
    useCallback(callback, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { callback, deps }; return slots[index].callback; },
    useEffect(effect, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  const component = name => Object.defineProperty(() => null, "name", { value: name });
  const eventTarget = prefix => ({ addEventListener(name, callback) { subscriptions.set(`${prefix}:${name}`, callback); }, removeEventListener(name) { subscriptions.delete(`${prefix}:${name}`); } });
  const modules = new Map();
  const environment = {
    FormData, AbortController, URLSearchParams, Date,
    document: { body: {}, activeElement: null, ...eventTarget("document") }, window: { innerWidth: 390, innerHeight: 844, ...eventTarget("window") },
    Node: class Node {},
    sessionStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    crypto: { randomUUID: () => id(++sequence) },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: (url, init = {}) => new Promise((resolve, reject) => requests.push({ url, init, done: false,
      respond(body, status = 200) { this.done = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); }, fail() { this.done = true; reject(new Error("Conexión interrumpida")); } })),
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(new URL(`../app/dashboard/atencion/${name}.tsx`, import.meta.url), "utf8");
    const loaded = { exports: {} }; modules.set(name, loaded.exports);
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    runInNewContext(outputText, { ...environment, module: loaded, exports: loaded.exports, require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-dom") return { createPortal: element => element };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name === "./attention-message-actions") return load("attention-message-actions");
      return { default: component(name) };
    } });
    return loaded.exports;
  }
  const module = load(file);
  function render() { cursor = 0; dirty = false; effects = []; tree = module[exported](props); for (const effect of effects) effect(); }
  async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) {
    const end = clock + ms;
    for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; clock = timer.at; timers.delete(id); timer.callback(); await flush(); }
    clock = end; await flush();
  }
  render();
  return { all: () => nodes(tree), module, requests, saved, flush, advance,
    setProps(patch) { props = { ...props, ...patch }; render(); },
    button(label) { return nodes(tree).find(node => ["button", "Button"].includes(typeof node.type === "string" ? node.type : node.type?.name) && (node.props["aria-label"] === label || text(node) === label)); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("opciones de mensaje abren un menú explícito y no disparan envío; responder y reenviar conservan acciones distintas", async () => {
  let replied = 0, forwarded = 0;
  const f = mount("attention-message-actions", { message, disabled: false, canReply: true, canForward: true, onReply: () => replied++, onForward: () => forwarded++ });
  assert.equal(f.all().some(node => node.props.role === "menu"), false);
  f.button("Opciones del mensaje").props.onClick(); await f.flush();
  assert.deepEqual(f.all().filter(node => node.props.role === "menuitem").map(text), ["Responder", "Reenviar"]);
  assert.equal(f.requests.length, 0); f.button("Responder").props.onClick(); await f.flush();
  assert.equal(replied, 1); assert.equal(forwarded, 0); assert.equal(f.all().some(node => node.props.role === "menu"), false);
  f.button("Opciones del mensaje").props.onClick(); await f.flush(); f.button("Reenviar").props.onClick(); await f.flush();
  assert.equal(forwarded, 1); assert.equal(f.requests.length, 0); f.unmount();
});

test("el menú respeta capacidades y pérdida de acceso; Escape no responde y devuelve foco", async () => {
  const f = mount("attention-message-actions", { message, disabled: false, canReply: false, canForward: true, onReply() { assert.fail(); }, onForward() { assert.fail(); } });
  f.button("Opciones del mensaje").props.onClick(); await f.flush(); assert.equal(f.button("Responder"), undefined);
  let prevented = false; f.all().find(node => node.props.role === "menu").props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() {} }); await f.flush(); assert.equal(prevented, true);
  f.button("Opciones del mensaje").props.onClick(); await f.flush(); f.setProps({ disabled: true }); await f.flush();
  assert.equal(f.all().some(node => node.props.role === "menu"), false); assert.equal(f.button("Opciones del mensaje").props.disabled, true); f.unmount();
});

function forwardFixture(saved) {
  const busy = [], sent = [], denied = [];
  const f = mount("attention-forward-message", { actorKey: "admin:1", source, onClose() {}, onBusyChange: value => busy.push(value), onSent: value => sent.push(value), onAccessDenied: (...args) => denied.push(args) }, "default", saved);
  return { ...f, busy, sent, denied, async select(detail = destination) {
    await f.flush(); await f.advance(250); f.requests.at(-1).respond(list); await f.flush();
    f.all().find(node => node.type === "button" && text(node).includes("Contacto destino")).props.onClick(); await f.flush(); f.requests.at(-1).respond(detail); await f.flush();
  } };
}

test("seleccionar destinatario solo consulta; reenviar exige botón y manda IDs canónicos una sola vez", async () => {
  const f = forwardFixture(); await f.select();
  assert.equal(f.requests.filter(item => item.init.method === "POST").length, 0);
  const send = f.button("Reenviar mensaje"); assert.equal(send.props.disabled, false); send.props.onClick(); send.props.onClick(); await f.flush();
  const writes = f.requests.filter(item => item.init.method === "POST"); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `/api/atencion/${id(2)}/messages`);
  assert.deepEqual([...writes[0].init.body.keys()].sort(), ["forwardConversationId", "forwardMessageId", "requestId", "version"]);
  assert.equal(writes[0].init.body.get("forwardConversationId"), id(1)); assert.equal(writes[0].init.body.get("forwardMessageId"), id(3)); assert.equal(writes[0].init.body.get("version"), "8");
  assert.equal(f.button("Reenviar mensaje"), undefined, "un intento pendiente retira el envío y muestra recuperación");
  writes[0].respond({ message: { ...message, direction: "outbound", deliveryStatus: "accepted" } }); await f.flush();
  assert.deepEqual(f.sent, [id(2)]); assert.equal(f.saved.size, 0); assert.deepEqual(f.busy, [true, false]); f.unmount();
});

test("una ventana cerrada o destinatario sin permiso no permite reenviar", async () => {
  for (const payload of [{ ...destination, permissions: { canSend: false } }, { ...destination, messaging: { canReply: false, reason: "La ventana terminó" } }]) {
    const f = forwardFixture(); await f.select(payload); assert.equal(f.button("Reenviar mensaje").props.disabled, true);
    f.button("Reenviar mensaje").props.onClick(); await f.flush(); assert.equal(f.requests.filter(item => item.init.method === "POST").length, 0); f.unmount();
  }
});

test("envío incierto conserva la intención tras cerrar y recargar; consultar no vuelve a enviar", async () => {
  const f = forwardFixture(); await f.select(); f.button("Reenviar mensaje").props.onClick(); await f.flush(); const write = f.requests.at(-1), requestId = write.init.body.get("requestId");
  write.fail(); await f.flush(); assert.equal(f.saved.size, 1);
  const saved = new Map(f.saved); f.unmount();
  const recovered = forwardFixture(saved); await recovered.flush();
  assert.equal(recovered.requests.length, 0, "no se ejecuta un envío por restaurar el intento");
  recovered.button("Consultar estado").props.onClick(); await recovered.flush(); assert.equal(recovered.requests.length, 1); assert.match(recovered.requests[0].url, new RegExp(`requestId=${requestId}`));
  assert.notEqual(recovered.requests[0].init.method, "POST"); recovered.requests[0].respond({ message: { ...message, deliveryStatus: "accepted" } }); await recovered.flush();
  assert.deepEqual(recovered.sent, [id(2)]); assert.equal(recovered.saved.size, 0); recovered.unmount();
});

test("intento ausente requiere cancelación confirmada antes de preparar otro destino", async () => {
  const f = forwardFixture(); await f.select(); f.button("Reenviar mensaje").props.onClick(); await f.flush(); f.requests.at(-1).fail(); await f.flush();
  f.button("Consultar estado").props.onClick(); await f.flush(); f.requests.at(-1).respond({ message: null }); await f.flush();
  assert.ok(f.button("Cancelar intento")); assert.equal(f.button("Reenviar mensaje"), undefined);
  f.button("Cancelar intento").props.onClick(); await f.flush(); const cancel = f.requests.at(-1); assert.equal(cancel.init.method, "DELETE");
  cancel.respond({ cancelled: true }); await f.flush(); assert.equal(f.saved.size, 0); assert.equal(f.requests.filter(item => item.init.method === "POST").length, 1); f.unmount();
});

test("lectura tardía del destinatario se descarta al cerrar y otro actor no recupera la intención", async () => {
  const f = forwardFixture(); await f.flush(); await f.advance(250); f.requests.at(-1).respond(list); await f.flush();
  f.all().find(node => node.type === "button" && text(node).includes("Contacto destino")).props.onClick(); await f.flush(); const late = f.requests.at(-1);
  f.all().find(node => node.type?.name === "@/app/_components/finser-side-panel").props.onClose(); await f.flush(); late.respond(destination); await f.flush();
  assert.equal(f.button("Reenviar mensaje"), undefined); f.unmount();
  const saved = new Map([["finser-attention-forward:admin:1", JSON.stringify({ requestId: id(8), version: 1, destinationId: id(2), sourceConversationId: id(1), sourceMessageId: id(3) })]]);
  const other = mount("attention-forward-message", { actorKey: "analyst:9", source: null, onClose() {}, onSent() {}, onBusyChange() {}, onAccessDenied() {} }, "default", saved); await other.flush();
  assert.equal(other.button("Reenvío por confirmar"), undefined); assert.equal(other.requests.length, 0); other.unmount();
});
