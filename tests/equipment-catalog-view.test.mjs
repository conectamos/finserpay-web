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
const components = Object.fromEntries([
  "Badge", "Button", "Card", "EmptyState", "Input", "LoadingState", "PageHeader", "Tabs",
].map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
const ExportLink = () => null;
const source = ts.transpileModule(readFileSync(path.join(projectRoot, "app/dashboard/catalogo-equipos/ally-equipment-catalog.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [
  value, ...nodes(value.props?.children), ...nodes(value.props?.action), ...nodes(value.props?.actions),
];
const rawText = value => Array.isArray(value) ? value.map(rawText).join(" ") : typeof value === "string" || typeof value === "number" ? String(value) :
  value && typeof value === "object" ? [rawText(value.props?.children), value.props?.label, value.props?.title, value.props?.description].filter(Boolean).join(" ") : "";
const text = value => rawText(value).replace(/\s+/g, " ").trim();
const response = (items, options = {}) => ({ ok: options.ok ?? true, json: async () => options.error ? { error: options.error } : { items } });
const item = (id, marca, modelo, precioBaseVenta, activo = true) => ({ id, marca, modelo, precioBaseVenta, activo });
const catalog = [
  item(1, "SAMSUNG", "Galaxy A35", 1_089_990),
  item(2, "XIAOMI", "Redmi Nóte 13", 875_900),
  item(3, "MOTOROLA", "Moto G84", 1_399_000),
  item(4, "IPHONE", "iPhone 15 Pro 256GB", 3_149_990),
  item(5, "APPLE", "iPhone 14 128GB", 2_749_990),
  item(6, "Apple iPhone", "iPhone 13 128GB", 2_199_900),
  item(7, "SAMSUNG", "Equipo retirado", 700_000, false),
  item(8, "IPHONE", "iPhone retirado", 1_500_000, false),
];
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function mount({ send = async () => response(catalog) } = {}) {
  const slots = [], requests = [];
  let hookIndex = 0, dirty = true, effects = [], tree, mounted = true, lateWrites = 0;
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
      if (!slots[index] || deps.some((value, part) => !Object.is(value, slots[index].deps[part]))) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || deps.some((value, part) => !Object.is(value, slots[index].deps[part])))
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const loaded = { exports: {} };
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, AbortController, Error, Intl,
    fetch: async (url, options) => { requests.push({ url, ...options }); return send(url, options); },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "lucide-react") return Object.fromEntries(["ArrowLeft", "CircleAlert", "RefreshCw", "Search", "X"].map(icon => [icon, () => null]));
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/lib/credit-factory") return { isEquipmentCatalogItemAllowedForPlatform };
      if (name === "./catalog-export-link") return { default: ExportLink };
      if (name === "next/link" || name === "@/app/dashboard/creditos/equipment-visual") return { default: () => null };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_target, key) => String(key) }) };
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
      assert.fail("Equipment catalog did not settle");
    },
    tree: () => tree,
    find: predicate => nodes(tree).find(predicate),
    all: predicate => nodes(tree).filter(predicate),
    button: label => nodes(tree).find(node => (node.type === components.Button || node.type === "button") && text(node).trim() === label),
    input: () => nodes(tree).find(node => node.type === components.Input),
    tab: product => nodes(tree).find(node => node.props?.role === "tab" && node.props?.id === `catalog-tab-${product}`),
    panel: () => nodes(tree).find(node => node.props?.role === "tabpanel"),
    models: () => nodes(tree).filter(node => node.type === "h2").map(text),
    unmount() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); },
    lateWrites: () => lateWrites,
  };
}

function assertReadOnlyRequests(h) {
  assert.ok(h.requests.length > 0);
  for (const request of h.requests) {
    assert.equal(request.url, "/api/creditos/catalogo-equipos");
    assert.equal(request.method || "GET", "GET");
    assert.equal(request.cache, "no-store");
    assert.equal(request.body, undefined);
  }
}

