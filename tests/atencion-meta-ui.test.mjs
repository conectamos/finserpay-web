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
function mount(options = {}) {
  let cursor = 0, dirty = false, effects = [], tree, timerId = 0, now = 0, uuid = 10;
  const slots = [], timers = new Map(), requests = [], objectUrls = [], revokedUrls = [], mediaElements = [];
  const epoch = Date.now();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [epoch + now])); } static now() { return epoch + now; } }
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const schedule = (fn, delay, interval = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }]; },
    useRef(value) { const n = cursor++; slots[n] ??= { current: value }; return slots[n]; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(effect, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  const component = name => Object.defineProperty(() => null, "name", { value: name });
  const source = readFileSync(new URL("../app/dashboard/atencion/attention-console.tsx", import.meta.url), "utf8") + "\nexport const testUi = { privateMediaUrl, replyValidation, replyWindowOpen, MessageContent, MediaImage, MessageDelivery, FinancialPanel, CustomerBadge, ConversationLabels, isReservedTag, ReplyComposer, ChatDropSurface, ReplyAudioPreview };";
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  const sources = [], events = new Map();
  const environment = { visibilityState: "visible", onLine: true };
  const eventTarget = target => ({ addEventListener(name, fn) { events.set(`${target}:${name}`, fn); }, removeEventListener(name) { events.delete(`${target}:${name}`); } });
  class FakeEventSource {
    constructor(url) { this.url = url; this.events = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    close() { this.closed = true; }
    emit(name, data = {}) { this.events.get(name)?.({ data: JSON.stringify(data) }); }
  }

  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, FormData, File, AbortController, URLSearchParams, Date: ClockDate,
    URL: { createObjectURL(file) { const value = `blob:synthetic-${objectUrls.length + 1}`; objectUrls.push({ file, value }); return value; }, revokeObjectURL(value) { revokedUrls.push(value); } },
    document: { get visibilityState() { return environment.visibilityState; }, ...eventTarget("document") }, navigator: { get onLine() { return environment.onLine; } }, window: eventTarget("window"),
    ...(options.sse ? { EventSource: FakeEventSource } : {}),
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
      if (name === "./attention-operational") return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      return { default: component(name) };
    },
  });
  function render() {
    cursor = 0; effects = []; dirty = false; tree = options.component ? loaded.exports.testUi[options.component](options.props) : loaded.exports.default({ actor: options.actor || actor });
    if (options.mediaRefs) for (const node of nodes(tree)) if (["img", "video", "audio"].includes(node.type) && node.props.ref && !node.props.ref.current) {
      const element = { tag: node.type, src: "", pauses: 0, pause() { this.pauses++; }, removeAttribute(name) { if (name === "src") this.src = ""; } };
      node.props.ref.current = element; mediaElements.push(element);
    }
    for (const run of effects) run();
  }
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
  return { requests, flush, advance, all, composer, ui: loaded.exports.testUi, sources, environment, objectUrls, revokedUrls, mediaElements,
    dropSurface: () => all().find(node => node.type?.name === "ChatDropSurface"),
    setProps(patch) { options.props = { ...options.props, ...patch }; render(); },
    dispatch(target, name) { events.get(`${target}:${name}`)?.(); },
    financial: () => all().find(node => node.type?.name === "CustomerPanel")?.props.financial,
    rerender() { render(); },
    async ready() { await advance(250); requests.at(-1).respond({ ...inbox, actor: options.actor || actor }); await flush(); all().find(node => node.type === "button" && text(node) === "Conversaciones").props.onClick(); await flush(); },
    async select(payload = detail) { all().find(node => node.type === "button" && text(node).includes(payload.conversation.name)).props.onClick(); await flush(); await advance(0); requests.at(-1).respond(payload); await flush(); },
    async change(patch) { composer().props.change(patch); await flush(); },
    async completeReads(payload = detail) { for (const r of requests.filter(r => !r.done && r.init.method !== "POST")) r.respond(r.url.includes("?") ? inbox : payload); await flush(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("marcar leído para el equipo usa revisión y UUID, conserva borrador y filtros, y no responde ni finaliza", async () => {
  const f = mount(); await f.ready();
  const closed = { ...detail, conversation: { ...chat, status: "closed", unreadCount: 0 } };
  await f.select(closed);
  const file = new File(["archivo"], "borrador.jpg", { type: "image/jpeg" });
  await f.change({ text: "Respuesta que sigo preparando", file });
  const filters = () => f.all().find(node => node.type?.name === "AttentionWorkFilters");
  filters().props.change("unread", "Seguimiento"); await f.flush(); await f.advance(250); f.requests.at(-1).respond(inbox); await f.flush();
  const button = () => f.all().find(node => node.props["aria-label"] === "Marcar como leído para el equipo");
  assert.ok(button(), "la lectura nominal previa no debe ocultar la acción compartida");
  button().props.onClick(); button().props.onClick(); await f.flush();
  const writes = f.requests.filter(request => request.init.method === "POST"); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `/api/atencion/${chat.id}/read/team`);
  const payload = JSON.parse(writes[0].init.body); assert.equal(payload.version, chat.version); assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(payload).sort(), ["requestId", "version"]); assert.equal(button().props.disabled, true);
  writes[0].respond({ unreadCount: 0, changed: true }); await f.flush(); await f.completeReads(closed);
  assert.equal(f.composer().props.draft.text, "Respuesta que sigo preparando"); assert.equal(f.composer().props.draft.file, file);
  assert.equal(f.composer().props.detail.conversation.status, "closed"); assert.equal(filters().props.filter, "unread"); assert.equal(filters().props.tag, "Seguimiento");
  assert.ok(f.all().some(node => node.props.role === "status" && text(node).includes("leídos para el equipo")));
  assert.ok(!f.requests.some(request => request.init.method === "PATCH" || request.url.endsWith("/messages"))); f.unmount();
});

test("conflicto al compartir lectura actualiza el chat y exige otra pulsación sin borrar el borrador", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "No perder mi respuesta" });
  const button = () => f.all().find(node => node.props["aria-label"] === "Marcar como leído para el equipo");
  button().props.onClick(); await f.flush(); const first = f.requests.at(-1), original = JSON.parse(first.init.body);
  first.respond({ error: "La conversación cambió" }, 409); await f.flush();
  const updated = { ...detail, conversation: { ...chat, version: chat.version + 1, unreadCount: 1 } };
  await f.completeReads(updated);
  assert.equal(f.requests.filter(request => request.init.method === "POST").length, 1);
  assert.equal(f.composer().props.draft.text, "No perder mi respuesta");
  assert.ok(f.all().some(node => node.props.role === "alert" && text(node).includes("vuelve a pulsar")));
  button().props.onClick(); await f.flush(); const retry = f.requests.at(-1), refreshed = JSON.parse(retry.init.body);
  assert.equal(refreshed.version, chat.version + 1); assert.notEqual(refreshed.requestId, original.requestId);
  retry.respond({ unreadCount: 0, changed: true }); await f.flush(); await f.completeReads(updated); f.unmount();
});

