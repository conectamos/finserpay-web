import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../app/dashboard/aprobaciones/excepciones-mora/mora-exception-requests-client.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ centralAdmin = true, product = "IPHONE", detailProduct = product } = {}) {
  const components = Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "Select", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null, MoraSupports = () => null;
  const stubs = new Set([...Object.values(components), ConfirmDialog, MoraSupports]);
  const node = (type, props) => typeof type === "function" && !stubs.has(type) ? type(props) : { type, props };
  const slots = [], effects = [], requests = [];
  let cursor = 0, dirty = false, tree;
  const same = (before, after) => before?.length === after?.length && before.every((value, index) => Object.is(value, after[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++; slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, next => { const value = typeof next === "function" ? next(slots[index].value) : next; dirty ||= !Object.is(value, slots[index].value); slots[index].value = value; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useCallback(value, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value, dependencies }; return slots[index].value; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const previous = slots[index]; slots[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  // Deliberately contradictory references: the product must come only from the server field.
  const credit = { id: 77, producto: product, folio: "FC-77", numeroSadmin: "0100000077", clienteNombre: "Cliente de prueba", clienteDocumento: "00111222333", clienteTelefono: "3209998877", equipo: "IPHONE ANDROID MODELO", imei: "001234567890123", aliadoNombre: "Aliado de prueba", valorVencido: 100000, diasMora: 3 };
  const item = { id: "request-77", creditoId: 77, type: "EXCEPCION", status: "APPROVED", version: 1, centralDirect: true, expiresOn: "2026-10-21", reason: "Motivo registrado", observation: "", promiseAmount: null, promiseDate: null, installmentNumber: null, installmentDueDate: null, createdByName: "Administrador", createdAt: "2026-10-18T12:00:00Z", credit };
  const list = { ok: true, items: [item], page: 1, pageSize: 25, total: 1, totalPages: 1 };
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, URLSearchParams, Intl, Date, Number, Error,
    crypto: { randomUUID: () => "local-test-only" },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET" });
      let payload;
      if (url === "/api/aprobaciones/excepciones-mora/request-77") payload = { ok: true, item, history: [], credit: { ...credit, producto: detailProduct } };
      else if (url.includes("/creditos?q=") || url.startsWith("/api/aprobaciones/cartera-mora?q=")) payload = { ok: true, items: [credit] };
      else if (url.includes("?creditoId=")) payload = { ...list, credit, eligibility: { promise: { amount: 100000, date: "2026-10-21" }, excepcion: { canRequest: true }, prorroga: { canRequest: true } } };
      else if (url.startsWith("/api/aprobaciones/excepciones-mora?")) payload = list;
      else throw new Error("Petición inesperada: " + url);
      return { ok: true, json: async () => payload };
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "next/link") return { default: props => node("a", props) };
      if (name === "next/image") return { default: props => node("img", props) };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => props => node("svg", { ...props, "data-icon": key }) });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: ConfirmDialog };
      if (name === "@/app/_components/finser-side-panel") return { default: props => props.open ? node("aside", props) : null };
      if (name === "@/lib/colombia-date") return { colombiaDateKey: () => "2026-10-18" };
      if (name === "../mora-supports") return { default: MoraSupports };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => key }) };
      throw new Error("Importación inesperada: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value : value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => { let count = 0; do { dirty = false; cursor = 0; tree = loaded.exports.default({ centralAdmin }); effects.splice(0).forEach(callback => callback()); if (++count > 20) throw new Error("Render no estable"); } while (dirty); };
  const find = predicate => nodes(tree).find(predicate);
  const byClass = (className, root = tree) => nodes(root).find(value => value.props?.className === className);
  const button = label => find(value => value.type === components.Button && text(value.props.children).trim() === label);
  const settle = async () => { for (let index = 0; index < 4; index++) { await setImmediate(); render(); } };
  const click = label => { const target = button(label); assert.ok(target, label); assert.equal(Boolean(target.props.disabled), false); target.props.onClick(); render(); };
  const start = async () => { render(); await settle(); };
  const searchCandidates = async () => {
    click("Nueva solicitud");
    const input = find(value => value.type === components.Input && value.props["aria-label"] === (centralAdmin ? "Buscar crédito" : "Buscar crédito en mora"));
    input.props.onChange({ target: { value: "00111222333" } }); render();
    byClass("candidateSearch").props.onSubmit({ preventDefault() {} }); await settle();
  };
  return { start, settle, click, find, byClass, nodes, text, requests, searchCandidates, render };
}

