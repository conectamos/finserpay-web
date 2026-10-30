import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const source = compile("../app/dashboard/atencion/attention-board.tsx");
const types = { exports: {} }; runInNewContext(compile("../lib/atencion-board-types.ts"), { module: types, exports: types.exports });
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : ["string", "number"].includes(typeof value) ? String(value) : "";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { key: "admin:1", name: "Central QA", central: true };
const sections = [{ id: null, name: "Sin sección", color: "slate", position: 0, version: 0, count: 2, totalCount: 2 }, { id: id(100), name: "FINSER PAY", color: "green", position: 1, version: 1, count: 0, totalCount: 0 }, { id: id(200), name: "SUMASPAY", color: "lime", position: 2, version: 3, count: 1, totalCount: 1 }];
const board = { sections, permissions: { manage: true }, pageSize: 1 };
const card = (n, sectionId = null, assigneeKey = "analyst:2") => ({ id: id(n), name: `Contacto QA ${n}`, phone: "+12025550100", sectionId, boardVersion: 9, version: 27, assigneeKey, assigneeName: "Analista QA", preview: "Mensaje artificial", channel: "whatsapp", autoTags: [], tags: [], unreadCount: 0, waitingSince: null });
const cards = { none: [card(1), card(2)], [id(100)]: [], [id(200)]: [card(3, id(200), "analyst:9")] };