test("reintento de lectura tras fallo de red conserva intención y respuesta tardía de otro chat no modifica el actual", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Borrador A" });
  const button = () => f.all().find(node => node.props["aria-label"] === "Marcar como leído para el equipo");
  button().props.onClick(); await f.flush(); const first = f.requests.at(-1); first.fail(); await f.flush();
  button().props.onClick(); await f.flush(); const retry = f.requests.at(-1); assert.equal(retry.init.body, first.init.body);
  await f.select({ ...detail, conversation: other }); retry.respond({ unreadCount: 0, changed: true }); await f.flush(); await f.completeReads({ ...detail, conversation: other });
  assert.equal(f.composer().props.detail.conversation.id, other.id);
  assert.ok(!f.all().some(node => node.props.role === "status" && text(node).includes("leídos para el equipo")));
  await f.select(); assert.equal(f.composer().props.draft.text, "Borrador A"); f.unmount();
});

test("lectura compartida se oculta sin permiso y un404 retira el chat que dejó de estar autorizado", async () => {
  const restricted = mount(); await restricted.ready(); await restricted.select({ ...detail, permissions: { manage: false } });
  assert.equal(restricted.all().some(node => node.props["aria-label"] === "Marcar como leído para el equipo"), false); restricted.unmount();
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Dato protegido" });
  f.all().find(node => node.props["aria-label"] === "Marcar como leído para el equipo").props.onClick(); await f.flush();
  f.requests.at(-1).respond({ error: "No autorizado" }, 404); await f.flush();
  assert.equal(f.composer(), undefined); assert.equal(f.financial(), undefined); f.unmount();
});

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
  assert.equal(f.ui.replyValidation({ text: "Texto conservado como borrador", file: new File(["audio"], "a.ogg", { type: "audio/ogg" }) }), null);
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

test("imagen fallida ofrece reintento accesible sobre la misma ruta privada y conserva una sola descarga", async () => {
  for (const url of [`/api/atencion/${chat.id}/messages/${outbound.id}/media`, `/api/atencion/solicitudes/${chat.id}/files/${outbound.id}`]) {
    let layouts = 0;
    const f = mount({ component: "MediaImage", props: { url, name: "Soporte recibido", onLoad: () => layouts++ } });
    const first = f.all().find(n => n.props.src === url);
    assert.equal(first.props.unoptimized, true);
    assert.equal(first.props.width, 640); assert.equal(first.props.height, 480);
    first.props.onError(); await f.flush();
    const status = f.all().find(n => n.props.role === "status");
    assert.match(text(status), /No se pudo cargar la imagen/); assert.doesNotMatch(text(status), /Meta/);
    assert.equal(f.all().some(n => n.props.src), false, "no debe conservar una imagen rota");
    const retry = f.all().find(n => n.props.type === "button" && text(n) === "Reintentar imagen");
    assert.ok(retry); retry.props.onClick(); await f.flush();
    const replacement = f.all().find(n => n.props.src === url);
    assert.ok(replacement); assert.notEqual(replacement.key, first.key);
    assert.equal(f.ui.privateMediaUrl(replacement.props.src), url, "el reintento no añade query ni expone la URL de proveedor");
    replacement.props.onLoad(); assert.equal(layouts, 2);
    const message = f.ui.MessageContent({ text: "", dapta: false, media: { kind: "image", url } });
    assert.equal(nodes(message).filter(n => n.type === "a" && text(n) === "Abrir o descargar archivo").length, 1);
    f.unmount();
  }
});

const makeDragEvent = (files = [], types = ["Files"]) => ({ dataTransfer: { files, types, dropEffect: "none" }, prevented: false, preventDefault() { this.prevented = true; } });
const dropSection = surface => surface.all().find(node => node.type === "section");
function connectedDropSurface(parent) {
  return mount({ component: "ChatDropSurface", props: { children: "Historial", receive: files => parent.dropSurface().props.receive(files) } });
}

