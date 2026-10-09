import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const root = "../";
const source = readFileSync(new URL(`${root}app/dashboard/_components/welcome-pending-alerts.tsx`, import.meta.url), "utf8");
const stateSource = readFileSync(new URL(`${root}lib/approval-welcome-alerts.ts`, import.meta.url), "utf8");
const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Badge", "Button", "Card"].map((name) => [name, placeholder(name)]));
const icons = Object.fromEntries(["Bell", "GripHorizontal", "Volume2", "VolumeX", "X"].map((name) => [name, placeholder(name)]));
const summary = (count = 2, fingerprint = "a".repeat(32)) => ({
  ok: true, pendingCount: count, attentionCount: count, fingerprint,
  href: "/dashboard/aprobaciones", checkedAt: "2026-10-08T14:00:00Z",
});
const receiptKey = (actor = "user-1") => `finser:welcome-alerts:${actor}:receipt`;
const preferenceKey = (actor = "user-1") => `finser:welcome-alerts:${actor}:sound`;
const positionKey = (actor = "user-1") => `finser:welcome-alerts:${actor}:position`;
function evaluate(code, dependencies = {}, globals = {}) {
  const { outputText } = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const loaded = { exports: {} };
  runInNewContext(outputText, { module: loaded, exports: loaded.exports, ...globals,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
  });
  return loaded.exports;
}
const rules = evaluate(stateSource);
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function sharedBrowser() {
  const storage = new Map();
  let lockQueue = Promise.resolve();
  const lockNames = [];
  return {
    storage, lockNames,
    locks: { request(name, options, callback) {
      lockNames.push(name);
      const attempt = lockQueue.then(() => callback({ name, mode: options.mode }));
      lockQueue = attempt.catch(() => undefined);
      return attempt;
    } },
  };
}

