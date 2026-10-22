import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/pending-signature-recovery.tsx", import.meta.url), "utf8");
const dispatchId = "00000000-0000-4000-8000-000000003482";
const processUuid = "11111111111141118111111111111111";
const reason = "Revisé el cliente y el folio en el portal de FirmaSeguro.";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(overrides = {}) {
  const states = [], refs = [], effectDeps = [], cleanups = [], requests = [], recovered = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, effects = [], timerId = 0;
  const timers = new Map();
  const React = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect(callback, deps) { const index = effectIndex++; const before = effectDeps[index]; if (!before || deps.some((value, i) => value !== before[i])) { effectDeps[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); }); } },
  };
  let transport = async url => ({ ok: true, status: url.endsWith("conciliar") ? "AWAITING_SIGNATURE" : "PREPARING" });
  const context = { module: { exports: {} }, Error, JSON, Number, AbortController,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); const result = await transport(url, options); return { ok: result.httpOk ?? true, status: result.httpStatus ?? 200, json: async () => result }; },
    require(name) { if (name === "react") return React; if (name === "react/jsx-runtime") return jsxRuntime; if (name.endsWith("finser-ui")) return { Button: "button", Input: "input" }; if (name.endsWith("finser-confirm-dialog")) return { __esModule: true, default: "confirm-dialog" }; assert.fail(name); },
  };
  context.exports = context.module.exports;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, context);
  let props = { draftId: 3482, dispatchId, canRecover: true, onRecovered() { recovered.push(true); }, ...overrides };
  const render = () => { stateIndex = 0; refIndex = 0; effectIndex = 0; const tree = context.module.exports.default(props); const pending = effects; effects = []; pending.forEach(effect => effect()); return tree; };
  render();
  return { render, requests, recovered, setTransport(value) { transport = value; }, updateProps(value) { props = { ...props, ...value }; render(); }, unmount() { cleanups.forEach(cleanup => cleanup?.()); }, pendingTimers: () => timers.size,
    async expire() { for (const [id, timer] of timers) { timers.delete(id); timer.callback(); } await flush(); },
  };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  return (Array.isArray(children) ? children.flat(Infinity) : [children]).map(child => find(child, predicate)).find(Boolean) || null;
}
const text = node => typeof node === "string" ? node : !node || typeof node !== "object" ? "" : (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join(" ");
const button = (tree, label) => find(tree, node => node.type === "button" && text(node).includes(label));
const input = (tree, type = "input") => find(tree, node => node.type === type);
const dialog = tree => find(tree, node => node.type === "confirm-dialog");
function open(f) { const toggle = button(f.render(), "Resolver envío"); if (!toggle.props["aria-expanded"]) toggle.props.onClick(); return f.render(); }
function prepare(f) {
  open(f); button(f.render(), "No pude localizarlo").props.onClick();
  input(f.render(), "textarea").props.onChange({ target: { value: reason } });
  const checkboxes = []; const visit = node => { if (!node || typeof node !== "object") return; if (node.type === "input" && node.props.type === "checkbox") checkboxes.push(node); const children = node.props?.children; (Array.isArray(children) ? children.flat(Infinity) : [children]).forEach(visit); }; visit(f.render());
  checkboxes.forEach(checkbox => checkbox.props.onChange({ target: { checked: true } }));
}
function ask(f) { find(f.render(), node => node.type === "form").props.onSubmit({ preventDefault() {} }); return dialog(f.render()); }

test("se oculta sin permiso o contexto válido, y abrirlo no consulta ni envía al proveedor", () => {
  for (const props of [{ canRecover: false }, { draftId: 0 }, { draftId: 1.5 }, { dispatchId: "otro" }]) {
    const f = fixture(props); assert.equal(f.render(), null); assert.equal(f.requests.length, 0);
  }
  const f = fixture(); const tree = open(f);
  assert.match(text(tree), /502 no demuestra/); assert.equal(f.requests.length, 0);
  assert.equal(button(tree, "Verificar y vincular").props.disabled, true);
  assert.equal(find(tree, node => node.type === "a").props.href, "https://app.firmaseguro.co/Process/List");
});

test("conciliar exige un UUID válido y confirma antes de vincular el mismo proceso sin enviar", async () => {
  const f = fixture(); open(f);
  input(f.render()).props.onChange({ target: { value: "https://otro.example/process" } });
  ask(f); assert.equal(dialog(f.render()).props.open, false); assert.equal(f.requests.length, 0);
  input(f.render()).props.onChange({ target: { value: ` ${processUuid} ` } });
  const confirmation = ask(f); assert.equal(confirmation.props.open, true); assert.equal(confirmation.props.danger, false);
  assert.equal(f.requests.length, 0); confirmation.props.onConfirm(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/creditos/borradores/3482/firma-seguro/conciliar");
  assert.deepEqual(f.requests[0].body, { dispatchId, processUuid }); assert.equal(f.requests[0].method, "POST");
  assert.equal(f.recovered.length, 1); assert.equal(f.render(), null); assert.equal(f.pendingTimers(), 0);
});

test("preparar requiere motivo y las dos confirmaciones; el diálogo final conserva la incertidumbre", async () => {
  const f = fixture(); open(f); button(f.render(), "No pude localizarlo").props.onClick();
  assert.equal(button(f.render(), "Revisar recuperación").props.disabled, true);
  input(f.render(), "textarea").props.onChange({ target: { value: "Motivo muy corto" } }); ask(f);
  assert.equal(dialog(f.render()).props.open, false);
  prepare(f); const confirmation = ask(f);
  assert.equal(confirmation.props.open, true); assert.equal(confirmation.props.danger, true);
  assert.match(confirmation.props.description, /incierto/); assert.match(confirmation.props.description, /no se enviará/);
  assert.equal(f.requests.length, 0); confirmation.props.onConfirm(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/creditos/borradores/3482/firma-seguro/recuperar");
  assert.deepEqual(f.requests[0].body, { dispatchId, reason, providerReviewConfirmed: true, remoteOutcomeUnknownAccepted: true });
  assert.equal(f.recovered.length, 1);
  assert.equal(f.requests.some(request => /create-full|\/firma-seguro$/.test(request.url)), false);
});

test("doble confirmación comparte una sola petición y no permite cerrar mientras se procesa", async () => {
  const f = fixture(); let finish; f.setTransport(() => new Promise(resolve => { finish = resolve; }));
  prepare(f); const confirmation = ask(f); confirmation.props.onConfirm(); confirmation.props.onConfirm();
  assert.equal(f.requests.length, 1); assert.equal(dialog(f.render()).props.busy, true);
  dialog(f.render()).props.onCancel(); assert.equal(dialog(f.render()).props.open, true);
  finish({ ok: true, status: "PREPARING" }); await flush(); assert.equal(f.recovered.length, 1);
});

test("errores o estados inesperados no se muestran crudos ni anuncian una recuperación", async () => {
  for (const reply of [{ ok: false, httpOk: false, error: "token=private postgres error", code: "INTERNAL" }, { ok: true, status: "DISPATCHING" }, { ok: true }, { ok: false, code: "DRAFT_ADMINISTRATIVE_STATE" }]) {
    const f = fixture(); f.setTransport(async () => reply); prepare(f); ask(f).props.onConfirm(); await flush();
    const tree = f.render(); assert.equal(f.recovered.length, 0); assert.ok(find(tree, node => node.props?.role === "alert"));
    assert.doesNotMatch(text(tree), /token=|postgres|private/); assert.equal(input(tree, "textarea").props.value, reason);
    assert.equal(f.requests.length, 1); assert.equal(f.pendingTimers(), 0);
  }
});

test("los rechazos contractuales o de identidad indican la revisión necesaria sin habilitar otro intento", async () => {
  for (const [code, expected, unchanged] of [
    ["DRAFT_ADMINISTRATIVE_CONTRACT_INVALID", /integridad o la fecha del contrato requiere revisión/, /No se habilitó otro intento ni se cambiaron los valores/],
    ["DRAFT_ADMINISTRATIVE_IDENTITY_CHANGED", /validación de identidad cambió o ya no está aprobada/, /revisa la identidad del cliente/],
  ]) {
    const f = fixture(); f.setTransport(async () => ({ ok: false, httpOk: false, httpStatus: 409, code, error: "postgres internal context: private-token" }));
    prepare(f); ask(f).props.onConfirm(); await flush();
    const tree = f.render(); const alert = find(tree, node => node.props?.role === "alert");
    assert.match(text(alert), expected); assert.match(text(alert), unchanged);
    assert.doesNotMatch(text(tree), /postgres|internal|private-token/);
    assert.equal(f.recovered.length, 0); assert.equal(f.requests.length, 1);
    assert.equal(input(tree, "textarea").props.value, reason);
    assert.equal(dialog(tree).props.open, false);
  }
});

test("los cambios de solicitud, evidencia y confirmación muestran instrucciones específicas por código permitido", async () => {
  for (const [code, expected] of [
    ["DRAFT_ADMINISTRATIVE_STATE", /consulta o vincula el proceso existente/],
    ["DRAFT_ADMINISTRATIVE_DRAFT_CHANGED", /solicitud venció o sus datos cambiaron/],
    ["DRAFT_ADMINISTRATIVE_EVIDENCE_CHANGED", /proceso, un comprobante u otra recuperación/],
    ["DRAFT_ADMINISTRATIVE_REPLAY_CONFLICT", /responsable que la autorizó/],
  ]) {
    const f = fixture(); f.setTransport(async () => ({ ok: false, httpOk: false, code, error: "No mostrar este cuerpo remoto" }));
    prepare(f); ask(f).props.onConfirm(); await flush();
    assert.match(text(find(f.render(), node => node.props?.role === "alert")), expected);
    assert.doesNotMatch(text(f.render()), /No mostrar este cuerpo remoto/);
    assert.equal(f.recovered.length, 0); assert.equal(f.requests.length, 1);
  }
});

test("una respuesta tardía de otra solicitud o con permiso revocado no afecta la vista actual", async () => {
  for (const changes of [{ draftId: 9999 }, { dispatchId: "00000000-0000-4000-8000-000000009999" }, { canRecover: false }]) {
    const f = fixture(); let finish; f.setTransport(() => new Promise(resolve => { finish = resolve; }));
    prepare(f); ask(f).props.onConfirm(); f.updateProps(changes); finish({ ok: true, status: "PREPARING" }); await flush();
    assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.recovered.length, 0); assert.equal(f.pendingTimers(), 0);
  }
});

test("timeout o desmontaje abortan y limpian el temporizador sin reintentos automáticos", async () => {
  const f = fixture(); f.setTransport(() => new Promise(() => {})); prepare(f); ask(f).props.onConfirm();
  assert.equal(f.pendingTimers(), 1); await f.expire();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.pendingTimers(), 0); assert.equal(f.recovered.length, 0);
  assert.match(text(f.render()), /Actualiza la solicitud antes de repetir/); assert.equal(f.requests.length, 1);
  const gone = fixture(); gone.setTransport(() => new Promise(() => {})); prepare(gone); ask(gone).props.onConfirm(); gone.unmount(); await flush();
  assert.equal(gone.requests[0].signal.aborted, true); assert.equal(gone.pendingTimers(), 0); assert.equal(gone.recovered.length, 0);
});
