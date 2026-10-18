import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { isEquipmentCatalogItemAllowedForPlatform } = await jiti.import("../lib/credit-factory.ts");
const mock = name => Object.defineProperty(() => null, "name", { value: name });
const components = Object.fromEntries([
  "Badge", "Button", "Card", "EmptyState", "Input", "LoadingState", "PageHeader", "Select", "StatusPill", "Tabs",
].map(name => [name, mock(name)]));
const SidePanel = mock("SidePanel"), ConfirmDialog = mock("ConfirmDialog"), CatalogExportLink = mock("CatalogExportLink");
const component = value => ({ __esModule: true, default: value });
const source = ts.transpileModule(readFileSync(path.join(projectRoot, "app/dashboard/catalogo-equipos/equipment-catalog-console.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [
  value,
  ...((value.type === SidePanel || value.type === ConfirmDialog) && !value.props?.open ? [] : nodes(value.props?.children)),
  ...nodes(value.props?.action), ...nodes(value.props?.actions),
];
const rawText = value => (value?.type === SidePanel || value?.type === ConfirmDialog) && !value.props?.open ? "" :
  Array.isArray(value) ? value.map(rawText).join(" ") : typeof value === "string" || typeof value === "number" ? String(value) :
  value && typeof value === "object" ? [rawText(value.props?.children), value.props?.label, value.props?.title, value.props?.description].filter(Boolean).join(" ") : "";
const text = value => rawText(value).replace(/\s+/g, " ").trim();
const item = (id, marca, modelo, precioBaseVenta, activo = true) => ({ id, marca, modelo, precioBaseVenta, activo });
const catalog = [
  ...Array.from({ length: 13 }, (_, index) => item(index + 1, "SAMSUNG", `Galaxy ${String(index + 1).padStart(2, "0")}`, 1_000_000 + index * 100_000)),
  item(14, "IPHONE", "iPhone 15 Pro", 3_249_990),
  item(15, "APPLE", "iPhone 14", 2_749_990),
  item(16, "Apple iPhone", "iPhone 13", 2_199_900),
  item(17, "SAMSUNG", "Equipo retirado", 700_000, false),
];
const response = (items, options = {}) => ({ ok: options.ok ?? true, json: async () => options.error ? { error: options.error } : { items } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function mount({ send = async () => response(catalog) } = {}) {
  const slots = [], requests = [];
  let hookIndex = 0, dirty = true, effects = [], tree, mounted = true, lateWrites = 0;
  const changed = (index, deps) => !slots[index] || !deps || deps.some((value, part) => !Object.is(value, slots[index].deps?.[part]));
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        if (!mounted) lateWrites++;
        slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
        dirty = true;
      }];
    },
    useRef(initial) { const index = hookIndex++; slots[index] ||= { current: initial }; return slots[index]; },
    useCallback(callback, deps) {
      const index = hookIndex++;
      if (changed(index, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useMemo(factory, deps) {
      const index = hookIndex++;
      if (changed(index, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (changed(index, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const loaded = { exports: {} };
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, AbortController, Error, Intl, URLSearchParams,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (url === "/api/session") return { ok: true, json: async () => ({ rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) };
      return send(url, options);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => mock(String(key)) });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-side-panel") return component(SidePanel);
      if (name === "@/app/_components/finser-confirm-dialog") return component(ConfirmDialog);
      if (name === "@/lib/credit-factory") return { isEquipmentCatalogItemAllowedForPlatform };
      if (name === "@/lib/roles") return { isAdminRole: value => value === "ADMIN" };
      if (name === "@/lib/aliados") return { isFinserPayCentralAlly: value => value === "FINSERPAY" };
      if (name === "./catalog-export-link") return component(CatalogExportLink);
      if (name === "next/link" || name === "@/app/dashboard/creditos/equipment-visual") return component(mock(name));
      if (name.endsWith(".module.css")) return component(new Proxy({}, { get: (_target, key) => String(key) }));
      throw new Error("Unexpected dependency: " + name);
    },
  });
  function render() {
    if (!dirty || !mounted) return;
    dirty = false; hookIndex = 0; effects = [];
    tree = loaded.exports.default(); effects.forEach(effect => effect());
  }
  return {
    requests, render,
    async flush() {
      for (let cycle = 0; cycle < 30; cycle++) {
        render(); await setImmediate();
        if (!dirty || !mounted) return;
      }
      assert.fail("Equipment catalog management did not settle");
    },
    tree: () => tree,
    find: predicate => nodes(tree).find(predicate),
    all: predicate => nodes(tree).filter(predicate),
    button: label => nodes(tree).find(node => (node.type === components.Button || node.type === "button") && text(node) === label),
    input: label => nodes(tree).find(node => node.type === components.Input && node.props?.["aria-label"] === label) ||
      nodes(nodes(tree).find(node => node.type === "label" && text(node).startsWith(label))?.props?.children).find(node => node.type === components.Input),
    tab: product => nodes(tree).find(node => node.props?.role === "tab" && node.props.id === `central-catalog-tab-${product}`),
    models: () => nodes(tree).filter(node => node.type === "h2").map(text),
    panel: () => nodes(tree).find(node => node.type === SidePanel),
    exportProps: () => JSON.parse(JSON.stringify(nodes(tree).find(node => node.type === CatalogExportLink)?.props)),
    unmount() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); },
    lateWrites: () => lateWrites,
  };
}

const fill = async (h, values) => {
  for (const [label, value] of Object.entries(values)) {
    assert.ok(h.input(label), `Campo disponible: ${label}`);
    h.input(label).props.onChange({ target: { value } });
  }
  await h.flush();
};
const submit = h => h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
const writes = h => h.requests.filter(request => request.method && request.method !== "GET");

test("central carga los precios reales, oculta el formulario y limita el detalle a diez equipos", async () => {
  const pending = deferred(), h = mount({ send: () => pending.promise });
  try {
    h.render();
    assert.ok(h.find(node => node.type === components.LoadingState));
    assert.equal(h.find(node => node.props?.role === "tabpanel").props["aria-busy"], true);
    assert.equal(h.find(node => node.type === "form"), undefined);
    pending.resolve(response(catalog)); await h.flush();
    assert.equal(h.models().length, 10);
    assert.match(text(h.tree()), /Mostrando 1\s*–\s*10 de 16 equipos/);
    assert.equal(h.button("Anterior").props.disabled, true);
    h.button("Siguiente").props.onClick(); await h.flush();
    assert.equal(h.models().length, 6);
    assert.match(text(h.tree()), /Mostrando 11\s*–\s*16 de 16 equipos/);
    assert.match(text(h.tree()), /\$\s*3\.249\.990/);
    assert.doesNotMatch(text(h.tree()), /,00|3\.24999\s*M/);
    assert.equal(h.button("Siguiente").props.disabled, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, "/api/creditos/catalogo-equipos?includeInactive=true");
    assert.equal(h.requests[0].cache, "no-store");
    assert.deepEqual(writes(h), []);
  } finally { h.unmount(); }
});

test("buscar, cambiar producto y consultar retirados reinicia la página sin escrituras", async () => {
  const h = mount();
  try {
    await h.flush();
    h.button("Siguiente").props.onClick(); await h.flush();
    await fill(h, { "Buscar equipos por marca o modelo": "galaxy 01" });
    assert.deepEqual(h.models(), ["Galaxy 01"]);
    assert.match(text(h.tree()), /Mostrando 1\s*–\s*1 de 1 equipos/);
    h.find(node => node.props?.["aria-label"] === "Limpiar búsqueda").props.onClick();
    h.tab("IPHONE").props.onClick(); await h.flush();
    assert.deepEqual(h.models(), ["iPhone 15 Pro", "iPhone 14", "iPhone 13"]);
    assert.equal(h.tab("IPHONE").props["aria-selected"], true);
    h.tab("ANDROID").props.onClick(); await h.flush();
    assert.equal(h.models().length, 10);
    h.find(node => node.type === components.Select).props.onChange({ target: { value: "RETIRADOS" } }); await h.flush();
    assert.deepEqual(h.models(), ["Equipo retirado"]);
    assert.match(text(h.tree()), /\$\s*700\.000/);
    h.tab("IPHONE").props.onClick(); await h.flush();
    assert.deepEqual(h.models(), []);
    assert.ok(h.find(node => node.type === components.EmptyState));
    assert.equal(h.requests.length, 1);
    assert.deepEqual(writes(h), []);
  } finally { h.unmount(); }
});

test("Excel recibe producto, estado y búsqueda vigentes e incluye toda la selección sin limitar por página", async () => {
  const h = mount();
  try {
    await h.flush();
    assert.deepEqual(h.exportProps(), { product: "TODOS", query: "", status: "ACTIVOS" });
    h.button("Siguiente").props.onClick(); await h.flush();
    assert.deepEqual(h.exportProps(), { product: "TODOS", query: "", status: "ACTIVOS" });
    assert.match(text(h.tree()), /Mostrando 11\s*–\s*16 de 16 equipos/);
    h.tab("ANDROID").props.onClick();
    h.find(node => node.type === components.Select).props.onChange({ target: { value: "TODOS" } });
    await fill(h, { "Buscar equipos por marca o modelo": "Galaxy" });
    assert.deepEqual(h.exportProps(), { product: "ANDROID", query: "Galaxy", status: "TODOS" });
    h.find(node => node.type === components.Select).props.onChange({ target: { value: "RETIRADOS" } });
    await fill(h, { "Buscar equipos por marca o modelo": "retirado" });
    assert.deepEqual(h.exportProps(), { product: "ANDROID", query: "retirado", status: "RETIRADOS" });
    assert.equal(h.requests.length, 1, "preparar filtros de descarga no solicita ni modifica equipos");
    assert.deepEqual(writes(h), []);
  } finally { h.unmount(); }
});

test("crear equipo abre el panel y evita un POST duplicado aunque el formulario se envíe dos veces", async () => {
  const pending = deferred(), h = mount({ send: (_url, options) => options?.method ? pending.promise : response(catalog) });
  try {
    await h.flush();
    h.button("Nuevo equipo").props.onClick(); await h.flush();
    assert.equal(h.panel().props.open, true);
    await fill(h, { Marca: "Motorola", Modelo: "Moto G85", "Precio base de venta": "$ 1.450.000" });
    const form = h.find(node => node.type === "form");
    form.props.onSubmit({ preventDefault() {} });
    form.props.onSubmit({ preventDefault() {} });
    await h.flush();
    assert.equal(writes(h).length, 1);
    assert.equal(writes(h)[0].method, "POST");
    assert.deepEqual(JSON.parse(writes(h)[0].body), { id: null, marca: "Motorola", modelo: "Moto G85", precioBaseVenta: "1450000" });
    assert.equal(h.panel().props.busy, true);
    h.panel().props.onClose(); await h.flush();
    assert.equal(h.panel().props.open, true, "no se cierra una operación en curso");
    pending.resolve(response([...catalog, item(18, "Motorola", "Moto G85", 1_450_000)])); await h.flush();
    assert.equal(h.panel().props.open, false);
    assert.equal(h.find(node => node.type === "form"), undefined);
    assert.match(text(h.tree()), /Equipo agregado al catálogo/);
    assert.match(text(h.tree()), /Mostrando 1\s*–\s*10 de 17 equipos/);
  } finally { h.unmount(); }
});

test("errores de guardado conservan los datos y permiten corregir y reintentar", async () => {
  let attempts = 0;
  const h = mount({ send: (_url, options) => !options?.method ? response(catalog) : ++attempts === 1
    ? response([], { ok: false, error: "Ese modelo ya existe en el catálogo" })
    : response([...catalog, item(18, "Motorola", "Modelo corregido", 1_450_000)]) });
  try {
    await h.flush(); h.button("Nuevo equipo").props.onClick(); await h.flush();
    submit(h); await h.flush();
    assert.equal(writes(h).length, 0, "datos vacíos se validan antes de enviar");
    assert.match(text(h.tree()), /Completa la marca/);
    await fill(h, { Marca: "Motorola", Modelo: "Modelo repetido", "Precio base de venta": "1450000" });
    submit(h); await h.flush();
    assert.equal(h.panel().props.open, true);
    assert.equal(h.input("Marca").props.value, "Motorola");
    assert.equal(h.input("Modelo").props.value, "Modelo repetido");
    assert.match(h.input("Precio base de venta").props.value, /1\.450\.000/);
    assert.ok(h.find(node => node.props?.role === "alert"));
    await fill(h, { Modelo: "Modelo corregido" }); submit(h); await h.flush();
    assert.equal(writes(h).length, 2);
    assert.equal(h.panel().props.open, false);
  } finally { h.unmount(); }
});

test("editar conserva el ID y precio íntegro, cancelar no escribe y retirar requiere confirmación", async () => {
  let current = structuredClone(catalog);
  const pending = deferred();
  const h = mount({ send: (_url, options) => {
    if (options?.method === "PATCH") {
      const body = JSON.parse(options.body);
      current = current.map(row => row.id === body.id ? { ...row, precioBaseVenta: Number(body.precioBaseVenta) } : row);
      return response(current);
    }
    if (options?.method === "DELETE") return pending.promise;
    return response(current);
  } });
  try {
    await h.flush();
    h.find(node => node.props?.["aria-label"] === "Editar SAMSUNG Galaxy 01").props.onClick(); await h.flush();
    assert.equal(h.input("Marca").props.value, "SAMSUNG");
    assert.equal(h.input("Modelo").props.value, "Galaxy 01");
    h.button("Cancelar").props.onClick(); await h.flush();
    assert.equal(h.panel().props.open, false);
    assert.deepEqual(writes(h), []);
    h.find(node => node.props?.["aria-label"] === "Editar SAMSUNG Galaxy 01").props.onClick(); await h.flush();
    await fill(h, { "Precio base de venta": "$ 1.125.900" }); submit(h); await h.flush();
    assert.equal(writes(h)[0].method, "PATCH");
    assert.deepEqual(JSON.parse(writes(h)[0].body), { id: 1, marca: "SAMSUNG", modelo: "Galaxy 01", precioBaseVenta: "1125900" });
    assert.match(text(h.tree()), /\$\s*1\.125\.900/);
    h.find(node => node.props?.["aria-label"] === "Retirar SAMSUNG Galaxy 01").props.onClick(); await h.flush();
    const dialog = h.find(node => node.type === ConfirmDialog);
    assert.equal(dialog.props.open, true);
    assert.equal(writes(h).length, 1, "abrir confirmación no retira el modelo");
    dialog.props.onConfirm(); dialog.props.onConfirm(); await h.flush();
    assert.equal(writes(h).length, 2);
    assert.equal(writes(h)[1].method, "DELETE");
    assert.equal(writes(h)[1].url, "/api/creditos/catalogo-equipos?id=1");
    pending.resolve(response(current.filter(row => row.id !== 1))); await h.flush();
    assert.equal(h.find(node => node.type === ConfirmDialog).props.open, false);
    assert.ok(!h.models().includes("Galaxy 01"));
    assert.match(text(h.tree()), /Equipo retirado del catálogo/);
  } finally { h.unmount(); }
});

test("una lectura tardía no reemplaza el catálogo confirmado tras guardar", async () => {
  const stale = deferred();
  const h = mount({ send: (_url, options) => options?.method ? response([...catalog, item(18, "Motorola", "Nuevo", 1_450_000)]) : stale.promise });
  try {
    h.render(); h.button("Nuevo equipo").props.onClick(); await h.flush();
    await fill(h, { Marca: "Motorola", Modelo: "Nuevo", "Precio base de venta": "1450000" }); submit(h); await h.flush();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.match(text(h.tree()), /Mostrando 1\s*–\s*10 de 17 equipos/);
    stale.resolve(response(catalog)); await h.flush();
    assert.match(text(h.tree()), /Mostrando 1\s*–\s*10 de 17 equipos/);
  } finally { h.unmount(); }
});

test("un error de lectura ofrece reintentar y salir cancela respuestas pendientes", async () => {
  let calls = 0;
  const h = mount({ send: () => ++calls === 1 ? response([], { ok: false, error: "Catálogo temporalmente no disponible" }) : response(catalog) });
  try {
    await h.flush();
    assert.ok(h.find(node => node.props?.role === "alert"));
    assert.equal(h.find(node => node.type === components.EmptyState).props.title, "Catálogo no disponible");
    h.button("Reintentar").props.onClick(); await h.flush();
    assert.equal(h.models().length, 10);
    assert.equal(h.requests.length, 2);
  } finally { h.unmount(); }
  const pending = deferred(), abandoned = mount({ send: () => pending.promise });
  abandoned.render(); abandoned.unmount();
  assert.equal(abandoned.requests[0].signal.aborted, true);
  pending.resolve(response(catalog)); await abandoned.flush();
  assert.equal(abandoned.lateWrites(), 0);
});
