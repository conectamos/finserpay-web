import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

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
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { exports, storage, windowListeners, documentListeners, render(props) {
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