test("arrastrar al historial prepara un archivo sin enviarlo y mantiene el overlay entre elementos hijos", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Pie de foto" });
  const surface = connectedDropSurface(f); const file = new File(["imagen"], "foto.png", { type: "image/png" });
  const unrelated = makeDragEvent([], ["text/plain"]); dropSection(surface).props.onDragEnter(unrelated); await surface.flush();
  assert.equal(unrelated.prevented, false); assert.equal(surface.all().some(n => n.props.role === "status"), false);
  dropSection(surface).props.onDragEnter(makeDragEvent([file])); dropSection(surface).props.onDragEnter(makeDragEvent([file])); await surface.flush();
  assert.match(text(surface.all().find(n => n.props.role === "status")), /revisarlo antes de enviarlo/);
  dropSection(surface).props.onDragLeave(makeDragEvent()); await surface.flush();
  assert.ok(surface.all().some(n => n.props.role === "status"), "entrar a un hijo no debe ocultar el destino de drop");
  const over = makeDragEvent([file]); dropSection(surface).props.onDragOver(over);
  assert.equal(over.prevented, true); assert.equal(over.dataTransfer.dropEffect, "copy");
  const drop = makeDragEvent([file]); dropSection(surface).props.onDrop(drop); await surface.flush(); await f.flush();
  assert.equal(drop.prevented, true); assert.equal(f.composer().props.draft.file, file); assert.equal(f.composer().props.draft.text, "Pie de foto");
  assert.equal(surface.all().some(n => n.props.role === "status"), false);
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 0);
  surface.unmount(); f.unmount();
});

test("drop conserva el archivo preparado, rechaza varios archivos y muestra un aviso sin enviar", async () => {
  const f = mount(); await f.ready(); await f.select(); const surface = connectedDropSurface(f);
  const original = new File(["pdf"], "original.pdf", { type: "application/pdf" });
  const replacement = new File(["foto"], "otra.jpg", { type: "image/jpeg" });
  dropSection(surface).props.onDrop(makeDragEvent([original, replacement])); await surface.flush(); await f.flush();
  assert.match(text(surface.all().find(n => n.props.role === "alert")), /un archivo a la vez/);
  assert.equal(f.composer().props.draft.file, null);
  await f.change({ file: original });
  dropSection(surface).props.onDrop(makeDragEvent([replacement])); await surface.flush(); await f.flush();
  assert.match(text(surface.all().find(n => n.props.role === "alert")), /Ya tienes un archivo preparado/);
  assert.equal(f.composer().props.draft.file, original);
  surface.all().find(n => n.props["aria-label"] === "Cerrar aviso de archivo").props.onClick(); await surface.flush();
  assert.equal(surface.all().some(n => n.props.role === "alert"), false);
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 0); surface.unmount(); f.unmount();
});

test("drop deniega permiso, ventana vencida, chat interno y solicitud bloqueada sin modificar el borrador", async () => {
  const file = new File(["foto"], "foto.jpg", { type: "image/jpeg" });
  for (const restricted of [
    { ...detail, permissions: { canSend: false }, messaging: { ...detail.messaging, reason: "Sin permiso de respuesta" } },
    { ...detail, messaging: { ...detail.messaging, canReply: false, reason: "Envío pendiente" } },
    { ...detail, messaging: { ...detail.messaging, windowExpiresAt: "2000-01-01T00:00:00Z" } },
    { ...detail, conversation: { ...chat, channel: "internal" } },
  ]) {
    const f = mount(); await f.ready(); await f.select(restricted);
    const surface = connectedDropSurface(f); dropSection(surface).props.onDrop(makeDragEvent([file])); await surface.flush(); await f.flush();
    assert.ok(surface.all().some(n => n.props.role === "alert")); assert.equal(f.composer()?.props.draft.file ?? null, null);
    assert.equal(f.requests.filter(r => r.init.method === "POST").length, 0); surface.unmount(); f.unmount();
  }
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Intención conservada" });
  f.composer().props.send(); await f.flush(); f.requests.at(-1).fail(); await f.flush();
  const surface = connectedDropSurface(f); dropSection(surface).props.onDrop(makeDragEvent([file])); await surface.flush(); await f.flush();
  assert.match(text(surface.all().find(n => n.props.role === "alert")), /consulta su estado/);
  assert.equal(f.composer().props.draft.file, null); assert.equal(f.composer().props.draft.text, "Intención conservada");
  assert.equal(f.composer().props.draft.locked, true); assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  surface.unmount(); f.unmount();
});

test("micrófono sigue habilitado con texto escrito y los stickers se preparan desde la biblioteca", async () => {
  const root = mount(); await root.ready(); await root.select(); await root.change({ text: "Mensaje para después del audio" });
  const f = mount({ component: "ReplyComposer", props: root.composer().props });
  const tools = () => f.all().find(n => n.type?.name?.endsWith("attention-composer-tools"));
  assert.notEqual(tools().key, f.all().find(n => n.type?.name?.endsWith("attention-template-composer")).key, "herramientas y plantillas hermanas necesitan claves distintas");
  assert.equal(tools().props.disabled, false); assert.equal(tools().props.audioDisabled, false);
  const audio = new File(["audio"], "grabacion.ogg", { type: "audio/ogg" });
  tools().props.onAudio(audio); await root.flush(); f.setProps(root.composer().props);
  assert.equal(tools().props.audioDisabled, true); assert.equal(root.composer().props.draft.file, audio);
  assert.equal(root.composer().props.draft.text, "Mensaje para después del audio");
  assert.match(text(f.all().find(n => n.type === "p" && text(n).includes("borrador"))), /quedará como borrador/);
  const picker = f.all().find(n => n.type?.name?.endsWith("attention-sticker-picker"));
  assert.equal(picker.props.disabled, false);
  const sticker=new File(["sticker"],"sticker.webp",{type:"image/webp"});
  picker.props.onSelect(sticker);await root.flush();
  assert.equal(root.composer().props.draft.file,sticker);
  assert.equal(root.requests.filter(r => r.init.method === "POST").length, 0);
  f.unmount(); root.unmount();
});