// Run the real component and reducer rules. Control browser transports and React
// lifecycle so slow requests, background tabs and blocked audio are repeatable.
function mount({ shared = sharedBrowser(), actorKey = "user-1", href, visible = true,
  bodies = [summary()], audio = "ready", storageBlocked = false, viewportWidth = 1024, scrollbarWidth = 0 } = {}) {
  let now = 1_000_000, nextTimer = 0, hookIndex = 0, dirty = true, effects = [], tree, renderedRef, measuredWidth;
  const slots = [], timers = new Map(), requests = [], contexts = [], observers = new Set();
  const capturedPointers = new Set();
  const pointerTarget = {
    setPointerCapture: (id) => capturedPointers.add(id),
    releasePointerCapture: (id) => capturedPointers.delete(id),
    hasPointerCapture: (id) => capturedPointers.has(id),
  };
  const listeners = { window: new Map(), document: new Map() };
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const add = (target, name, listener) => {
    if (!listeners[target].has(name)) listeners[target].set(name, new Set());
    listeners[target].get(name).add(listener);
  };
  const remove = (target, name, listener) => listeners[target].get(name)?.delete(listener);
  const hooks = {
    useId() { hookIndex++; return "welcome-test-panel"; },
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial,
        set(value) { const next = typeof value === "function" ? value(slots[index].value) : value;
          if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; } } };
      return [slots[index].value, slots[index].set];
    },
    useRef(value) { const index = hookIndex++; slots[index] ||= { current: value }; return slots[index]; },
    useCallback(fn, deps) {
      const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, effect, cleanup: effect() };
      });
    },
  };
  const document = {
    documentElement: { get clientWidth() { return window.innerWidth - scrollbarWidth; } },
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (name, fn) => add("document", name, fn),
    removeEventListener: (name, fn) => remove("document", name, fn),
  };
  class FakeAudioContext {
    state = "suspended"; currentTime = 10; destination = {}; onstatechange = null;
    oscillators = []; closeCalls = 0; resumeCalls = 0;
    constructor() { contexts.push(this); if (audio === "constructor-blocked") throw new Error("No audio access"); }
    resume() {
      this.resumeCalls++;
      if (audio === "blocked") return Promise.reject(new Error("Gesture denied"));
      this.state = "running"; this.onstatechange?.(); return Promise.resolve();
    }
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
    createOscillator() {
      if (audio === "playback-blocked") throw new Error("Device unavailable");
      const item = { frequency: { setValueAtTime() {} }, startCalls: [], stopCalls: [], disconnectCalls: 0,
        connect() {}, disconnect() { this.disconnectCalls++; },
        start(at) { this.startCalls.push(at); }, stop(at) { this.stopCalls.push(at); } };
      this.oscillators.push(item); return item;
    }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const window = {
    innerWidth: viewportWidth,
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error("Storage disabled"); return shared.storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error("Storage disabled"); shared.storage.set(key, value); },
    },
    AudioContext: audio === "unsupported" ? undefined : FakeAudioContext,
    setInterval(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay, interval: delay }); return id; },
    clearInterval: (id) => timers.delete(id),
    addEventListener: (name, fn) => add("window", name, fn),
    removeEventListener: (name, fn) => remove("window", name, fn),
  };
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.target = target; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  class Clock extends Date { static now() { return now; } }
  const navigator = { locks: shared.locks, onLine: true };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    assert.ok(bodies.length, "An unexpected poll was issued");
    const next = bodies.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(options);
    if (next instanceof Promise) return next;
    return Response.json(next.body ?? next, { status: next.status ?? 200 });
  };
  const Component = evaluate(source, {
    react: hooks, "react/jsx-runtime": jsxRuntime, "lucide-react": icons,
    "@/app/_components/finser-ui": ui, "@/lib/approval-welcome-alerts": rules,
    "./welcome-pending-alerts.module.css": { default: new Proxy({}, { get: (_, key) => key }) },
  }, { window, document, navigator, fetch, AbortController, Date: Clock, ResizeObserver: FakeResizeObserver }).default;
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== "object" ? [] : [node, ...nodes(node.props?.children)];
  const text = (node) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
  const find = (predicate) => { const result = nodes(tree).find(predicate); assert.ok(result, "Expected rendered control"); return result; };
  const dispatch = (target, name, payload = {}) => { for (const fn of listeners[target].get(name) || []) fn(payload); };
  const asideElement = {
    getBoundingClientRect() {
      const aside = nodes(tree).find((node) => node.type === "aside");
      const width = Math.min(nodes(tree).some((node) => node.type === ui.Card) ? 360 : 220, document.documentElement.clientWidth - 32);
      const right = document.documentElement.clientWidth - (aside?.props.style?.right ?? 24);
      return { width, left: right - width, right, top: 400, bottom: 700, height: 300 };
    },
  };
  const page = {
    requests, timers, contexts, document, navigator, shared, capturedPointers, observers,
    async flush() {
      for (let cycle = 0; cycle < 30; cycle++) {
        if (dirty) {
          dirty = false; hookIndex = 0; effects = []; tree = Component({ actorKey, href });
          if (renderedRef) renderedRef.current = null;
          for (const node of nodes(tree)) {
            if (node.type === "aside" && node.props.ref) {
              renderedRef = node.props.ref;
              renderedRef.current = asideElement;
            }
          }
          for (const effect of effects) effect();
          const width = asideElement.getBoundingClientRect().width;
          if (measuredWidth !== width) {
            measuredWidth = width;
            for (const observer of [...observers]) observer.callback([{ target: observer.target }]);
          }
        }
        await setImmediate();
        if (!dirty) return;
      }
      assert.fail("Component did not settle");
    },
    dispatch, find, text: () => text(tree), all: (predicate) => nodes(tree).filter(predicate),
    button(label) { return find((node) => node.type === ui.Button && (text(node) === label || node.props["aria-label"] === label)); },
    open() { find((node) => node.type === ui.Button && node.props["aria-controls"] === "welcome-test-panel").props.onClick(); },
    dismiss() { page.button("Cerrar aviso de bienvenidas").props.onClick(); },
    async enable() { await page.button("Activar sonido").props.onClick(); await page.flush(); },
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [, timer] = next; now = timer.at; timer.at += timer.interval; timer.fn(); await page.flush();
      }
      now = until; await page.flush();
    },
    position() { return find((node) => node.type === "aside").props.style?.right; },
    rect: () => asideElement.getBoundingClientRect(),
    async pointer(type, values = {}) {
      const event = { pointerId: 1, isPrimary: true, button: 0, clientX: 500,
        currentTarget: pointerTarget, target: pointerTarget, preventDefault() {}, ...values };
      page.button("Mover aviso de bienvenidas").props["on" + type](event);
      await page.flush();
    },
    async key(key) {
      let prevented = false;
      page.button("Mover aviso de bienvenidas").props.onKeyDown({ key, preventDefault() { prevented = true; } });
      await page.flush();
      return prevented;
    },
    async resize(width) {
      window.innerWidth = width;
      dispatch("window", "resize");
      for (const observer of [...observers]) observer.callback([{ target: observer.target }]);
      await page.flush();
    },
    async hide() { document.visibilityState = "hidden"; dispatch("document", "visibilitychange"); await page.flush(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    replayEffects() { page.unmount(); for (const slot of slots) if (slot?.effect) slot.cleanup = slot.effect(); },
    listenerCount: () => Object.values(listeners).flatMap((target) => [...target.values()]).reduce((total, value) => total + value.size, 0),
  };
  return page;
}

