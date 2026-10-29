import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, AbortController, Intl,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; }, ...globals });
  return loaded.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const requestId = "00000000-0000-4000-8000-000000000001";
const batch = (patch = {}) => ({ id: "00000000-0000-4000-8000-000000000002", status: "COMPLETED",
  total: 3, pending: 0, accepted: 1, failed: 1, unknown: 1, skipped: 0, dateKey: "2026-10-18", ...patch });
const result = (value = null, configured = true) => ({ ok: true, configured, batch: value });
const response = (value, ok = true) => ({ ok, json: async () => value });
const flush = () => new Promise(resolve => setImmediate(resolve));
const content = node => Array.isArray(node) ? node.map(content).join("") : node == null || typeof node === "boolean" ? ""
  : typeof node === "object" ? content(node.props?.children) : String(node);
function walk(node) {
  if (!node || typeof node !== "object") return [];
  return Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
}
function fixture(fetcher = async () => response(result()), { campaign = "cuotavencida", uuid = requestId } = {}) {
  const states = [], refs = [], effects = [], pendingEffects = new Set(), timers = new Map(), requests = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, timerId = 0, uuidCalls = 0;
  const hooks = {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useId: () => `${campaign}-scope`,
    useEffect(callback, dependencies) {
      const i = effectIndex++, old = effects[i];
      if (!old || dependencies.some((value, index) => value !== old.dependencies[index])) {
        effects[i] = { callback, dependencies, cleanup: old?.cleanup }; pendingEffects.add(i);
      }
    },
  };
  const Component = load("app/dashboard/cartera/cuotavencida-whatsapp-button.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "@/app/_components/finser-ui": ui,
    "lucide-react": { LoaderCircle: () => null, Send: () => null },
    "./cuotavencida-whatsapp-button.module.css": { default: new Proxy({}, { get: (_, name) => String(name) }) },
  }, {
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
    crypto: { randomUUID: () => { uuidCalls++; return uuid; } },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  }).default;
  const tree = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    const instance = Component({ campaign });
    return instance.type(instance.props);
  };
  const render = () => renderToStaticMarkup(tree());
  const runEffects = () => { for (const i of pendingEffects) { const effect = effects[i]; effect.cleanup?.(); effect.cleanup = effect.callback(); } pendingEffects.clear(); };
  const settle = async () => { for (let i = 0; i < 3; i++) { tree(); runEffects(); await flush(); } return render(); };
  const button = label => {
    const item = walk(tree()).find(node => node.type === ui.Button && (node.props["aria-label"] === label || content(node) === label));
    assert.ok(item, `Missing button ${label}`); return item.props;
  };
  return { states, requests, timers, render, settle, button,
    mount: settle,
    click: (label = campaign === "bloqueo" ? "Enviar BLOQUEO por WhatsApp" : "Enviar Cuotavencida por WhatsApp") => button(label).onClick(),
    poll: async () => { const timer = [...timers].find(([, value]) => value.delay === 3_000); assert.ok(timer, "Expected GET polling timer");
      timers.delete(timer[0]); timer[1].callback(); return settle(); },
    unmount: () => { for (const effect of effects) effect.cleanup?.(); },
    get uuidCalls() { return uuidCalls; },
  };
}

test("opening the action only reads state; its global scope does not inherit Cartera filters", async () => {
  const f = fixture();
  const initial = f.render();
  assert.equal(f.requests.length, 0);
  assert.match(initial, /disabled/);
  const html = await f.mount();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, "GET");
  assert.equal(f.requests[0].url, "/api/dashboard/cartera/cuotavencida");
  assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, false);
  assert.match(html, /Clientes con 1 día de mora o más · todos los aliados y productos/);
  assert.equal(f.uuidCalls, 0);
});

test("BLOQUEO reads and sends only its own endpoint with the unprotected global scope", async () => {
  let current = null;
  const f = fixture(async (_url, options) => {
    if (options.method === "POST") current = batch();
    return response(result(current));
  }, { campaign: "bloqueo" });
  assert.equal(f.requests.length, 0);
  const html = await f.mount();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, "GET");
  assert.match(html, /Enviar BLOQUEO por WhatsApp/);
  assert.match(html, /Clientes en mora sin prórroga activa · todos los aliados y productos/);
  assert.match(html, /Excluye créditos con prórroga o excepción vigente/);
  assert.doesNotMatch(html, /Enviar Cuotavencida/);
  f.click(); await f.settle();
  assert.ok(f.requests.every(item => item.url === "/api/dashboard/cartera/bloqueo"));
  const posts = f.requests.filter(item => item.options.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), { requestId });
  assert.equal(f.uuidCalls, 1);
  f.unmount();
});

