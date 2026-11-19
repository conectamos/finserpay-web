import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/credit-historical-plan-correction-panel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
}
function harness(fetchImpl = async () => { throw new Error("Unexpected request"); }, sessionStorage = storage()) {
  const state = [], exports = {};
  let cursor = 0, effects = [], uuid = 0;
  vm.runInNewContext(compiled, {
    exports, fetch: fetchImpl, AbortController, window: { sessionStorage }, crypto: { randomUUID: () => `historical-request-${++uuid}` },
    require(name) {
      if (name === "react") return {
        useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial; return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }]; },
        useRef(initial) { const i = cursor++; return state[i] ??= { current: initial }; },
        useEffect(effect, deps) { const i = cursor++; const old = state[i]; if (!old || deps.some((dep, index) => dep !== old.deps[index])) effects.push(() => { old?.cleanup?.(); state[i] = { deps, cleanup: effect() }; }); },
      };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith("finser-ui")) return { Button: "Button", Input: "Input", Select: "Select" };
      if (name.endsWith("finser-confirm-dialog")) return { default: "ConfirmDialog" };
      if (name === "@/lib/credit-factory") return { MAX_CREDIT_INSTALLMENTS: 60, PAYMENT_FREQUENCY_OPTIONS: ["QUINCENAL", "MENSUAL", "SEMANAL", "CATORCENAL"].map(value => ({ value, label: value })) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { exports, sessionStorage, render(props) { cursor = 0; effects = []; const tree = exports.default(props); effects.forEach(effect => effect()); return tree; }, unmount() { state.forEach(item => item?.cleanup?.()); } };
}
function all(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(child => all(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
function text(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}
function button(tree, label) { return all(tree, node => node.type === "Button" && label.test(text(node)))[0]; }
function field(tree, label) { const wrapper = all(tree, node => node.type === "label" && text(node).startsWith(label))[0]; return all(wrapper, node => ["Input", "Select", "input"].includes(node.type))[0]; }
const response = data => ({ ok: true, status: 200, json: async () => data });
const context = { ok: true, eligible: true, creditoId: 101, plazoMeses: 36, frecuenciaPago: "QUINCENAL", valorCuota: 136450, proximaCuota: { numero: 5, fechaVencimiento: "2026-11-17", valorProgramado: 136450 } };
const form = { plazoMeses: "48", cuotasPagadas: "5", valorCuota: "106.000", frecuenciaPago: "QUINCENAL", fechaProximaCuota: "2026-12-02", motivo: "Corrección documentada por administrador" };
const fields = { ...form, plazoMeses: 48, cuotasPagadas: 5, valorCuota: 106000 };
const quote = { ...fields, montoCreditoActualizado: 5180350, totalPlanNominal: 5088000, totalAbonadoAlCorte: 622350, diferenciaHistorica: 92350, saldoPendiente: 4558000, cuotasPendientes: 43, proximaCuota: { numero: 6, fechaVencimiento: "2026-12-02", valor: 106000 } };
const quoteHash = "b".repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function ready(fetchImpl, sessionStorage) {
  const requests = [];
  const runtime = harness(async (url, options) => {
    requests.push({ url, options });
    return !options?.method ? response(context) : fetchImpl(url, options);
  }, sessionStorage);
  let applied = 0;
  const props = { creditId: 101, revisionKey: "revision-1", onApplied: async () => { applied++; } };
  button(runtime.render(props), /^Corregir plan histórico$/).props.onClick();
  runtime.render(props);
  await tick();
  const update = (label, value) => field(runtime.render(props), label).props.onChange({ target: { value } });
  if (!sessionStorage?.values.size) {
    update("Cuotas totales", "48"); update("Cuotas reconocidas", "5"); update("Valor de cada", "106.000");
    update("Fecha de la próxima", "2026-12-02"); update("Motivo de la", form.motivo);
  }
  return { runtime, props, requests, render: () => runtime.render(props), applied: () => applied };
}
async function preview(ready) { await button(ready.render(), /^Previsualizar/).props.onClick(); await tick(); }
function acknowledgeAndOpen(ready) {
  field(ready.render(), "Reconozco la diferencia").props.onChange({ target: { checked: true } });
  button(ready.render(), /^Revisar y confirmar/).props.onClick();
  return all(ready.render(), node => node.type === "ConfirmDialog")[0];
}

test("payload mantiene cuotas reconocidas separadas de los recaudos y usa el calendario quincenal", () => {
  const build = harness().exports.buildHistoricalCorrectionPayload;
  const payload = build(form);
  assert.equal(payload.plazoMeses, 48); assert.equal(payload.cuotasPagadas, 5); assert.equal(payload.valorCuota, 106000);
  assert.equal(payload.fechaProximaCuota, "2026-12-02");
  for (const patch of [{ cuotasPagadas: "48" }, { cuotasPagadas: "" }, { plazoMeses: "61" }, { valorCuota: "0" }, { valorCuota: "1e6" }, { motivo: "Corto" }, { fechaProximaCuota: "2026-12-03" }, { fechaProximaCuota: "2026-02-30" }]) assert.throws(() => build({ ...form, ...patch }));
});

test("abrir consulta contexto; editar no modifica el crédito ni envía un preview implícito", async () => {
  const fixture = await ready(async () => { throw new Error("Unexpected mutation"); });
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].options.method, undefined);
  assert.equal(fixture.applied(), 0);
  fixture.runtime.unmount();
});

test("preview distingue los importes nominal, operativo y diferencia; confirmar exige reconocimiento y diálogo", async () => {
  const fixture = await ready(async () => response({ ok: true, quote, quoteHash }));
  await preview(fixture);
  const tree = fixture.render();
  assert.match(text(tree), /Total nominal del plan/); assert.match(text(tree), /Total operativo/);
  assert.equal(button(tree, /^Revisar y confirmar/).props.disabled, true);
  assert.equal(fixture.requests.length, 2);
  const dialog = acknowledgeAndOpen(fixture);
  assert.equal(dialog.props.open, true);
  assert.equal(fixture.requests.length, 2, "abrir el diálogo no confirma la operación");
  assert.match(dialog.props.description, /43 cuotas/); assert.match(dialog.props.description, /02\/12\/2026/);
  fixture.runtime.unmount();
});

test("un preview incoherente queda bloqueado", async () => {
  const fixture = await ready(async () => response({ ok: true, quote: { ...quote, saldoPendiente: 4465650 }, quoteHash }));
  await preview(fixture);
  assert.match(text(fixture.render()), /no coincide con el ajuste/);
  assert.equal(button(fixture.render(), /^Revisar y confirmar/), undefined);
  fixture.runtime.unmount();
});

test("doble confirmación guarda una sola revisión y recarga únicamente tras éxito", async () => {
  const fixture = await ready(async (_url, options) => JSON.parse(options.body).accion === "PREVISUALIZAR" ? response({ ok: true, quote, quoteHash }) : response({ ok: true, aplicado: true, quote }));
  await preview(fixture);
  const dialog = acknowledgeAndOpen(fixture);
  dialog.props.onConfirm(); dialog.props.onConfirm();
  await tick();
  assert.equal(fixture.requests.filter(item => item.options.method === "POST").length, 2);
  assert.equal(fixture.applied(), 1); assert.equal(fixture.runtime.sessionStorage.values.size, 0);
  assert.match(text(fixture.render()), /Corrección aplicada/);
  fixture.runtime.unmount();
});

test("una respuesta incierta conserva el payload exacto y reintenta la misma idempotencia", async () => {
  let confirmations = 0;
  const fixture = await ready(async (_url, options) => {
    if (JSON.parse(options.body).accion === "PREVISUALIZAR") return response({ ok: true, quote, quoteHash });
    if (++confirmations === 1) throw new Error("Conexión interrumpida");
    return response({ ok: true, aplicado: true });
  });
  await preview(fixture); acknowledgeAndOpen(fixture).props.onConfirm(); await tick();
  const first = JSON.parse(fixture.requests.at(-1).options.body);
  assert.equal(fixture.applied(), 0); assert.equal(fixture.runtime.sessionStorage.values.size, 1);
  await button(fixture.render(), /^Verificar corrección pendiente/).props.onClick(); await tick();
  const second = JSON.parse(fixture.requests.at(-1).options.body);
  assert.deepEqual(second, first); assert.equal(fixture.applied(), 1);
  fixture.runtime.unmount();
});

test("cambiar un campo invalida la previsualización y cambiar de crédito no recupera otra confirmación", async () => {
  const fixture = await ready(async () => response({ ok: true, quote, quoteHash }));
  await preview(fixture);
  field(fixture.render(), "Cuotas totales").props.onChange({ target: { value: "49" } });
  assert.equal(button(fixture.render(), /^Revisar y confirmar/), undefined);
  const read = fixture.runtime.exports.readHistoricalCorrectionPending;
  const pending = { version: 1, creditId: 101, request: { ...fields, accion: "CONFIRMAR", quoteHash, idempotencyKey: "historical-replay-01" } };
  assert.equal(read(JSON.stringify(pending), 101).idempotencyKey, "historical-replay-01");
  assert.throws(() => read(JSON.stringify(pending), 102));
  assert.throws(() => read("{broken", 101));
  assert.throws(() => read(JSON.stringify({ ...pending, request: { ...pending.request, cuotasPagadas: 49 } }), 101));
  fixture.runtime.unmount();
});

test("un rechazo definitivo de versión permite una nueva previsualización sin dejar una confirmación atascada", async () => {
  const fixture = await ready(async (_url, options) => JSON.parse(options.body).accion === "PREVISUALIZAR"
    ? response({ ok: true, quote, quoteHash })
    : { ok: false, status: 409, json: async () => ({ error: "El crédito o sus recibos cambiaron." }) });
  await preview(fixture); acknowledgeAndOpen(fixture).props.onConfirm(); await tick();
  assert.equal(fixture.applied(), 0); assert.equal(fixture.runtime.sessionStorage.values.size, 0);
  assert.match(text(fixture.render()), /recibos cambiaron/);
  assert.ok(button(fixture.render(), /^Previsualizar/));
  assert.equal(button(fixture.render(), /^Verificar corrección pendiente/), undefined);
  fixture.runtime.unmount();
});

test("cerrar durante la consulta de contexto libera el estado ocupado del expediente", async () => {
  const busy = [];
  const runtime = harness(() => new Promise(() => {}));
  const props = { creditId: 101, revisionKey: "revision-1", onBusyChange: value => busy.push(value), onApplied: async () => {} };
  button(runtime.render(props), /^Corregir plan histórico$/).props.onClick();
  runtime.render(props); runtime.render(props);
  assert.equal(busy.at(-1), true);
  button(runtime.render(props), /^Cerrar corrección/).props.onClick();
  runtime.render(props); runtime.render(props);
  assert.equal(busy.at(-1), false);
  runtime.unmount();
});

test("una previsualización anterior no se presenta después de cambiar la versión del crédito", async () => {
  let resolvePreview;
  const fixture = await ready(async () => new Promise(resolve => { resolvePreview = resolve; }));
  button(fixture.render(), /^Previsualizar/).props.onClick();
  fixture.props.revisionKey = "revision-2";
  fixture.render();
  resolvePreview(response({ ok: true, quote, quoteHash }));
  await tick();
  assert.equal(button(fixture.render(), /^Revisar y confirmar/), undefined);
  assert.equal(fixture.applied(), 0);
  fixture.runtime.unmount();
});