test("la primera bienvenida abre el aviso sin pedir permiso ni activar audio y enlaza la cola", async () => {
  const page = mount({ bodies: [{ ...summary(3), pendingCount: 5 }] });
  await page.flush();
  assert.match(page.text(), /Hay 3 bienvenidas pendientes por gestionar/);
  assert.match(page.text(), /5 en la cola/);
  assert.equal(page.contexts.length, 0);
  assert.equal(page.find((node) => node.type === "a").props.href, "/dashboard/aprobaciones");
  assert.equal(page.requests[0].method, "GET");
  assert.equal(page.requests[0].credentials, "same-origin");
  assert.equal(page.requests[0].cache, "no-store");
  page.unmount();
});

test("una consulta lenta conserva un solo request y desmontar aborta y elimina eventos y polling", async () => {
  const pending = deferred();
  const page = mount({ bodies: [pending.promise] });
  await page.flush();
  page.dispatch("window", "focus"); page.dispatch("window", "online");
  page.dispatch("document", "visibilitychange");
  await page.advance(90_000);
  assert.equal(page.requests.length, 1);
  page.unmount();
  assert.equal(page.requests[0].signal.aborted, true);
  assert.equal(page.timers.size, 0);
  assert.equal(page.listenerCount(), 0);
  pending.resolve(Response.json(summary())); await page.flush();
  assert.equal(page.all((node) => node.type === ui.Card).length, 0, "A late result cannot reopen the dismissed context");
});

test("perder sesión detiene polling, oculta la alerta y cierra el sonido", async () => {
  for (const status of [401, 403]) {
    const page = mount({ bodies: [summary(), { status, body: {} }] });
    await page.flush(); await page.enable();
    assert.equal(page.contexts[0].state, "running");
    await page.advance(30_000);
    assert.equal(page.text(), "");
    assert.equal(page.contexts[0].state, "closed");
    assert.equal(page.timers.size, 0);
    assert.equal(page.listenerCount(), 0);
    await page.advance(600_000); assert.equal(page.requests.length, 2);
    page.unmount();
  }
});

test("la misma cola no se repite hasta diez minutos y cerrar guarda el recibo", async () => {
  const page = mount({ bodies: Array.from({ length: 21 }, () => summary()) });
  await page.flush(); page.dismiss(); await page.flush();
  await page.advance(570_000);
  assert.equal(page.all((node) => node.type === ui.Card).length, 0);
  await page.advance(30_000);
  assert.equal(page.all((node) => node.type === ui.Card).length, 1);
  assert.equal(JSON.parse(page.shared.storage.get(receiptKey())).notifiedAt, 1_600_000);
  page.unmount();
});