test("campaign instances keep running state and ambiguous request ids independent", async () => {
  let finishCuotavencida;
  const cuota = fixture(async (_url, options) => options.method === "POST"
    ? new Promise(resolve => { finishCuotavencida = resolve; }) : response(result()));
  const bloqueoId = "00000000-0000-4000-8000-000000000003";
  let bloqueoAttempts = 0;
  const bloqueo = fixture(async (_url, options) => {
    if (options.method === "POST" && ++bloqueoAttempts === 1) throw new Error("Synthetic lost response");
    return response(result(options.method === "POST" ? batch() : null));
  }, { campaign: "bloqueo", uuid: bloqueoId });
  await cuota.mount(); await bloqueo.mount();
  cuota.click();
  assert.equal(cuota.button("Enviar Cuotavencida por WhatsApp").disabled, true);
  assert.equal(bloqueo.button("Enviar BLOQUEO por WhatsApp").disabled, false);
  bloqueo.click();
  assert.match(await bloqueo.settle(), /No se pudo confirmar la solicitud/);
  assert.equal(cuota.requests.filter(item => item.options.method === "POST").length, 1);
  bloqueo.click(); await bloqueo.settle();
  const bloqueoPosts = bloqueo.requests.filter(item => item.options.method === "POST");
  assert.equal(bloqueoPosts.length, 2);
  assert.deepEqual(bloqueoPosts.map(item => JSON.parse(item.options.body)), [{ requestId: bloqueoId }, { requestId: bloqueoId }]);
  assert.equal(bloqueo.uuidCalls, 1);
  assert.equal(cuota.uuidCalls, 1);
  assert.ok(cuota.requests.every(item => item.url === "/api/dashboard/cartera/cuotavencida"));
  assert.ok(bloqueo.requests.every(item => item.url === "/api/dashboard/cartera/bloqueo"));
  assert.equal(cuota.button("Enviar Cuotavencida por WhatsApp").disabled, true);
  finishCuotavencida(response(result(batch())));
  await cuota.settle();
  assert.deepEqual(JSON.parse(cuota.requests.find(item => item.options.method === "POST").options.body), { requestId });
  cuota.unmount(); bloqueo.unmount();
});

test("BLOQUEO configuration and empty result do not change the existing action", async () => {
  const disabled = fixture(async () => response(result(null, false)), { campaign: "bloqueo" });
  const cuota = fixture();
  await disabled.mount(); await cuota.mount();
  disabled.click();
  assert.equal(disabled.button("Enviar BLOQUEO por WhatsApp").disabled, true);
  assert.ok(disabled.requests.every(item => item.options.method === "GET"));
  assert.equal(cuota.button("Enviar Cuotavencida por WhatsApp").disabled, false);
  const empty = fixture(async () => response(result(batch({ total: 0, accepted: 0, failed: 0, unknown: 0 }))), { campaign: "bloqueo" });
  const html = await empty.mount();
  assert.match(html, /No hay clientes en mora elegibles sin prórroga activa/);
  assert.doesNotMatch(html, /Aceptados por WhatsApp|entregad/i);
  disabled.unmount(); cuota.unmount(); empty.unmount();
});

test("one click immediately posts once; a second click cannot duplicate an in-flight request", async () => {
  let finish;
  let current = null;
  const f = fixture(async (_url, options) => options.method === "POST"
    ? new Promise(resolve => { finish = value => { current = value; resolve(response(result(value))); }; })
    : response(result(current)));
  await f.mount();
  const click = f.button("Enviar Cuotavencida por WhatsApp").onClick;
  click(); click();
  assert.equal(f.requests.filter(item => item.options.method === "POST").length, 1);
  assert.equal(f.uuidCalls, 1);
  const sent = f.requests.find(item => item.options.method === "POST");
  assert.deepEqual(JSON.parse(sent.options.body), { requestId });
  assert.equal(sent.options.headers["Content-Type"], "application/json");
  assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, true);
  finish(batch({ status: "RUNNING", pending: 2, accepted: 1, failed: 0, unknown: 0 }));
  await f.settle();
  assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, true);
  current = batch();
  const html = await f.poll();
  assert.equal(f.requests.filter(item => item.options.method === "POST").length, 1);
  assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, false);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 3_000), false);
  assert.match(html, /Aceptados por WhatsApp: 1/);
  assert.match(html, /Fallidos: 1/); assert.match(html, /Sin confirmar: 1/);
  assert.doesNotMatch(html, /entregad|window\.confirm|dialog/i);
});

test("an already running batch resumes GET polling without a new request id or POST", async () => {
  let current = batch({ status: "QUEUED", accepted: 0, failed: 0, unknown: 0, pending: 3 });
  const f = fixture(async () => response(result(current)));
  await f.mount();
  f.click();
  assert.equal(f.requests.length, 1);
  current = batch();
  await f.poll();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(item => item.options.method === "GET"));
  assert.equal(f.uuidCalls, 0);
});

