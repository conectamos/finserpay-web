import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";
const component = name => Object.defineProperty(() => null, "name", { value: name });
const detail = (kind = "enrollment", callMode = "undecided") => ({ item: { id: "12345678-1234-4234-8234-123456789abc", kind, callMode, version: 3, state: "review", name: "Cliente sintético", ally: "Aliado de prueba", branch: "Sede de prueba", advisor: "Asesor de prueba", assignee: "Analista de prueba" }, canManage: true, canWrite: true, document: "12345", imei: "123456789012345", messages: [], events: [] });
const enrollment = (overrides = {}) => ({ available: true, version: 3, document: "12345", imei: "123456789012345", caseToken: "isolated-case-token", status: "ready", reason: null, review: null, ...overrides });
const welcome = (overrides = {}) => ({ ok: true, detail: { id: 101, clienteTelefono: "3000000000", review: { revision: 2, reviewHash: "synthetic-review" }, callRecording: { available: true, required: true, canUpload: true, recording: null } }, workVersion: 3, contextHash: "a".repeat(64), callMode: "human", voiceItems: [], ...overrides });

function mount(file, initialProps = {}) {
  let cursor = 0, dirty = false, tree, api, props, sequence = 0, timerId = 0;
  const slots = [], timers = new Map(), requests = [], updates = [], busy = [], modes = [], modules = new Map();
  let effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, index) => !Object.is(value, a[index]));
  const react = {
    useState(value) { const n = cursor++; slots[n] ??= { value: typeof value === "function" ? value() : value }; return [slots[n].value, next => { const value = typeof next === "function" ? next(slots[n].value) : next; if (!Object.is(slots[n].value, value)) { slots[n].value = value; dirty = true; } }]; },
    useRef(value) { const n = cursor++; slots[n] ??= { current: value }; return slots[n]; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!slots[n] || changed(slots[n].deps, deps)) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: fn() }; }); },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const mod = { exports: {} }; modules.set(name, mod.exports);
    const source = ts.transpileModule(readFileSync(new URL(`../app/dashboard/atencion/${name}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(source, {
      module: mod, exports: mod.exports, Error, Date, Intl, AbortController, URLSearchParams,
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` },
      document: { body: {}, visibilityState: "visible" }, window: { addEventListener() {}, removeEventListener() {} },
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
      fetch: (url, init = {}) => new Promise((resolve, reject) => requests.push({ url, init, done: false,
        respond(body, status = 200) { this.done = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); },
        fail(error) { this.done = true; reject(error); },
      })),
      require(name) {
        if (name === "react") return react;
        if (name === "react-dom") return { createPortal: value => value };
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "./attention-work-action") return load("attention-work-action.ts");
        if (name === "@/lib/atencion-work-enrollment-types" || name === "@/lib/atencion-work-welcome-types" || name === "@/lib/atencion-work-links") return load(`../../../lib/${name.split("/").at(-1)}.ts`);
        if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => component(String(key)) });
        return { default: component(name) };
      },
    });
    modules.set(name, mod.exports); return mod.exports;
  }
  props = { detail: detail(), disabled: false, onUpdated: value => updates.push(value), onBusyChange: value => busy.push(value), onCallModeChange: value => modes.push(value), ...initialProps };
  const loaded = load(file), renderComponent = file === "attention-work-action.ts" ? current => { api = loaded.useWorkAction(current); return null; } : loaded.default;
  function render() { cursor = 0; dirty = false; effects = []; tree = renderComponent(props); for (const fn of effects) fn(); }
  async function flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); if (dirty) render(); } }
  const all = () => nodes(tree), named = name => all().find(node => node.type?.name === name || node.type?.name?.endsWith(name));
  render();
  return { requests, updates, busy, modes, timers, flush, all, named, get tree() { return tree; }, get api() { return api; },
    button: label => all().find(node => node.type?.name === "Button" && text(node) === label),
    setProps(next) { props = { ...props, ...next }; render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("intento incierto conserva URL, UUID y contenido; bloquea doble acción y sólo reintenta por decisión explícita", async () => {
  const f = mount("attention-work-action.ts"), body = { version: 3, contextHash: "a".repeat(64), outcome: "HUMAN_CONTACT", observation: "Gestión sintética" };
  const first = f.api.run("/api/test/finalizar", body);
  await f.api.run("/api/test/otra", { version: 4 }); await f.flush();
  assert.equal(f.requests.length, 1); assert.equal(f.api.saving, true); assert.equal(f.busy.at(-1), true);
  const frozen = f.requests[0].init.body; f.requests[0].respond({ error: "No se confirmó el resultado" }, 503); await first; await f.flush();
  assert.ok(f.api.pending); assert.equal(f.api.saving, false); assert.equal(f.busy.at(-1), true);
  await f.api.run("/api/test/otra", { version: 4 }); await f.flush(); assert.equal(f.requests.length, 1);
  const retry = f.api.retry(); await f.api.retry(); await f.flush();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].url, "/api/test/finalizar"); assert.equal(f.requests[1].init.body, frozen);
  f.requests[1].respond({ detail: detail(), result: {}, alreadyApplied: true }); await retry; await f.flush();
  assert.equal(f.api.pending, null); assert.equal(f.updates.length, 1); assert.equal(f.busy.at(-1), false); f.unmount();
});