test("las pestañas comparten el recibo bajo un lock y emiten un solo aviso para el mismo cambio", async () => {
  const shared = sharedBrowser();
  const first = mount({ shared, bodies: [summary(), summary(2, "b".repeat(32)), summary(2, "b".repeat(32))] });
  const second = mount({ shared, bodies: [summary(), summary(2, "b".repeat(32)), summary(2, "b".repeat(32))] });
  await Promise.all([first.flush(), second.flush()]);
  assert.equal(first.all((node) => node.type === ui.Card).length + second.all((node) => node.type === ui.Card).length, 1);
  first.open(); second.open(); await Promise.all([first.flush(), second.flush()]);
  // Opening one already visible panel closes it; explicitly open both for audio settings.
  if (!first.all((node) => node.type === ui.Card).length) { first.open(); await first.flush(); }
  if (!second.all((node) => node.type === ui.Card).length) { second.open(); await second.flush(); }
  await Promise.all([first.enable(), second.enable()]);
  assert.equal(first.contexts.length + second.contexts.length, 2);
  await Promise.all([first.advance(60_000), second.advance(60_000)]);
  assert.equal(first.contexts[0].oscillators.length + second.contexts[0].oscillators.length, 6, "Two previews and one automatic two-tone sound");
  assert.ok(shared.lockNames.every((name) => name === "finser:welcome-alerts:user-1"));
  first.unmount(); second.unmount();
});

test("un navegador que bloquea el audio conserva el aviso y ofrece reintentar y silenciar", async () => {
  for (const audio of ["blocked", "unsupported", "playback-blocked", "constructor-blocked"]) {
    const page = mount({ audio });
    await page.flush(); await page.enable();
    assert.match(page.text(), /Hay 2 bienvenidas pendientes/);
    assert.ok(page.button("Activar sonido")); assert.ok(page.button("Silenciar"));
    assert.match(page.text(), audio === "unsupported" ? /no admite sonido/ : /no pudo activar el sonido/);
    page.button("Silenciar").props.onClick(); await page.flush();
    assert.equal(page.shared.storage.get(preferenceKey()), "false");
    page.unmount();
  }
});

test("guardar la preferencia no reproduce al volver a montar; una interacción habilita esta pestaña", async () => {
  const shared = sharedBrowser(); shared.storage.set(preferenceKey(), "true");
  const page = mount({ shared, bodies: [summary(0), summary()] });
  await page.flush(); assert.equal(page.contexts.length, 0);
  page.open(); await page.flush(); assert.ok(page.button("Activar sonido"));
  page.dispatch("window", "pointerdown"); await page.flush();
  assert.equal(page.contexts[0].state, "running");
  assert.equal(page.contexts[0].oscillators.length, 0, "Unlocking a saved preference is silent");
  await page.advance(30_000); assert.equal(page.contexts[0].oscillators.length, 2);
  assert.ok(page.contexts[0].oscillators.every((tone) => tone.stopCalls[0] - tone.startCalls[0] < 1));
  page.unmount(); assert.equal(page.contexts[0].state, "closed");
});

test("solo una pestaña oculta con audio ya activo consulta y avisa en segundo plano", async () => {
  const page = mount({ bodies: [summary(0), summary(0), summary(), summary()] });
  await page.flush(); page.open(); await page.flush(); await page.enable();
  await page.hide(); await page.advance(60_000);
  assert.equal(page.requests.length, 4);
  assert.equal(page.contexts[0].oscillators.length, 4, "One preview and one background notice");
  page.unmount();
  const hidden = mount({ visible: false });
  await hidden.flush(); await hidden.advance(90_000);
  assert.equal(hidden.requests.length, 0);
  assert.equal(hidden.shared.storage.has(receiptKey()), false);
  hidden.document.visibilityState = "visible";
  hidden.dispatch("document", "visibilitychange"); await hidden.flush();
  assert.equal(hidden.requests.length, 1); assert.match(hidden.text(), /Hay 2 bienvenidas/);
  hidden.unmount();
});

test("silenciar en otra pestaña cierra el contexto y una cola fallida no se presenta vacía", async () => {
  const page = mount({ bodies: [summary(), new Error("Offline"), { status: 500, body: {} }] });
  await page.flush(); await page.enable();
  page.shared.storage.set(preferenceKey(), "false");
  page.dispatch("window", "storage", { key: preferenceKey() }); await page.flush();
  assert.equal(page.contexts[0].state, "closed");
  await page.advance(30_000);
  assert.match(page.text(), /Hay 2 bienvenidas/); assert.match(page.text(), /No pudimos actualizar/);
  await page.advance(30_000);
  assert.doesNotMatch(page.text(), /No hay bienvenidas/);
  page.unmount();
});