for (const [kind, mime, name] of [["audio", "audio/ogg", "grabacion.ogg"], ["sticker", "image/webp", "sticker.webp"]]) {
  test(`${kind} se envía sin caption y la aceptación conserva íntegro el texto borrador`, async () => {
    const f = mount(); await f.ready(); await f.select(); const draftText = "  Texto para enviar después  ";
    const file = new File([kind], name, { type: mime }); await f.change({ text: draftText, file });
    assert.equal(f.ui.replyValidation(f.composer().props.draft), null);
    f.composer().props.send(); await f.flush(); const sent = f.requests.at(-1);
    assert.equal(sent.init.body.get("text"), ""); assert.equal(sent.init.body.get("file").name, name);
    assert.equal(f.composer().props.draft.text, draftText); assert.equal(f.composer().props.draft.file, file);
    sent.respond({ message: { ...outbound, text: "", deliveryStatus: "accepted", attachment: { kind } } }); await f.flush();
    assert.equal(f.composer().props.draft.text, draftText); assert.equal(f.composer().props.draft.file, null);
    assert.equal(f.composer().props.draft.locked, false); await f.completeReads();
    assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1, "el texto conservado no se envía automáticamente"); f.unmount();
  });
}

for (const [tag, mime] of [["img", "image/png"], ["video", "video/mp4"], ["audio", "audio/ogg"]]) {
  test(`vista previa ${tag} utiliza un blob local y lo libera al sustituir el archivo y desmontar`, () => {
    const first = new File(["primero"], "primero", { type: mime }); const second = new File(["segundo"], "segundo", { type: mime });
    const f = mount({ component: "ReplyAudioPreview", mediaRefs: true, props: { file: first } });
    assert.equal(f.all()[0].type, tag); assert.equal(f.mediaElements[0].src, "blob:synthetic-1");
    if (tag !== "img") assert.equal(f.all()[0].props.controls, true);
    f.setProps({ file: second }); assert.deepEqual(f.revokedUrls, ["blob:synthetic-1"]); assert.equal(f.mediaElements[0].src, "blob:synthetic-2");
    f.unmount(); assert.deepEqual(f.revokedUrls, ["blob:synthetic-1", "blob:synthetic-2"]); assert.equal(f.mediaElements[0].src, "");
    if (tag !== "img") assert.equal(f.mediaElements[0].pauses, 2); assert.equal(f.requests.length, 0);
  });
}

test("alias MP3/M4A de Windows y application/ogg admiten preview de audio, caption vacío y borrador separado", async () => {
  for (const [mime, name] of [["audio/mp3", "nota.mp3"], ["audio/x-m4a", "nota.m4a"], ["audio/m4a", "grabacion.m4a"], ["application/ogg", "nota.ogg"]]) {
    const f = mount(); await f.ready(); await f.select();
    const file = new File(["audio sintético"], name, { type: mime }); const draftText = "Texto pendiente ".repeat(100);
    await f.change({ text: draftText, file });
    assert.equal(f.ui.replyValidation(f.composer().props.draft), null, `${mime} no debe usar el límite de caption de 1024 caracteres`);
    const composer = mount({ component: "ReplyComposer", props: f.composer().props });
    const picker = composer.all().find(n => n.type === "input" && n.props["aria-label"] === "Adjuntar archivo");
    assert.ok(picker.props.accept.split(",").includes(mime));
    const preview = mount({ component: "ReplyAudioPreview", mediaRefs: true, props: { file } });
    assert.equal(preview.all()[0].type, "audio"); assert.equal(preview.all()[0].props.controls, true);
    assert.equal(preview.mediaElements[0].src, "blob:synthetic-1");
    assert.equal(f.requests.filter(r => r.init.method === "POST").length, 0);
    f.composer().props.send(); await f.flush(); const sent = f.requests.at(-1);
    assert.equal(sent.init.body.get("text"), ""); assert.equal(sent.init.body.get("file").name, name);
    assert.equal(sent.init.body.get("file").type, mime);
    sent.respond({ message: { ...outbound, text: "", deliveryStatus: "accepted", attachment: { kind: "audio" } } }); await f.flush();
    assert.equal(f.composer().props.draft.text, draftText); assert.equal(f.composer().props.draft.file, null);
    await f.completeReads(); assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
    composer.unmount(); preview.unmount(); f.unmount(); assert.deepEqual(preview.revokedUrls, ["blob:synthetic-1"]);
  }
});

const receiptInput = { creditId: 31, paymentId: 51, version: 4, requestId: "00000000-0000-4000-8000-000000000091" };
const extensionInput = { creditId: 31, days: 2, version: 4, requestId: "00000000-0000-4000-8000-000000000092", reason: "Acuerdo registrado", observation: "Cliente confirmó el compromiso", promiseAmount: 30000, promiseDate: "2026-10-31" };

test("recibo incierto conserva crédito, pago y UUID; consultar nunca reenvía y reintento reutiliza la intención", async () => {
  const f = mount(); await f.ready(); await f.select();
  f.financial().sendReceipt(receiptInput); f.financial().sendReceipt(receiptInput); await f.flush();
  const first = f.requests.at(-1); assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  assert.ok(first.url.endsWith("/receipts/latest/send")); assert.deepEqual(JSON.parse(first.init.body), receiptInput);
  first.fail(); await f.flush(); assert.equal(f.financial().attempts.receipt.phase, "uncertain");
  f.financial().sendReceipt({ ...receiptInput, requestId: "new-intention", creditId: 32 }); await f.flush();
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  f.financial().resolveReceipt(); await f.flush(); const check = f.requests.at(-1);
  assert.ok(check.url.endsWith(`messages?requestId=${receiptInput.requestId}`)); assert.equal(check.init.method, undefined);
  check.respond({ message: null }); await f.flush(); await f.completeReads();
  assert.equal(f.financial().attempts.receipt.phase, "missing");
  f.financial().sendReceipt({ ...receiptInput, creditId: 999, paymentId: 999, version: 99 }, true); await f.flush();
  assert.deepEqual(JSON.parse(f.requests.at(-1).init.body), receiptInput); f.unmount();
});

