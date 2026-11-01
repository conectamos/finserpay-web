import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workId = uuid(81);
const marker = (n, second = n) => ({ id: uuid(100 + n), sentAt: `2026-10-31T15:00:${String(second).padStart(2, "0")}.000Z` });
const summary = (count = 2, patch = {}) => ({ workId, kind: "welcome", target: "C-12", unreadCount: count,
  lastInbound: marker(2), lastUnreadInbound: count ? marker(2) : null, ...patch });

function mount(options = {}) {
  let cursor = 0, dirty = false, effects = [], value, now = 0, timerId = 0, unmounted = false, writesAfterUnmount = 0;
  let args = [workId, 12];
  const slots = [], requests = [], sources = [], timers = new Map(), events = new Map();
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const react = {
    useState(initial) {
      const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, next => {
        if (unmounted) writesAfterUnmount++;
        const result = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
  };
  const schedule = (fn, delay = 0, interval = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const addEventListener = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); };
  const removeEventListener = (name, fn) => events.get(name)?.delete(fn);
  const document = { visibilityState: "visible", addEventListener, removeEventListener };
  const navigator = { onLine: true };
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; this.listeners = new Map(); sources.push(this); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    close() { this.closed = true; }
    emit(name, data = {}) { for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(data) }); this[`on${name}`]?.({ data: JSON.stringify(data) }); }
  }
  function load(file) {
    const loaded = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
    });
    assert.equal(compiled.diagnostics.length, 0);
    runInNewContext(compiled.outputText, {
      module: loaded, exports: loaded.exports, Error, AbortController, URLSearchParams, URL, Date, document, navigator,
      window: { addEventListener, removeEventListener },
      ...(!options.withoutEvents ? { EventSource: FakeEventSource } : {}),
      setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id),
      fetch: (url, init = {}) => new Promise((resolve, reject) => {
        const request = { url, init, done: false,
          respond(body, status = 200) { if (this.done) return; this.done = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); },
          fail(error = new Error("Falla temporal")) { if (this.done) return; this.done = true; reject(error); },
        };
        requests.push(request);
        init.signal?.addEventListener("abort", () => { if (!options.ignoreAbort) request.fail(Object.assign(new Error("abort"), { name: "AbortError" })); }, { once: true });
      }),
      require(name) { if (name === "react") return react; if (name === "@/lib/atencion-work-links") return load("lib/atencion-work-links.ts"); throw new Error(`Unexpected dependency ${name}`); },
    });
    return loaded.exports;
  }
  const { useApprovalChatUnread: runHook } = load("app/dashboard/aprobaciones/use-approval-chat-unread.ts");
  function render() { cursor = 0; dirty = false; effects = []; value = runHook(...args); for (const run of effects) run(); }
  async function flush() { for (let n = 0; n < 35; n++) { await Promise.resolve(); if (dirty && !unmounted) render(); } }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
      const [id, entry] = next; now = entry.at; if (entry.interval) entry.at += entry.interval; else timers.delete(id); entry.fn(); await flush();
    }
    now = until; await flush();
  }
  render();
  return { requests, sources, timers, flush, advance, get value() { return value; }, get writesAfterUnmount() { return writesAfterUnmount; },
    async event(name) { for (const fn of events.get(name) || []) fn(); await flush(); },
    async visible(state) { document.visibilityState = state; for (const fn of events.get("visibilitychange") || []) fn(); await flush(); },
    setArgs(next) { args = next; render(); },
    unmount() { unmounted = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}

async function start(f) { await f.flush(); await f.advance(200); assert.ok(f.requests.length > 0, "se consulta el resumen al montar"); }
async function respond(f, payload = summary(), status = 200) { const pending = f.requests.filter(request => !request.done).at(-1); assert.ok(pending, "hay una consulta pendiente"); pending.respond(payload, status); await f.flush(); }
async function refresh(f, payload = summary(), status = 200) { f.value.refresh(); await f.flush(); await f.advance(200); await respond(f, payload, status); }

test("consulta solamente el resumen autorizado y fija pendientes existentes sin anunciar una llegada falsa", async () => {
  const f = mount(); assert.equal(f.value.count, null); await start(f);
  const request = f.requests[0], url = new URL(request.url, "https://finserpay.test");
  assert.equal(url.pathname, `/api/atencion/solicitudes/${workId}/resumen`); assert.equal(url.searchParams.get("target"), "C-12");
  assert.equal(request.init.credentials, "same-origin"); assert.equal(request.init.cache, "no-store");
  await respond(f); assert.equal(f.value.count, 2); assert.equal(f.value.hasNew, false); assert.equal(f.value.arrival, 0);
  assert.ok(f.sources.every(source => source.url === "/api/atencion/events")); assert.ok(f.requests.every(req => !req.init.method || req.init.method === "GET")); f.unmount();
});

test("avisa de mensajes nuevos una vez y no confunde la lectura de otra pestaña con una nueva llegada", async () => {
  const f = mount(); await start(f); await respond(f);
  await refresh(f, summary(3, { lastInbound: marker(3), lastUnreadInbound: marker(3) }));
  assert.equal(f.value.count, 3); assert.equal(f.value.hasNew, true); assert.equal(f.value.arrival, 1);
  await refresh(f, summary(3, { lastInbound: marker(3), lastUnreadInbound: marker(3) })); assert.equal(f.value.arrival, 1);
  await refresh(f, summary(2, { lastInbound: marker(3), lastUnreadInbound: marker(2) })); assert.equal(f.value.arrival, 1, "leer el último deja el marcador antiguo, sin crear otro aviso");
  await refresh(f, summary(2, { lastInbound: marker(4), lastUnreadInbound: marker(4) })); assert.equal(f.value.arrival, 2, "leer uno y recibir otro conserva el total, pero es una llegada nueva");
  await refresh(f, summary(0, { lastInbound: marker(4) })); assert.equal(f.value.count, 0); assert.equal(f.value.hasNew, false);
  const before = f.requests.length; f.value.refresh(); await f.flush(); assert.equal(f.value.count, 0, "no se cambia el contador de forma optimista"); await f.advance(200);
  await respond(f, summary(1, { lastInbound: marker(5), lastUnreadInbound: marker(5) })); assert.equal(f.value.arrival, 3);
  assert.ok(f.requests.slice(before).every(req => !req.init.method || req.init.method === "GET")); f.unmount();
});

test("ordena los marcadores empatados por UUID y conserva el máximo al quedar cero pendientes", async () => {
  const f = mount(); await start(f); await respond(f, summary(1, { lastInbound: marker(2, 1), lastUnreadInbound: marker(2, 1) }));
  await refresh(f, summary(1, { lastInbound: marker(3, 1), lastUnreadInbound: marker(3, 1) })); assert.equal(f.value.arrival, 1);
  await refresh(f, summary(0, { lastInbound: marker(3, 1) }));
  await refresh(f, summary(0, { lastInbound: marker(3, 1) })); assert.equal(f.value.arrival, 1); assert.equal(f.value.hasNew, false); f.unmount();
});

test("respeta microsegundos antes del UUID al leer el último o recibir otro mensaje dentro del mismo milisegundo", async () => {
  const latest = { id: uuid(111), sentAt: "2026-10-31T15:00:01.123900Z" };
  const older = { id: uuid(199), sentAt: "2026-10-31T15:00:01.123800Z" };
  const incoming = { id: uuid(101), sentAt: "2026-10-31T15:00:01.123950Z" };
  const f = mount(); await start(f); await respond(f, summary(2, { lastInbound: latest, lastUnreadInbound: latest }));
  await refresh(f, summary(1, { lastInbound: latest, lastUnreadInbound: older }));
  assert.equal(f.value.arrival, 0, "el UUID mayor del mensaje antiguo no lo convierte en una llegada nueva");
  assert.equal(f.value.hasNew, false); assert.equal(f.value.count, 1);
  await refresh(f, summary(1, { lastInbound: incoming, lastUnreadInbound: incoming }));
  assert.equal(f.value.arrival, 1, "el timestamp más reciente avanza aunque el UUID sea menor y el total no cambie");
  assert.equal(f.value.hasNew, true); assert.equal(f.value.count, 1); f.unmount();
});

test("SSE agrupa ráfagas y nunca solapa consultas del mismo contador", async () => {
  const f = mount(); await start(f); await respond(f); const source = f.sources[0]; assert.ok(source);
  for (let i = 0; i < 8; i++) source.emit("invalidate"); await f.advance(149); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests.length, 2);
  for (const event of ["ready", "degraded", "invalidate"]) source.emit(event); await f.advance(200); assert.equal(f.requests.length, 2, "se espera la respuesta en curso");
  await respond(f); await f.advance(200); assert.equal(f.requests.length, 3, "la ráfaga pendiente produce una sola revalidación adicional");
  await respond(f); assert.ok(f.requests.every(req => !req.init.method || req.init.method === "GET")); f.unmount();
});