test("el enlace compartido usa su destino y storage bloqueado conserva el recibo en memoria", async () => {
  const page = mount({ storageBlocked: true, actorKey: "shared-opaque-session", href: "/revision-creditos", bodies: [summary(), summary()] });
  await page.flush();
  assert.equal(page.find((node) => node.type === "a").props.href, "/revision-creditos");
  page.dismiss(); await page.flush(); await page.advance(30_000);
  assert.equal(page.all((node) => node.type === ui.Card).length, 0);
  page.unmount();
});


test("React repite el montaje sin dejar polling ni lecturas antiguas activos", async () => {
  const first = deferred();
  const page = mount({ bodies: [first.promise, summary()] });
  await page.flush(); page.replayEffects(); await page.flush();
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].signal.aborted, true);
  assert.equal(page.timers.size, 1);
  assert.equal(page.listenerCount(), 7);
  first.resolve(Response.json(summary(9, "b".repeat(32)))); await page.flush();
  assert.match(page.text(), /Hay 2 bienvenidas/); assert.doesNotMatch(page.text(), /Hay 9/);
  page.unmount(); assert.equal(page.timers.size, 0); assert.equal(page.listenerCount(), 0);
});

test("la suspensión de audio evita que una pestaña oculta consuma el aviso", async () => {
  const page = mount({ bodies: [summary(0), summary()] });
  await page.flush(); page.open(); await page.flush(); await page.enable();
  const context = page.contexts[0];
  context.state = "suspended"; context.onstatechange(); await page.flush();
  await page.hide(); await page.advance(90_000);
  assert.equal(page.requests.length, 1); assert.equal(page.shared.storage.has(receiptKey()), false);
  page.document.visibilityState = "visible";
  page.dispatch("window", "focus"); await page.flush();
  assert.match(page.text(), /Hay 2 bienvenidas/); assert.ok(page.button("Activar sonido"));
  page.unmount();
});


test("arrastrar mueve solo el aviso, captura el puntero y conserva consultas y audio", async () => {
  const page = mount();
  await page.flush(); await page.enable();
  const initial = page.position();
  const context = page.contexts[0];
  await page.pointer("PointerDown");
  assert.equal(page.capturedPointers.has(1), true);
  await page.pointer("PointerMove", { clientX: 497 });
  assert.equal(page.position(), initial, "A short press does not move the notice");
  await page.pointer("PointerMove", { pointerId: 2, clientX: 200 });
  assert.equal(page.position(), initial, "Another pointer cannot take over the drag");
  await page.pointer("PointerMove", { clientX: 400 });
  assert.equal(page.position(), initial + 100);
  assert.equal(page.all((node) => node.type === ui.Card).length, 1);
  assert.equal(page.requests.length, 1);
  assert.equal(page.timers.size, 1);
  assert.equal(page.contexts[0], context);
  assert.equal(context.state, "running");
  assert.equal(context.closeCalls, 0);
  await page.pointer("PointerUp", { clientX: 400 });
  assert.equal(page.capturedPointers.size, 0);
  const stored = Number(page.shared.storage.get(positionKey()));
  assert.ok(stored > 0 && stored < 1);
  await page.pointer("PointerMove", { clientX: 300 });
  assert.equal(page.position(), initial + 100, "Movement stops after releasing the handle");
  page.unmount();
});

test("el arrastre respeta ambos bordes y omite botones secundarios y contactos adicionales", async () => {
  const page = mount(); await page.flush();
  const initial = page.position();
  for (const ignored of [{ button: 2 }, { isPrimary: false }]) {
    await page.pointer("PointerDown", ignored);
    await page.pointer("PointerMove", { clientX: -5000 });
    assert.equal(page.position(), initial);
    assert.equal(page.capturedPointers.size, 0);
  }
  await page.pointer("PointerDown");
  await page.pointer("PointerMove", { clientX: -5000 });
  assert.equal(page.rect().left, 16);
  await page.pointer("PointerMove", { clientX: 5000 });
  assert.equal(page.position(), 16);
  await page.pointer("PointerUp");
  page.unmount();
});

