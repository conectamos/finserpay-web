import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/cupos-consultas/cupos-consultas-client.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/dashboard/cupos-consultas/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const endpoint = "/api/creditos/datacredito/cupos-sedes";
const jsx = (type, props) => ({ type, props: props ?? {} });
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.actions)] : [];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
const quota = (patch = {}) => ({
  id: 8, name: "Aliado prueba", dailyQueryLimit: 80, branchQuotaEnabled: true,
  dailyQueriesUsed: 43, dailyQueriesRemaining: 37, dailyQuotaResetsAt: "2026-11-20T05:00:00Z",
  branches: [
    { id: 11, name: "Norte", active: true, dailyQueryLimit: 50, usedToday: 30, remainingToday: 20 },
    { id: 12, name: "Sur", active: true, dailyQueryLimit: 30, usedToday: 13, remainingToday: 17 },
    { id: 13, name: "Inactiva", active: false, dailyQueryLimit: 100, usedToday: 1, remainingToday: 0 },
  ], ...patch,
});
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function mount({ ally = quota(), handleGet, handlePost } = {}) {
  const state = [], requests = [], effects = [];
  let cursor = 0, dirty = true, tree, getCount = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = { value: typeof initial === "function" ? initial() : initial };
      return [state[index].value, next => { state[index].value = typeof next === "function" ? next(state[index].value) : next; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; return state[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++, old = state[index];
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) state[index] = { deps, fn };
      return state[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++, old = state[index];
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) effects.push(() => { old?.cleanup?.(); state[index] = { deps, cleanup: fn() }; });
    },
  };
  const controls = new Proxy({}, { get: (_, key) => String(key) });
  const exports = {};
  runInNewContext(compiled, {
    exports, AbortController, Error, JSON,
    fetch: async (url, options = {}) => {
      assert.equal(url, endpoint, "El aliado solo usa su endpoint de redistribución");
      const request = { url, options, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (options.method === "POST") return handlePost ? handlePost(request) : response({ ok: true, ally });
      getCount++;
      return handleGet ? handleGet(request, getCount) : response({ ok: true, ally });
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "lucide-react" || name.endsWith("finser-ui")) return controls;
      if (name.endsWith("finser-confirm-dialog")) return { default: "ConfirmDialog" };
      if (name.endsWith(".module.css")) return { default: controls };
      throw new Error("Unexpected dependency " + name);
    },
  });
  function render() {
    cursor = 0; dirty = false;
    tree = exports.default();
    effects.splice(0).forEach(effect => effect());
  }
  const ui = {
    requests,
    async flush() {
      for (let i = 0; i < 20; i++) { if (dirty) render(); await tick(); if (!dirty) return; }
      throw new Error("Cupos UI did not settle");
    },
    all: predicate => nodes(tree).filter(predicate),
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, "Expected cupos control"); return node; },
    text: () => text(tree),
    field(id) { return ui.find(node => node.props.id === id); },
    button(label) { return ui.find(node => node.type === "Button" && text(node) === label); },
    dialog() { return ui.find(node => node.type === "ConfirmDialog"); },
    async change(id, value) { ui.field(id).props.onChange({ target: { value } }); await ui.flush(); },
    async prepare() { ui.button("Guardar distribución").props.onClick(); await ui.flush(); },
    unmount() { state.forEach(item => item?.cleanup?.()); },
  };
  return ui;
}
async function edited(options) {
  const ui = mount(options); await ui.flush();
  await ui.change("branch-quota-11", "40"); await ui.change("branch-quota-12", "40");
  return ui;
}

test("admin aliado consulta su distribución, sin editar tope, modo ni otros aliados", async () => {
  const ui = mount(); await ui.flush();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].options.method, undefined);
  assert.match(ui.text(), /Tope general del aliado80/);
  assert.match(ui.text(), /Usadas hoy43/);
  assert.equal(ui.all(node => node.type === "Input").length, 3, "Solo cupos de sedes activas y motivo");
  assert.equal(ui.all(node => node.type === "Select" || node.props.type === "checkbox").length, 0);
  assert.equal(ui.all(node => node.props.id === "branch-quota-13").length, 0);
  assert.match(page, /getDataCreditoAllyBranchQuotaAdmin/);
  assert.doesNotMatch(source, /\/api\/creditos\/datacredito\/politicas/);
  ui.unmount();
});

test("revisar no guarda; la confirmación envía solamente cupos y snapshot del tope", async () => {
  let posted;
  const ui = await edited({ handlePost: request => {
    posted = request.body;
    return response({ ok: true, ally: quota({ branches: quota().branches.map(branch => ({ ...branch, dailyQueryLimit: branch.active ? 40 : 100 })) }) });
  } });
  await ui.change("quota-redistribution-reason", "Mayor demanda en Sur");
  await ui.prepare();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.dialog().props.open, true);
  assert.match(ui.dialog().props.description, /Norte: 40; Sur: 40/);
  assert.match(ui.dialog().props.description, /tope general seguirá en 80/);
  assert.match(ui.dialog().props.description, /43 consultas usadas hoy se conservan/);
  ui.dialog().props.onConfirm(); await ui.flush();
  assert.deepEqual(posted, { expectedDailyQueryLimit: 80, branches: [
    { branchId: 11, dailyLimit: 40, expectedDailyLimit: 50 },
    { branchId: 12, dailyLimit: 40, expectedDailyLimit: 30 },
  ], reason: "Mayor demanda en Sur" });
  assert.match(ui.text(), /distribución de consultas quedó guardada/);
  assert.equal(ui.dialog().props.open, false);
  ui.unmount();
});

