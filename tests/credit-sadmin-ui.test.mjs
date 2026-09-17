import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "PageHeader"].map(name => [name, placeholder(name)]));
const icons = new Proxy({}, { get: (_, key) => placeholder(String(key)) });
const styles = new Proxy({}, { get: (_, key) => String(key) });
const source = readFileSync(new URL("../app/dashboard/aprobaciones/sadmin-credit-table.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} });

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node, ...nodes(node.props?.children), ...nodes(node.props?.actions)];
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" ? content(node.props?.children) : "";
}

// Execute the real component's effects and callbacks. Only its leaf visual
// components are opaque; no hook indexes or implementation source assertions
// determine the expectations below.
function mount(fetch) {
  const slots = [], listeners = new Map();
  let hookIndex = 0, dirty = true, effects = [], tree;
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial,
        set(value) { const next = typeof value === "function" ? value(slots[index].value) : value;
          if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; } } };
      return [slots[index].value, slots[index].set];
    },
    useRef(value) { const index = hookIndex++; slots[index] ||= { current: value }; return slots[index]; },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, console, AbortController, URLSearchParams, Intl, fetch,
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "lucide-react") return icons;
      if (name === "@/app/_components/finser-ui") return ui;
      if (name === "./sadmin-credit-table.module.css") return { __esModule: true, default: styles };
      assert.fail(`Unexpected dependency ${name}`);
    },
  }, { filename: "sadmin-credit-table.tsx" });
  const Component = loaded.exports.default;
  return {
    async flush() {
      for (let cycle = 0; cycle < 30; cycle++) {
        if (dirty) {
          dirty = false; hookIndex = 0; effects = []; tree = Component({ onBack() {} });
          for (const effect of effects) effect();
        }
        await setImmediate();
        if (!dirty) return;
      }
      assert.fail("Component did not settle");
    },
    tree: () => tree,
    find(predicate, root = tree) { const found = nodes(root).find(predicate); assert.ok(found, "Expected rendered control"); return found; },
    all: (predicate) => nodes(tree).filter(predicate),
    guardsLeaving: () => listeners.has("beforeunload"),
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const registration = (overrides = {}) => ({ version: 0, codeudorCreado: false, creditoCreado: false, numeroCreditoConfirmado: false, numeroCredito: null, estado: "PENDIENTE", updatedAt: null, completedAt: null, ...overrides });
const row = (id, sadmin = registration()) => ({ id, folio: `QA-${id}`, createdAt: "2026-09-17T13:30:00Z", fechaCredito: "2026-09-17", clienteNombre: `Cliente ${id}`, clienteDocumento: `QA${id}`, clienteTelefono: "3000000000", clienteDireccion: "Dirección de prueba", clienteFechaNacimiento: "1990-01-02", clienteCorreo: "qa@example.test", clienteGenero: "No informado", imei: "000000000000000", referenciaEquipo: "Equipo de prueba", numeroCuotas: 24, frecuenciaPago: "QUINCENAL", valorVenta: 1000000, cuotaInicial: 200000, creditoAutorizado: 800000, valorCuota: 45000, interesMensual: 0.02, fianza: 0.6, seguro: 0.0003, aliadoNombre: "Aliado QA", sedeNombre: "Sede QA", fechaProximoPago: "2026-10-02", cuotasPagadas: 0, cuotasPendientes: 24, saldoObligacion: 1080000, saldoCapital: 800000, saldoFianza: 180000, saldoIntereses: 100000, diasVencidos: 0, ultimoPago: null, sadmin });
const page = (items, current = 1, total = items.length) => ({ ok: true, items, page: current, pageSize: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)) });
const json = (value, status = 200) => Response.json(value, { status });
const fieldset = (h, id) => h.find(node => node.type === "fieldset" && node.props["aria-label"] === `Verificaciones SADMIN de QA-${id}`);
const button = (h, label, root) => h.find(node => node.type === ui.Button && content(node) === label, root);
const check = (h, id, label) => {
  const wrapper = h.find(node => node.type === "label" && content(node) === label, fieldset(h, id));
  return h.find(node => node.type === "input" && node.props.type === "checkbox", wrapper);
};
const number = (h, id) => h.find(node => node.type === ui.Input && node.props.id === `sadmin-number-${id}`);
const renderedIds = h => h.all(node => node.type === "fieldset").map(node => Number(node.props["aria-label"].split("QA-")[1]));
const editNumber = (h, id, value) => number(h, id).props.onChange({ target: { value } });
const errors = h => h.all(node => node.props?.role === "alert").map(content).join(" ");

