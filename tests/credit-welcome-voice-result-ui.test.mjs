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
    require(name) { assert.ok(name in dependencies, "Unexpected dependency " + name); return dependencies[name]; },
    ...globals,
  }, { filename: path });
  return compiledModule.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const call = (patch = {}) => ({ id: "event-one", creditId: 72, status: "COMPLETED", source: "NORMAL", providerCallId: "call-one",
  createdAt: "2026-10-08T15:00:00Z", dispatchedAt: "2026-10-08T15:00:00Z", completedAt: "2026-10-08T15:02:00Z",
  durationSeconds: 94, identityVerified: false, summary: "Se conversó con el cliente.", doubts: "Revisar una fecha.",
  recordingUrl: "https://app.dapta.ai/call-log/private-one", audioStorage: "DAPTA_PRIVATE_LINK", resultCode: "CUSTOMER_DISCREPANCY",
  ...patch,
});
const requestId = "f2c3a440-73de-49e3-8901-fdef75132504";
const secondRequestId = "06b6f7b1-0aa6-4078-9651-fc50a72fce7c";
const eventId = "cf372fb9-89ac-48c7-aaf4-14abc7ac6206";
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ items = [call()], loading = false, error = "", manualCall, fetch, storage = new Map(), timers = { setTimeout, clearTimeout } } = {}) {
  const states = [loading ? null : { creditId: 72, revision: 0, items, error, manualCall }, 0, null];
  const effects = []; const changes = []; const refs = []; const effectSlots = [];
  let index = 0; let refIndex = 0; let effectIndex = 0; let uuidCalls = 0;
  const hooks = { useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial;
    return [states[slot], value => { changes.push({ slot, value }); states[slot] = typeof value === "function" ? value(states[slot]) : value; }]; },
    useRef: initial => refs[refIndex++] ??= { current: initial },
    useEffect: (callback, dependencies) => {
      const slot = effectIndex++; const old = effectSlots[slot];
      if (!old || dependencies.some((value, item) => value !== old.dependencies[item])) {
        effectSlots[slot] = { callback, dependencies }; effects.push(callback);
      }
    } };
  const Icon = () => null;
  const Component = load("app/dashboard/aprobaciones/credit-welcome-voice-result.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "lucide-react": { ExternalLink: Icon, Headphones: Icon, Phone: Icon, RefreshCw: Icon },
    "@/app/_components/finser-ui": ui,
  }, { fetch, ...timers, crypto: { randomUUID: () => { uuidCalls++; return uuidCalls === 1 ? requestId : secondRequestId; } }, sessionStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  } }).default;
  const tree = (creditId = 72) => { index = 0; refIndex = 0; effectIndex = 0; return Component({ creditId }); };
  const render = (creditId = 72) => renderToStaticMarkup(tree(creditId));
  const walk = node => {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  };
  const action = label => { const button = walk(tree()).find(node => node.type === ui.Button && node.props["aria-label"] === label);
    assert.ok(button, `Missing action ${label}`); return button.props.onClick; };
  const click = label => action(label)();
  return { render, tree, click, action, effects, changes, storage, get uuidCalls() { return uuidCalls; },
    read: async () => { effectSlots[0].callback(); await flush(); }, auto: () => effectSlots[2].callback() };
}

test("voice result renders actual outcome and a private Dapta link while explaining manual audio download", () => {
  const html = fixture().render();
  assert.match(html, /Llamada finalizada/); assert.match(html, /Diferencia por revisar/);
  assert.match(html, /Sin verificación registrada/); assert.doesNotMatch(html, /Verificada en FINSER PAY/);
  assert.match(html, /1 min 34 s/); assert.match(html, /Revisar una fecha/);
  assert.match(html, /href="https:\/\/app\.dapta\.ai\/call-log\/private-one"/);
  assert.match(html, /Abrir llamada en Dapta/); assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.match(html, /El audio permanece en Dapta y se descarga manualmente allí/);
  assert.match(html, /no guarda el archivo de audio/); assert.doesNotMatch(html, /<audio|type="file"|Enviar llamada/);
});

test("voice result never renders an untrusted recording URL or interprets summaries as HTML", () => {
  for (const url of ["javascript:alert(1)", "https://public-recordings.test/file.mp3", "https://app.dapta.ai.attacker.test/call", "https://user:password@app.dapta.ai/call"]) {
    const html = fixture({ items: [call({ recordingUrl: url, summary: "<img src=x onerror=alert(1)>", doubts: "<script>bad()</script>" })] }).render();
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
  assert.doesNotMatch(permitted, /<input|Confirmar llamada/);
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
  assert.match(second.render(), /Aún no se confirma que el cliente haya contestado/);
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
  assert.match(f.render(), /Dapta aceptó la solicitud/);
  assert.doesNotMatch(f.render(), /No se había registrado la llamada/);
  assert.deepEqual(posts, [{ requestId }]); assert.equal(f.uuidCalls, 0); assert.equal(storage.size, 1);
});