test("timeout y respuesta incompleta conservan intento; conflicto definitivo libera sólo ese intento", async () => {
  const f = mount("attention-work-action.ts");
  let pending = f.api.run("/api/test", { version: 3 }); f.requests[0].fail(Object.assign(new Error("interrupted"), { name: "AbortError" })); await pending; await f.flush();
  assert.match(f.api.error, /puede haberse guardado/); const frozen = f.requests[0].init.body;
  pending = f.api.retry(); f.requests[1].respond({ ok: true }); await pending; await f.flush();
  assert.ok(f.api.pending); assert.equal(f.requests[1].init.body, frozen);
  pending = f.api.retry(); f.requests[2].respond({ error: "La identidad cambió" }, 409); await pending; await f.flush();
  assert.equal(f.api.pending, null); assert.equal(f.busy.at(-1), false);
  pending = f.api.run("/api/test", { version: 4 }); assert.notEqual(JSON.parse(f.requests[3].init.body).requestId, JSON.parse(frozen).requestId);
  f.requests[3].respond({ detail: detail(), result: {} }); await pending; f.unmount();
});

test("enrolamiento exige cuatro verificaciones y confirmación antes del único POST", async () => {
  const f = mount("attention-enrollment-management.tsx"); f.requests[0].respond(enrollment()); await f.flush();
  assert.equal(f.requests.filter(r => r.init.method === "POST").length, 0);
  const approve = () => f.button("Autorizar y finalizar enrolamiento");
  assert.equal(approve().props.disabled, true);
  for (let i = 0; i < 4; i++) {
    f.all().filter(node => node.type === "input" && node.props.type === "checkbox")[i].props.onChange({ target: { checked: true } }); await f.flush();
    assert.equal(approve().props.disabled, i !== 3);
  }
  approve().props.onClick(); await f.flush(); assert.equal(f.requests.length, 1);
  f.named("finser-confirm-dialog").props.onConfirm(); await f.flush();
  const sent = f.requests.find(r => r.init.method === "POST"), payload = JSON.parse(sent.init.body);
  assert.equal(payload.action, "confirm"); assert.equal(payload.caseToken, "isolated-case-token");
  assert.deepEqual(payload.checks, { activationLock: true, abm: true, deviceLock: true, deviceUnlock: true });
  sent.respond({ error: "No confirmado" }, 503); await f.flush(); assert.equal(f.button("Consultar / reintentar mismo intento").props.disabled, false); f.unmount();
});

