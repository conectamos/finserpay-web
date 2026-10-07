import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createJiti} from "jiti";
const paymentMethods=await createJiti(import.meta.url).import("../lib/payment-methods.ts");

const source = readFileSync(new URL("../app/dashboard/creditos/credit-principal-payment-panel.tsx", import.meta.url), "utf8");
const factory = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
    items,
  };
}

function harness(fetchImpl = async () => { throw new Error("Unexpected request"); }, storage = memoryStorage()) {
  const state = [];
  let cursor = 0;
  let effects = [];
  const exports = {};
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      return state[index] ??= { current: initial };
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const old = state[index];
      if (!old || dependencies.some((value, position) => value !== old.dependencies[position])) {
        effects.push(() => { old?.cleanup?.(); state[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  let uuid = 0;
  const windowListeners = new Map();
  const documentListeners = new Map();
  vm.runInNewContext(compiled, {
    exports, fetch: fetchImpl, AbortController, crypto: { randomUUID: () => `test-idempotency-${++uuid}` },
    window: {
      sessionStorage: storage, confirm: () => false,
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      removeEventListener: (name) => windowListeners.delete(name),
    },
    document: {
      addEventListener: (name, callback) => documentListeners.set(name, callback),
      removeEventListener: (name) => documentListeners.delete(name),
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith("finser-confirm-dialog")) return { default: "ConfirmDialog" };
      if (name.endsWith("finser-ui")) return Object.fromEntries(["Badge", "Button", "Card", "DataTable", "Input", "Select"].map((name) => [name, name]));
      if(name === "@/lib/payment-methods") return paymentMethods;
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { exports, storage, windowListeners, documentListeners, unmount() {
    state.forEach((entry) => entry?.cleanup?.());
  }, render(props) {
    cursor = 0; effects = [];
    const tree = exports.default(props);
    effects.forEach((effect) => effect());
    return tree;
  } };
}

function all(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => all(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
function text(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "object") return text(tree.props?.children);
  return String(tree);
}
function button(tree, label) {
  return all(tree, (item) => item.type === "Button" && label.test(text(item)))[0];
}
function input(tree, label) {
  const wrapper = all(tree, (item) => item.type === "label" && text(item).startsWith(label))[0];
  return all(wrapper, (item) => item.type === "Input" || item.type === "input")[0];
}

const credit = { id: 101, cuotaHabitual: 100000, numeroProximaCuota: 4, revisionKey: "revision-1" };
const form = {
  valor: "200000", capitalPendiente: "1000000", tasaPeriodo: "0,01", cuotaCredito: "70000",
  fianzaCuota: "29000", seguroCuota: "1000", fuente: "Estado de cuenta conciliado al corte", metodoPago: "EFECTIVO", observacion: "",
};
const quote = {
  saldoCapitalAntes: 1000000, saldoCapitalDespues: 800000, abonoCapital: 200000, cuotaHabitual: 100000,
  ultimaCuota: { numero: 15, fechaVencimiento: "2027-03-17", valor: 60000 },
  cuotasPendientesAntes: 15, cuotasPendientesDespues: 12, cuotasEliminadas: 3,
  saldoPendienteAntes: 1500000, saldoPendienteDespues: 1160000,
  planCapitalVigente: { cuotas: [{ numero: 4, fechaVencimiento: "2026-10-02", valorProgramado: 100000, valorAbonadoAlCorte: 900, capital: 62000, interes: 8000, fianza: 29000, seguro: 1000 }] },
};
const quoteHash = "a".repeat(64);
const okPreview = () => ({ ok: true, status: 200, json: async () => ({ ok: true, quote, quoteHash }) });

test("primer abono exige conciliación y confirmación de pagos ordinarios", () => {
  const { buildPrincipalPaymentPayload } = harness().exports;
  assert.throws(() => buildPrincipalPaymentPayload(form, credit, true, false), /pagos ordinarios/);
  assert.throws(() => buildPrincipalPaymentPayload(form, credit, false, true), /fuente/);
  assert.throws(() => buildPrincipalPaymentPayload({ ...form, fuente: "" }, credit, true, true), /fuente/);
});

test("la conciliación transmite la tasa periódica decimal y componentes documentados", () => {
  const payload = harness().exports.buildPrincipalPaymentPayload(form, credit, true, true);
  assert.equal(payload.conciliacion.tasaPeriodo, 0.01);
  assert.equal(payload.conciliacion.capitalPendiente, 1000000);
  assert.equal(payload.conciliacion.numeroProximaCuota, 4);
  assert.equal(payload.valor, 200000);
});

test("rechaza cuota incompleta, tasa anual, capital insuficiente y próxima cuota desconocida", () => {
  const build = harness().exports.buildPrincipalPaymentPayload;
  for (const patch of [{ seguroCuota: "" }, { cuotaCredito: "65000" }, { tasaPeriodo: "29.24" }, { capitalPendiente: "200000" }, { valor: "NaN" }, { valor: "0" }]) {
    assert.throws(() => build({ ...form, ...patch }, credit, true, true));
  }
  assert.throws(() => build(form, { ...credit, numeroProximaCuota: null }, true, true), /próxima cuota/);
});

test("plan vigente usa el snapshot del servidor sin permitir reemplazar su conciliación", () => {
  const payload = harness().exports.buildPrincipalPaymentPayload(form, { ...credit, planCapitalVigente: { version: 1 } }, false, true);
  assert.equal(payload.conciliacion, undefined);
});

function readyHarness(fetchImpl, storage) {
  const runtime = harness(fetchImpl, storage);
  let applied = 0;
  const props = { credit: { ...credit, planCapitalVigente: { version: 1 } }, onBusyChange() {}, onApplied() { applied += 1; } };
  let tree = runtime.render(props);
  button(tree, /Preparar abono/).props.onClick();
  tree = runtime.render(props);
  input(tree, "Valor adicional").props.onChange({ target: { value: "200.000" } });
  input(tree, "Ya registré").props.onChange({ target: { checked: true } });
  return { runtime, props, render: () => runtime.render(props), applied: () => applied };
}

test("abrir o editar no registra pagos; solo preview explícita consulta el plan", async () => {
  const requests = [];
  const ready = readyHarness(async (url, options) => { requests.push(JSON.parse(options.body)); return okPreview(); });
  assert.equal(requests.length, 0);
  await button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].accion, "PREVISUALIZAR");
  assert.match(text(ready.render()), /Resultado antes de registrar/);
  assert.equal(ready.applied(), 0);
});

test("confirmar exige diálogo y refresca solo tras respuesta exitosa", async () => {
  const requests = [];
  const ready = readyHarness(async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return body.accion === "PREVISUALIZAR" ? okPreview() : { ok: true, status: 200, json: async () => ({ ok: true, item: { id: 55 } }) };
  });
  button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  button(ready.render(), /^Registrar /).props.onClick();
  assert.equal(requests.length, 1);
  const dialog = all(ready.render(), (item) => item.type === "ConfirmDialog")[0];
  assert.equal(dialog.props.open, true);
  dialog.props.onConfirm(); dialog.props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, "doble clic no debe generar dos solicitudes");
  assert.equal(requests[1].accion, "CONFIRMAR");
  assert.equal(requests[1].quoteHash, quoteHash);
  assert.equal(ready.applied(), 1);
  assert.match(text(ready.render()), /Abono a capital registrado/);
});

test("error de red conserva exactamente la misma operación al reintentar", async () => {
  const requests = [];
  const ready = readyHarness(async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.accion === "PREVISUALIZAR") return okPreview();
    if (requests.length === 2) throw new Error("Red interrumpida");
    return { ok: true, status: 200, json: async () => ({ ok: true, item: { id: 55 }, alreadyApplied: true }) };
  });
  button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  button(ready.render(), /^Registrar /).props.onClick();
  all(ready.render(), (item) => item.type === "ConfirmDialog")[0].props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = ready.render();
  assert.equal(input(tree, "Valor adicional").props.disabled, true);
  button(tree, /reintentar misma operación/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(ready.applied(), 1);
});

test("un 409 descarta la cotización y exige nueva previsualización", async () => {
  const ready = readyHarness(async (url, options) => JSON.parse(options.body).accion === "PREVISUALIZAR" ? okPreview() : {
    ok: false, status: 409, json: async () => ({ ok: false, error: "Cambió el saldo" }),
  });
  button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  button(ready.render(), /^Registrar /).props.onClick();
  all(ready.render(), (item) => item.type === "ConfirmDialog")[0].props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve));
  const tree = ready.render();
  assert.match(text(tree), /genera una nueva previsualización/);
  assert.equal(button(tree, /^Registrar /), undefined);
  assert.equal(ready.applied(), 0);
});