test("prórroga doble clic registra una intención; un replay vencido no anuncia una concesión nueva", async () => {
  const f = mount(); await f.ready(); await f.select();
  f.financial().grant(extensionInput); f.financial().grant(extensionInput); await f.flush();
  const first = f.requests.at(-1); assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  assert.deepEqual(JSON.parse(first.init.body), extensionInput);
  first.fail(); await f.flush(); assert.equal(f.financial().attempts.extension.phase, "uncertain");
  f.financial().grant({ ...extensionInput, requestId: "different", days: 4 }); await f.flush();
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1);
  f.financial().grant(extensionInput); await f.flush();
  assert.deepEqual(JSON.parse(f.requests.at(-1).init.body), extensionInput);
  f.requests.at(-1).respond({ extension: { id: "ex-1", status: "EXPIRED", expiresOn: "2026-10-31" }, unchanged: true, version: 5 });
  await f.flush(); await f.completeReads();
  assert.match(f.financial().attempts.extension.message, /ya registrada: prórroga vencida/);
  assert.doesNotMatch(f.financial().attempts.extension.message, /concedida/); f.unmount();
});

test("un 409 de prórroga exige revisar la cuota y conserva la intención rechazada sin reenvío automático", async () => {
  const f = mount(); await f.ready(); await f.select();
  f.financial().grant(extensionInput); await f.flush();
  f.requests.at(-1).respond({ error: "La cuota pendiente cambió o no fue confirmada." }, 409); await f.flush();
  const attempt = f.financial().attempts.extension;
  assert.equal(attempt.phase, "failed"); assert.equal(attempt.requiresReview, true);
  assert.deepEqual(JSON.parse(JSON.stringify(attempt.input)), extensionInput);
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 1); f.unmount();
});

test("reasignación durante una operación financiera retira contexto protegido sin borrar otro chat", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Privado de A" });
  f.financial().sendReceipt(receiptInput); await f.flush(); const pending = f.requests.at(-1);
  await f.select({ ...detail, conversation: other });
  pending.respond({ error: "No disponible" }, 404); await f.flush();
  assert.equal(f.composer().props.detail.conversation.id, other.id);
  f.financial().sendReceipt({ ...receiptInput, requestId: "00000000-0000-4000-8000-000000000095" }); await f.flush();
  f.requests.at(-1).respond({ error: "No disponible" }, 404); await f.flush();
  assert.equal(f.composer(), undefined); assert.equal(f.financial(), undefined); f.unmount();
});

function financialFixture() {
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const credit = { id: 31, number: "QA-031", state: "AL_DIA", extension: { canGrant: true, blockedReason: null, installmentNumber: 2, dueDate: day(0), choices: [{ days: 1, expiresOn: day(1) }, { days: 2, expiresOn: day(2) }], active: null, promise: { amount: 30000, date: day(1) } }, lastPayment: { id: 51, date: day(0), amount: 30000, method: "EFECTIVO", receiptAvailable: true } };
  return { credits: [credit, { ...credit, id: 32, number: "QA-032", lastPayment: { ...credit.lastPayment, id: 52 } }], version: 4, blockedReason: null };
}
const findButton = (f, label) => f.all().find(node => node.type?.name === "Button" && text(node).trim() === label);
const financialDialog = f => f.all().find(node => node.type?.name === "@/app/_components/finser-confirm-dialog");

test("ficha exige elegir crédito y confirmar el pago actual antes de enviar su PDF", async () => {
  const sent = [], payload = financialFixture();
  const actions = { attempts: {}, disabled: false, accessDenied: () => false, sendReceipt: async input => sent.push(input) };
  const f = mount({ component: "FinancialPanel", props: { detail, actions } });
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush();
  assert.equal(findButton(f, "Enviar recibo"), undefined);
  const selector = f.all().find(node => node.type?.name === "Select");
  assert.equal(selector.props.value, ""); selector.props.onChange({ target: { value: "32" } }); await f.flush();
  findButton(f, "Enviar recibo").props.onClick(); await f.flush();
  assert.equal(sent.length, 0); assert.equal(f.requests.length, 2);
  f.requests.at(-1).respond(payload); await f.flush();
  assert.equal(financialDialog(f).props.open, true); assert.match(financialDialog(f).props.description, /QA-032/);
  assert.equal(sent.length, 0); financialDialog(f).props.onConfirm(); await f.flush();
  assert.equal(sent.length, 1); assert.equal(sent[0].creditId, 32); assert.equal(sent[0].paymentId, 52);
  assert.equal(sent[0].version, 4); assert.match(sent[0].requestId, /^[0-9a-f-]{36}$/); f.unmount();
});

test("si cambia el último pago al confirmar, la ficha exige revisarlo y no abre confirmación antigua", async () => {
  const payload = financialFixture(); payload.credits = [payload.credits[0]];
  const f = mount({ component: "FinancialPanel", props: { detail, actions: { attempts: {}, disabled: false, accessDenied: () => false, sendReceipt: async () => assert.fail("No debe enviar") } } });
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush();
  findButton(f, "Enviar recibo").props.onClick(); await f.flush();
  f.requests.at(-1).respond({ ...payload, credits: [{ ...payload.credits[0], lastPayment: { ...payload.credits[0].lastPayment, id: 99 } }] }); await f.flush();
  assert.equal(financialDialog(f).props.open, false); assert.ok(f.all().some(node => text(node).includes("Cambió el último pago"))); f.unmount();
});