test("carga el catálogo real y muestra únicamente modelos activos con precios completos en COP", async () => {
  const pending = deferred(), h = mount({ send: () => pending.promise });
  try {
    h.render();
    assert.ok(h.find(node => node.type === components.LoadingState));
    assert.equal(h.panel().props["aria-busy"], true);
    assert.equal(h.button("Actualizando…").props.disabled, true);
    assert.deepEqual(h.models(), []);
    pending.resolve(response(catalog)); await h.flush();
    assert.deepEqual(h.models(), ["Galaxy A35", "Redmi Nóte 13", "Moto G84"]);
    assert.match(text(h.tree()), /3 de 3 equipos Android/);
    assert.match(text(h.tree()), /\$\s*1\.089\.990/);
    assert.match(text(h.tree()), /\$\s*875\.900/);
    assert.match(text(h.tree()), /\$\s*1\.399\.000/);
    assert.doesNotMatch(text(h.tree()), /Equipo retirado|iPhone retirado|,00|\d+\s*M\b/);
    assert.equal(h.panel().props["aria-busy"], false);
    assert.equal(h.button("Actualizar").props.disabled, false);
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("ANDROID e IPHONE usan la clasificación vigente, conservan sus importes y cambian sin escrituras", async () => {
  const h = mount();
  try {
    await h.flush();
    assert.equal(h.tab("ANDROID").props["aria-selected"], true);
    h.tab("IPHONE").props.onClick(); await h.flush();
    assert.equal(h.tab("IPHONE").props["aria-selected"], true);
    assert.equal(h.tab("ANDROID").props["aria-selected"], false);
    assert.deepEqual(h.models(), ["iPhone 15 Pro 256GB", "iPhone 14 128GB", "iPhone 13 128GB"]);
    assert.match(text(h.tree()), /3 de 3 equipos iPhone/);
    for (const price of ["3.149.990", "2.749.990", "2.199.900"]) assert.ok(text(h.tree()).includes(price));
    assert.equal(h.panel().props["aria-labelledby"], "catalog-tab-IPHONE");
    h.tab("ANDROID").props.onClick(); await h.flush();
    assert.deepEqual(h.models(), ["Galaxy A35", "Redmi Nóte 13", "Moto G84"]);
    assert.equal(h.requests.length, 1, "cambiar de producto no consulta ni modifica el catálogo");
    const labels = h.all(node => node.type === "button" || node.type === components.Button).map(node => text(node).trim());
    assert.ok(labels.every(label => /^(Actualizar|ANDROID \d+|IPHONE \d+)$/.test(label)), labels.join(", "));
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("el administrador aliado puede exportar el producto y la búsqueda seleccionados sin escrituras", async () => {
  const h = mount();
  try {
    await h.flush();
    assert.equal(h.find(node => node.type === ExportLink).props.product, "ANDROID");
    h.tab("IPHONE").props.onClick();
    h.input().props.onChange({ target: { value: "14 128GB" } });
    await h.flush();
    const link = h.find(node => node.type === ExportLink);
    assert.equal(link.props.product, "IPHONE");
    assert.equal(link.props.query, "14 128GB");
    assert.equal(link.props.status, undefined, "la consulta aliada utiliza únicamente activos");
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("la búsqueda ignora mayúsculas y tildes, conserva el producto y se puede limpiar sin consultar", async () => {
  const h = mount();
  try {
    await h.flush();
    h.input().props.onChange({ target: { value: "nOtE" } }); await h.flush();
    assert.deepEqual(h.models(), ["Redmi Nóte 13"]);
    assert.match(text(h.tree()), /1 de 3 equipos Android/);
    h.input().props.onChange({ target: { value: " inexistente " } }); await h.flush();
    assert.deepEqual(h.models(), []);
    assert.equal(h.find(node => node.type === components.EmptyState).props.title, "Sin coincidencias");
    assert.equal(h.input().props.value, " inexistente ");
    h.button("Limpiar búsqueda").props.onClick(); await h.flush();
    assert.equal(h.input().props.value, "");
    assert.deepEqual(h.models(), ["Galaxy A35", "Redmi Nóte 13", "Moto G84"]);
    h.input().props.onChange({ target: { value: "Galaxy" } }); await h.flush();
    h.find(node => node.props?.["aria-label"] === "Limpiar búsqueda").props.onClick(); await h.flush();
    assert.equal(h.input().props.value, "");
    assert.equal(h.requests.length, 1);
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("un error conserva la búsqueda y el producto; reintentar recupera precios sin operaciones de venta", async () => {
  let calls = 0;
  const h = mount({ send: async () => ++calls === 1
    ? response([], { ok: false, error: "No se pudo consultar el catálogo." })
    : response(catalog) });
  try {
    await h.flush();
    assert.match(text(h.tree()), /No se pudo consultar el catálogo/);
    assert.ok(h.find(node => node.props?.role === "alert"));
    assert.equal(h.requests.length, 1, "no hay reintentos automáticos tras un error");
    h.tab("IPHONE").props.onClick();
    h.input().props.onChange({ target: { value: "14 128GB" } }); await h.flush();
    h.button("Reintentar").props.onClick(); await h.flush();
    assert.equal(h.input().props.value, "14 128GB");
    assert.equal(h.tab("IPHONE").props["aria-selected"], true);
    assert.deepEqual(h.models(), ["iPhone 14 128GB"]);
    assert.match(text(h.tree()), /\$\s*2\.749\.990/);
    assert.equal(h.find(node => node.props?.role === "alert"), undefined);
    assert.equal(h.requests.length, 2);
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("actualizar recibe los nuevos valores configurados y conserva la consulta visible", async () => {
  let calls = 0;
  const updated = catalog.map(entry => entry.id === 1 ? { ...entry, precioBaseVenta: 1_145_990 } : entry);
  const h = mount({ send: async () => response(++calls === 1 ? catalog : updated) });
  try {
    await h.flush();
    h.input().props.onChange({ target: { value: "Galaxy" } }); await h.flush();
    h.button("Actualizar").props.onClick(); await h.flush();
    assert.equal(h.input().props.value, "Galaxy");
    assert.deepEqual(h.models(), ["Galaxy A35"]);
    assert.match(text(h.tree()), /\$\s*1\.145\.990/);
    assert.doesNotMatch(text(h.tree()), /1\.089\.990/);
    assert.equal(catalog[0].precioBaseVenta, 1_089_990, "la presentación no altera el precio original");
    assert.equal(h.requests.length, 2);
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("sin equipos activos muestra el estado vacío y no ofrece edición", async () => {
  const h = mount({ send: async () => response(catalog.filter(entry => !entry.activo)) });
  try {
    await h.flush();
    const empty = h.find(node => node.type === components.EmptyState);
    assert.equal(empty.props.title, "Sin equipos disponibles");
    assert.equal(empty.props.description, "No hay equipos activos en Android.");
    assert.equal(h.find(node => node.type === "form"), undefined);
    assert.deepEqual(h.models(), []);
    assertReadOnlyRequests(h);
  } finally { h.unmount(); }
});

test("salir aborta la consulta y descarta una respuesta tardía sin modificar estado", async () => {
  const pending = deferred(), h = mount({ send: () => pending.promise });
  h.render(); h.unmount();
  assert.equal(h.requests[0].signal.aborted, true);
  pending.resolve(response(catalog)); await h.flush();
  assert.equal(h.lateWrites(), 0);
  assert.deepEqual(h.models(), []);
  assertReadOnlyRequests(h);
});
