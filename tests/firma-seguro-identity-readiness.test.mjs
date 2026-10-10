import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/use-firma-seguro-identity-readiness.ts", import.meta.url), "utf8");
const binding = { draftId: 2887, validationId: 42, assessmentId: "assessment-current", fullName: "María del Mar De la Peña Muñoz del Río", documentNumber: "001110477922", enabled: true };
const readyItem = { draftId: binding.draftId, validationId: binding.validationId, assessmentId: binding.assessmentId,
  canonicalFullName: binding.fullName, documentNumber: binding.documentNumber,
  signingReady: true, signingSource: "VERIFF", eligible: true, reason: null };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(initialBinding = binding) {
  const states = [], refs = [], callbacks = [], effectDeps = [], cleanups = [], requests = [];
  const listeners = new Map(), timers = new Map();
  let stateIndex = 0, refIndex = 0, callbackIndex = 0, effectIndex = 0, effects = [], timerId = 0, now = 0;
  let currentBinding = { ...initialBinding };
  let transport = async () => ({ ok: true, item: { ...readyItem } });
  const react = {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial) { const i = refIndex++; return refs[i] ||= { current: initial }; },
    useCallback(callback, deps) { const i = callbackIndex++, previous = callbacks[i];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) callbacks[i] = { callback, deps };
      return callbacks[i].callback; },
    useEffect(callback, deps) { const i = effectIndex++, previous = effectDeps[i];
      if (!previous || deps.some((value, index) => value !== previous[index])) { effectDeps[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); }); } },
  };
  const context = { module: { exports: {} }, AbortController, Error, JSON,
    document: { visibilityState: "visible" },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
      removeEventListener(event, callback) { listeners.get(event)?.delete(callback); },
    },
    fetch: async (url, options) => { requests.push({ url, ...options }); const result = await transport(url, options);
      return { ok: result.ok !== false, status: result.status || 200, json: async () => result }; },
    require(name) { if (name === "react") return react; assert.fail(name); },
  };
  context.exports = context.module.exports;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const render = () => { stateIndex = 0; refIndex = 0; callbackIndex = 0; effectIndex = 0;
    const value = context.module.exports.useFirmaSeguroIdentityReadiness(currentBinding);
    const pending = effects; effects = []; pending.forEach(effect => effect()); return value; };
  return { requests, render, setTransport(value) { transport = value; }, update(value) { currentBinding = { ...currentBinding, ...value }; return render(); },
    dispatch(event) { for (const callback of listeners.get(event) || []) callback(); }, setVisible(value) { context.document.visibilityState = value ? "visible" : "hidden"; },
    pendingTimers: () => timers.size, listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    async advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } await flush(); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
async function load(f) { f.render(); await flush(); return f.render(); }

test("aprobación vigente comprueba readiness mediante un único GET local y preserva cédula con ceros", async () => {
  const f = fixture(); const result = await load(f);
  assert.equal(result.status, "ready"); assert.equal(result.source, "VERIFF"); assert.equal(result.message, null);
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.url, "/api/creditos/borradores/2887/identidad-firma"); assert.equal(request.method, "GET");
  assert.equal(request.credentials, "same-origin"); assert.equal(request.cache, "no-store"); assert.equal(request.body, undefined);
  assert.equal(f.pendingTimers(), 0); f.unmount(); assert.equal(f.listenerCount(), 0);
});

test("no consulta antes de aprobar o sin contexto; cambios de aspecto no repiten la lectura", async () => {
  for (const invalid of [{ enabled: false }, { draftId: null }, { validationId: null }, { assessmentId: null }]) {
    const f = fixture({ ...binding, ...invalid }); await load(f); assert.equal(f.requests.length, 0); f.unmount();
  }
  const f = fixture({ ...binding, enabled: false }); assert.equal((await load(f)).status, "idle");
  f.update({ enabled: true }); await flush(); assert.equal(f.render().status, "ready");
  f.render(); f.render(); assert.equal(f.requests.length, 1); f.unmount();
});

test("CC sin componentes exige revisión y revisión autorizada habilita readiness sin despachar firma", async () => {
  const f = fixture(); f.setTransport(async () => ({ ok: true, item: { ...readyItem, signingReady: false, signingSource: null, reason: "Revisa nombres y apellidos." } }));
  let result = await load(f); assert.equal(result.status, "review"); assert.equal(result.source, null); assert.equal(result.message, "Revisa nombres y apellidos.");
  f.setTransport(async () => ({ ok: true, item: { ...readyItem, signingSource: "AUTHORIZED_REVIEW" } })); result.retry(); await load(f);
  result = f.render(); assert.equal(result.status, "ready"); assert.equal(result.source, "AUTHORIZED_REVIEW");
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(request => request.method === "GET" && request.body === undefined)); f.unmount();
});