test("respuesta de preview de una revisión anterior no habilita confirmar", async () => {
  let resolveFetch;
  const ready = readyHarness(() => new Promise((resolve) => { resolveFetch = resolve; }));
  button(ready.render(), /Previsualizar/).props.onClick();
  ready.props.credit = { ...ready.props.credit, revisionKey: "revision-2" };
  ready.render();
  resolveFetch(okPreview());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button(ready.render(), /^Registrar /), undefined);
});

test("cambiar importe o estado del crédito invalida la preview anterior", async () => {
  const ready = readyHarness(async () => okPreview());
  button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  input(ready.render(), "Valor adicional").props.onChange({ target: { value: "210000" } });
  assert.equal(button(ready.render(), /^Registrar /), undefined);
});

test("integración limita el panel a administración central y evita operar un resumen de otro crédito", () => {
  assert.match(factory, /canSeeInternalPricing && paymentSummary\?\.id === selectedCredit\.id && \(/);
  assert.match(factory, /<CreditPrincipalPaymentPanel\s+key=\{selectedCredit\.id\}/);
  assert.match(factory, /registeringPaymentRef\.current \|\| principalPaymentBusy/);
  assert.match(factory, /onApplied=\{async \(\) => \{\s+await loadPayments\(selectedCredit\.id\);\s+await loadCredits\(true, activeSearch\);/);
  assert.doesNotMatch(source, /700000|2647264/);
  assert.doesNotMatch(source, /\b\d{10,12}\b/, "no incrustar identificaciones personales en la interfaz" );
});

async function sendConfirmation(ready) {
  button(ready.render(), /Previsualizar/).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  button(ready.render(), /^Registrar /).props.onClick();
  all(ready.render(), (item) => item.type === "ConfirmDialog")[0].props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve));
}

test("la solicitud confirmada se conserva antes de enviarse y se recupera tras recargar sin autoenvío", async () => {
  const storage = memoryStorage();
  let original;
  const ready = readyHarness(async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.accion === "PREVISUALIZAR") return okPreview();
    original = request;
    const entry = JSON.parse(storage.getItem("finser-capital-pending-v1:101"));
    assert.deepEqual(entry.request, original, "persistir debe ocurrir antes del POST financiero");
    throw new Error("Conexión perdida después del envío");
  }, storage);
  await sendConfirmation(ready);
  ready.render();
  assert.equal(ready.runtime.windowListeners.has("beforeunload"), true);
  let prevented = false;
  ready.runtime.windowListeners.get("beforeunload")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ready.runtime.documentListeners.has("click"), true);

  const requests = [];
  const recovered = harness(async (url, options) => {
    requests.push({ url, request: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, alreadyApplied: true, item: { id: 99 } }) };
  }, storage);
  const locks = [];
  let applied = 0;
  const props = { credit: { ...credit, revisionKey: "posterior-al-abono", planCapitalVigente: { revision: 1 } }, disabled: true,
    onBusyChange(value) { locks.push(value); }, onApplied() { applied += 1; } };
  const tree = recovered.render(props);
  assert.equal(requests.length, 0, "recargar no debe disparar ningún POST");
  assert.match(text(tree), /confirmación pendiente/);
  assert.equal(input(tree, "Valor adicional").props.disabled, true);
  assert.equal(locks.at(-1), true, "bloquea otras operaciones mientras confirma resultado");
  const retry = button(tree, /reintentar misma operación/);
  assert.equal(retry.props.disabled, false, "permite verificar recibo aunque estado posterior del crédito deshabilite nuevos pagos");
  retry.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [{ url: "/api/creditos/101/abono-capital", request: original }]);
  assert.equal(applied, 1);
  assert.equal(storage.getItem("finser-capital-pending-v1:101"), null);
});

