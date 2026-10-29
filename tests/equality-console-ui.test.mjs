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
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, URLSearchParams,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; }, ...globals });
  return loaded.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const response = (data, ok = true) => ({ ok, json: async () => data });
const imei = "000123456789012";
const device = (uid = imei, patch = {}) => ({
  configured: true, canManage: true, deviceUid: uid, probe: false,
  deviceState: "Active", serviceDetails: "POSTPAID", resultCode: "SUCCESS", resultMessage: "Consulta recibida",
  remoteStatusCode: 200, response: { fixture: true },
  deliveryStatus: { ready: true, label: "100% entregable", detail: "Estado confirmado por el servidor.", tone: "emerald" },
  deviceSnapshot: { deviceUid: uid, deviceManufacturer: "Samsung", deviceMarketName: "Galaxy A16",
    deviceModel: "SM-A165", lastCheckIn: "2026-10-29T12:00:00Z", createdTimeStamp: "2026-10-28T12:00:00Z",
    lastChanged: "2026-10-29T12:00:00Z", serviceDetails: "POSTPAID", stateInfo: "Active", tenantName: "FINSER PAY",
    transitionState: null, transitionQueue: [] }, ...patch,
});
const probe = () => device("probe-fixture", { probe: true, deviceSnapshot: null, deliveryStatus: null });
const defaultFetch = async (url, options = {}) => options.method === "POST"
  ? response({ ok: true, resultMessage: "Orden recibida" })
  : response(url.includes("probe=1") ? probe() : device(new URL(url, "https://test.invalid").searchParams.get("deviceUid")));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function content(node) {
  return Array.isArray(node) ? node.map(content).join("") : node == null || typeof node === "boolean" ? ""
    : typeof node === "object" ? content(node.props?.children) : String(node);
}
function walk(node) {
  return !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
}
function ConfirmDialog({ open, title, description }) {
  return open ? jsxRuntime.jsxs("section", { role: "alertdialog", children: [title, description] }) : null;
}
function harness({ fetcher = defaultFetch, canAdmin = true, search = "" } = {}) {
  const states = [], refs = [], effects = [], callbacks = [], pending = new Set(), requests = [], urls = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, callbackIndex = 0, refresh;
  const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => value !== a[i]);
  const hooks = {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useCallback(fn, deps) { const i = callbackIndex++; if (changed(callbacks[i]?.deps, deps)) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
    useEffect(fn, deps) { const i = effectIndex++, old = effects[i]; if (changed(old?.deps, deps)) {
      effects[i] = { fn, deps, cleanup: old?.cleanup }; pending.add(i);
    } },
  };
  const Component = load("app/dashboard/equality/equality-zero-touch-console.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "@/app/_components/finser-ui": ui,
    "next/link": { default: ({ href, children, ...props }) => jsxRuntime.jsx("a", { href, ...props, children }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/app/_components/finser-confirm-dialog": { default: ConfirmDialog },
    "@/lib/use-live-refresh": { useLiveRefresh: (callback, options) => { refresh = { callback, options }; } },
    "./equality-zero-touch-console.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  }, {
    window: { location: { search }, history: { replaceState: (_state, _unused, url) => urls.push(url) } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
  }).default;
  const tree = () => { stateIndex = refIndex = effectIndex = callbackIndex = 0; return Component({ canAdmin, roleName: "Administrador" }); };
  const render = () => renderToStaticMarkup(tree());
  const runEffects = () => { for (const i of pending) { const e = effects[i]; e.cleanup?.(); e.cleanup = e.fn(); } pending.clear(); };
  const settle = async () => { for (let i = 0; i < 4; i++) { tree(); runEffects(); await flush(); } return render(); };
  const input = () => walk(tree()).find(node => node.type === ui.Input).props;
  const button = label => {
    const node = walk(tree()).find(node => node.type === ui.Button && content(node) === label);
    assert.ok(node, `Missing button: ${label}`); return node.props;
  };
  const dialog = () => walk(tree()).find(node => node.type === ConfirmDialog).props;
  return { requests, urls, tree, render, settle, input, button, dialog, mount: settle,
    setUid: value => input().onChange({ target: { value } }),
    submit: () => walk(tree()).find(node => node.type === "form").props.onSubmit({ preventDefault() {} }),
    click: label => button(label).onClick(),
    confirm: () => dialog().onConfirm(), cancel: () => dialog().onCancel(),
    get refresh() { tree(); return refresh; },
    get posts() { return requests.filter(r => r.options?.method === "POST"); },
  };
}
async function consulted(options = {}) {
  const f = harness(options); await f.mount(); f.setUid(imei); f.submit(); await f.settle(); return f;
}

test("opening Equality probes with GET only and keeps device actions disabled until a query", async () => {
  const f = harness(); const html = await f.mount();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/equality?probe=1");
  assert.equal(f.posts.length, 0);
  assert.match(html, /Servicio conectado/);
  assert.match(html, /Todo empieza con una consulta/);
  assert.equal(f.button("Inscribir equipo").disabled, true);
  assert.equal(f.button("Bloquear equipo").disabled, true);
  assert.equal(f.refresh.options.enabled, false);
});

test("search preserves leading zeros and accepts text Device UID without assuming every identifier is an IMEI", async () => {
  const f = await consulted();
  assert.equal(f.input().value, imei);
  assert.match(f.requests.at(-1).url, new RegExp(`deviceUid=${imei}$`));
  assert.match(f.render(), /Samsung Galaxy A16/);
  assert.equal(f.button("Inscribir equipo").disabled, false);
  f.setUid("  UID-00 ABC  "); f.submit(); await f.settle();
  assert.equal(f.input().value, "UID-00ABC");
  assert.equal(f.requests.at(-1).url, "/api/equality?deviceUid=UID-00ABC");
  assert.equal(f.urls.at(-1), "/dashboard/equality?deviceUid=UID-00ABC");
  assert.equal(f.posts.length, 0);
});

test("a direct device link performs only its GET query and starts automatic status reads", async () => {
  const f = harness({ search: `?deviceUid=${imei}` }); await f.mount();
  assert.deepEqual(f.requests.map(r => r.url), [`/api/equality?deviceUid=${imei}`]);
  assert.equal(f.input().value, imei);
  assert.equal(f.refresh.options.enabled, true);
  assert.equal(f.refresh.options.intervalMs, 25000);
  await f.refresh.callback(); await f.settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.posts.length, 0);
});

test("opening and cancelling each action confirmation never dispatches a command", async () => {
  const f = await consulted();
  for (const label of ["Inscribir equipo", "Desbloquear equipo", "Bloquear equipo", "Liberar equipo"]) {
    f.click(label);
    assert.equal(f.dialog().open, true);
    assert.equal(f.dialog().title, label);
    assert.ok(f.dialog().description.includes(imei));
    assert.equal(f.input().disabled, true);
    assert.equal(f.refresh.options.enabled, false);
    f.cancel();
    assert.equal(f.dialog().open, false);
  }
  assert.equal(f.posts.length, 0);
});

test("confirming twice dispatches one command, freezes the device, then refreshes its confirmed result", async () => {
  const post = deferred();
  const f = await consulted({ fetcher: (url, options = {}) => options.method === "POST" ? post.promise : defaultFetch(url, options) });
  f.click("Desbloquear equipo");
  const confirm = f.dialog().onConfirm;
  confirm(); confirm();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(JSON.parse(f.posts[0].options.body), { action: "unlock", deviceUid: imei });
  assert.equal(f.dialog().busy, true);
  assert.equal(f.input().disabled, true);
  f.cancel(); assert.equal(f.dialog().open, true);
  post.resolve(response({ ok: true, resultMessage: "Orden recibida" })); await f.settle();
  assert.equal(f.dialog().open, false);
  assert.equal(f.posts.length, 1);
  assert.equal(f.requests.at(-1).url, `/api/equality?deviceUid=${imei}`);
  assert.match(f.render(), /Orden recibida/);
});

test("an edited identifier cannot use the previous device result or an earlier confirmation", async () => {
  const f = await consulted();
  f.click("Bloquear equipo");
  assert.ok(f.dialog().description.includes(imei));
  // Exercise the handler guard independently of the disabled input and modal focus trap.
  f.setUid("000999999999999");
  assert.ok(f.dialog().description.includes(imei), "confirmation target stays frozen");
  f.confirm(); await f.settle();
  assert.equal(f.posts.length, 0);
  f.cancel();
  assert.equal(f.button("Bloquear equipo").disabled, true);
  assert.equal(f.refresh.options.enabled, false);
  assert.match(f.render(), /Consulta el nuevo identificador antes de operar/);
  f.click("Bloquear equipo");
  assert.equal(f.dialog().open, false);
});

test("a pending automatic read never overwrites an edited input", async () => {
  const poll = deferred(); let readCount = 0;
  const f = await consulted({ fetcher: (url, options) => {
    if (!url.includes("probe=1") && ++readCount === 2) return poll.promise;
    return defaultFetch(url, options);
  } });
  const pending = f.refresh.callback();
  f.setUid("UID-NEW");
  poll.resolve(response(device())); await pending; await f.settle();
  assert.equal(f.input().value, "UID-NEW");
  assert.match(f.render(), /La lectura corresponde al identificador anterior/);
  assert.equal(f.button("Desbloquear equipo").disabled, true);
  assert.equal(f.posts.length, 0);
});

test("testing the connection preserves the device reading and does not dispatch commands", async () => {
  const f = await consulted(); const before = f.input().value;
  f.click("Probar conexión"); await f.settle();
  assert.equal(f.requests.at(-1).url, "/api/equality?probe=1");
  assert.equal(f.input().value, before);
  assert.match(f.render(), /Samsung Galaxy A16/);
  assert.match(f.render(), /Estado confirmado por el servidor/);
  assert.equal(f.button("Desbloquear equipo").disabled, false);
  assert.equal(f.posts.length, 0);
});

test("a failed automatic read replaces the connected indicator and disables actions while retaining input", async () => {
  let fail = false;
  const f = await consulted({ fetcher: (url, options) => fail ? response({ error: "Proveedor no disponible" }, false) : defaultFetch(url, options) });
  fail = true; await f.refresh.callback(); await f.settle();
  const html = f.render();
  assert.match(html, /Conexión sin confirmar/);
  assert.match(html, /Última lectura recibida/);
  assert.match(html, /Proveedor no disponible/);
  assert.doesNotMatch(html, /Servicio conectado/);
  assert.equal(f.input().value, imei);
  assert.equal(f.button("Liberar equipo").disabled, true);
  fail = false; f.click("Probar conexión"); await f.settle();
  assert.match(f.render(), /Servicio conectado/);
  assert.equal(f.button("Liberar equipo").disabled, false);
});

test("HTTP 200 with ok false is an operation failure and never shows successful dispatch", async () => {
  const f = await consulted({ fetcher: (url, options = {}) => options.method === "POST"
    ? response({ ok: false, resultMessage: "La operación fue rechazada por Equality" }) : defaultFetch(url, options) });
  f.click("Liberar equipo"); f.confirm(); await f.settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.dialog().open, false);
  assert.match(f.render(), /role="alert"/);
  assert.match(f.render(), /La operación fue rechazada por Equality/);
  assert.doesNotMatch(f.render(), /Accion enviada correctamente/);
  assert.equal(f.input().value, imei);
});

