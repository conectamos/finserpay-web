import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../app/dashboard/atencion/attention-conversation-section.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : ["string", "number"].includes(typeof value) ? String(value) : "";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sections = [{ id: null, name: "Sin sección" }, { id: id(100), name: "FINSER PAY" }, { id: id(200), name: "SUMASPAY" }];
const placement = (patch = {}) => ({ conversationId: id(1), sectionId: null, boardVersion: 9, sections, permissions: { move: true }, ...patch });

function mount(initial = {}) {
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, uuid = 700;
  const slots = [], timers = new Map(), requests = [], busy = [], moved = [], denied = [];
  const props = {
    conversationId: id(1), actorKey: "analyst:2", active: true, disabled: false,
    busyChanged: value => busy.push(value), onMoved: () => moved.push(true), accessDenied: error => { denied.push(error); return [401, 403, 404].includes(error.status); },
    request: (url, init = {}) => new Promise((resolve, reject) => {
      const item = { url, init, done: false, respond(body) { this.done = true; resolve(body); }, fail(error = new Error("Conexión interrumpida")) { this.done = true; reject(error); } };
      init.signal?.addEventListener("abort", () => { if (!item.done) item.fail(new DOMException("Aborted", "AbortError")); });
      requests.push(item);
    }), ...initial,
  };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }]; },
    useRef(initial) { const n = cursor++; slots[n] ??= { current: initial }; return slots[n]; },
    useEffect(effect, deps) { const n = cursor++; if (!slots[n] || deps.some((value, i) => !Object.is(value, slots[n].deps[i]))) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  const loaded = { exports: {} };
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, AbortController, Error,
    crypto: { randomUUID: () => id(++uuid) }, setTimeout: (fn, delay) => { const key = ++timerId; timers.set(key, { fn, at: now + delay }); return key; }, clearTimeout: key => timers.delete(key),
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => String(key) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(name);
    },
  });
  function render() { cursor = 0; dirty = false; effects = []; tree = loaded.exports.default(props); effects.forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, timer] = next; timers.delete(key); now = timer.at; timer.fn(); await flush();
    }
    now = until; await flush();
  }
  const all = () => nodes(tree);
  const find = (type, predicate = () => true) => all().find(node => node.type === type && predicate(node.props, node));
  const button = name => find("Button", (_, node) => text(node) === name);
  render();
  return {
    requests, busy, moved, denied, props, all, find, button, flush, advance, text: () => text(tree),
    posts: () => requests.filter(item => item.init.method === "POST"),
    async ready(data = placement()) { await advance(0); requests.at(-1).respond(data); await flush(); },
    async update(patch) { Object.assign(props, patch); render(); await flush(); },
    async choose(value) { const select = find("Select"); assert.ok(select && !select.props.disabled); select.props.onChange({ target: { value } }); await flush(); },
    async submit(times = 1) { const form = find("form"); assert.ok(form); for (let n = 0; n < times; n++) form.props.onSubmit({ preventDefault() {} }); await flush(); },
    async click(name) { const control = button(name); assert.ok(control && !control.props.disabled, name); control.props.onClick(); await flush(); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("ficha consulta ubicación real sin escribir ni marcar lecturas; elegir sección aún no mueve", async () => {
  const h = mount(); await h.ready();
  assert.equal(h.requests[0].url, `/api/atencion/${id(1)}/section`);
  assert.match(h.text(), /Sección actualSin sección/);
  assert.equal(h.all().some(node => node.type === "option" && node.props.value === "none"), false);
  await h.choose(id(100)); assert.equal(h.posts().length, 0); assert.equal(h.button("Mover chat").props.disabled, false);
  h.unmount();
});

test("movimiento explícito bloquea doble envío, usa boardVersion y espera confirmación", async () => {
  const h = mount(); await h.ready(); await h.choose(id(100)); await h.submit(2);
  assert.equal(h.posts().length, 1);
  const body = JSON.parse(h.posts()[0].init.body);
  assert.equal(body.boardVersion, 9); assert.equal(body.sectionId, id(100)); assert.equal("version" in body, false); assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.match(h.text(), /Sección actualSin sección/); assert.equal(h.button("Moviendo…").props.disabled, true); assert.deepEqual(h.busy, [true]);
  h.posts()[0].respond({ conversationId: id(1), sectionId: id(100), boardVersion: 10, unchanged: false }); await h.flush();
  assert.match(h.text(), /Sección actualFINSER PAY/); assert.match(h.text(), /Chat en FINSER PAY/); assert.deepEqual(h.busy, [true, false]); assert.equal(h.moved.length, 1);
  assert.ok(h.all().some(node => node.type === "option" && node.props.value === "none")); h.unmount();
});

test("409 exige consultar ubicación y una nueva confirmación; nunca reintenta automáticamente", async () => {
  const h = mount(); await h.ready(); await h.choose(id(100)); await h.submit();
  h.posts()[0].fail(Object.assign(new Error("La conversación cambió"), { status: 409 })); await h.flush();
  assert.match(h.text(), /Actualiza la ubicación/); assert.equal(h.find("Select").props.disabled, true);
  await h.advance(5000); assert.equal(h.requests.length, 2);
  await h.click("Actualizar ubicación"); await h.advance(0); h.requests.at(-1).respond(placement({ sectionId: id(200), boardVersion: 10 })); await h.flush();
  assert.match(h.text(), /Sección actualSUMASPAY/); assert.equal(h.button("Mover chat").props.disabled, true); assert.equal(h.posts().length, 1);
  await h.choose(id(100)); await h.submit();
  assert.equal(JSON.parse(h.posts()[1].init.body).boardVersion, 10);
  assert.notEqual(JSON.parse(h.posts()[0].init.body).requestId, JSON.parse(h.posts()[1].init.body).requestId); h.unmount();
});

test("fallo ambiguo conserva UUID al revisar y repetir la misma intención sin cambio de versión", async () => {
  const h = mount(); await h.ready(); await h.choose(id(100)); await h.submit(); const first = JSON.parse(h.posts()[0].init.body);
  h.posts()[0].fail(); await h.flush(); assert.equal(h.moved.length, 0);
  await h.click("Actualizar ubicación"); await h.advance(0); h.requests.at(-1).respond(placement()); await h.flush();
  await h.choose(id(100)); await h.submit(); const retry = JSON.parse(h.posts()[1].init.body);
  assert.deepEqual(retry, first); h.unmount();
});

test("Sin sección envía null; permisos de solo lectura y bloqueo externo impiden mover", async () => {
  const h = mount(); await h.ready(placement({ sectionId: id(100) })); await h.choose("none"); await h.submit();
  assert.equal(JSON.parse(h.posts()[0].init.body).sectionId, null); h.unmount();
  const read = mount(); await read.ready(placement({ permissions: { move: false } })); assert.equal(read.find("form"), undefined); assert.match(read.text(), /No tienes permiso/); read.unmount();
  const disabled = mount({ disabled: true }); await disabled.ready(); assert.equal(disabled.find("Select").props.disabled, true); await disabled.submit(); assert.equal(disabled.posts().length, 0); disabled.unmount();
});

test("ficha oculta no consulta; ocultar aborta y descarta la respuesta, reabrir refresca", async () => {
  const h = mount({ active: false }); await h.advance(1000); assert.equal(h.requests.length, 0);
  await h.update({ active: true }); await h.advance(0); const pending = h.requests[0];
  await h.update({ active: false }); assert.equal(pending.init.signal.aborted, true);
  pending.respond(placement()); await h.flush(); assert.doesNotMatch(h.text(), /Sección actual/);
  await h.update({ active: true }); await h.ready(); assert.equal(h.requests.length, 2); assert.match(h.text(), /Sección actualSin sección/); h.unmount();
});

test("cambiar chat o actor descarta lecturas previas y nunca muestra la ubicación ajena", async () => {
  const h = mount(); await h.advance(0); const previous = h.requests[0];
  await h.update({ conversationId: id(2), actorKey: "analyst:3" }); assert.equal(previous.init.signal.aborted, true);
  await h.advance(0); const current = h.requests.at(-1); current.respond(placement({ conversationId: id(2), sectionId: id(200) })); await h.flush();
  previous.respond(placement({ sectionId: id(100) })); await h.flush(); assert.match(h.text(), /Sección actualSUMASPAY/); assert.doesNotMatch(h.text(), /Sección actualFINSER PAY/); h.unmount();
});

test("pérdida de acceso notifica al contenedor y retira la ubicación del chat", async () => {
  const h = mount(); await h.advance(0); const error = Object.assign(new Error("Sin acceso"), { status: 403 });
  h.requests[0].fail(error); await h.flush(); assert.deepEqual(h.denied, [error]); assert.equal(h.find("form"), undefined); assert.doesNotMatch(h.text(), /Sección actual/); h.unmount();
});

test("lectura lenta ofrece recuperación y un timeout de movimiento libera el bloqueo sin fingir éxito", async () => {
  const h = mount(); await h.advance(15_000); assert.equal(h.requests[0].init.signal.aborted, true); assert.match(h.text(), /consulta tardó demasiado/); assert.ok(h.button("Actualizar ubicación")); h.unmount();
  const move = mount(); await move.ready(); await move.choose(id(100)); await move.submit(); await move.advance(30_000);
  assert.equal(move.posts()[0].init.signal.aborted, true); assert.equal(move.moved.length, 0); assert.deepEqual(move.busy, [true, false]); assert.match(move.text(), /Actualiza la ubicación/); move.unmount();
});

test("respuesta de ubicación con otro id y respuesta tardía tras desmontar no actualizan el chat", async () => {
  const h = mount(); await h.ready(placement({ conversationId: id(2) })); assert.equal(h.find("form"), undefined); assert.match(h.text(), /confirmar la ubicación/); h.unmount();
  const stale = mount(); await stale.ready(); await stale.choose(id(100)); await stale.submit(); stale.unmount();
  stale.posts()[0].respond({ conversationId: id(1), sectionId: id(100), boardVersion: 10 }); await stale.flush(); assert.equal(stale.moved.length, 0); assert.deepEqual(stale.busy, [true, false]);
});
