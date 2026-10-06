import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies, globals) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, ...globals,
    require(name) {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return loaded.exports;
}

// Execute the real component and shared hook; only browser time and React lifecycle
// are controlled so overlapping navigation events and slow RSC requests are repeatable.
function mount({ visible = true } = {}) {
  let now = 0, nextTimer = 0, cursor = 0, effects = [], pending = false;
  const timers = new Map(), slots = [], listeners = { window: new Map(), document: new Map() };
  const requests = [];
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const add = (target, name, listener) => {
    if (!listeners[target].has(name)) listeners[target].set(name, new Set());
    listeners[target].get(name).add(listener);
  };
  const remove = (target, name, listener) => listeners[target].get(name)?.delete(listener);
  const setTimer = (fn, delay, interval = false) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, interval: interval ? delay : 0 });
    return id;
  };
  const document = {
    visibilityState: visible ? "visible" : "hidden",
    get hidden() { return this.visibilityState !== "visible"; },
    addEventListener: (name, fn) => add("document", name, fn),
    removeEventListener: (name, fn) => remove("document", name, fn),
  };
  const window = {
    setTimeout: (fn, delay) => setTimer(fn, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: (id) => timers.delete(id),
    addEventListener: (name, fn) => add("window", name, fn),
    removeEventListener: (name, fn) => remove("window", name, fn),
  };
  const startTransition = (fn) => { pending = true; fn(); };
  const react = {
    useRef(value) { const index = cursor++; slots[index] ||= { current: value }; return slots[index]; },
    useTransition() { cursor++; return [pending, startTransition]; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, effect, cleanup: effect() };
      });
    },
  };
  const globals = { window, document };
  const hook = load("lib/use-live-refresh.ts", { react }, globals);
  const router = { refresh: () => requests.push(now) };
  const Component = load("app/dashboard/_components/seller-dashboard-refresh.tsx", {
    react, "next/navigation": { useRouter: () => router }, "@/lib/use-live-refresh": hook,
  }, globals).default;
  function render() {
    cursor = 0; effects = [];
    assert.equal(Component(), null, "El refresco no modifica el diseño ni los controles");
    for (const effect of effects) effect();
  }
  function dispatch(target, name, payload = {}) {
    for (const listener of listeners[target].get(name) || []) listener(payload);
  }
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.fn();
      render();
    }
    now = until;
  }
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); };
  render();
  return {
    requests, document, dispatch, advance, render, unmount,
    complete() { pending = false; render(); },
    resume() {
      document.visibilityState = "visible";
      dispatch("document", "visibilitychange");
      dispatch("window", "focus");
      dispatch("window", "pageshow", { persisted: true });
    },
    replayEffects() {
      unmount();
      for (const slot of slots) if (slot?.effect) slot.cleanup = slot.effect();
    },
    activeTimers: () => timers.size,
    activeListeners: () => Object.values(listeners).flatMap((target) => [...target.values()]).reduce((total, value) => total + value.size, 0),
  };
}

test("el dashboard monta el refresco sin cambiar el alcance de sus datos", () => {
  const source = readFileSync(new URL("../app/dashboard/_components/seller-commercial-dashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /import SellerDashboardRefresh from "\.\/seller-dashboard-refresh"/);
  assert.match(source, /<SellerDashboardRefresh \/>/);
});

test("montar una ruta restaurada agrupa pageshow, foco y visibilidad en un solo refresco", () => {
  const page = mount();
  page.resume();
  page.advance(249);
  assert.equal(page.requests.length, 0);
  page.advance(1);
  assert.deepEqual(page.requests, [250]);
  page.complete();
  page.render();
  page.advance(1000);
  assert.equal(page.requests.length, 1, "Recibir el nuevo RSC no crea un ciclo de refrescos");
  page.unmount();
});

test("una consulta lenta no se duplica por eventos ni por el intervalo de 60 segundos", () => {
  const page = mount();
  page.advance(250);
  page.resume();
  page.advance(120_000);
  assert.equal(page.requests.length, 1);
  page.complete();
  page.resume();
  page.advance(250);
  assert.equal(page.requests.length, 2);
  page.unmount();
});

test("el intervalo actualiza cada 60 segundos y solo mientras el dashboard está visible", () => {
  const page = mount();
  page.advance(250);
  page.complete();
  page.advance(59_999);
  assert.equal(page.requests.length, 1);
  page.advance(1);
  assert.equal(page.requests.length, 2);
  page.complete();
  page.document.visibilityState = "hidden";
  page.advance(120_000);
  assert.equal(page.requests.length, 2);
  page.resume();
  page.advance(250);
  assert.equal(page.requests.length, 3);
  page.unmount();
});

test("una pestaña oculta no consulta al montar ni ejecuta un refresco pendiente al ocultarse", () => {
  const page = mount({ visible: false });
  page.dispatch("window", "focus");
  page.dispatch("window", "pageshow");
  page.advance(61_000);
  assert.equal(page.requests.length, 0);
  page.resume();
  page.document.visibilityState = "hidden";
  page.advance(250);
  assert.equal(page.requests.length, 0);
  page.resume();
  page.advance(250);
  assert.equal(page.requests.length, 1);
  page.unmount();
});

test("los avisos entre pestañas comparten la misma protección contra consultas duplicadas", () => {
  const page = mount();
  page.advance(250);
  page.complete();
  page.dispatch("window", "storage", { key: "otra-clave" });
  page.advance(250);
  assert.equal(page.requests.length, 1);
  page.dispatch("window", "storage", { key: "conectamos:live-refresh" });
  page.dispatch("window", "conectamos:live-refresh");
  page.resume();
  page.advance(250);
  assert.equal(page.requests.length, 2);
  page.unmount();
});

test("desmontar limpia listeners y timers, incluso con la repetición de efectos de React", () => {
  const page = mount();
  page.replayEffects();
  assert.equal(page.activeListeners(), 5);
  assert.equal(page.activeTimers(), 2);
  page.advance(250);
  assert.equal(page.requests.length, 1);
  page.complete();
  page.resume();
  page.unmount();
  assert.equal(page.activeTimers(), 0);
  assert.equal(page.activeListeners(), 0);
  page.advance(120_000);
  assert.equal(page.requests.length, 1);
});