test("registrar autorización existente no inventa pruebas ni cambia su autor", async () => {
  const f = mount("attention-enrollment-management.tsx"); f.requests[0].respond(enrollment({ status: "approved", review: { id: "review-1", analystName: "Analista original", approvedAt: "2026-10-30T15:00:00Z" } })); await f.flush();
  assert.match(text(f.tree), /Analista original/); assert.equal(f.all().filter(node => node.type === "input" && node.props.type === "checkbox").length, 0);
  assert.equal(f.button("Registrar autorización y finalizar").props.disabled, false);
  f.button("Registrar autorización y finalizar").props.onClick(); await f.flush(); f.named("finser-confirm-dialog").props.onConfirm(); await f.flush();
  const sent = f.requests.find(r => r.init.method === "POST"), payload = JSON.parse(sent.init.body);
  assert.equal(payload.action, "record_existing"); assert.equal(Object.hasOwn(payload, "checks"), false); assert.equal(Object.hasOwn(payload, "analystName"), false);
  sent.respond({ error: "Synthetic conflict" }, 409); await f.flush(); f.unmount();
});

test("actualizar expediente descarta checklist anterior y nunca autoriza automáticamente", async () => {
  const f = mount("attention-enrollment-management.tsx"); f.requests[0].respond(enrollment()); await f.flush();
  for (const box of f.all().filter(node => node.type === "input" && node.props.type === "checkbox")) box.props.onChange({ target: { checked: true } }); await f.flush();
  f.setProps({ detail: { ...detail(), item: { ...detail().item, version: 4 } } }); await f.flush();
  f.requests.at(-1).respond(enrollment({ version: 4, imei: "999999999999999" })); await f.flush();
  assert.ok(f.all().filter(node => node.type === "input" && node.props.type === "checkbox").every(box => box.props.checked === false));
  assert.equal(f.button("Autorizar y finalizar enrolamiento").props.disabled, true);
  assert.equal(f.requests.some(r => r.init.method === "POST"), false); f.unmount();
});

test("bienvenida no inicia llamadas al abrir ni seleccionar modalidad; subida no se deshabilita a sí misma", async () => {
  const f = mount("attention-welcome-management.tsx", { detail: detail("welcome", "human") }); f.requests[0].respond(welcome()); await f.flush();
  f.all().find(node => node.type?.name === "Select").props.onChange({ target: { value: "dapta" } }); await f.flush();
  assert.deepEqual(f.modes, ["dapta"]); assert.equal(f.requests.some(r => r.init.method === "POST"), false);
  f.named("approval-call-recording").props.onBusyChange(true); await f.flush();
  assert.equal(f.busy.at(-1), true); assert.equal(f.named("approval-call-recording").props.disabled, false, "Child upload keeps its own confirmation controls");
  assert.equal(f.all().find(node => node.type?.name === "Select").props.disabled, true, "Concurrent mode changes are blocked");
  f.named("approval-call-recording").props.onBusyChange(false); await f.flush(); assert.equal(f.busy.at(-1), false); f.unmount();
});

test("contacto humano exige evidencia vigente mientras no contesta permite registrar seguimiento", async () => {
  const f = mount("attention-welcome-management.tsx", { detail: detail("welcome", "human") }); f.requests[0].respond(welcome()); await f.flush();
  const selectOutcome = value => f.all().filter(node => node.type?.name === "Select")[1].props.onChange({ target: { value } });
  selectOutcome("HUMAN_CONTACT"); f.all().find(node => node.type === "textarea").props.onChange({ target: { value: "Observación sintética" } }); await f.flush();
  assert.equal(f.button("Finalizar bienvenida").props.disabled, true); assert.match(text(f.tree), /exige la grabación/);
  selectOutcome("NO_ANSWER"); await f.flush(); assert.equal(f.button("Registrar seguimiento").props.disabled, false);
  f.button("Registrar seguimiento").props.onClick(); await f.flush(); f.named("finser-confirm-dialog").props.onConfirm(); await f.flush();
  const sent = f.requests.find(r => r.init.method === "POST"), payload = JSON.parse(sent.init.body);
  assert.equal(payload.outcome, "NO_ANSWER"); assert.equal(payload.mode, "human"); assert.equal(payload.contextHash, "a".repeat(64));
  assert.equal(Object.hasOwn(payload, "recordingId"), false); assert.equal(Object.hasOwn(payload, "voiceEventId"), false);
  sent.respond({ error: "Synthetic conflict" }, 409); await f.flush(); f.unmount();
});