test("gestiones e historial enlaza solo el crédito autorizado elegido y sigue disponible al recargar", async () => {
  const payload = financialFixture();
  const actions = { attempts: {}, disabled: false, accessDenied: () => false };
  const historyLink = f => f.all().find(node => node.type?.name === "next/link" && text(node).startsWith("Gestiones e historial"));
  const f = mount({ component: "FinancialPanel", props: { detail, actions } });
  assert.equal(historyLink(f), undefined);
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush();
  assert.equal(historyLink(f), undefined, "varios créditos requieren selección explícita");
  for (const id of [32, 31]) {
    f.all().find(node => node.type?.name === "Select").props.onChange({ target: { value: String(id) } }); await f.flush();
    assert.equal(historyLink(f).props.href, `/dashboard/aprobaciones/gestion-cartera?creditId=${id}`);
    assert.equal(historyLink(f).props.target, "_blank"); assert.equal(historyLink(f).props.rel, "noopener noreferrer");
  }
  f.unmount();
  const reloaded = mount({ component: "FinancialPanel", props: { detail, actions } });
  await reloaded.advance(0); reloaded.requests.at(-1).respond({ ...payload, credits: [payload.credits[0]] }); await reloaded.flush();
  assert.equal(historyLink(reloaded).props.href, "/dashboard/aprobaciones/gestion-cartera?creditId=31");
  assert.equal(reloaded.requests.filter(r => r.init.method === "POST").length, 0); reloaded.unmount();
});

test("prórroga exige compromiso explícito y una opción vigente del servidor antes del diálogo", async () => {
  const granted = [], payload = financialFixture(); payload.credits = [payload.credits[0]];
  const actions = { attempts: {}, disabled: false, accessDenied: () => false, grant: async input => { granted.push(input); return null; } };
  const f = mount({ component: "FinancialPanel", props: { detail, actions } });
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush();
  findButton(f, "Conceder prórroga").props.onClick(); await f.flush();
  const edit = (label, value) => {
    const group = f.all().find(node => node.type === "label" && text(node).startsWith(label));
    const input = nodes(group).find(node => node.props.onChange); input.props.onChange({ target: { value } });
  };
  edit("Días autorizados", "2"); await f.flush();
  edit("Motivo", "Acuerdo de pago verificado"); edit("Observación", "Cliente confirmó fecha y valor por chat"); await f.flush();
  assert.equal(findButton(f, "Revisar y confirmar").props.disabled, true);
  f.all().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  assert.equal(f.requests.length, 1, "no consulta ni concede sin compromiso confirmado");
  f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); await f.flush();
  assert.equal(findButton(f, "Revisar y confirmar").props.disabled, false);
  f.all().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  f.requests.at(-1).respond({ ...payload, version: 8 }); await f.flush();
  assert.equal(granted.length, 0); assert.equal(financialDialog(f).props.open, true);
  assert.match(financialDialog(f).props.description, /QA-031/); assert.match(financialDialog(f).props.description, /2 días/);
  assert.match(financialDialog(f).props.description, /gestión de cartera como Acuerdo de pago/);
  assert.match(financialDialog(f).props.description, /08:00 \(Bogotá\) del día siguiente al compromiso/);
  financialDialog(f).props.onConfirm(); await f.flush();
  assert.equal(granted.length, 1); assert.equal(granted[0].creditId, 31); assert.equal(granted[0].days, 2); assert.equal(granted[0].version, 8);
  assert.equal(granted[0].installmentNumber, payload.credits[0].extension.installmentNumber); assert.equal(granted[0].installmentDueDate, payload.credits[0].extension.dueDate);
  assert.equal(granted[0].promiseAmount, 30000); assert.equal(granted[0].promiseDate, payload.credits[0].extension.promise.date); f.unmount();
});

function financialField(f, label) {
  return nodes(f.all().find(node => node.type === "label" && text(node).startsWith(label))).find(node => node.props.onChange);
}
async function prepareFinancialDraft(f) {
  findButton(f, "Conceder prórroga").props.onClick(); await f.flush();
  for (const [label, value] of [["Días autorizados", "2"], ["Motivo", "Acuerdo de pago verificado"], ["Observación", "Cliente confirmó la fecha por chat"]]) {
    financialField(f, label).props.onChange({ target: { value } }); await f.flush();
  }
  f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); await f.flush();
}

test("si la cuota cambia durante la revisión, conserva el formulario y exige revisar la nueva antes del diálogo", async () => {
  const payload = financialFixture(); payload.credits = [payload.credits[0]];
  const actions = { attempts: {}, disabled: false, accessDenied: () => false, grant: async () => assert.fail("No debe conceder sin revisar") };
  const f = mount({ component: "FinancialPanel", props: { detail, actions } });
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush(); await prepareFinancialDraft(f);
  f.all().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  const changed = { ...payload, version: 8, credits: [{ ...payload.credits[0], extension: { ...payload.credits[0].extension, installmentNumber: 3, dueDate: "2099-01-02" } }] };
  f.requests.at(-1).respond(changed); await f.flush();
  assert.equal(financialDialog(f).props.open, false);
  assert.match(text(f.all()[0]), /Cambió la cuota pendiente/);
  assert.equal(financialField(f, "Motivo").props.value, "Acuerdo de pago verificado");
  assert.equal(financialField(f, "Observación").props.value, "Cliente confirmó la fecha por chat");
  assert.equal(f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.checked, false);
  assert.equal(findButton(f, "Revisar y confirmar").props.disabled, true); f.unmount();
});