test("rechaza cupos vacíos, negativos, fraccionarios o una suma superior al total", async () => {
  for (const value of ["", "-1", "1.5", "10001", "51", "1e2"]) {
    const ui = mount(); await ui.flush();
    await ui.change("branch-quota-11", value);
    assert.equal(ui.button("Guardar distribución").props.disabled, true, value);
    await ui.prepare();
    assert.equal(ui.dialog().props.open, false);
    assert.equal(ui.requests.length, 1);
    ui.unmount();
  }
});

test("modo compartido y tope sin límite no permiten habilitar ni redistribuir desde el aliado", async () => {
  for (const ally of [quota({ branchQuotaEnabled: false }), quota({ dailyQueryLimit: null, dailyQueriesRemaining: null })]) {
    const ui = mount({ ally }); await ui.flush();
    assert.match(ui.text(), /FINSERPAY debe habilitar la distribución/);
    assert.equal(ui.field("branch-quota-11").props.disabled, true);
    assert.equal(ui.all(node => node.type === "Button" && text(node) === "Guardar distribución").length, 0);
    ui.unmount();
  }
});

test("doble clic de confirmación ejecuta una sola modificación", async () => {
  const deferredPost = deferred();
  const ui = await edited({ handlePost: () => deferredPost.promise }); await ui.prepare();
  const dialog = ui.dialog(); dialog.props.onConfirm(); dialog.props.onConfirm();
  await ui.flush();
  assert.equal(ui.requests.filter(request => request.options.method === "POST").length, 1);
  assert.equal(ui.field("branch-quota-11").props.disabled, true);
  deferredPost.resolve(response({ ok: true, ally: quota() })); await ui.flush();
  ui.unmount();
});

test("editar después de revisar invalida la confirmación anterior", async () => {
  const ui = await edited(); await ui.prepare(); const stale = ui.dialog();
  await ui.change("branch-quota-11", "39");
  assert.equal(ui.dialog().props.open, false);
  stale.props.onConfirm(); await ui.flush();
  assert.equal(ui.requests.length, 1);
  ui.unmount();
});

test("un conflicto exige cargar la distribución vigente y confirmar de nuevo", async () => {
  const ui = await edited({ handlePost: () => response({ ok: false, error: "La distribución cambió" }, 409) });
  await ui.prepare(); ui.dialog().props.onConfirm(); await ui.flush();
  assert.equal(ui.button("Guardar distribución").props.disabled, true);
  assert.match(ui.text(), /distribución cambió/);
  assert.equal(ui.requests.length, 2);
  await ui.button("Consultar cupos vigentes").props.onClick(); await ui.flush();
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests[2].options.method, undefined);
  assert.equal(ui.field("branch-quota-11").props.value, "50");
  assert.match(ui.text(), /Se cargó la distribución vigente/);
  ui.unmount();
});

test("guardado confirmado sin recarga se recupera con lectura y nunca repite la escritura", async () => {
  const ui = await edited({ handlePost: () => response({ ok: true, operationCommitted: true,
    quotaReloadRequired: true, code: "BRANCH_QUOTA_REFRESH_FAILED" }) });
  await ui.prepare(); ui.dialog().props.onConfirm(); await ui.flush();
  assert.match(ui.text(), /La distribución quedó guardada/);
  assert.equal(ui.button("Guardar distribución").props.disabled, true);
  assert.equal(ui.requests.length, 2);
  await ui.button("Consultar cupos vigentes").props.onClick(); await ui.flush();
  assert.equal(ui.requests.filter(request => request.options.method === "POST").length, 1);
  assert.match(ui.text(), /quedó guardada y el cupo vigente se actualizó/);
  ui.unmount();
});

test("respuesta incierta bloquea otra modificación hasta consultar el estado vigente", async () => {
  const ui = await edited({ handlePost: () => { throw new Error("Respuesta interrumpida"); } });
  await ui.prepare(); ui.dialog().props.onConfirm(); await ui.flush();
  assert.match(ui.text(), /No se pudo confirmar el resultado/);
  assert.equal(ui.button("Guardar distribución").props.disabled, true);
  assert.equal(ui.requests.length, 2);
  await ui.button("Consultar cupos vigentes").props.onClick(); await ui.flush();
  assert.equal(ui.requests.filter(request => request.options.method === "POST").length, 1);
  assert.match(ui.text(), /Consulta completada/);
  ui.unmount();
});

test("pérdida de permisos retira los cupos anteriores de la pantalla", async () => {
  const ui = mount({ handleGet: (_request, count) => count === 1 ? response({ ok: true, ally: quota() }) : response({ ok: false, error: "Acceso retirado" }, 403) });
  await ui.flush(); assert.match(ui.text(), /Aliado prueba/);
  await ui.button("Actualizar").props.onClick(); await ui.flush();
  assert.doesNotMatch(ui.text(), /Aliado prueba/);
  assert.equal(ui.all(node => node.props.id === "branch-quota-11").length, 0);
  ui.unmount();
});

test("una consulta vieja no reemplaza la nueva y desmontar aborta la lectura", async () => {
  const first = deferred();
  const ui = mount({ handleGet: (_request, count) => count === 1 ? first.promise : response({ ok: true, ally: quota({ name: "Datos vigentes" }) }) });
  await ui.flush();
  const firstSignal = ui.requests[0].options.signal;
  await ui.button("Actualizar").props.onClick(); await ui.flush();
  assert.equal(firstSignal.aborted, true);
  assert.match(ui.text(), /Datos vigentes/);
  first.resolve(response({ ok: true, ally: quota({ name: "Datos anteriores" }) })); await ui.flush();
  assert.doesNotMatch(ui.text(), /Datos anteriores/);
  ui.unmount();
  assert.equal(ui.requests.at(-1).options.signal.aborted, true);
});