test("resultado Dapta usa sólo evidencia de esa modalidad aunque exista grabación humana", async () => {
  const voice = { id: "22345678-1234-4234-8234-123456789abc", status: "COMPLETED", source: "OPERATOR_REQUEST", providerCallId: "provider-test", communicationOutcome: "HUMAN_CONTACT", completedAt: "2026-10-30T15:00:00Z", createdAt: "2026-10-30T15:00:00Z" };
  const recording = { id: "32345678-1234-4234-8234-123456789abc" };
  const view = welcome(); view.detail.callRecording.recording = recording; view.voiceItems = [voice];
  const f = mount("attention-welcome-management.tsx", { detail: detail("welcome", "dapta") }); f.requests[0].respond(view); await f.flush();
  f.all().filter(node => node.type?.name === "Select")[1].props.onChange({ target: { value: voice.id } });
  f.all().find(node => node.type === "textarea").props.onChange({ target: { value: "Resultado del agente verificado" } }); await f.flush();
  f.button("Finalizar bienvenida").props.onClick(); await f.flush(); f.named("finser-confirm-dialog").props.onConfirm(); await f.flush();
  const sent = f.requests.find(r => r.init.method === "POST"), payload = JSON.parse(sent.init.body);
  assert.equal(payload.mode, "dapta"); assert.equal(payload.voiceEventId, voice.id); assert.equal(Object.hasOwn(payload, "recordingId"), false);
  sent.respond({ error: "Synthetic conflict" }, 409); await f.flush(); f.unmount();
});

test("Dapta permite seguimiento no contestado y excluye pruebas, llamadas pendientes o sin evidencia", async () => {
  const base = { status: "COMPLETED", source: "OPERATOR_REQUEST", providerCallId: "provider-test", communicationOutcome: "NO_ANSWER", completedAt: "2026-10-30T15:00:00Z", createdAt: "2026-10-30T15:00:00Z" };
  const valid = { ...base, id: "22345678-1234-4234-8234-123456789abc" };
  const calls = [valid, { ...base, id: "test-call", source: "CONTROLLED_TEST" }, { ...base, id: "pending-call", status: "DISPATCHING" }, { ...base, id: "no-provider", providerCallId: null }, { ...base, id: "no-time", completedAt: null }, { ...base, id: "unknown-outcome", communicationOutcome: "UNKNOWN" }];
  const f = mount("attention-welcome-management.tsx", { detail: detail("welcome", "dapta") }); f.requests[0].respond(welcome({ voiceItems: calls })); await f.flush();
  const chooser = f.all().filter(node => node.type?.name === "Select")[1];
  assert.deepEqual(nodes(chooser).filter(node => node.type === "option").map(node => node.props.value), ["", valid.id]);
  chooser.props.onChange({ target: { value: valid.id } }); f.all().find(node => node.type === "textarea").props.onChange({ target: { value: "No contestó. Requiere continuidad." } }); await f.flush();
  assert.equal(f.button("Registrar seguimiento").props.disabled, false); assert.match(text(f.tree), /continuará en revisión/);
  f.button("Registrar seguimiento").props.onClick(); await f.flush(); f.named("finser-confirm-dialog").props.onConfirm(); await f.flush();
  const sent = f.requests.find(request => request.init.method === "POST"); assert.equal(JSON.parse(sent.init.body).outcome, "NO_ANSWER");
  sent.respond({ error: "Synthetic conflict" }, 409); await f.flush(); f.unmount();
});