test("tras409 actualizar cuota conserva datos, no envía y requiere compromiso y nueva confirmación con otro UUID", async () => {
  const payload = financialFixture(); payload.credits = [payload.credits[0]]; const granted = [];
  const actions = { attempts: {}, disabled: false, accessDenied: () => false, grant: async input => {
    granted.push(input); actions.attempts = { extension: { input, phase: "failed", requiresReview: true, message: "La cuota pendiente cambió." } }; return null;
  } };
  const f = mount({ component: "FinancialPanel", props: { detail, actions } });
  await f.advance(0); f.requests.at(-1).respond(payload); await f.flush(); await prepareFinancialDraft(f);
  f.all().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush(); f.requests.at(-1).respond(payload); await f.flush();
  financialDialog(f).props.onConfirm(); await f.flush();
  const first = granted[0]; assert.equal(granted.length, 1); assert.equal(financialDialog(f).props.open, false);
  assert.equal(f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.checked, false);
  f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); await f.flush();
  assert.equal(findButton(f, "Revisar y confirmar").props.disabled, true, "revisar requiere primero refrescar el409");
  findButton(f, "Actualizar cuota y revisar").props.onClick(); await f.flush();
  const fresh = { ...payload, version: 9, credits: [{ ...payload.credits[0], extension: { ...payload.credits[0].extension, installmentNumber: 3 } }] };
  f.requests.at(-1).respond(fresh); await f.flush();
  assert.equal(granted.length, 1, "refrescar nunca envía"); assert.equal(financialDialog(f).props.open, false);
  for (const [label, expected] of [["Días autorizados", "2"], ["Motivo", first.reason], ["Observación", first.observation], ["Compromiso de pago", String(first.promiseAmount)], ["Fecha del compromiso", first.promiseDate]]) assert.equal(financialField(f, label).props.value, expected);
  assert.equal(findButton(f, "Revisar y confirmar").props.disabled, true);
  f.all().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); await f.flush();
  f.all().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush(); f.requests.at(-1).respond(fresh); await f.flush();
  assert.equal(granted.length, 1); assert.equal(financialDialog(f).props.open, true); assert.match(financialDialog(f).props.description, /cuota 3/);
  financialDialog(f).props.onConfirm(); await f.flush();
  assert.equal(granted.length, 2); assert.notEqual(granted[1].requestId, first.requestId);
  assert.equal(granted[1].installmentNumber, 3); assert.equal(granted[1].installmentDueDate, fresh.credits[0].extension.dueDate); assert.equal(granted[1].version, 9); f.unmount();
});

test("solo un resultado con gestión del mismo crédito anuncia el registro y enlaza al muro", async () => {
  const management = { id: "mg-1", creditId: extensionInput.creditId, nextFollowUpAt: "2026-11-02T13:00:00.000Z" };
  for (const supplied of [undefined, management, { ...management, creditId: 999 }]) {
    const root = mount(); await root.ready(); await root.select(); root.financial().grant(extensionInput); await root.flush();
    root.requests.at(-1).respond({ extension: { id: "ex-1", status: "APPROVED", expiresOn: "2026-11-02" }, unchanged: false, version: 5, management: supplied });
    await root.flush(); await root.completeReads();
    const expected = supplied?.creditId === extensionInput.creditId;
    assert.equal(Boolean(root.financial().attempts.extension.management), expected);
    assert.equal(root.financial().attempts.extension.message.includes("Gestión registrada en Gestión de cartera"), expected);
    const panel = mount({ component: "FinancialPanel", props: { detail, actions: root.financial() } });
    await panel.advance(0); panel.requests.at(-1).respond(financialFixture()); await panel.flush();
    const link = panel.all().find(node => node.type?.name === "next/link" && text(node).includes("Ver en Gestión de cartera"));
    assert.equal(Boolean(link), expected);
    if (expected) { assert.equal(link.props.href, `/dashboard/aprobaciones/gestion-cartera?creditId=${extensionInput.creditId}`); assert.match(text(panel.all()[0]), /Próximo seguimiento/); }
    panel.unmount(); root.unmount();
  }
});

test("etiqueta FINSERPAY depende de clasificación automática y jamás de un texto manual", () => {
  const f = mount();
  assert.equal(f.ui.CustomerBadge({ conversation: { ...chat, tags: ["FINSERPAY"], autoTags: [] } }), null);
  assert.equal(text(f.ui.CustomerBadge({ conversation: { ...chat, autoTags: ["FINSERPAY"] } })), "FINSERPAY");
  for (const reserved of ["finserpay", "FINSER PAY", "ＦＩＮＳＥＲＰＡＹ"]) assert.equal(f.ui.isReservedTag(reserved), true);
  assert.equal(f.ui.isReservedTag("Seguimiento"), false); f.unmount();
});

test("SSE solo declara conectado tras ready, agrupa eventos y conserva borrador y scroll", async () => {
  const f = mount({ sse: true }); await f.ready(); await f.select(); await f.change({ text: "Borrador sin enviar" });
  const source = f.sources.at(-1); assert.equal(source.url, "/api/atencion/events");
  assert.equal(f.all().some(node => node.props.role === "status" && text(node) === "Conectado"), false);
  const log = f.all().find(node => node.props.role === "log");
  const position = { scrollTop: 150, scrollHeight: 1000, clientHeight: 200 };
  log.props.ref.current = position; await f.advance(0); position.scrollTop = 150; log.props.onScroll(); await f.flush();
  source.emit("ready", { connected: true }); await f.flush();
  assert.ok(f.all().some(node => node.props.role === "status" && text(node) === "Conectado"));
  for (let i = 0; i < 10; i++) source.emit("invalidate", { reason: "conversation_changed" });
  await f.advance(250); assert.equal(f.requests.length, 4);
  f.requests[2].respond(inbox); f.requests[3].respond({ ...detail, messages: [{ ...outbound, id: "message-live", text: "Mensaje en tiempo real" }] });
  await f.flush(); await f.advance(0);
  assert.equal(f.composer().props.draft.text, "Borrador sin enviar"); assert.equal(position.scrollTop, 150);
  assert.ok(f.all().some(node => node.type?.name === "MessageContent" && node.props.text === "Mensaje en tiempo real"));
  await f.advance(20_000); assert.equal(f.requests.length, 4, "no hace polling adicional mientras está conectado");
  source.emit("degraded", {}); await f.flush(); await f.advance(20_000); assert.equal(f.requests.length, 6);
  f.unmount(); assert.ok(f.sources.every(item => item.closed));
});