test("el sondeo se suspende oculto y se recupera al volver, enfocar o recuperar la conexión", async () => {
  const f = mount({ withoutEvents: true }); await start(f); await respond(f); const count = f.requests.length;
  await f.visible("hidden"); await f.event("focus"); await f.advance(10_000); assert.equal(f.requests.length, count);
  await f.visible("visible"); await f.advance(200); await respond(f); assert.equal(f.requests.length, count + 1);
  await f.event("focus"); await f.advance(200); await respond(f);
  await f.event("online"); await f.advance(200); await respond(f);
  const before = f.requests.length; await f.advance(5000); assert.equal(f.requests.length, before + 1); f.unmount();
});

for (const status of [401, 403, 404, 409]) test(`el acceso ${status} retira contador y aviso, sin continuar consultas ni exponer datos`, async () => {
  const f = mount(); await start(f); await respond(f); await refresh(f, summary(3, { lastInbound: marker(3), lastUnreadInbound: marker(3) }));
  await refresh(f, { error: "No autorizado" }, status); assert.equal(f.value.denied, true); assert.equal(f.value.count, null); assert.equal(f.value.hasNew, false);
  const count = f.requests.length; assert.ok(f.sources.every(source => source.closed)); f.value.refresh(); await f.event("focus"); await f.event("online"); await f.advance(20_000);
  assert.equal(f.requests.length, count); f.unmount();
});