test("expediente no elegible mantiene envío bloqueado y conserva la razón del servidor", async () => {
  const f = fixture(); f.setTransport(async () => ({ ok: true, item: { ...readyItem, signingReady: false, signingSource: null, eligible: false, reason: "La validación vigente está pendiente." } }));
  const result = await load(f); assert.equal(result.status, "blocked"); assert.equal(result.source, null); assert.match(result.message, /vigente está pendiente/); f.unmount();
});

test("rechaza ready que no corresponde a draft, última Veriff, evaluación, nombre, cédula o procedencia", async () => {
  for (const mismatch of [{ draftId: 99 }, { validationId: 41 }, { assessmentId: "assessment-old" }, { canonicalFullName: "Otra persona" },
    { documentNumber: "1110477922" }, { signingSource: "DATACREDITO" }, { signingReady: undefined }]) {
    const f = fixture(); f.setTransport(async () => ({ ok: true, item: { ...readyItem, ...mismatch } }));
    const result = await load(f); assert.equal(result.status, "error", JSON.stringify(mismatch)); assert.equal(result.source, null); f.unmount();
  }
  const f = fixture({ ...binding, documentNumber: "001.110.477.922" }); assert.equal((await load(f)).status, "ready"); f.unmount();
});

test("error de lectura ofrece reintento y ninguna respuesta error conserva autorización previa", async () => {
  const f = fixture(); let result = await load(f); assert.equal(result.status, "ready");
  f.setTransport(async () => ({ ok: false, status: 503, error: "Comprobación temporalmente no disponible." })); result.retry(); await load(f);
  result = f.render(); assert.equal(result.status, "error"); assert.equal(result.source, null); assert.equal(result.message, "Comprobación temporalmente no disponible.");
  f.setTransport(async () => ({ ok: true, item: readyItem })); result.retry(); await load(f); assert.equal(f.render().status, "ready");
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.method === "GET")); f.unmount();
});

test("cambiar draft o validación aborta la lectura anterior y una respuesta tardía nunca autoriza el contexto nuevo", async () => {
  for (const change of [{ draftId: 2888 }, { validationId: 43 }, { assessmentId: "assessment-new" }, { fullName: "Otro Cliente" }, { documentNumber: "009876543210" }]) {
    const pending = []; const f = fixture(); f.setTransport(() => new Promise(resolve => pending.push(resolve)));
    f.render(); assert.equal(f.requests.length, 1); f.update(change); assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, true);
    pending[0]({ ok: true, item: readyItem }); await flush(); assert.equal(f.render().status, "loading", JSON.stringify(change));
    const next = { ...binding, ...change }; pending[1]({ ok: true, item: { ...readyItem, draftId: next.draftId, validationId: next.validationId,
      assessmentId: next.assessmentId, canonicalFullName: next.fullName, documentNumber: next.documentNumber } });
    await flush(); assert.equal(f.render().status, "ready"); assert.equal(f.requests.length, 2); f.unmount();
  }
});

test("deshabilitar y salir descarta incluso respuestas que llegan después de abortar", async () => {
  let complete; const f = fixture(); f.setTransport(() => new Promise(resolve => { complete = resolve; }));
  f.render(); f.update({ enabled: false }); assert.equal(f.requests[0].signal.aborted, true);
  complete({ ok: true, item: readyItem }); await flush(); assert.equal(f.render().status, "idle"); assert.equal(f.listenerCount(), 0); f.unmount();
  const pending = fixture(); pending.setTransport(() => new Promise(() => {})); pending.render(); pending.unmount();
  assert.equal(pending.requests[0].signal.aborted, true); assert.equal(pending.pendingTimers(), 0); assert.equal(pending.listenerCount(), 0);
});

test("timeout20s muestra error recuperable y foco/online sólo revalidan visible", async () => {
  const f = fixture(); f.setTransport((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Abortada")), { once: true })));
  f.render(); await f.advance(19_999); assert.equal(f.render().status, "loading"); await f.advance(1);
  assert.equal(f.render().status, "error"); assert.match(f.render().message, /tardó demasiado/); assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.pendingTimers(), 0);
  f.setTransport(async () => ({ ok: true, item: readyItem })); f.setVisible(false); f.dispatch("focus"); f.dispatch("online"); f.render(); assert.equal(f.requests.length, 1);
  f.setVisible(true); f.dispatch("focus"); await load(f); assert.equal(f.requests.length, 2); assert.equal(f.render().status, "ready");
  f.dispatch("online"); await load(f); assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.method === "GET")); f.unmount();
});
