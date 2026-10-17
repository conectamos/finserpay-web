import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/_components/pwa-register.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ controlled = true, supported = true, protocol = "https:", deferred = false, pathname = "/clientes", safe = true } = {}) {
  const listeners = { window: new Map(), document: new Map(), worker: new Map() };
  const effects = [];
  const timers = new Map();
  const registrations = [];
  let updates = 0;
  let reloads = 0;
  let resolveRegistration;
  const registration = { update: async () => { updates += 1; } };
  const pendingRegistration = new Promise((resolve) => { resolveRegistration = resolve; });
  const events = (target) => ({
    addEventListener(name, callback) {
      const handlers = listeners[target].get(name) || new Set();
      handlers.add(callback);
      listeners[target].set(name, handlers);
    },
    removeEventListener(name, callback) { listeners[target].get(name)?.delete(callback); },
  });
  const worker = {
    ...events("worker"), controller: controlled ? {} : null,
    register: async (url, options) => {
      registrations.push({ url, updateViaCache: options.updateViaCache });
      return deferred ? pendingRegistration : registration;
    },
  };
  const document = {
    ...events("document"), readyState: "complete", visibilityState: "visible", updateSafe: safe,
    querySelector(selector) {
      assert.equal(selector, '#cliente-dashboard[data-client-update-safe="true"]');
      return this.updateSafe ? {} : null;
    },
  };
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require(name) {
      assert.equal(name, "react");
      return { useEffect: (effect) => effects.push(effect) };
    },
    console,
    navigator: supported ? { serviceWorker: worker } : {}, document,
    window: {
      ...events("window"),
      location: { protocol, hostname: "finserpay.test", pathname, reload: () => { reloads += 1; } },
      setInterval(callback, ms) { timers.set(1, { callback, ms }); return 1; },
      clearInterval(id) { timers.delete(id); },
    },
  });
  testModule.exports.default();
  const cleanup = effects[0]();
  return {
    document, worker, registrations, timers,
    get updates() { return updates; },
    get reloads() { return reloads; },
    dispatch(target, event) { for (const handler of listeners[target].get(event) || []) handler(); },
    finishRegistration() { resolveRegistration(registration); },
    cleanup: () => cleanup?.(),
    listenerCount: () => Object.values(listeners).reduce((total, target) =>
      total + [...target.values()].reduce((count, handlers) => count + handlers.size, 0), 0),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("busca actualizaciones sin cache y recarga una sola vez al cambiar un controlador existente", async () => {
  const app = harness();
  await settle();
  assert.deepEqual(app.registrations, [{ url: "/sw.js", updateViaCache: "none" }]);
  assert.equal(app.updates, 1);
  assert.equal(app.timers.get(1).ms, 30 * 60 * 1000);
  app.dispatch("window", "focus");
  app.document.visibilityState = "hidden";
  app.dispatch("document", "visibilitychange");
  assert.equal(app.updates, 2);
  app.document.visibilityState = "visible";
  app.dispatch("document", "visibilitychange");
  app.timers.get(1).callback();
  assert.equal(app.updates, 4);
  assert.equal(app.reloads, 0, "Comprobar un worker idéntico no recarga la página");
  app.worker.controller = null;
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 0);
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 1);
});

test("la primera instalación no recarga; una actualización posterior en esa misma sesión sí", async () => {
  const app = harness({ controlled: false });
  await settle();
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 0);
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 1);
});

test("la actualización pendiente espera hasta que el inicio del cliente permita recargar", async () => {
  const app = harness({ safe: false });
  await settle();
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  app.dispatch("window", "focus");
  app.dispatch("document", "visibilitychange");
  app.timers.get(1).callback();
  assert.equal(app.reloads, 0, "Un panel, una confirmación o un pago activo no se interrumpen");
  app.document.updateSafe = true;
  app.dispatch("window", "finserpay:client-update-safe");
  app.dispatch("window", "focus");
  assert.equal(app.reloads, 1);
});

test("admin y login nunca se recargan automáticamente al actualizar el worker", async () => {
  for (const options of [
    { pathname: "/dashboard/creditos", safe: true },
    { pathname: "/clientes", safe: false },
    { pathname: "/clientes-extra", safe: true },
  ]) {
    const app = harness(options);
    await settle();
    app.worker.controller = {};
    app.dispatch("worker", "controllerchange");
    app.dispatch("window", "finserpay:client-update-safe");
    app.dispatch("window", "focus");
    assert.equal(app.reloads, 0);
  }
});

test("un inicio seguro oculto espera a recuperar visibilidad antes de recargar", async () => {
  const app = harness();
  await settle();
  app.document.visibilityState = "hidden";
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 0);
  app.document.visibilityState = "visible";
  app.dispatch("document", "visibilitychange");
  assert.equal(app.reloads, 1);
});

test("restaurar una página con pageshow retoma una actualización pendiente ya segura", async () => {
  const app = harness({ safe: false });
  await settle();
  app.worker.controller = {};
  app.dispatch("worker", "controllerchange");
  assert.equal(app.reloads, 0);
  app.document.updateSafe = true;
  app.dispatch("window", "pageshow");
  assert.equal(app.reloads, 1);
});

test("desmontar cancela listeners y temporizador, incluso con registro todavía pendiente", async () => {
  for (const deferred of [false, true]) {
    const app = harness({ deferred });
    await settle();
    app.cleanup();
    app.finishRegistration();
    await settle();
    assert.equal(app.listenerCount(), 0);
    assert.equal(app.timers.size, 0);
    app.dispatch("worker", "controllerchange");
    assert.equal(app.reloads, 0);
    if (deferred) assert.equal(app.updates, 0);
  }
});

test("sin service worker o sin contexto seguro no registra ni programa actualizaciones", async () => {
  for (const options of [{ supported: false }, { protocol: "http:" }]) {
    const app = harness(options);
    await settle();
    assert.equal(app.registrations.length, 0);
    assert.equal(app.listenerCount(), 0);
    assert.equal(app.timers.size, 0);
  }
});