test("el evento unauthorized cancela una consulta atrasada que no puede restaurar el contador", async () => {
  const f = mount({ ignoreAbort: true }); await start(f); await respond(f); f.value.refresh(); await f.advance(200); const old = f.requests.at(-1);
  f.sources[0].emit("unauthorized"); await f.flush(); assert.equal(old.init.signal.aborted, true); assert.equal(f.value.denied, true); assert.equal(f.value.count, null);
  old.respond(summary(99)); await f.flush(); assert.equal(f.value.count, null); assert.equal(f.value.hasNew, false); assert.equal(f.value.denied, true); f.unmount();
});

test("errores de red y timeout muestran contador desconocido y reintentan sin inventar cero", async () => {
  const f = mount(); await start(f); await respond(f); f.value.refresh(); await f.advance(200); f.requests.at(-1).fail(); await f.flush();
  assert.equal(f.value.count, null); assert.equal(f.value.unavailable, true); assert.equal(f.value.denied, false);
  await f.advance(5000); await respond(f, summary(3, { lastInbound: marker(3), lastUnreadInbound: marker(3) })); assert.equal(f.value.count, 3); assert.equal(f.value.unavailable, false);
  f.value.refresh(); await f.advance(200); const hung = f.requests.at(-1); await f.advance(15_000);
  assert.equal(hung.init.signal.aborted, true); assert.equal(f.value.count, null); assert.equal(f.value.unavailable, true); assert.equal(f.value.denied, false);
  if (!f.requests.some(request => !request.done)) { f.value.refresh(); await f.advance(200); }
  await respond(f, summary(0, { lastInbound: marker(3) })); assert.equal(f.value.count, 0); assert.equal(f.value.unavailable, false); f.unmount();
});

