import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(path, dependencies, globals = {}) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, URL, Date, Intl, AbortController,
    require(name) {
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_target, key) => String(key) }) };
      assert.ok(name in dependencies, "Unexpected dependency " + name); return dependencies[name];
    },
    ...globals,
  }, { filename: path });
  return compiledModule.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const voicePhone = load("lib/credit-welcome-voice-phone.ts", {});
const voicePresentation = load("lib/credit-welcome-voice-presentation.ts", {});
const call = (patch = {}) => ({ id: "event-one", creditId: 72, status: "COMPLETED", source: "NORMAL", providerCallId: "call-one",
  createdAt: "2026-10-08T15:00:00Z", dispatchedAt: "2026-10-08T15:00:00Z", completedAt: "2026-10-08T15:02:00Z",
  durationSeconds: 94, identityVerified: false, summary: "Se conversó con el cliente.", doubts: "Revisar una fecha.",
  recordingUrl: "https://app.dapta.ai/call-log/private-one", audioStorage: "DAPTA_PRIVATE_LINK", resultCode: "CUSTOMER_DISCREPANCY",
  destinationPhone: "573001234567", communicationOutcome: "HUMAN_CONTACT", disconnectionReason: null,
  ...patch,
});
const requestId = "f2c3a440-73de-49e3-8901-fdef75132504";
const secondRequestId = "06b6f7b1-0aa6-4078-9651-fc50a72fce7c";
const eventId = "cf372fb9-89ac-48c7-aaf4-14abc7ac6206";
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ items = [call()], loading = false, error = "", manualCall, fetch, storage = new Map(), timers = { setTimeout, clearTimeout }, globals = {} } = {}) {
  const states = [loading ? null : { creditId: 72, revision: 0, items, error, manualCall }, 0, null];
  const effects = []; const changes = []; const refs = []; const effectSlots = [];
  let index = 0; let refIndex = 0; let effectIndex = 0; let idIndex = 0; let uuidCalls = 0;
  const hooks = { useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial;
    return [states[slot], value => { changes.push({ slot, value }); states[slot] = typeof value === "function" ? value(states[slot]) : value; }]; },
    useRef: initial => refs[refIndex++] ??= { current: initial },
    useId: () => idIndex++ === 0 ? "welcome-voice-phone" : `welcome-voice-dialog-${idIndex}`,
    useEffect: (callback, dependencies) => {
      const slot = effectIndex++; const old = effectSlots[slot];
      if (!old || dependencies.some((value, item) => value !== old.dependencies[item])) {
        effectSlots[slot] = { callback, dependencies }; effects.push(callback);
      }
    } };
  const Icon = () => null;
  const Component = load("app/dashboard/aprobaciones/credit-welcome-voice-result.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/app/_components/finser-ui": ui,
    "@/lib/credit-welcome-voice-phone": voicePhone,
    "@/lib/credit-welcome-voice-presentation": voicePresentation,
  }, { fetch, ...timers, ...globals, crypto: { randomUUID: () => { uuidCalls++; return uuidCalls === 1 ? requestId : secondRequestId; } }, sessionStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  } }).default;
  const tree = (creditId = 72) => { index = 0; refIndex = 0; effectIndex = 0; idIndex = 0; return Component({ creditId }); };
  const render = (creditId = 72) => renderToStaticMarkup(tree(creditId));
  const walk = node => {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  };
  const content = node => typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(content).join("") : node && typeof node === "object" ? content(node.props?.children) : "";
  const action = (label, creditId = 72) => { const button = walk(tree(creditId)).find(node =>
    (node.type === ui.Button || node.type === "button") && (node.props["aria-label"] === label || content(node) === label));
    assert.ok(button, `Missing action ${label}`); return button.props.onClick; };
  const click = (label, creditId = 72) => action(label, creditId)();
  const control = (type, creditId = 72) => {
    const input = walk(tree(creditId)).find(node => (node.type === "input" || node.type === ui.Input) && node.props.type === type);
    assert.ok(input, `Missing control ${type}`); return input.props;
  };
  const other = (checked, creditId = 72) => control("checkbox", creditId).onChange({ target: { checked } });
  const phone = (value, creditId = 72) => control("tel", creditId).onChange({ target: { value } });
  return { render, tree, click, action, control, other, phone, effects, changes, storage, states, refs,
    nodes: (creditId = 72) => walk(tree(creditId)), get uuidCalls() { return uuidCalls; },
    read: async () => { effectSlots[0].callback(); await flush(); }, auto: () => effectSlots[2].callback(), modal: () => effectSlots[3].callback() };
}