test("una confirmación de otro crédito no se recupera y no se guarda identidad ni plan completo", async () => {
  const storage = memoryStorage();
  const ready = readyHarness(async (url, options) => {
    if (JSON.parse(options.body).accion === "PREVISUALIZAR") return okPreview();
    throw new Error("Conexión perdida");
  }, storage);
  await sendConfirmation(ready);
  const entry = JSON.parse(storage.getItem("finser-capital-pending-v1:101"));
  assert.deepEqual(Object.keys(entry).sort(), ["creditId", "request", "version"]);
  assert.deepEqual(Object.keys(entry.request).sort(), ["accion", "idempotencyKey", "metodoPago", "observacion", "quoteHash", "valor"]);
  const other = harness(async () => { throw new Error("No request allowed"); }, storage);
  const tree = other.render({ credit: { ...credit, id: 102 }, onApplied() {}, onBusyChange() {} });
  assert.equal(button(tree, /reintentar misma operación/), undefined);
  assert.ok(storage.getItem("finser-capital-pending-v1:101"), "no elimina el pendiente de otro crédito");
});

test("si no puede persistir la protección contra duplicados no envía el pago", async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("Storage denied"); };
  const requests = [];
  const ready = readyHarness(async (url, options) => { requests.push(JSON.parse(options.body)); return okPreview(); }, storage);
  await sendConfirmation(ready);
  assert.deepEqual(requests.map((request) => request.accion), ["PREVISUALIZAR"]);
  assert.match(text(ready.render()), /El abono no fue enviado/);
});