test("an ambiguous POST reconciles by GET and the next user click reuses its id", async () => {
  let attempts = 0;
  const f = fixture(async (_url, options) => {
    if (options.method === "POST" && ++attempts === 1) throw new Error("Sensitive provider detail");
    return response(result(options.method === "POST" ? batch() : null));
  });
  await f.mount(); f.click();
  let html = await f.settle();
  assert.match(html, /No se pudo confirmar la solicitud/);
  assert.doesNotMatch(html, /Sensitive provider detail/);
  assert.equal(f.requests.filter(item => item.options.method === "POST").length, 1);
  assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, false);
  f.click(); html = await f.settle();
  const posts = f.requests.filter(item => item.options.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(item => JSON.parse(item.options.body)), [{ requestId }, { requestId }]);
  assert.equal(f.uuidCalls, 1);
  assert.doesNotMatch(html, /No se pudo confirmar la solicitud/);
});

test("disabled configuration and invalid server data cannot enable a bulk send", async () => {
  for (const value of [result(null, false), { ok: true, configured: true, batch: batch({ status: "unexpected" }) },
    { ok: true, configured: true, batch: batch({ status: ["RUNNING"] }) },
    { ok: true, configured: true, batch: batch({ accepted: "private-data" }) }]) {
    const f = fixture(async () => response(value));
    const html = await f.mount(); f.click();
    assert.equal(f.button("Enviar Cuotavencida por WhatsApp").disabled, true);
    assert.ok(f.requests.every(item => item.options.method === "GET"));
    assert.doesNotMatch(html, /private-data|unexpected/);
    f.unmount();
  }
});

test("an empty completed batch is stated without inventing accepted or delivered messages", async () => {
  const f = fixture(async () => response(result(batch({ total: 0, accepted: 0, failed: 0, unknown: 0 }))));
  const html = await f.mount();
  assert.match(html, /No hay clientes elegibles con mora de un día o más/);
  assert.doesNotMatch(html, /Aceptados por WhatsApp|entregad/i);
});

test("reports only confirmed protection counts without inventing them for historical batches", async () => {
  const protectedBatch = fixture(async () => response(result(batch({ stats: { excludedActiveMoraProtection: 12 } }))));
  assert.match(await protectedBatch.mount(), /Excluidos por prórroga o excepción al crear el lote: 12 créditos/);
  for (const stats of [undefined, { excludedActiveMoraProtection: -1 }, { excludedActiveMoraProtection: "12" }]) {
    const historical = fixture(async () => response(result(batch({ stats }))));
    assert.doesNotMatch(await historical.mount(), /Excluidos por prórroga o excepción al crear el lote:/);
    assert.ok(historical.requests.every(item => item.options.method === "GET"));
  }
});

test("unmount aborts an initial GET and ignores its late response", async () => {
  let finish;
  const f = fixture(async () => new Promise(resolve => { finish = resolve; }));
  await f.mount();
  const signal = f.requests[0].options.signal;
  f.unmount(); assert.equal(signal.aborted, true);
  finish(response(result(batch()))); await flush();
  assert.equal(f.states[0], null);
  assert.equal(f.timers.size, 0);
});

test("unmount clears polling and aborts an in-flight POST without an automatic resubmission", async () => {
  const running = fixture(async () => response(result(batch({ status: "RUNNING", pending: 3 }))));
  await running.mount(); assert.ok(running.timers.size > 0);
  running.unmount(); assert.equal(running.timers.size, 0);
  let finish;
  const f = fixture(async (_url, options) => options.method === "POST"
    ? new Promise(resolve => { finish = resolve; }) : response(result()));
  await f.mount(); f.click();
  const post = f.requests.find(item => item.options.method === "POST");
  f.unmount(); assert.equal(post.options.signal.aborted, true);
  finish(response(result(batch()))); await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 0);
});

test("completed batch details start folded while unresolved counts remain visible in its summary", async () => {
  const f = fixture(async () => response(result(batch())));
  const html = await f.mount();
  assert.match(html, /<h3[^>]*>Cuota vencida<\/h3>/);
  assert.match(html, /<details class="history"><summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[ =>])/);
  assert.match(html, /2 por revisar<\/span><\/summary>/);
  assert.match(html, /<div class="batchDetails">[\s\S]*Aceptados por WhatsApp: 1/);
  assert.ok(f.requests.every(item => item.options.method === "GET"));
  f.unmount();
});

test("an active batch keeps progress visible without a completed-batch disclosure", async () => {
  const f = fixture(async () => response(result(batch({ status: "RUNNING", pending: 2 }))));
  const html = await f.mount();
  assert.match(html, /Lote en proceso/);
  assert.match(html, /Pendientes: 2/);
  assert.doesNotMatch(html, /<details/);
  assert.ok(f.requests.every(item => item.options.method === "GET"));
  f.unmount();
});