test("voice panel renders only the latest compact call and reveals conversation and protected recording on demand", () => {
  const f = fixture({ items: [call({ id: "older", createdAt: "2026-10-07T15:00:00Z", destinationPhone: "573019876543", summary: "Older confidential conversation" }), call()] });
  const compact = f.render();
  assert.match(compact, /Contestada/); assert.match(compact, /573001234567/); assert.match(compact, /1 min 34 s/);
  assert.match(compact, /Ver historial \(2\)/); assert.match(compact, /Ver detalle/);
  assert.doesNotMatch(compact, /573019876543|Se conversó con el cliente|Older confidential conversation|Revisar una fecha/);
  assert.doesNotMatch(compact, /Abrir llamada en Dapta|Sin verificación registrada|<audio|type="file"|El audio permanece/);
  assert.equal(f.nodes().filter(node => node.type === "article").length, 1);
  f.click("Ver detalle del último intento");
  const html = f.render();
  assert.match(html, /Sin verificación registrada/); assert.doesNotMatch(html, /Verificada en FINSER PAY/);
  assert.match(html, /1 min 34 s/); assert.match(html, /Revisar una fecha/);
  assert.match(html, /href="https:\/\/app\.dapta\.ai\/call-log\/private-one"/);
  assert.match(html, /Abrir llamada en Dapta/); assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(html, /Older confidential conversation|<audio|type="file"|Enviar llamada/);
});