test("SSE difiere eventos durante envío, limpia acceso al revocarse y cierra al ocultar la página", async () => {
  const f = mount({ sse: true }); await f.ready(); await f.select(); await f.change({ text: "Mensaje humano" });
  let source = f.sources.at(-1); source.emit("ready", { connected: true });
  f.composer().props.send(); await f.flush(); const sent = f.requests.at(-1);
  source.emit("invalidate", {}); await f.advance(1500); assert.equal(f.requests.length, 3);
  sent.respond({ message: { ...outbound, deliveryStatus: "accepted" } }); await f.flush(); await f.completeReads();
  await f.advance(1000); assert.equal(f.requests.length, 7); await f.completeReads();
  f.environment.visibilityState = "hidden"; f.dispatch("document", "visibilitychange"); await f.flush();
  assert.equal(source.closed, true); const count = f.requests.length; await f.advance(20000); assert.equal(f.requests.length, count);
  f.environment.visibilityState = "visible"; f.dispatch("document", "visibilitychange"); await f.flush();
  source = f.sources.at(-1); source.emit("unauthorized", {}); await f.flush(); await f.advance(0);
  assert.equal(source.closed, true); assert.equal(f.composer(), undefined); assert.equal(f.financial(), undefined);
  await f.advance(20000); assert.equal(f.requests.length, count); f.unmount();
});

test("SSE abierto pero silencioso reactiva la consulta y reemplaza una sola conexión", async () => {
  const f = mount({ sse: true }); await f.ready(); await f.select();
  const first = f.sources.at(-1); first.emit("ready", { connected: true }); await f.flush();
  await f.advance(40_000); assert.equal(f.requests.length, 2); assert.equal(first.closed, false);
  await f.advance(20_000); assert.equal(f.requests.length, 4); assert.equal(first.closed, true);
  assert.equal(f.sources.filter(source => !source.closed).length, 1);
  assert.ok(f.all().some(node => node.props.role === "status" && text(node) === "Reconectando…"));
  const replacement = f.sources.at(-1); replacement.emit("ready", { connected: true }); await f.flush(); await f.completeReads();
  for (let i = 0; i < 4; i++) { await f.advance(15_000); replacement.emit("heartbeat", { at: new Date().toISOString(), connected: true }); await f.flush(); }
  assert.equal(replacement.closed, false); assert.equal(f.requests.length, 4); f.unmount();
});

test("la navegación compartida respeta central y analista nominal sin simular permisos administrativos", async () => {
  const central = mount(); await central.ready();
  const navigation = central.all().find(node => node.type?.name === "@/app/dashboard/_components/finser-navigation");
  assert.equal(navigation.props.admin, true); assert.equal(navigation.props.adminCentral, true);
  assert.equal(navigation.props.rolUsuario, "ADMIN"); assert.equal(navigation.props.variant, "administration");
  central.unmount();
  const analyst = mount({ actor: { key: "analyst:8", name: "Analista nominal", central: false, admin: false, analyst: true } }); await analyst.ready();
  assert.equal(analyst.all().some(node => node.type?.name === "@/app/dashboard/_components/finser-navigation"), false);
  const analystNavigation = analyst.all().find(node => node.type?.name === "@/app/dashboard/aprobaciones/analyst-navigation");
  assert.equal(analystNavigation.props.userRole, "ANALISTA_APROBACION"); assert.equal(analystNavigation.props.centralAdmin, false);
  assert.ok(analyst.all().some(node => node.props.href === "/dashboard/aprobaciones/centro")); analyst.unmount();
});

test("abrir y cerrar ficha conserva el chat, el borrador y la instancia de seguimiento", async () => {
  const f = mount(); await f.ready(); await f.select(); await f.change({ text: "Borrador conservado al consultar el crédito" });
  assert.notEqual(f.all().find(node => node.type?.name === "AttentionObservedRead").key, f.composer().key, "el lector y composer hermanos necesitan claves distintas");
  const sidePanel = () => f.all().find(node => node.type?.name === "@/app/_components/finser-side-panel");
  const contact = () => f.all().find(node => node.type?.name === "CustomerPanel");
  assert.equal(sidePanel().props.open, false); assert.equal(sidePanel().props.keepMounted, true);
  const instance = contact().key;
  f.all().find(node => node.type?.name === "Button" && text(node).trim() === "Ficha").props.onClick(); await f.flush();
  assert.equal(sidePanel().props.open, true); assert.equal(contact().key, instance);
  sidePanel().props.onClose(); await f.flush();
  assert.equal(sidePanel().props.open, false); assert.equal(contact().key, instance);
  assert.equal(f.composer().props.draft.text, "Borrador conservado al consultar el crédito"); f.unmount();
});

test("colas y etiqueta conservan página y borrador durante invalidaciones SSE", async () => {
  const f = mount({ sse: true }); await f.ready(); await f.select(); await f.change({ text: "Borrador antes del filtro" });
  const filters = () => f.all().find(node => node.type?.name === "AttentionWorkFilters");
  filters().props.change("unread", "Seguimiento"); await f.flush(); await f.advance(250);
  let read = f.requests.at(-1); assert.match(read.url, /filter=unread/); assert.match(read.url, /tag=Seguimiento/); assert.match(read.url, /page=1/);
  read.respond({ ...inbox, total: 81 }); await f.flush();
  f.all().find(node => node.props["aria-label"] === "Página siguiente").props.onClick(); await f.flush(); await f.advance(250);
  read = f.requests.at(-1); assert.match(read.url, /page=2/); read.respond({ ...inbox, total: 81, page: 2 }); await f.flush();
  const stream = f.sources.at(-1); stream.emit("ready", { connected: true }); stream.emit("invalidate"); await f.advance(250);
  const refresh = f.requests.filter(request => !request.done && request.url.includes("?")).at(-1);
  assert.match(refresh.url, /filter=unread/); assert.match(refresh.url, /page=2/); assert.match(refresh.url, /tag=Seguimiento/);
  await f.completeReads(); assert.equal(f.composer().props.draft.text, "Borrador antes del filtro"); assert.equal(filters().props.filter, "unread"); assert.equal(filters().props.tag, "Seguimiento"); f.unmount();
});