for (const [product, label, icon] of [["IPHONE", "iPhone", "/assets/dashboard/apple.svg"], ["ANDROID", "Android", "/assets/dashboard/android.svg"], [null, "Sin identificar", null]]) {
  test(`listado: producto ${product ?? "desconocido"} usa el dato canónico y preserva los identificadores`, async () => {
    const ui = harness({ product }); await ui.start();
    const table = ui.byClass("table");
    assert.deepEqual(ui.nodes(table).filter(node => node.type === "th").map(node => ui.text(node)), ["Cliente / Crédito", "Producto", "Tipo", "Estado", "Vencimiento", "Responsable", "Detalle"]);
    const row = ui.nodes(table).find(node => node.type === "tbody");
    const cells = ui.nodes(row).filter(node => node.type === "td");
    assert.equal(ui.text(cells[1]).trim(), label);
    assert.match(ui.text(cells[0]), /00111222333/); assert.match(ui.text(cells[0]), /0100000077/); assert.match(ui.text(cells[0]), /FC-77/);
    const image = ui.nodes(cells[1]).find(node => node.type === "img");
    if (icon) { assert.equal(image.props.src, icon); assert.equal(image.props.alt, ""); }
    else { assert.equal(image, undefined); assert.ok(ui.nodes(cells[1]).find(node => node.type === "svg" && node.props["data-icon"] === "Smartphone")); }
    assert.ok(ui.requests.every(request => request.method === "GET"));
  });

  test(`detalle: producto ${product ?? "desconocido"} se muestra junto al equipo sin modificar la solicitud`, async () => {
    const ui = harness({ product: "ANDROID", detailProduct: product }); await ui.start(); ui.click("Ver detalle"); await ui.settle();
    const detail = ui.byClass("detailIdentity");
    assert.match(ui.text(detail), /Producto/); assert.equal(ui.text(ui.byClass("product", detail)).trim(), label);
    assert.match(ui.text(detail), /001234567890123/); assert.ok(ui.requests.every(request => request.method === "GET"));
  });
}

for (const centralAdmin of [true, false]) {
  test(`${centralAdmin ? "central" : "analista"}: búsqueda y selección conservan el alcance y muestran producto sin mutaciones`, async () => {
    const ui = harness({ centralAdmin, product: "ANDROID" }); await ui.start(); await ui.searchCandidates();
    const candidates = ui.byClass("candidates"), candidate = ui.nodes(candidates).find(node => node.type === "button");
    assert.equal(ui.text(ui.byClass("product", candidate)).trim(), "Android");
    candidate.props.onClick(); ui.render(); await ui.settle();
    const selected = ui.byClass("selectedCredit");
    assert.equal(ui.text(ui.byClass("product", selected)).trim(), "Android");
    assert.match(ui.text(selected), /Producto/); assert.match(ui.text(selected), /001234567890123/);
    assert.ok(ui.requests.some(request => request.url === (centralAdmin ? "/api/aprobaciones/excepciones-mora/creditos?q=" : "/api/aprobaciones/cartera-mora?q=") + "00111222333"));
    assert.ok(ui.requests.some(request => request.url === "/api/aprobaciones/excepciones-mora?creditoId=77"));
    assert.ok(ui.requests.every(request => request.method === "GET"));
  });
}