function mount(initial = {}) {
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, uuid = 700;
  const slots = [], timers = new Map(), requests = [], opened = [], denied = [], busy = [];
  const props = { actor, active: true, onRefresh: 0, onOpenConversation: value => opened.push(value), onAccessDenied: value => denied.push(value), busyChanged: value => busy.push(value), ...initial };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }]; },
    useRef(initial) { const n = cursor++; slots[n] ??= { current: initial }; return slots[n]; },
    useEffect(effect, deps) { const n = cursor++; if (!slots[n] || deps.some((value, i) => !Object.is(value, slots[n].deps[i]))) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  const loaded = { exports: {} };
  runInNewContext(source, { module: loaded, exports: loaded.exports, AbortController, URLSearchParams,
    crypto: { randomUUID: () => id(++uuid) }, setTimeout: (fn, delay) => { const key = ++timerId; timers.set(key, { fn, at: now + delay }); return key; }, clearTimeout: key => timers.delete(key),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init: init || {}, done: false, respond(body, status = 200) { this.done = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); }, fail() { this.done = true; reject(new Error("Conexión interrumpida")); } })),
    require(name) { if (name === "react") return react; if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" }; if (name === "@/lib/atencion-board-types") return types.exports; if (name === "lucide-react" || name === "@/app/_components/finser-ui" || name === "./attention-operational") return new Proxy({}, { get: (_, key) => String(key) }); if (name.endsWith("finser-side-panel")) return { default: "Panel" }; if (name.endsWith("finser-confirm-dialog")) return { default: "Confirm" }; if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) }; throw new Error(name); },
  });
  function render() { cursor = 0; dirty = false; effects = []; tree = loaded.exports.default(props); effects.forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [key, timer] = next; timers.delete(key); now = timer.at; timer.fn(); await flush(); } now = until; await flush(); }
  const all = () => nodes(tree);
  const find = (type, predicate = () => true) => all().find(node => node.type === type && predicate(node.props, node));
  const button = name => all().find(node => ["Button", "button"].includes(node.type) && (node.props["aria-label"] === name || text(node) === name));
  async function completeReads(nextBoard = board, sourceCards = cards) {
    for (let round = 0; round < 6; round++) {
      const pending = requests.filter(item => !item.done && !item.init.method);
      if (!pending.length) break;
      for (const item of pending) {
        if (item.url.startsWith("/api/atencion/board?")) item.respond(nextBoard);
        else {
          const query = new URL(item.url, "https://qa.invalid").searchParams; const key = query.get("sectionId"); const page = Number(query.get("page")); const values = sourceCards[key] || [];
          item.respond({ sectionId: key === "none" ? null : key, conversations: values.slice((page - 1) * nextBoard.pageSize, page * nextBoard.pageSize), total: values.length, page, pageSize: nextBoard.pageSize });
        }
      }
      await flush();
    }
  }
  render();
  return { props, requests, opened, denied, busy, all, find, button, flush, advance, completeReads, text: () => text(tree),
    async ready(next = board, sourceCards = cards) { await advance(250); await completeReads(next, sourceCards); },
    async update(patch) { Object.assign(props, patch); render(); await flush(); },
    async click(name) { const node = button(name); assert.ok(node, name); assert.ok(!node.props.disabled, `${name} disabled`); node.props.onClick(); await flush(); },
    moveSelect: n => find("Select", props => props["aria-label"] === `Mover Contacto QA ${n} a otra sección`),
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("tablero usa contadores y secciones del servidor; abrir chat no marca leído ni envía mensajes", async () => {
  const h = mount(); await h.ready();
  assert.ok(h.find("section", p => p["aria-label"] === "Sección FINSER PAY"));
  assert.ok(h.find("span", p => p["aria-label"] === "0 conversaciones"));
  await h.click("Abrir chat de Contacto QA 1"); assert.deepEqual(h.opened, [id(1)]);
  assert.equal(h.requests.some(request => request.init.method), false); h.unmount();
});

test("Mover a usa boardVersion independiente y un solo UUID ante doble clic; espera confirmación del servidor", async () => {
  const h = mount(); await h.ready(); const select = h.moveSelect(1);
  select.props.onChange({ target: { value: id(100) } }); select.props.onChange({ target: { value: id(100) } }); await h.flush();
  const moves = h.requests.filter(request => request.init.method === "POST"); assert.equal(moves.length, 1);
  const input = JSON.parse(moves[0].init.body); assert.equal(input.boardVersion, 9); assert.equal("version" in input, false); assert.equal(input.sectionId, id(100)); assert.match(input.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(h.text().includes("Contacto QA 1")); assert.doesNotMatch(h.text(), /Conversación movida/);
  moves[0].respond({ conversationId: id(1), sectionId: id(100), boardVersion: 10 }); await h.flush();
  assert.match(h.text(), /Conversación movida a FINSER PAY/); assert.deepEqual(h.busy, [true, false]); h.unmount();
});

function dragEvent() { return { target: { closest: () => null }, dataTransfer: { types: ["application/x-finser-attention-card"], setData() {}, effectAllowed: "", dropEffect: "" }, prevented: false, preventDefault() { this.prevented = true; } }; }
test("drag interno mueve; drops ajenos o hacia la misma sección no producen escrituras", async () => {
  const h = mount(); await h.ready(); const target = h.find("section", p => p["aria-label"] === "Sección FINSER PAY");
  target.props.onDrop(dragEvent()); await h.flush(); assert.equal(h.requests.some(request => request.init.method), false);
  h.find("article", (_, node) => text(node).includes("Contacto QA 1")).props.onDragStart(dragEvent());
  h.find("section", p => p["aria-label"] === "Sección Sin sección").props.onDrop(dragEvent()); await h.flush(); assert.equal(h.requests.some(request => request.init.method), false);
  h.find("article", (_, node) => text(node).includes("Contacto QA 1")).props.onDragStart(dragEvent()); target.props.onDrop(dragEvent()); await h.flush();
  assert.equal(h.requests.filter(request => request.init.method === "POST").length, 1); h.unmount();
});

test("409 conserva ubicación hasta refresco y no reintenta automáticamente el movimiento", async () => {
  const h = mount(); await h.ready(); h.moveSelect(1).props.onChange({ target: { value: id(100) } }); await h.flush();
  h.requests.at(-1).respond({ error: "Versión de tablero cambió" }, 409); await h.flush(); assert.match(h.text(), /revisa su ubicación/);
  await h.advance(250); await h.completeReads(); assert.equal(h.requests.filter(request => request.init.method === "POST").length, 1); h.unmount();
});

test("cargar más conserva páginas en SSE y la búsqueda nueva reinicia sólo la paginación", async () => {
  const h = mount(); await h.ready(); await h.click("Cargar más · 1 de 2");
  assert.match(h.requests.at(-1).url, /sectionId=none.*page=2/); await h.completeReads(); assert.ok(h.text().includes("Contacto QA 2"));
  const before = h.requests.length; await h.update({ onRefresh: 1 }); await h.advance(250); await h.completeReads();
  assert.ok(h.requests.slice(before).some(request => request.url.includes("sectionId=none") && request.url.includes("page=2"))); assert.ok(h.text().includes("Contacto QA 2"));
  h.find("Input", p => p["aria-label"] === "Buscar en el tablero").props.onChange({ target: { value: "Camila" } }); await h.flush(); const first = h.requests.length; await h.advance(250); await h.completeReads();
  assert.ok(h.requests.slice(first).every(request => request.url.includes("search=Camila"))); assert.ok(!h.requests.slice(first).some(request => request.url.includes("page=2"))); h.unmount();
});

test("ocultar tablero aborta lecturas y pausa SSE; volver conserva búsqueda y datos mientras refresca", async () => {
  const h = mount(); await h.ready(); h.find("Input", p => p["aria-label"] === "Buscar en el tablero").props.onChange({ target: { value: "Camila" } }); await h.flush(); await h.advance(250);
  const pending = h.requests.at(-1); await h.update({ active: false, onRefresh: 2 }); assert.equal(pending.init.signal.aborted, true); const total = h.requests.length; await h.advance(5000); assert.equal(h.requests.length, total);
  pending.respond({ ...board, sections: [{ ...sections[0], name: "RESPUESTA VIEJA" }] }); await h.flush(); assert.doesNotMatch(h.text(), /RESPUESTA VIEJA/);
  await h.update({ active: true }); await h.advance(250); assert.match(h.requests.at(-1).url, /search=Camila/); await h.completeReads(); h.unmount();
});

test("denegación de acceso elimina tarjetas y bloquea respuestas paralelas tardías", async () => {
  const h = mount(); await h.advance(250); h.requests[0].respond(board); await h.flush();
  const pending = h.requests.filter(request => !request.done); pending[0].respond({ error: "Acceso retirado" }, 403); await h.flush();
  pending.slice(1).forEach(request => request.respond({ sectionId: id(200), conversations: [card(90, id(200))], total: 1, page: 1, pageSize: 1 })); await h.flush();
  assert.deepEqual(h.denied, ["Acceso retirado"]); assert.doesNotMatch(h.text(), /Contacto QA 90/); assert.equal(h.find("article"), undefined); h.unmount();
});

test("analista sólo puede mover asignados y no recibe controles de administración de secciones", async () => {
  const h = mount({ actor: { key: "analyst:2", central: false } }); await h.ready();
  assert.equal(h.button("Secciones"), undefined); assert.equal(h.find("Panel"), undefined); assert.equal(h.moveSelect(1).props.disabled, false); assert.equal(h.moveSelect(3).props.disabled, true);
  h.moveSelect(3).props.onChange({ target: { value: id(100) } }); await h.flush(); assert.equal(h.requests.some(request => request.init.method), false); h.unmount();
});

test("archivar requiere totalCount cero sin importar búsqueda y confirmación explícita", async () => {
  const filtered = { ...board, sections: sections.map(section => ({ ...section, count: 0 })) };
  const h = mount(); await h.ready(filtered, {}); await h.click("Secciones"); assert.equal(h.button("Archivar SUMASPAY").props.disabled, true); assert.equal(h.button("Archivar Sin sección"), undefined);
  await h.click("Archivar FINSER PAY"); assert.equal(h.requests.some(request => request.init.method), false); h.find("Confirm", p => p.open).props.onConfirm(); await h.flush();
  const input = JSON.parse(h.requests.at(-1).init.body); assert.equal(input.action, "archive"); assert.equal(input.id, id(100)); assert.equal(input.version, 1); h.unmount();
});

test("reordenar envía todas las secciones activas con versiones, sin mover Sin sección", async () => {
  const h = mount(); await h.ready(); await h.click("Secciones"); assert.equal(h.button("Subir FINSER PAY").props.disabled, true); await h.click("Bajar FINSER PAY");
  const input = JSON.parse(h.requests.at(-1).init.body); assert.equal(input.action, "reorder"); assert.deepEqual(input.ordered, [{ id: id(200), version: 3 }, { id: id(100), version: 1 }]); h.unmount();
});

test("conflicto al renombrar conserva borrador y requiere revisar la versión antes de otro intento", async () => {
  const h = mount(); await h.ready(); await h.click("Secciones"); await h.click("Editar FINSER PAY");
  h.find("Input", p => p.value === "FINSER PAY").props.onChange({ target: { value: "Mi nombre propuesto" } }); await h.flush(); await h.click("Guardar nombre"); const first = JSON.parse(h.requests.at(-1).init.body);
  h.requests.at(-1).respond({ error: "Otra persona cambió la sección" }, 409); await h.flush(); assert.equal(h.button("Guardar nombre").props.disabled, true);
  await h.advance(250); await h.completeReads({ ...board, sections: sections.map(section => section.id === id(100) ? { ...section, name: "Nombre actualizado", version: 2 } : section) });
  assert.ok(h.find("Input", p => p.value === "Mi nombre propuesto")); await h.click("Actualizar revisión"); await h.click("Guardar nombre");
  const second = JSON.parse(h.requests.at(-1).init.body); assert.equal(second.name, "Mi nombre propuesto"); assert.equal(second.version, 2); assert.notEqual(second.requestId, first.requestId); h.unmount();
});

test("cambiar de actor retira inmediatamente datos anteriores y no reutiliza tarjetas al cargar el nuevo alcance", async () => {
  const h = mount(); await h.ready(); await h.update({ actor: { key: "analyst:77", central: false } }); assert.equal(h.find("article"), undefined);
  await h.advance(250); h.requests.at(-1).respond({ ...board, permissions: { manage: false } }); await h.flush(); assert.equal(h.find("article"), undefined);
  await h.completeReads(board, { none: [card(77, null, "analyst:77")] }); assert.ok(h.text().includes("Contacto QA 77")); assert.doesNotMatch(h.text(), /Contacto QA 1/); h.unmount();
});