test("carga 20 registros y cada página reemplaza los anteriores", async () => {
  const requests = [];
  const h = mount(async (url, options) => {
    requests.push({ url, options });
    const current = Number(new URL(url, "https://example.test").searchParams.get("page"));
    const ids = Array.from({ length: 20 }, (_, index) => current === 1 ? 40 - index : 20 - index);
    return json(page(ids.map(id => row(id)), current, 40));
  });
  await h.flush();
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].url, "/api/aprobaciones/sadmin?page=1&q=");
  assert.deepEqual(renderedIds(h), Array.from({ length: 20 }, (_, index) => 40 - index));
  assert.equal(button(h, "Anterior").props.disabled, true);
  button(h, "Siguiente").props.onClick(); await h.flush();
  assert.equal(new URL(requests[1].url, "https://example.test").searchParams.get("page"), "2");
  assert.deepEqual(renderedIds(h), Array.from({ length: 20 }, (_, index) => 20 - index));
  assert.equal(button(h, "Siguiente").props.disabled, true);
  assert.equal(button(h, "Anterior").props.disabled, false);
  h.unmount();
});

test("conserva ceros y letras del número y solo permite verificarlo después de guardarlo", async () => {
  const patches = [];
  const h = mount(async (_url, options) => {
    if (options.method !== "PATCH") return json(page([row(81)]));
    const body = JSON.parse(options.body); patches.push(body);
    return json({ ok: true, sadmin: registration({ version: 1, numeroCredito: body.value }) });
  });
  await h.flush();
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  editNumber(h, 81, "0007-A"); await h.flush();
  assert.equal(number(h, 81).props.value, "0007-A");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, true);
  assert.equal(h.guardsLeaving(), true);
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.deepEqual(patches, [{ version: 0, field: "numeroCredito", value: "0007-A" }]);
  assert.equal(number(h, 81).props.value, "0007-A");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, false);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, false);
  assert.equal(h.guardsLeaving(), false);
  h.unmount();
});

test("muestra CREADO SADMIN cuando el servidor confirma las tres verificaciones", async () => {
  let stored = registration({ version: 1, numeroCredito: "00081" });
  const patches = [];
  const h = mount(async (_url, options) => {
    if (options.method !== "PATCH") return json(page([row(81, stored)]));
    const body = JSON.parse(options.body); patches.push(body);
    stored = { ...stored, [body.field]: body.value, version: stored.version + 1 };
    if (stored.codeudorCreado && stored.creditoCreado && stored.numeroCreditoConfirmado) stored = { ...stored, estado: "CREADO_SADMIN", completedAt: "2026-09-17T14:00:00Z" };
    return json({ ok: true, sadmin: stored });
  });
  await h.flush();
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) {
    check(h, 81, label).props.onChange({ target: { checked: true } }); await h.flush();
  }
  assert.deepEqual(patches.map(patch => patch.version), [1, 2, 3]);
  assert.equal(h.all(node => node.type === ui.Badge && content(node) === "CREADO SADMIN").length, 1);
  assert.equal(h.all(node => node.type === ui.Badge && content(node) === "3 de 3 verificaciones").length, 1);
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) assert.equal(check(h, 81, label).props.checked, true);
  h.unmount();
});

test("serializa guardados incluso si dos filas se activan antes del siguiente render", async () => {
  const pending = deferred(); const patches = [];
  const h = mount(async (url, options) => {
    if (options.method !== "PATCH") return json(page([row(81), row(82)]));
    patches.push({ url, body: JSON.parse(options.body) });
    return pending.promise;
  });
  await h.flush();
  const first = check(h, 81, "CODEUDOR CREADO").props.onChange;
  const second = check(h, 82, "CODEUDOR CREADO").props.onChange;
  first({ target: { checked: true } }); second({ target: { checked: true } }); await h.flush();
  assert.equal(patches.length, 1);
  assert.equal(fieldset(h, 81).props.disabled, true);
  assert.equal(fieldset(h, 82).props.disabled, true);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, true);
  pending.resolve(json({ ok: true, sadmin: registration({ version: 1, codeudorCreado: true }) })); await h.flush();
  assert.equal(fieldset(h, 81).props.disabled, false);
  assert.equal(fieldset(h, 82).props.disabled, false);
  assert.equal(check(h, 81, "CODEUDOR CREADO").props.checked, true);
  assert.equal(check(h, 82, "CODEUDOR CREADO").props.checked, false);
  h.unmount();
});