test("missing UI or server management permission blocks every command", async () => {
  for (const mode of ["ui", "server"]) {
    const f = await consulted({ canAdmin: mode !== "ui", fetcher: async (url, options) => {
      const r = await defaultFetch(url, options); const data = await r.json();
      return response({ ...data, canManage: mode !== "server" });
    } });
    assert.equal(f.button("Inscribir equipo").disabled, true);
    f.click("Inscribir equipo");
    assert.equal(f.dialog().open, false);
    assert.equal(f.posts.length, 0);
    assert.match(f.render(), /sin permisos para administrar este equipo/);
    if (mode === "ui") assert.doesNotMatch(f.render(), /Acciones sensibles|Desbloquear equipo/);
  }
});

test("server pending status remains pending even when the raw device says Active", async () => {
  const f = await consulted({ fetcher: (url, options) => url.includes("probe=1") ? defaultFetch(url, options)
    : response(device(imei, { deliveryStatus: { ready: false, label: "Configurando", detail: "Hay transiciones pendientes.", tone: "amber" } })) });
  const html = f.render();
  assert.match(html, /No entregues el equipo todavía/);
  assert.match(html, /Hay transiciones pendientes/);
  assert.doesNotMatch(html, /Puedes entregar el equipo/);
  assert.match(html, /Detalle técnico/);
  assert.match(html, /Tenant/);
  assert.match(html, /Cola de transiciones/);
});


test("automatic recovery clears the read error without dismissing a command rejection", async () => {
  let failRead = false;
  const f = await consulted({ fetcher: (url, options = {}) => options.method === "POST"
    ? response({ ok: false, resultMessage: "Orden rechazada" })
    : failRead ? response({ error: "Lectura interrumpida" }, false) : defaultFetch(url, options) });
  failRead = true; await f.refresh.callback(); await f.settle();
  assert.match(f.render(), /Lectura interrumpida/);
  failRead = false; await f.refresh.callback(); await f.settle();
  assert.doesNotMatch(f.render(), /Lectura interrumpida/);
  assert.match(f.render(), /Servicio conectado/);
  f.click("Liberar equipo"); f.confirm(); await f.settle();
  await f.refresh.callback(); await f.settle();
  assert.match(f.render(), /Orden rechazada/);
});