test("un pendiente ilegible bloquea otro abono sin borrar evidencia ni autoenviar", () => {
  const storage = memoryStorage();
  storage.setItem("finser-capital-pending-v1:101", "{invalid JSON");
  const runtime = harness(undefined, storage);
  const tree = runtime.render({ credit, onApplied() {}, onBusyChange() {} });
  assert.match(text(tree), /No se pudo recuperar con seguridad/);
  assert.equal(button(tree, /Previsualizar/).props.disabled, true);
  assert.equal(storage.getItem("finser-capital-pending-v1:101"), "{invalid JSON");
});

test("error de autenticación no descarta la confirmación que puede haberse registrado", async () => {
  const storage = memoryStorage();
  const ready = readyHarness(async (url, options) => JSON.parse(options.body).accion === "PREVISUALIZAR" ? okPreview() : {
    ok: false, status: 401, json: async () => ({ error: "Vuelve a iniciar sesión" }),
  }, storage);
  await sendConfirmation(ready);
  assert.ok(storage.getItem("finser-capital-pending-v1:101"));
  assert.ok(button(ready.render(), /reintentar misma operación/));
});

test("pagar todo requiere liquidación conciliada, no ofrece liquidación automática", () => {
  assert.throws(() => harness().exports.buildPrincipalPaymentPayload({ ...form, valor: "1000000" }, credit, true, true), /liquidación conciliada con administración/);
  assert.doesNotMatch(source, /para pagar todo usa liquidación anticipada/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const contextResponse = (mode = "AUTOMATICA", patch = {}) => ({
  ok: true, status: 200,
  json: async () => ({
    ok: true, modoConciliacion: mode, requiereConciliacion: mode === "MANUAL",
    motivoConciliacion: mode === "MANUAL" ? "El crédito importado requiere una fuente de conciliación documentada." : null,
    capitalPendiente: mode === "MANUAL" ? null : 1000000, ...patch,
  }),
});

function firstPaymentHarness(fetchImpl, storage) {
  const runtime = harness(fetchImpl, storage);
  let applied = 0;
  const props = { credit: { ...credit }, onBusyChange() {}, onApplied() { applied += 1; } };
  let tree = runtime.render(props);
  button(tree, /Preparar abono/).props.onClick();
  tree = runtime.render(props);
  input(tree, "Valor adicional").props.onChange({ target: { value: "200.000" } });
  input(tree, "Ya registré").props.onChange({ target: { checked: true } });
  return { runtime, props, render: () => runtime.render(props), applied: () => applied };
}

test("primer abono consulta el modo del servidor al abrir y bloquea preview mientras carga", async () => {
  const requests = [];
  let resolveContext;
  const runtime = harness((url, options) => {
    requests.push({ url, options });
    return new Promise((resolve) => { resolveContext = resolve; });
  });
  const props = { credit, onApplied() {}, onBusyChange() {} };
  let tree = runtime.render(props);
  assert.equal(requests.length, 0, "panel cerrado no consulta ni registra pagos");
  button(tree, /Preparar abono/).props.onClick();
  tree = runtime.render(props);
  input(tree, "Valor adicional").props.onChange({ target: { value: "200000" } });
  input(tree, "Ya registré").props.onChange({ target: { checked: true } });
  tree = runtime.render(props);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.cache, "no-store");
  assert.match(text(tree), /Verificando los datos financieros/);
  assert.equal(button(tree, /Previsualizar/).props.disabled, true);
  button(tree, /Previsualizar/).props.onClick();
  assert.equal(requests.length, 1, "la guarda también impide invocar preview durante carga");
  assert.equal(input(tree, "Capital después"), undefined);
  resolveContext(contextResponse());
  await flush();
  tree = runtime.render(props);
  assert.match(text(tree), /Datos financieros automáticos/);
  assert.match(text(tree), /amortización original registrada en FINSERPAY/);
  assert.match(text(tree), /Capital pendiente/);
  assert.equal(button(tree, /Previsualizar/).props.disabled, false);
  assert.equal(input(tree, "Tasa periódica"), undefined);
});

test("primer abono automático previsualiza y confirma solo el importe y datos del pago", async () => {
  const requests = [];
  const ready = firstPaymentHarness(async (url, options) => {
    if (options.method === "GET") return contextResponse();
    const body = JSON.parse(options.body); requests.push(body);
    return body.accion === "PREVISUALIZAR" ? okPreview() : { ok: true, status: 200, json: async () => ({ ok: true, item: { id: 55 } }) };
  });
  await flush();
  assert.equal(input(ready.render(), "Fuente de conciliación"), undefined);
  await sendConfirmation(ready);
  assert.deepEqual(requests[0], { accion: "PREVISUALIZAR", valor: 200000, metodoPago: "EFECTIVO", observacion: "" });
  assert.equal(requests[1].conciliacion, undefined);
  assert.equal(requests[1].quoteHash, quoteHash);
  assert.equal(ready.applied(), 1);
});

test("modo manual conserva conciliación completa y explica el motivo del servidor", async () => {
  const requests = [];
  const ready = firstPaymentHarness(async (url, options) => {
    if (options.method === "GET") return contextResponse("MANUAL");
    requests.push(JSON.parse(options.body)); return okPreview();
  });
  await flush();
  let tree = ready.render();
  assert.match(text(tree), /crédito importado requiere una fuente/);
  assert.ok(input(tree, "Capital después"));
  button(tree, /Previsualizar/).props.onClick();
  assert.equal(requests.length, 0, "no salta la verificación manual");
  tree = ready.render();
  for (const [label, value] of [
    ["Capital después", "1000000"], ["Cuota de capital", "70000"], ["Aval / fianza", "29000"],
    ["Seguro por cuota", "1000"], ["Tasa periódica", "0.01"], ["Fuente de conciliación", form.fuente],
  ]) input(tree, label).props.onChange({ target: { value } });
  input(tree, "Verifiqué el capital").props.onChange({ target: { checked: true } });
  button(ready.render(), /Previsualizar/).props.onClick();
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].conciliacion.capitalPendiente, 1000000);
  assert.equal(requests[0].conciliacion.tasaPeriodo, 0.01);
});

