import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const actor = { key: "admin:1", name: "Central", central: true };
const chat = { id: "00000000-0000-4000-8000-000000000001", name: "Contacto A", phone: "+573001234567", channel: "whatsapp", externalId: "legacy", status: "open", version: 4, tags: [] };
const other = { ...chat, id: "00000000-0000-4000-8000-000000000002", name: "Contacto B" };
const inbox = { actor, schemaReady: true, conversations: [chat, other], total: 2, pageSize: 40, team: [], quickReplies: [], metrics: {}, integration: { configured: true, canSync: true, canSend: true } };
const detail = { conversation: chat, permissions: { canSend: true, manage: true }, messaging: { canReply: true, windowExpiresAt: "2099-01-01T00:00:00Z", reason: null }, customer: {}, notes: [], tasks: [], messages: [] };
const outbound = { id: "00000000-0000-4000-8000-000000000003", text: "Respuesta", direction: "outbound", sentAt: "2026-10-30T15:00:00Z", author: "Analista" };
const jsx = (type, props, key) => ({ type, props: props || {}, key });
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : ""; }

// Execute the real UI with deterministic React lifecycle and an inert transport.
// Deliberately allow responses after abort to cover navigation and late replies.
function mount() {
  let cursor = 0, dirty = false, effects = [], tree, timerId = 0, now = 0, uuid = 10;
  const slots = [], timers = new Map(), requests = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const schedule = (fn, delay, interval = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: initial }; return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }]; },
    useRef(value) { const n = cursor++; slots[n] ??= { current: value }; return slots[n]; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(effect, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  const component = name => Object.defineProperty(() => null, "name", { value: name });
  const source = readFileSync(new URL("../app/dashboard/atencion/attention-console.tsx", import.meta.url), "utf8") + "\nexport const testUi = { privateMediaUrl, replyValidation, replyWindowOpen, MessageContent, MessageDelivery };";
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, FormData, File, AbortController, URLSearchParams,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} }, navigator: { onLine: true }, window: { addEventListener() {}, removeEventListener() {} },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` }, sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => schedule(fn, 0), cancelAnimationFrame: id => timers.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, done: false,
      respond(body, status = 200) { this.done = true; resolve({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }); },
      fail() { this.done = true; reject(new Error("Conexión interrumpida")); },
    })),
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      return { default: component(name) };
    },
  });
  function render() { cursor = 0; effects = []; dirty = false; tree = loaded.exports.default({ actor }); for (const run of effects) run(); }
  async function flush() { for (let i = 0; i < 18; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
      const [id, timer] = next; now = timer.at; if (timer.interval) timer.at += timer.interval; else timers.delete(id); timer.fn(); await flush();
    }
    now = until; await flush();
  }
  const all = () => nodes(tree);
  const composer = () => all().find(node => node.type?.name === "ReplyComposer");
  render();
  return { requests, flush, advance, all, composer, ui: loaded.exports.testUi,
    async ready() { await advance(250); requests.at(-1).respond(inbox); await flush(); all().find(node => node.type === "button" && text(node) === "Conversaciones").props.onClick(); await flush(); },
    async select(payload = detail) { all().find(node => node.type === "button" && text(node).includes(payload.conversation.name)).props.onClick(); await flush(); await advance(0); requests.at(-1).respond(payload); await flush(); },
    async change(patch) { composer().props.change(patch); await flush(); },
    async completeReads(payload = detail) { for (const r of requests.filter(r => !r.done && r.init.method !== "POST")) r.respond(r.url.includes("?") ? inbox : payload); await flush(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("envío humano usa multipart con versión y requestId; no borra el borrador antes de aceptación", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "  Respuesta humana  " });
  f.composer().props.send(); f.composer().props.send(); await f.flush();
  const sends = f.requests.filter(r => r.init.method === "POST"); assert.equal(sends.length, 1);
  assert.equal(sends[0].url, `/api/atencion/${chat.id}/messages`); assert.equal(sends[0].init.headers["Content-Type"], undefined);
  assert.equal(sends[0].init.body.get("text"), "Respuesta humana"); assert.equal(sends[0].init.body.get("version"), "4");
  assert.match(sends[0].init.body.get("requestId"), /^[0-9a-f-]{36}$/);
  assert.equal(f.composer().props.draft.text, "  Respuesta humana  "); assert.equal(f.composer().props.draft.locked, true);
  sends[0].respond({ message: { ...outbound, deliveryStatus: "accepted" } }); await f.flush();
  assert.equal(f.composer().props.draft.text, ""); await f.completeReads(); f.unmount();
});

test("archivo e incertidumbre conservan solicitud y borrador; consultar estado no vuelve a enviar", async () => {
  const f = mount(); await f.ready(); await f.select(); const file = new File(["imagen"], "imagen.jpg", { type: "image/jpeg" });
  await f.change({ file }); f.composer().props.send(); await f.flush(); const sent = f.requests.at(-1);
  assert.equal(sent.init.body.get("file").name, "imagen.jpg"); const requestId = sent.init.body.get("requestId");
  sent.fail(); await f.flush(); assert.equal(f.composer().props.draft.file, file); assert.equal(f.composer().props.draft.locked, true);
  await f.change({ text: "no debe cambiar" }); assert.equal(f.composer().props.draft.text, "");
  f.composer().props.send(); await f.flush(); assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  f.composer().props.resolve(); await f.flush(); const check = f.requests.at(-1);
  assert.equal(check.url, `/api/atencion/${chat.id}/messages?requestId=${requestId}`); assert.equal(check.init.method, undefined);
  check.respond({ message: { ...outbound, deliveryStatus: "sent" } }); await f.flush();
  assert.equal(f.composer().props.draft.file, null); await f.completeReads(); f.unmount();
});

test("202 pendiente no se presenta enviado; GET null solo permite repetir el mismo requestId y contenido", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Mensaje pendiente" });
  f.composer().props.send(); await f.flush(); const first = f.requests.at(-1); const firstId = first.init.body.get("requestId");
  first.respond({ message: { ...outbound, deliveryStatus: "uncertain" }, uncertain: true }, 202); await f.flush(); await f.completeReads();
  assert.equal(f.composer().props.draft.text, "Mensaje pendiente"); assert.equal(f.composer().props.draft.locked, true);
  f.composer().props.restart(); await f.flush(); assert.equal(f.composer().props.draft.locked, true);
  f.composer().props.resolve(); await f.flush(); f.requests.at(-1).respond({ message: null }); await f.flush(); await f.completeReads();
  assert.equal(f.composer().props.draft.locked, true); f.composer().props.restart(); await f.flush();
  assert.equal(f.composer().props.draft.locked, true); await f.change({ text: "Otro mensaje" });
  assert.equal(f.composer().props.draft.text, "Mensaje pendiente"); f.composer().props.retry(); await f.flush();
  assert.equal(f.requests.at(-1).init.body.get("requestId"), firstId); assert.equal(f.requests.at(-1).init.body.get("text"), first.init.body.get("text"));
  assert.equal(f.requests.at(-1).init.body.get("version"), first.init.body.get("version")); f.unmount();
});

test("estado pendiente y respuesta de otro chat no borran su borrador", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Borrador A" }); f.composer().props.send(); await f.flush(); const sent = f.requests.at(-1);
  await f.select({ ...detail, conversation: other });
  sent.respond({ message: { ...outbound, deliveryStatus: "queued" } }, 202); await f.flush(); await f.completeReads({ ...detail, conversation: other });
  assert.equal(f.composer().props.detail.conversation.id, other.id); await f.change({ text: "Borrador B" });
  await f.select(); assert.equal(f.composer().props.draft.text, "Borrador A"); assert.equal(f.composer().props.draft.locked, true);
  await f.select({ ...detail, conversation: other }); assert.equal(f.composer().props.draft.text, "Borrador B"); f.unmount();
});

test("descartar un intento exige confirmación del servidor y no desbloquea ante409", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Borrador conservado" });
  f.composer().props.send(); await f.flush(); const originalId = f.requests.at(-1).init.body.get("requestId"); f.requests.at(-1).fail(); await f.flush();
  f.composer().props.resolve(); await f.flush(); f.requests.at(-1).respond({ message: null }); await f.flush(); await f.completeReads();
  f.composer().props.discard(); await f.flush(); const cancel = f.requests.at(-1);
  assert.equal(cancel.init.method, "DELETE"); assert.ok(cancel.url.endsWith(`requestId=${originalId}`));
  cancel.respond({ error: "Ya está en proceso" }, 409); await f.flush(); assert.equal(f.composer().props.draft.locked, true);
  f.composer().props.discard(); await f.flush(); f.requests.at(-1).respond({ cancelled: true }); await f.flush(); await f.completeReads();
  assert.equal(f.composer().props.draft.locked, false); assert.equal(f.composer().props.draft.text, "Borrador conservado");
  f.composer().props.send(); await f.flush(); assert.notEqual(f.requests.at(-1).init.body.get("requestId"), originalId); f.unmount();
});

test("permiso, ventana y validación de archivos impiden llamar el envío", async () => {
  for (const restricted of [{ ...detail, permissions: { canSend: false } }, { ...detail, messaging: { canReply: false } }, { ...detail, messaging: { canReply: true, windowExpiresAt: "2000-01-01T00:00:00Z" } }]) {
    const f = mount(); await f.ready(); await f.select(restricted); await f.change({ text: "Bloqueado" }); f.composer().props.send(); await f.flush(); assert.equal(f.requests.length, 2); f.unmount();
  }
  const f = mount(); await f.ready(); await f.select();
  const base = { text: "", file: null };
  assert.match(f.ui.replyValidation({ ...base, file: new File(["<svg>"], "a.svg", { type: "image/svg+xml" }) }), /formato/);
  assert.match(f.ui.replyValidation({ ...base, file: { type: "image/png", size: 5 * 1024 * 1024 + 1 } }), /5 MB/);
  assert.match(f.ui.replyValidation({ text: "Texto", file: new File(["audio"], "a.ogg", { type: "audio/ogg" }) }), /sin texto/);
  assert.match(f.ui.replyValidation({ ...base, text: "x".repeat(4097) }), /4.096/);
  await f.change({ file: new File(["html"], "a.html", { type: "text/html" }) }); f.composer().props.send(); await f.flush(); assert.equal(f.requests.length, 2); f.unmount();
});

test("reproductores y descargas solo usan URLs locales del mensaje; estados no afirman entrega sin recibo", () => {
  const f = mount(); const url = `/api/atencion/${chat.id}/messages/${outbound.id}/media`;
  for (const kind of ["audio", "video", "image", "document", "sticker"]) {
    const result = f.ui.MessageContent({ text: "", dapta: false, media: { kind, url, fileName: "Archivo" } });
    assert.ok(nodes(result).some(n => n.props.href === url || n.props.src === url));
    if (["audio", "video"].includes(kind)) assert.ok(nodes(result).some(n => n.type === kind && n.props.controls && n.props.preload === "none"));
    for (const unsafe of ["https://example.com/private", "//example.com/file", "javascript:alert(1)", `${url}?token=secret`, "/api/other/file"]) {
      const blocked = f.ui.MessageContent({ text: "", dapta: false, media: { kind, url: unsafe, fileName: "Archivo" } });
      assert.ok(!nodes(blocked).some(n => n.props.src || n.props.href));
    }
  }
  for (const [status, label] of [["queued", "En cola"], ["sending", "En proceso"], ["accepted", "Aceptado por WhatsApp"], ["uncertain", "Envío por confirmar"], ["delivered", "Entregado"], ["read", "Leído"]]) {
    assert.equal(text(f.ui.MessageDelivery({ message: { ...outbound, deliveryStatus: status } })), label);
  }
  assert.equal(f.ui.MessageDelivery({ message: outbound }), null); f.unmount();
});