test("un conflicto de versión recarga y conserva el número editado para reintentar", async () => {
  let reads = 0; const patches = [];
  const h = mount(async (_url, options) => {
    if (options.method !== "PATCH") {
      reads++;
      return json(page([row(81, reads === 1 ? registration() : registration({ version: 4, numeroCredito: "PREVIO", codeudorCreado: true }))]));
    }
    const body = JSON.parse(options.body); patches.push(body);
    if (patches.length === 1) return json({ ok: false, code: "SADMIN_CHANGED", error: "Cambió el crédito" }, 409);
    return json({ ok: true, sadmin: registration({ version: 5, numeroCredito: body.value, codeudorCreado: true }) });
  });
  await h.flush(); editNumber(h, 81, "000-NUEVO"); await h.flush();
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.equal(reads, 2);
  assert.equal(number(h, 81).props.value, "000-NUEVO");
  assert.equal(check(h, 81, "CODEUDOR CREADO").props.checked, true);
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  assert.match(errors(h), /Otra persona actualizó/);
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.deepEqual(patches[1], { version: 4, field: "numeroCredito", value: "000-NUEVO" });
  assert.equal(number(h, 81).props.value, "000-NUEVO");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, false);
  assert.equal(errors(h), "");
  h.unmount();
});

test("un número duplicado muestra el motivo real y no recarga ni borra el borrador", async () => {
  let reads = 0;
  const h = mount(async (_url, options) => {
    if (options.method !== "PATCH") { reads++; return json(page([row(81)])); }
    return json({ ok: false, code: "SADMIN_NUMBER_EXISTS", error: "Ese número de SADMIN ya está registrado en otro crédito." }, 409);
  });
  await h.flush(); editNumber(h, 81, "000-DUPLICADO"); await h.flush();
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.equal(reads, 1);
  assert.match(errors(h), /Ese número de SADMIN ya está registrado en otro crédito/);
  assert.doesNotMatch(errors(h), /Otra persona actualizó/);
  assert.equal(number(h, 81).props.value, "000-DUPLICADO");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  assert.equal(fieldset(h, 81).props.disabled, false);
  h.unmount();
});

test("un fallo de conexión conserva las verificaciones guardadas y permite reintentar el número", async () => {
  let failing = true; const patches = [];
  const saved = registration({ version: 2, codeudorCreado: true, creditoCreado: true });
  const h = mount(async (_url, options) => {
    if (options.method !== "PATCH") return json(page([row(81, saved)]));
    const body = JSON.parse(options.body); patches.push(body);
    if (failing) throw new TypeError("Failed to fetch");
    return json({ ok: true, sadmin: { ...saved, version: 3, numeroCredito: body.value } });
  });
  await h.flush(); editNumber(h, 81, "000-REINTENTO"); await h.flush();
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.equal(number(h, 81).props.value, "000-REINTENTO");
  assert.equal(check(h, 81, "CODEUDOR CREADO").props.checked, true);
  assert.equal(check(h, 81, "CRÉDITO CREADO").props.checked, true);
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.checked, false);
  assert.match(errors(h), /Revisa tu conexión/);
  assert.doesNotMatch(errors(h), /Failed to fetch/);
  assert.equal(fieldset(h, 81).props.disabled, false);
  failing = false; button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.deepEqual(patches[1], patches[0]);
  assert.equal(number(h, 81).props.value, "000-REINTENTO");
  assert.equal(errors(h), "");
  h.unmount();
});

test("desmontar la tabla aborta una carga pendiente", async () => {
  const pending = deferred(); let signal;
  const h = mount((_url, options) => { signal = options.signal; return pending.promise; });
  await h.flush();
  assert.equal(signal.aborted, false);
  h.unmount();
  assert.equal(signal.aborted, true);
  pending.resolve(json(page([row(81)]))); await h.flush();
  assert.deepEqual(renderedIds(h), []);
});