test("fallo de contexto bloquea preview y permite reintentar GET sin enviar un abono", async () => {
  const requests = [];
  let attempts = 0;
  const ready = firstPaymentHarness(async (url, options) => {
    requests.push(options.method);
    if (++attempts === 1) throw new Error("No hay conexión para consultar el crédito");
    return contextResponse();
  });
  await flush();
  let tree = ready.render();
  assert.match(text(tree), /No fue posible consultar los datos del crédito/);
  assert.equal(button(tree, /Previsualizar/).props.disabled, true);
  button(tree, /Previsualizar/).props.onClick();
  assert.deepEqual(requests, ["GET"]);
  button(tree, /Reintentar consulta/).props.onClick();
  tree = ready.render();
  assert.match(text(tree), /Verificando los datos financieros/);
  await flush();
  tree = ready.render();
  assert.deepEqual(requests, ["GET", "GET"]);
  assert.equal(input(tree, "Valor adicional").props.value, "200.000");
  assert.equal(button(tree, /Previsualizar/).props.disabled, false);
});

test("una respuesta de contexto incompleta o contradictoria falla cerrada", async () => {
  for (const patch of [{ requiereConciliacion: true }, { modoConciliacion: "DESCONOCIDA" }, { capitalPendiente: -1 }, { motivoConciliacion: undefined }]) {
    const ready = firstPaymentHarness(async () => contextResponse("AUTOMATICA", patch));
    await flush();
    const tree = ready.render();
    assert.match(text(tree), /No se pudo verificar la información financiera/);
    assert.equal(button(tree, /Previsualizar/).props.disabled, true);
    assert.ok(button(tree, /Reintentar consulta/));
  }
});