test("cancelar el gesto o perder la captura detiene el arrastre sin abrir ni cerrar el aviso", async () => {
  const page = mount({ bodies: [summary(0)] }); await page.flush();
  for (const type of ["PointerCancel", "LostPointerCapture"]) {
    await page.pointer("PointerDown");
    await page.pointer("PointerMove", { clientX: 450 });
    const stopped = page.position();
    await page.pointer(type, { clientX: 450 });
    assert.equal(page.capturedPointers.size, 0);
    await page.pointer("PointerMove", { clientX: 250 });
    assert.equal(page.position(), stopped);
    assert.equal(page.all((node) => node.type === ui.Card).length, 0);
  }
  page.open(); await page.flush();
  assert.equal(page.all((node) => node.type === ui.Card).length, 1, "The separate launcher remains usable");
  page.unmount();
});

test("el control de movimiento admite flechas, Inicio y Fin sin consumir otras teclas", async () => {
  const page = mount(); await page.flush();
  const initial = page.position();
  assert.equal(await page.key("ArrowLeft"), true);
  assert.ok(page.position() > initial);
  assert.equal(await page.key("ArrowRight"), true);
  assert.equal(page.position(), initial);
  assert.equal(await page.key("Home"), true);
  assert.equal(page.rect().left, 16);
  assert.equal(await page.key("End"), true);
  assert.equal(page.position(), 16);
  assert.equal(await page.key("Tab"), false);
  assert.equal(page.position(), 16);
  page.unmount();
});

test("abrir la tarjeta y cambiar el ancho mantiene el aviso visible y conserva el lado elegido", async () => {
  const page = mount({ bodies: [summary(0)] }); await page.flush();
  await page.key("Home"); assert.equal(page.rect().left, 16);
  page.open(); await page.flush();
  assert.equal(page.rect().width, 360);
  assert.equal(page.rect().left, 16);
  await page.resize(375);
  assert.equal(page.position(), 16);
  assert.equal(page.rect().left, 16);
  assert.equal(page.rect().right, 359);
  await page.resize(1024);
  assert.equal(page.rect().left, 16);
  page.dismiss(); await page.flush();
  assert.equal(page.rect().width, 220);
  assert.equal(page.rect().left, 16);
  assert.equal(page.requests.length, 1);
  assert.equal(page.observers.size, 1);
  page.unmount();
  assert.equal(page.observers.size, 0);
  assert.equal(page.listenerCount(), 0);
});

test("la posición se recupera por cuenta y se adapta a otra ventana sin aceptar valores inválidos", async () => {
  const shared = sharedBrowser();
  const first = mount({ shared, bodies: [summary(0)] }); await first.flush();
  await first.key("ArrowLeft");
  const fraction = Number(shared.storage.get(positionKey()));
  assert.ok(fraction > 0 && fraction < 1);
  first.unmount();
  const restored = mount({ shared, bodies: [summary(0)], viewportWidth: 800 }); await restored.flush();
  assert.equal(restored.position(), 16 + fraction * (800 - restored.rect().width - 32));
  restored.unmount();
  const other = mount({ shared, actorKey: "user-2", bodies: [summary(0)] }); await other.flush();
  assert.equal(other.position(), 16);
  other.unmount();
  for (const invalid of ["NaN", "-1", "1.1"]) {
    const browser = sharedBrowser(); browser.storage.set(positionKey(), invalid);
    const page = mount({ shared: browser, bodies: [summary(0)] }); await page.flush();
    assert.equal(page.position(), 16);
    page.unmount();
  }
});


test("los límites y el desplazamiento respetan el área visible con una barra de scroll clásica", async () => {
  const page = mount({ viewportWidth: 1024, scrollbarWidth: 17 }); await page.flush();
  await page.key("Home");
  assert.equal(page.rect().left, 16);
  await page.key("End");
  assert.equal(page.rect().right, 1007 - 16);
  const initial = page.position();
  await page.pointer("PointerDown");
  await page.pointer("PointerMove", { clientX: 400 });
  assert.equal(page.position(), initial + 100, "Scrollbar width must not add a jump to the pointer delta");
  await page.pointer("PointerUp");
  await page.resize(800);
  assert.ok(page.rect().left >= 16);
  assert.ok(page.rect().right <= 800 - 17 - 16);
  page.unmount();
});