test("el timeout durante la lectura del JSON también retira el contador anterior", async () => {
  const f = mount(); await start(f); await respond(f); f.value.refresh(); await f.advance(200);
  let rejectBody;
  const body = new Promise((_resolve, reject) => { rejectBody = reject; });
  f.requests.at(-1).respond(body); await f.flush();
  await f.advance(15_000); rejectBody(Object.assign(new Error("El cuerpo se canceló al vencer el plazo"), { name: "AbortError" })); await f.flush();
  assert.equal(f.value.count, null); assert.equal(f.value.unavailable, true); assert.equal(f.value.denied, false); f.unmount();
});

test("cambiar de expediente descarta respuestas anteriores y no mezcla contador, avisos ni permiso", async () => {
  const f = mount({ ignoreAbort: true }); await start(f); await respond(f); f.value.refresh(); await f.advance(200); const old = f.requests.at(-1);
  const nextWorkId = uuid(82); f.setArgs([nextWorkId, 13]); assert.equal(f.value.count, null); await f.flush(); await f.advance(200);
  await respond(f, summary(7, { workId: nextWorkId, target: "C-13" })); assert.equal(f.value.count, 7); assert.equal(f.value.hasNew, false); assert.equal(f.value.denied, false);
  old.respond({ error: "Acceso de otro expediente" }, 403); await f.flush(); assert.equal(f.value.count, 7); assert.equal(f.value.denied, false); assert.equal(f.value.hasNew, false); f.unmount();
});

test("una respuesta con vínculo o contador inválidos no se presenta como información real", async () => {
  for (const invalid of [summary(2, { workId: uuid(82) }), summary(2, { target: "C-13" }), summary(2, { kind: "enrollment" }), summary(-1), summary(2, { lastUnreadInbound: marker(3, 80) })]) {
    const f = mount(); await start(f); await respond(f, invalid); assert.equal(f.value.count, null); assert.equal(f.value.hasNew, false); assert.ok(f.value.denied || f.value.unavailable); f.unmount();
  }
});

test("un vínculo inválido no inicia consultas ni suscripciones a información de otro expediente", async () => {
  const f = mount(); await start(f); await respond(f); const count = f.requests.length;
  for (const args of [["not-a-work-id", 12], [workId, 0], [workId, -1], [workId, 12.5], [workId, Number.MAX_SAFE_INTEGER + 1]]) {
    f.setArgs(args); await f.flush(); assert.equal(f.value.denied, true); assert.equal(f.value.count, null); assert.equal(f.value.hasNew, false);
    await f.event("focus"); await f.advance(6000); assert.equal(f.requests.length, count); assert.ok(f.sources.every(source => source.closed));
  }
  f.unmount();
});

test("una falla temporal del servidor no revoca acceso ni convierte un saldo desconocido en cero", async () => {
  const f = mount(); await start(f); await respond(f);
  await refresh(f, { error: "Servicio temporalmente no disponible" }, 503);
  assert.equal(f.value.count, null); assert.equal(f.value.unavailable, true); assert.equal(f.value.denied, false);
  await f.advance(5000); await respond(f); assert.equal(f.value.count, 2); assert.equal(f.value.unavailable, false); assert.equal(f.value.arrival, 0, "recuperar el mismo estado no produce un aviso de llegada");
  f.unmount();
});

test("desmontar cancela la consulta, cierra el flujo y elimina todos los temporizadores", async () => {
  const f = mount(); await start(f); const request = f.requests.at(-1); f.unmount(); await f.flush();
  assert.equal(request.init.signal.aborted, true); assert.ok(f.sources.every(source => source.closed)); assert.equal(f.timers.size, 0);
  await f.event("focus"); await f.advance(30_000); assert.equal(f.requests.length, 1); assert.equal(f.writesAfterUnmount, 0);
});