test("llamada Dapta conserva su propio control mientras bloquea una gestión simultánea", async () => {
  const f = mount("attention-welcome-management.tsx", { detail: detail("welcome", "dapta") }); f.requests[0].respond(welcome()); await f.flush();
  f.named("credit-welcome-voice-result").props.onBusyChange(true); await f.flush();
  assert.equal(f.busy.at(-1), true); assert.equal(f.named("credit-welcome-voice-result").props.disabled, false);
  assert.equal(f.all().find(node => node.type?.name === "Select").props.disabled, true);
  assert.equal(f.requests.some(request => request.init.method === "POST"), false);
  f.named("credit-welcome-voice-result").props.onBusyChange(false); await f.flush(); assert.equal(f.busy.at(-1), false); f.unmount();
});

test("panel de gestión no se monta para asesor y separa bloqueo propio del bloqueo externo", () => {
  const denied = mount("attention-work-management.tsx", { open: true, detail: { ...detail(), canManage: false }, busy: false });
  assert.equal(denied.tree, null); denied.unmount();
  const allowed = mount("attention-work-management.tsx", { open: true, detail: detail(), busy: true, disabled: false });
  assert.equal(allowed.named("finser-side-panel").props.busy, true);
  assert.equal(allowed.named("attention-enrollment-management").props.disabled, false);
  allowed.setProps({ disabled: true }); assert.equal(allowed.named("attention-enrollment-management").props.disabled, true); allowed.unmount();
});

test("bienvenida ofrece el muro vinculado sin descartar la gestión; inconsistencias y bloqueo no exponen otro crédito", () => {
  const linked={...detail("welcome"),item:{...detail("welcome").item,target:"C-101"},operationHref:"/dashboard/aprobaciones?credito=101"};
  const f=mount("attention-work-management.tsx",{open:true,detail:linked,busy:false});
  const link=()=>f.all().find(n=>n.type==="a"&&text(n)==="Abrir muro del crédito");
  assert.equal(link().props.href,`${linked.operationHref}&solicitud=${linked.item.id}`);assert.equal(link().props.target,"_blank");assert.equal(link().props.rel,"noopener noreferrer");
  assert.ok(f.named("attention-welcome-management"));assert.match(text(f.tree),/Vuelve a este chat para registrar el resultado/);assert.equal(f.requests.length,0);
  f.setProps({busy:true});assert.equal(link(),undefined);assert.equal(f.button("Abrir muro del crédito").props.disabled,true);
  f.setProps({busy:false,detail:{...linked,operationHref:"/dashboard/aprobaciones?credito=999"}});assert.equal(link(),undefined);assert.match(text(f.tree),/El muro no está disponible/);
  f.setProps({detail:{...linked,canManage:false}});assert.equal(f.tree,null);
  f.setProps({detail:detail("enrollment")});assert.equal(link(),undefined);assert.ok(f.named("attention-enrollment-management"));f.unmount();
});

test("la gestión abierta desde la burbuja del muro conserva su formulario sin volver a abrir otro muro", () => {
  const linked = { ...detail("welcome"), item: { ...detail("welcome").item, target: "C-101" }, operationHref: "/dashboard/aprobaciones?credito=101" };
  const f = mount("attention-work-management.tsx", { open: true, detail: linked, busy: false, welcomeWallOpen: true });
  assert.equal(f.all().some(node => node.type === "a"), false);
  assert.doesNotMatch(text(f.tree), /Expediente del crédito|Abrir muro del crédito|Se abre en otra pestaña/);
  assert.ok(f.named("attention-welcome-management"));
  assert.equal(f.requests.length, 0, "abrir gestión no inicia llamadas ni envíos");
  f.setProps({ detail: detail("enrollment") });
  assert.ok(f.named("attention-enrollment-management"), "el enrolamiento conserva su gestión");
  f.unmount();
});