test("voice result never renders an untrusted recording URL or interprets summaries as HTML", () => {
  for (const url of ["javascript:alert(1)", "https://public-recordings.test/file.mp3", "https://app.dapta.ai.attacker.test/call", "https://user:password@app.dapta.ai/call"]) {
    const f = fixture({ items: [call({ recordingUrl: url, summary: "<img src=x onerror=alert(1)>", doubts: "<script>bad()</script>" })] });
    f.click("Ver detalle del último intento"); const html = f.render();
    assert.doesNotMatch(html, /href=|<img|<script/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
    assert.match(html, /No hay un enlace privado disponible/);
  }
});

test("loading, error, empty and wrong-credit results do not expose stale conversation content", () => {
  assert.match(fixture({ loading: true }).render(), /Consultando llamada de bienvenida/);
  assert.doesNotMatch(fixture({ loading: true }).render(), /Se conversó con el cliente/);
  assert.match(fixture({ error: "No se pudo consultar." }).render(), /role="alert"/);
  assert.doesNotMatch(fixture({ error: "No se pudo consultar." }).render(), /Se conversó con el cliente/);
  assert.match(fixture({ items: [] }).render(), /Sin llamada registrada/);
  assert.doesNotMatch(fixture({ items: [call({ creditId: 99, summary: "Other customer private summary" })] }).render(), /Other customer/);
});

test("history shows the real scoped count, newest first, ten rows per page and only the selected detail", () => {
  const attempts = Array.from({ length: 23 }, (_, index) => call({ id: `event-${index}`, providerCallId: `provider-${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 8, 15, index)).toISOString(), destinationPhone: `57300123${String(index).padStart(4, "0")}`,
    summary: `Private summary ${index}`, doubts: null }));
  const foreign = call({ id: "foreign", creditId: 99, destinationPhone: "573119999999", summary: "Foreign confidential detail" });
  const f = fixture({ items: [foreign, ...attempts] });
  const compact = f.render();
  assert.match(compact, /Ver historial \(23\)/); assert.doesNotMatch(compact, /Private summary|Foreign confidential detail|573119999999/);
  f.click("Ver historial (23)");
  let html = f.render();
  assert.match(html, /<dialog/); assert.match(html, /Fecha/); assert.match(html, /Destino/);
  assert.match(html, /Resultado/); assert.match(html, /Duración/);
  assert.doesNotMatch(html, /Private summary|Foreign confidential detail|573119999999/);
  const rows = () => f.nodes().filter(node => /^Ver detalle del intento /.test(node.props?.["aria-label"] || ""));
  assert.deepEqual(rows().map(node => node.props["aria-label"]), Array.from({ length: 10 }, (_, index) => `Ver detalle del intento event-${22 - index}`));
  f.click("Siguiente");
  assert.deepEqual(rows().map(node => node.props["aria-label"]), Array.from({ length: 10 }, (_, index) => `Ver detalle del intento event-${12 - index}`));
  f.click("Ver detalle del intento event-10"); html = f.render();
  assert.match(html, /Private summary 10/); assert.doesNotMatch(html, /Private summary (?:9|11)|Foreign confidential detail/);
  f.click("Volver al historial");
  assert.equal(rows().length, 10); assert.equal(rows()[0].props["aria-label"], "Ver detalle del intento event-12");
  f.click("Siguiente");
  assert.deepEqual(rows().map(node => node.props["aria-label"]), ["Ver detalle del intento event-2", "Ver detalle del intento event-1", "Ver detalle del intento event-0"]);
  assert.match(f.render(), /21\s*[–−-]\s*23 de 23/);
});

test("opening and paging history or consulting a detail never dispatches a call", async () => {
  const requests = [];
  const attempts = Array.from({ length: 11 }, (_, index) => call({ id: `event-${index}`, createdAt: new Date(Date.UTC(2026, 9, 8, 15, index)).toISOString() }));
  const f = fixture({ items: attempts, manualCall: { canCall: true, phone: "+573001234567" }, fetch: async (url, options) => {
    requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, items: attempts }) };
  } });
  f.click("Ver historial (11)"); f.click("Siguiente"); f.click("Ver detalle del intento event-0");
  assert.equal(requests.length, 0); assert.equal(f.uuidCalls, 0); assert.equal(f.storage.size, 0);
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  assert.equal(requests.length, 1); assert.notEqual(requests[0].options.method, "POST");
  assert.equal(requests[0].url, "/api/creditos/72/bienvenida-voz");
});

test("a selected detail and history disappear immediately when the expediente changes", () => {
  const f = fixture(); f.click("Ver historial (1)"); f.click("Ver detalle del intento event-one");
  assert.match(f.render(), /Se conversó con el cliente/);
  const nextCredit = f.render(99);
  assert.doesNotMatch(nextCredit, /Se conversó con el cliente|573001234567|private-one|Ver historial \(1\)|Sin verificación registrada/);
});

test("native history modal locks scrolling and restores the previously focused control on close", () => {
  class FakeHTMLElement { isConnected = true; focusCount = 0; focus() { this.focusCount++; } }
  const previousFocus = new FakeHTMLElement();
  const document = { activeElement: previousFocus, body: { style: { overflow: "auto" } } };
  const f = fixture({ globals: { document, HTMLElement: FakeHTMLElement } });
  f.click("Ver historial (1)"); f.render();
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  f.refs[1].current = dialog;
  const cleanup = f.modal();
  assert.equal(dialog.open, true); assert.equal(document.body.style.overflow, "hidden");
  f.click("Cerrar historial de llamadas"); f.render(); cleanup();
  assert.equal(dialog.open, false); assert.equal(document.body.style.overflow, "auto"); assert.equal(previousFocus.focusCount, 1);
  assert.doesNotMatch(f.render(), /<dialog/);
});

test("provider updates replace the visible attempt without increasing its history count", async () => {
  const initial = call({ id: eventId, status: "ACCEPTED", completedAt: null, communicationOutcome: null, durationSeconds: null, summary: null });
  const completed = call({ id: eventId, summary: "Newly confirmed conversation" });
  let responseItems = [initial];
  const f = fixture({ items: [initial], fetch: async (_url, options) => {
    assert.notEqual(options.method, "POST"); return { ok: true, json: async () => ({ ok: true, items: responseItems }) };
  } });
  assert.match(f.render(), /En curso/); assert.match(f.render(), /Ver historial \(1\)/);
  responseItems = [initial, completed, completed];
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  assert.match(f.render(), /Contestada/); assert.match(f.render(), /Ver historial \(1\)/);
  f.click("Ver detalle del último intento");
  assert.match(f.render(), /Newly confirmed conversation/);
  assert.doesNotMatch(f.render(), /Bienvenida completada|Identidad verificada|Verificada en FINSER PAY/);
});

test("compact outcomes distinguish contact evidence from an ended call or verified identity", () => {
  const cases = [
    [{ status: "PENDING", communicationOutcome: null }, "Solicitada"],
    [{ status: "ACCEPTED", communicationOutcome: null }, "En curso"],
    [{ status: "COMPLETED", communicationOutcome: "HUMAN_CONTACT" }, "Contestada"],
    [{ status: "COMPLETED", communicationOutcome: "NO_ANSWER", resultCode: "VOICEMAIL" }, "Buzón de voz"],
    [{ status: "COMPLETED", communicationOutcome: "NO_ANSWER", resultCode: "NO_ANSWER" }, "Sin respuesta"],
    [{ status: "FAILED", communicationOutcome: null, resultCode: "CALL_FAILED" }, "Fallida"],
    [{ status: "COMPLETED", communicationOutcome: "UNCERTAIN", resultCode: "CALL_COMPLETED" }, "Finalizada"],
  ];
  for (const [patch, expected] of cases) {
    const html = fixture({ items: [call(patch)] }).render();
    assert.ok(html.includes(expected), `Missing contact state ${expected}`);
    assert.doesNotMatch(html, /Bienvenida completada|Identidad verificada|Verificada en FINSER PAY/);
  }
});

test("provider details update in the already selected attempt without reopening or duplicating the modal", async () => {
  const updated = call({ summary: "Updated provider summary", durationSeconds: 125 });
  const f = fixture({ fetch: async (_url, options) => {
    assert.notEqual(options.method, "POST"); return { ok: true, json: async () => ({ ok: true, items: [updated] }) };
  } });
  f.click("Ver detalle del último intento"); assert.match(f.render(), /Se conversó con el cliente/);
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  const html = f.render();
  assert.match(html, /Updated provider summary/); assert.match(html, /2 min 5 s/);
  assert.doesNotMatch(html, /Se conversó con el cliente/);
  assert.equal(f.nodes().filter(node => node.type === "dialog").length, 1);
  assert.match(html, /Ver historial \(1\)/);
});

test("an active existing call blocks another POST and continues cancellable GET refresh without a local request", async () => {
  const scheduled = new Map(); let timerId = 0; const requests = [];
  const initial = call({ status: "ACCEPTED", completedAt: null, communicationOutcome: null, durationSeconds: null });
  const f = fixture({ items: [initial], manualCall: { canCall: true, phone: "+573001234567" }, timers: {
    setTimeout: (callback, delay) => { const id = ++timerId; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout: id => scheduled.delete(id),
  }, fetch: async (url, options) => {
    requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, items: [initial], manualCall: { canCall: true, phone: "+573001234567" } }) };
  } });
  assert.match(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.equal(requests.length, 0); assert.equal(f.uuidCalls, 0);
  f.render(); const cancel = f.auto();
  assert.equal(scheduled.size, 1); assert.equal([...scheduled.values()][0].delay, 5000);
  [...scheduled.values()][0].callback(); f.render(); await f.read(); cancel();
  assert.equal(requests.length, 1); assert.notEqual(requests[0].options.method, "POST");
  assert.equal(scheduled.size, 0);
});

test("automatic refresh waits for a slow GET to settle before scheduling the next five-second check", async () => {
  const scheduled = new Map(); let timerId = 0; let resolveRead; const requests = [];
  const initial = call({ status: "ACCEPTED", completedAt: null, communicationOutcome: null });
  const f = fixture({ items: [initial], timers: {
    setTimeout: (callback, delay) => { const id = ++timerId; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout: id => scheduled.delete(id),
  }, fetch: (url, options) => {
    requests.push({ url, options }); return new Promise(resolve => { resolveRead = resolve; });
  } });
  f.render(); const cancelFirst = f.auto();
  const [id, timer] = [...scheduled][0]; scheduled.delete(id); timer.callback();
  f.render(); assert.equal(f.auto(), undefined); await f.read();
  assert.equal(requests.length, 1); assert.equal(requests[0].options.signal.aborted, false);
  f.render(); assert.equal(f.auto(), undefined); assert.equal(scheduled.size, 0);
  resolveRead({ ok: true, json: async () => ({ ok: true, items: [initial] }) }); await flush();
  f.render(); const cancelNext = f.auto();
  assert.equal(scheduled.size, 1); assert.equal([...scheduled.values()][0].delay, 5000);
  assert.equal(requests[0].options.signal.aborted, false);
  cancelFirst(); cancelNext(); assert.equal(scheduled.size, 0);
});

test("closing/changing the credit aborts its read so a late response cannot overwrite the visible result", async () => {
  let resolveResponse; let options;
  const f = fixture({ fetch: (_url, supplied) => { options = supplied; return new Promise(resolve => { resolveResponse = resolve; }); } });
  f.render(); const close = f.effects[0]();
  assert.equal(options.cache, "no-store"); close(); assert.equal(options.signal.aborted, true);
  resolveResponse({ ok: true, json: async () => ({ ok: true, items: [call()] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.changes.length, 0);
});

test("manual call is available only when supplied by the server and explains a disabled action", () => {
  assert.doesNotMatch(fixture().render(), /Llamar ahora|Consultar estado|Celular registrado/);
  const permitted = fixture({ manualCall: { canCall: true, phone: "+573001234567" } }).render();
  assert.match(permitted, /Llamar ahora/); assert.match(permitted, /Celular registrado: \+573001234567/);
  assert.match(permitted, /Llamar a otro número/);
  assert.doesNotMatch(permitted, /type="tel"|Confirmar llamada/);
  const disabled = fixture({ manualCall: { canCall: false, phone: "+573001234567", reason: "Hay una llamada en curso." } }).render();
  assert.match(disabled, /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"/);
  assert.match(disabled, /Hay una llamada en curso/);
  assert.doesNotMatch(fixture({ manualCall: { canCall: true, phone: "+573001234567" } }).render(99), /573001234567|Llamar ahora/);
});

test("Llamar ahora issues one immediate POST despite double click; UNKNOWN refresh is GET only", async () => {
  const posts = []; const reads = []; let resolvePost;
  const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (url, options) => {
    if (options.method === "POST") {
      assert.equal(url, "/api/creditos/72/bienvenida-voz");
      posts.push(options);
      if (posts.length === 1) return new Promise(resolve => { resolvePost = resolve; });
      return { ok: true, json: async () => ({ ok: true, eventId, status: "UNKNOWN" }) };
    }
    reads.push(url);
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall: { ...manualCall, canCall: false, reason: "Intento pendiente." },
      request: { requestId, found: true, eventId, status: "UNKNOWN" } }) };
  } });
  const trigger = f.action("Llamar ahora al celular registrado"); trigger(); trigger();
  assert.equal(posts.length, 1); assert.equal(f.uuidCalls, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { requestId });
  assert.equal(posts[0].cache, "no-store"); assert.equal(posts[0].headers["Content-Type"], "application/json");
  assert.match(f.render(), /Llamar ahora/); assert.doesNotMatch(f.render(), /Consultar estado/);
  resolvePost({ ok: true, json: async () => ({ ok: true, eventId, status: "UNKNOWN", message: "internal diagnostic ignored" }) });
  await flush(); f.render(); await f.read();
  assert.match(f.render(), /por confirmar/); assert.match(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"/);
  assert.doesNotMatch(f.render(), /internal diagnostic|llamada hecha/);
  f.click("Llamar ahora al celular registrado"); await flush();
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  assert.equal(posts.length, 1); assert.equal(f.uuidCalls, 1);
  assert.equal(reads.length, 2); assert.ok(reads.every(url => url.endsWith(`?requestId=${requestId}`)));
});

test("network ambiguity survives remount and recovers its receipt through GET without a second POST", async () => {
  const storage = new Map(); const posts = [];
  const manualCall = { canCall: true, phone: "+573001234567" };
  const first = fixture({ storage, manualCall, fetch: async (_url, options) => {
    posts.push(options); throw new Error("private transport details");
  } });
  first.click("Llamar ahora al celular registrado"); await flush();
  assert.equal(first.storage.size, 1);
  const reads = [];
  const second = fixture({ storage, loading: true, fetch: async (url, options) => {
    assert.notEqual(options.method, "POST"); reads.push(url);
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
      request: { requestId, found: true, eventId, status: "ACCEPTED" } }) };
  } });
  second.render(); await second.read();
  assert.match(second.render(), /Llamar ahora/); assert.doesNotMatch(second.render(), /Consultar estado|private transport details/);
  assert.match(second.render(), /Llamada solicitada/);
  assert.doesNotMatch(second.render(99), /573001234567|Dapta aceptó/);
  second.render(); second.click("Llamar ahora al celular registrado"); await flush();
  assert.equal(posts.length, 1); assert.equal(second.uuidCalls, 0);
  assert.equal(reads[0], `/api/creditos/72/bienvenida-voz?requestId=${requestId}`);
});

test("only a matching authoritative terminal lookup releases the pending request", async () => {
  const manualCall = { canCall: true, phone: "+573001234567" }; const posts = [];
  let lookup = { requestId: secondRequestId, found: true, eventId, status: "COMPLETED" };
  const f = fixture({ manualCall, fetch: async (_url, options) => {
    if (options.method === "POST") { posts.push(options); return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) }; }
    return { ok: true, json: async () => ({ ok: true, items: [call({ id: eventId })], manualCall, request: lookup }) };
  } });
  f.click("Llamar ahora al celular registrado"); await flush(); f.render(); await f.read();
  assert.match(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"/); assert.equal(f.storage.size, 1);
  lookup = { requestId, found: true, eventId, status: "COMPLETED" };
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  assert.match(f.render(), /Llamar ahora/); assert.doesNotMatch(f.render(), /Consultar estado/);
  assert.equal(f.storage.size, 0); assert.equal(posts.length, 1);
});

test("changing the credit aborts the manual request and a late receipt cannot update the new credit", async () => {
  let options; let resolvePost;
  const f = fixture({ manualCall: { canCall: true, phone: "+573001234567" }, fetch: (_url, supplied) => {
    options = supplied; return new Promise(resolve => { resolvePost = resolve; });
  } });
  f.render(); const close = f.effects[1]();
  f.click("Llamar ahora al celular registrado"); const previousChanges = f.changes.length;
  close(); assert.equal(options.signal.aborted, true); f.render(99);
  resolvePost({ ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) }); await flush();
  assert.equal(f.changes.length, previousChanges);
  assert.doesNotMatch(f.render(99), /573001234567|Dapta aceptó|Consultar estado/);
  assert.equal(f.storage.size, 1, "The uncertain request ID is preserved for its original credit");
});

test("a firm pre-reservation rejection releases its request ID and a later click creates a fresh request", async () => {
  const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (_url, options) => {
    if (options.method !== "POST") return { ok: true, json: async () => ({ ok: true, items: [], manualCall }) };
    posts.push(JSON.parse(options.body));
    return posts.length === 1
      ? { ok: false, status: 409, json: async () => ({ ok: false, code: "OTHER_CALL_IN_FLIGHT", requestCreated: false,
        error: "Hay otra llamada en curso. Intenta nuevamente cuando finalice." }) }
      : { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
  } });
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.equal(f.storage.size, 0); f.render(); await f.read();
  assert.match(f.render(), /Hay otra llamada en curso/);
  assert.doesNotMatch(f.render(), /Consultar estado|OTHER_CALL_IN_FLIGHT/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId }, { requestId: secondRequestId }]);
  assert.equal(f.uuidCalls, 2);
});

test("an ambiguous server error without a firm rejection marker preserves the same request", async () => {
  const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (_url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      return { ok: false, status: 503, json: async () => ({ ok: false, code: "UNAVAILABLE", error: "Diagnostic not for display" }) };
    }
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall }) };
  } });
  f.click("Llamar ahora al celular registrado"); await flush();
  f.render(); await f.read();
  assert.equal(f.storage.size, 1); assert.match(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"/);
  assert.doesNotMatch(f.render(), /Diagnostic not for display/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId }]); assert.equal(f.uuidCalls, 1);
});

test("a pure GET proving no reservation re-enables direct calling while preserving the same idempotency key", async () => {
  const manualCall = { canCall: true, phone: "+573001234567" }; const posts = []; const reads = [];
  const f = fixture({ manualCall, fetch: async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      return posts.length === 1 ? { ok: false, status: 403, json: async () => ({ error: "Old proxy rejection" }) }
        : { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    }
    reads.push(url);
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall, request: { requestId, found: false } }) };
  } });
  f.click("Llamar ahora al celular registrado"); await flush(); f.render(); await f.read();
  assert.match(f.render(), /No se había registrado la llamada/);
  assert.doesNotMatch(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al celular registrado"|Consultar estado/);
  assert.equal(f.storage.size, 1); assert.equal(posts.length, 1);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId }, { requestId }]); assert.equal(f.uuidCalls, 1);
  assert.deepEqual(reads, [`/api/creditos/72/bienvenida-voz?requestId=${requestId}`]);
});

test("pending auto refresh uses a cancellable five-second GET and never dispatches", async () => {
  const scheduled = new Map(); let timerId = 0; const reads = []; const posts = [];
  const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, timers: {
    setTimeout: (callback, delay) => { const id = ++timerId; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout: id => scheduled.delete(id),
  }, fetch: async (url, options) => {
    if (options.method === "POST") { posts.push(options); return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) }; }
    reads.push(url); return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
      request: { requestId, found: true, eventId, status: "ACCEPTED" } }) };
  } });
  f.click("Llamar ahora al celular registrado"); await flush(); f.render(); await f.read(); f.render();
  const cancel = f.auto(); assert.equal(scheduled.size, 1);
  const timer = [...scheduled.values()][0]; assert.equal(timer.delay, 5000);
  timer.callback(); f.render(); await f.read(); cancel();
  assert.equal(scheduled.size, 0); assert.equal(posts.length, 1); assert.equal(reads.length, 2);
  assert.ok(reads.every(url => url.endsWith(`?requestId=${requestId}`)));
});

test("a late missing-reservation GET cannot overwrite a newer accepted POST using the same key", async () => {
  const storage = new Map([["finserpay:welcome-voice:request:72", requestId]]);
  const manualCall = { canCall: true, phone: "+573001234567" };
  let reads = 0; let resolveOldRead; const posts = [];
  const f = fixture({ storage, manualCall, fetch: async (_url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    }
    reads++;
    if (reads === 2) return new Promise(resolve => { resolveOldRead = resolve; });
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall, request: { requestId, found: false } }) };
  } });
  f.render(); await f.read();
  const directCall = f.action("Llamar ahora al celular registrado");
  f.click("Actualizar resultado de la bienvenida por voz"); f.render(); await f.read();
  directCall(); await flush();
  resolveOldRead({ ok: true, json: async () => ({ ok: true, items: [], manualCall, request: { requestId, found: false } }) });
  await flush();
  assert.match(f.render(), /Llamada solicitada/);
  assert.doesNotMatch(f.render(), /No se había registrado la llamada/);
  assert.deepEqual(posts, [{ requestId }]); assert.equal(f.uuidCalls, 0); assert.equal(storage.size, 1);
});

test("an alternate Colombian mobile sends only a normalized call destination and leaves the registered phone visible", async () => {
  for (const value of ["301 234 5678", "573012345678", "+57 (301) 234-5678"]) {
    const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
    const f = fixture({ manualCall, fetch: async (_url, options) => {
      if (options.method !== "POST") return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
        request: { requestId, found: true, eventId, status: "ACCEPTED" } }) };
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    } });
    f.other(true);
    assert.match(f.render(), /Número para esta llamada/);
    assert.match(f.render(), /for="welcome-voice-phone"/);
    assert.match(f.render(), /Se usará únicamente para esta llamada. No cambia el celular registrado del cliente/);
    f.phone(value);
    assert.doesNotMatch(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al número indicado"/);
    f.click("Llamar ahora al número indicado"); await flush();
    assert.deepEqual(posts, [{ requestId, phone: "573012345678" }]);
    f.render(); await f.read();
    assert.match(f.render(), /Celular registrado: \+573001234567/);
    assert.deepEqual(JSON.parse([...f.storage.values()][0]), { requestId, phone: "573012345678" });
  }
});

test("invalid alternate destinations cannot create a request even through the click handler", async () => {
  for (const value of ["", "301234567", "30123456789", "+1 3012345678", "+3012345678", "6012345678", "3012345678 ext 5", "tel3012345678", "3012345678x", "３０１２３４５６７８", "++573012345678"]) {
    const posts = [];
    const f = fixture({ manualCall: { canCall: true, phone: "+573001234567" }, fetch: async (_url, options) => { posts.push(options); } });
    f.other(true); f.phone(value);
    assert.match(f.render(), /disabled=""[^>]*aria-label="Llamar ahora al número indicado"/);
    if (value) assert.match(f.render(), /celular colombiano válido/);
    f.click("Llamar ahora al número indicado"); await flush();
    assert.equal(posts.length, 0); assert.equal(f.uuidCalls, 0); assert.equal(f.storage.size, 0);
  }
});

test("turning off an unsubmitted alternate number uses the registered phone without sending a phone override", async () => {
  const posts = [];
  const f = fixture({ manualCall: { canCall: true, phone: "+573001234567" }, fetch: async (_url, options) => {
    posts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
  } });
  f.other(true); f.phone("3012345678"); f.other(false);
  assert.doesNotMatch(f.render(), /type="tel"/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId }]);
  assert.deepEqual(JSON.parse([...f.storage.values()][0]), { requestId });
});

test("a firm rejection removes both the alternate destination and its key before a fresh registered-phone request", async () => {
  const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (_url, options) => {
    if (options.method !== "POST") return { ok: true, json: async () => ({ ok: true, items: [], manualCall }) };
    posts.push(JSON.parse(options.body));
    return posts.length === 1 ? { ok: false, status: 409, json: async () => ({ ok: false, requestCreated: false, error: "No se creó la llamada." }) }
      : { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
  } });
  f.other(true); f.phone("3012345678"); f.click("Llamar ahora al número indicado"); await flush();
  assert.equal(f.storage.size, 0); f.render(); await f.read();
  assert.equal(f.control("checkbox").checked, false); assert.doesNotMatch(f.render(), /type="tel"/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId, phone: "573012345678" }, { requestId: secondRequestId }]);
});

test("alternate selections and their saved requests remain scoped to the original credit", async () => {
  const posts = [];
  const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (url, options) => {
    if (options.method === "POST") {
      posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    }
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall: { canCall: true, phone: "+573101234567" } }) };
  } });
  f.other(true); f.phone("3012345678"); f.click("Llamar ahora al número indicado"); await flush();
  f.render(99); await f.read();
  assert.equal(f.control("checkbox", 99).checked, false);
  assert.doesNotMatch(f.render(99), /3012345678|3001234567|type="tel"/);
  f.click("Llamar ahora al celular registrado", 99); await flush();
  assert.deepEqual(posts, [
    { url: "/api/creditos/72/bienvenida-voz", body: { requestId, phone: "573012345678" } },
    { url: "/api/creditos/99/bienvenida-voz", body: { requestId: secondRequestId } },
  ]);
  assert.equal(f.storage.size, 2);
});

test("pending call guards freeze the destination even against handlers captured before the POST", async () => {
  let resolvePost; const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
  const f = fixture({ manualCall, fetch: async (_url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body)); return new Promise(resolve => { resolvePost = resolve; });
    }
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
      request: { requestId, found: true, eventId, status: "UNKNOWN" } }) };
  } });
  f.other(true); f.phone("3012345678");
  const oldPhone = f.control("tel").onChange; const oldSelector = f.control("checkbox").onChange;
  const send = f.action("Llamar ahora al número indicado"); send(); send();
  oldPhone({ target: { value: "3022345678" } }); oldSelector({ target: { checked: false } });
  assert.equal(f.control("tel").value, "3012345678");
  assert.equal(f.control("tel").disabled, true); assert.equal(f.control("checkbox").disabled, true);
  resolvePost({ ok: true, json: async () => ({ ok: true, eventId, status: "UNKNOWN" }) });
  await flush(); f.render(); await f.read();
  assert.equal(f.control("tel").disabled, true); assert.equal(f.control("checkbox").disabled, true);
  assert.deepEqual(posts, [{ requestId, phone: "573012345678" }]); assert.equal(f.uuidCalls, 1);
});

test("a lost alternate request survives remount and found:false replays the exact destination with the same key", async () => {
  const storage = new Map(); const posts = []; const manualCall = { canCall: true, phone: "+573001234567" };
  const first = fixture({ storage, manualCall, fetch: async (_url, options) => {
    posts.push(JSON.parse(options.body)); throw new Error("lost response");
  } });
  first.other(true); first.phone("+57 (301) 234-5678"); first.click("Llamar ahora al número indicado"); await flush();
  assert.deepEqual(JSON.parse([...storage.values()][0]), { requestId, phone: "573012345678" });
  const reads = [];
  const second = fixture({ storage, loading: true, fetch: async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    }
    reads.push(url); return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
      request: { requestId, found: false } }) };
  } });
  second.render(); await second.read();
  assert.equal(second.control("tel").value, "573012345678");
  assert.equal(second.control("checkbox").checked, true);
  assert.equal(second.control("checkbox").disabled, true); assert.equal(second.control("tel").disabled, true);
  assert.doesNotMatch(second.render(), /disabled=""[^>]*aria-label="Llamar ahora al número indicado"/);
  second.phone("3022345678"); second.other(false);
  assert.equal(second.control("tel").value, "573012345678");
  second.click("Llamar ahora al número indicado"); await flush();
  assert.deepEqual(posts, [{ requestId, phone: "573012345678" }, { requestId, phone: "573012345678" }]);
  assert.equal(second.uuidCalls, 0); assert.deepEqual(reads, [`/api/creditos/72/bienvenida-voz?requestId=${requestId}`]);
});

test("a legacy UUID preserves the registered destination until its authoritative terminal result releases selection", async () => {
  const storage = new Map([["finserpay:welcome-voice:request:72", requestId]]); const posts = [];
  const manualCall = { canCall: true, phone: "+573001234567" }; let status;
  const f = fixture({ storage, loading: true, fetch: async (_url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, eventId, status: "ACCEPTED" }) };
    }
    return { ok: true, json: async () => ({ ok: true, items: [], manualCall,
      request: status ? { requestId, found: true, eventId, status } : { requestId, found: false } }) };
  } });
  f.render(); await f.read();
  assert.equal(f.control("checkbox").disabled, true); f.other(true);
  assert.equal(f.control("checkbox").checked, false); assert.doesNotMatch(f.render(), /type="tel"/);
  f.click("Llamar ahora al celular registrado"); await flush();
  assert.deepEqual(posts, [{ requestId }]); assert.equal(f.uuidCalls, 0);
  status = "COMPLETED"; f.render(); await f.read();
  assert.equal(f.storage.size, 0); assert.equal(f.control("checkbox").disabled, false);
  f.other(true); f.phone("3012345678");
  assert.equal(f.control("tel").value, "3012345678");
});