test("cambiar crédito o revisión aborta la consulta y descarta respuestas tardías", async () => {
  for (const patch of [{ id: 102 }, { revisionKey: "revision-2" }]) {
    const pending = [];
    const ready = firstPaymentHarness((url, options) => new Promise((resolve) => pending.push({ url, options, resolve })));
    ready.props.credit = { ...ready.props.credit, ...patch };
    ready.render();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].options.signal.aborted, true);
    pending[1].resolve(contextResponse("MANUAL"));
    await flush();
    assert.match(text(ready.render()), /Conciliación documentada/);
    pending[0].resolve(contextResponse("AUTOMATICA"));
    await flush();
    const tree = ready.render();
    assert.match(text(tree), /Conciliación documentada/);
    assert.doesNotMatch(text(tree), /Datos financieros automáticos/);
  }
});

test("una revisión nueva invalida el modo automático, la preview y la confirmación de pagos", async () => {
  let contexts = 0;
  let resolveSecond;
  const ready = firstPaymentHarness(async (url, options) => {
    if (options.method !== "GET") return okPreview();
    if (++contexts === 1) return contextResponse();
    return new Promise((resolve) => { resolveSecond = resolve; });
  });
  await flush();
  button(ready.render(), /Previsualizar/).props.onClick();
  await flush();
  assert.ok(button(ready.render(), /^Registrar /));
  ready.props.credit = { ...credit, revisionKey: "revision-2" };
  let tree = ready.render();
  assert.equal(button(tree, /^Registrar /), undefined);
  assert.equal(button(tree, /Previsualizar/).props.disabled, true);
  assert.equal(input(tree, "Ya registré").props.checked, false);
  resolveSecond(contextResponse("MANUAL"));
  await flush();
  tree = ready.render();
  assert.match(text(tree), /Conciliación documentada/);
  assert.equal(button(tree, /^Registrar /), undefined);
});

test("el servidor puede informar plan vigente aunque el resumen del navegador aún no lo tenga", async () => {
  const requests = [];
  const ready = firstPaymentHarness(async (url, options) => {
    if (options.method === "GET") return contextResponse("VIGENTE");
    requests.push(JSON.parse(options.body)); return okPreview();
  });
  await flush();
  const tree = ready.render();
  assert.match(text(tree), /plan vigente del abono anterior/);
  assert.equal(input(tree, "Fuente de conciliación"), undefined);
  button(tree, /Previsualizar/).props.onClick();
  await flush();
  assert.equal(requests[0].conciliacion, undefined);
});

test("reintento recuperado de primer abono automático no depende de GET y conserva payload exacto", async () => {
  const storage = memoryStorage();
  let original;
  const ready = firstPaymentHarness(async (url, options) => {
    if (options.method === "GET") return contextResponse();
    const request = JSON.parse(options.body);
    if (request.accion === "PREVISUALIZAR") return okPreview();
    original = request;
    throw new Error("Respuesta financiera perdida");
  }, storage);
  await flush();
  await sendConfirmation(ready);
  const requests = [];
  const recovered = harness(async (url, options) => {
    requests.push({ method: options.method, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, alreadyApplied: true }) };
  }, storage);
  const tree = recovered.render({ credit, disabled: true, onApplied() {}, onBusyChange() {} });
  assert.equal(requests.length, 0, "no consulta GET ni autoenvía al recuperar una confirmación");
  button(tree, /reintentar misma operación/).props.onClick();
  await flush();
  assert.deepEqual(requests, [{ method: "POST", body: original }]);
  assert.equal(original.conciliacion, undefined);
  assert.equal(storage.getItem("finser-capital-pending-v1:101"), null);
});

test("desmontar el panel cancela la consulta de contexto sin aceptar su respuesta", async () => {
  let request;
  const ready = firstPaymentHarness((url, options) => new Promise((resolve) => { request = { options, resolve }; }));
  ready.runtime.unmount();
  assert.equal(request.options.signal.aborted, true);
  request.resolve(contextResponse());
  await flush();
});
