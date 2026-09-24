import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "PageHeader", "Tabs"].map(name => [name, placeholder(name)]));
const icons = new Proxy({}, { get: (_, key) => placeholder(String(key)) });
const styles = new Proxy({}, { get: (_, key) => String(key) });
const source = readFileSync(new URL("../app/dashboard/aprobaciones/sadmin-credit-table.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} });
const displayModule = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/credit-display-number.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: displayModule, exports: displayModule.exports });

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
  const downloads = { objects: [], revoked: [], links: [] };
  const urlApi = {
    createObjectURL(blob) {
      const url = `blob:sadmin-${downloads.objects.length + 1}`;
      downloads.objects.push({ blob, url });
      return url;
    },
    revokeObjectURL(url) { downloads.revoked.push(url); },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, "a");
      const link = {
        href: "", download: "", style: {}, appended: false, clicked: false, removed: false,
        click() { this.clicked = true; },
        remove() { this.removed = true; },
      };
      downloads.links.push(link);
      return link;
    },
    body: { appendChild(link) { link.appended = true; } },
  };
  let hookIndex = 0, dirty = true, effects = [], tree;
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const hooks = {
    Fragment: jsxRuntime.Fragment,
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
    module: loaded, exports: loaded.exports, console, AbortController, URLSearchParams, Intl, Blob, fetch,
    URL: urlApi,
    document,
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
      setTimeout: callback => { callback(); return 1; },
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "lucide-react") return icons;
      if (name === "@/app/_components/finser-ui") return ui;
      if (name === "@/lib/credit-display-number") return displayModule.exports;
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
    downloads,
    guardsLeaving: () => listeners.has("beforeunload"),
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const registration = (overrides = {}) => ({ version: 0, codeudorCreado: false, creditoCreado: false, numeroCreditoConfirmado: false, numeroCredito: null, estado: "PENDIENTE", updatedAt: null, completedAt: null, ...overrides });
const row = (id, sadmin = registration()) => ({ id, folio: `QA-${id}`, createdAt: "2026-09-17T13:30:00Z", fechaCredito: "2026-09-17", clienteNombre: `Cliente ${id}`, clienteDocumento: `QA${id}`, clienteTelefono: "3000000000", clienteDireccion: "Dirección de prueba", clienteFechaNacimiento: "1990-01-02", clienteCorreo: "qa@example.test", clienteGenero: "No informado", imei: "000000000000000", referenciaEquipo: "Equipo de prueba", numeroCuotas: 24, frecuenciaPago: "QUINCENAL", valorVenta: 1000000, cuotaInicial: 200000, creditoAutorizado: 800000, valorCuota: 45000, interesMensual: 0.02, fianza: 0.6, seguro: 0.0003, aliadoNombre: "Aliado QA", sedeNombre: "Sede QA", fechaProximoPago: "2026-10-02", cuotasPagadas: 0, cuotasPendientes: 24, saldoObligacion: 1080000, saldoCapital: 800000, saldoFianza: 180000, saldoIntereses: 100000, diasVencidos: 0, ultimoPago: null, sadmin });
const page = (items, current = 1, total = items.length, counts = { all: total, pending: total, created: 0 }) => ({ ok: true, items, page: current, pageSize: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)), counts });
const json = (value, status = 200) => Response.json(value, { status });
const fieldset = (h, id) => h.find(node => node.type === "fieldset" && node.props.id === `sadmin-checklist-${id}`);
const button = (h, label, root) => h.find(node => node.type === ui.Button && content(node) === label, root);
const check = (h, id, label) => {
  const wrapper = h.find(node => node.type === "label" && content(node) === label, fieldset(h, id));
  return h.find(node => node.type === "input" && node.props.type === "checkbox", wrapper);
};
const number = (h, id) => h.find(node => node.type === ui.Input && node.props.id === `sadmin-number-${id}`);
const creditButton = (h, id) => h.find(node => node.type === "button" && node.props.id === `sadmin-credit-${id}`);
const statusTab = (h, status) => h.find(node => node.type === "button" && node.props.id === `sadmin-status-${status}`);
const toggleCredit = async (h, id) => { creditButton(h, id).props.onClick(); await h.flush(); };
const renderedIds = h => h.all(node => node.type === "button" && /^sadmin-credit-\d+$/.test(node.props.id)).map(node => Number(node.props.id.replace("sadmin-credit-", "")));
const editNumber = (h, id, value) => number(h, id).props.onChange({ target: { value } });
const errors = h => h.all(node => node.props?.role === "alert").map(content).join(" ");

test("carga 20 resúmenes de número, fecha y estado; cada página reemplaza los anteriores", async () => {
  const requests = [];
  const h = mount(async (url, options) => {
    requests.push({ url, options });
    const current = Number(new URL(url, "https://example.test").searchParams.get("page"));
    const ids = Array.from({ length: 20 }, (_, index) => current === 1 ? 40 - index : 20 - index);
    return json(page(ids.map(id => row(id)), current, 40));
  });
  await h.flush();
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].url, "/api/aprobaciones/sadmin?page=1&q=&status=all");
  assert.deepEqual(renderedIds(h), Array.from({ length: 20 }, (_, index) => 40 - index));
  const assertCollapsed = () => {
    const body = h.find(node => node.type === "tbody");
    assert.equal(nodes(body).filter(node => node.type === "fieldset" || node.type === "input" || node.type === ui.Input || node.props?.role === "region").length, 0);
    assert.doesNotMatch(content(body), /Cliente \d|Equipo de prueba|Aliado QA|Sede QA|CODEUDOR|CRÉDITO CREADO|\$|Valor venta/);
    for (const id of renderedIds(h)) {
      const summary = creditButton(h, id);
      assert.equal(summary.props["aria-expanded"], false);
      assert.equal(summary.props["aria-controls"], `sadmin-detail-${id}`);
      assert.ok(content(summary).includes(`QA-${id}`));
      assert.ok(content(summary).includes("PENDIENTE SADMIN"));
      assert.ok(content(summary).includes(new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", dateStyle: "short" }).format(new Date("2026-09-17"))));
    }
  };
  assertCollapsed();
  const headers = h.all(node => node.type === "thead").flatMap(nodes).filter(node => node.type === "th").map(content);
  assert.deepEqual(headers, ["Crédito"]);
  assert.equal(button(h, "Anterior").props.disabled, true);
  button(h, "Siguiente").props.onClick(); await h.flush();
  assert.equal(new URL(requests[1].url, "https://example.test").searchParams.get("page"), "2");
  assert.deepEqual(renderedIds(h), Array.from({ length: 20 }, (_, index) => 20 - index));
  assertCollapsed();
  assert.equal(button(h, "Siguiente").props.disabled, true);
  assert.equal(button(h, "Anterior").props.disabled, false);
  h.unmount();
});

test("filtra por Todos, Pendientes y Creados en el servidor, conserva la búsqueda y reinicia la página", async () => {
  const requests = [];
  const h = mount(async (url, options) => {
    requests.push({ url, options });
    const params = new URL(url, "https://example.test").searchParams;
    const status = params.get("status");
    const current = Number(params.get("page"));
    const fixture = status === "created"
      ? [row(91, registration({ version: 4, codeudorCreado: true, creditoCreado: true, numeroCreditoConfirmado: true, numeroCredito: "SADMIN-91", estado: "CREADO_SADMIN", completedAt: "2026-09-17T14:00:00Z" }))]
      : [row(status === "pending" ? 81 : current === 2 ? 72 : 71)];
    const total = status === "created" ? 1 : 40;
    return json(page(fixture, current, total, { all: 41, pending: 40, created: 1 }));
  });
  await h.flush();

  const tabs = ["all", "pending", "created"].map(status => statusTab(h, status));
  assert.deepEqual(tabs.map(tab => content(tab)), ["Todos41", "Pendientes40", "Creados1"]);
  assert.deepEqual(tabs.map(tab => tab.props.role), ["tab", "tab", "tab"]);
  assert.equal(statusTab(h, "all").props["aria-selected"], true);
  assert.equal(statusTab(h, "all").props["aria-controls"], "sadmin-credit-results");

  const search = h.find(node => node.type === ui.Input && node.props.id === "sadmin-search");
  search.props.onChange({ target: { value: "Cliente buscado" } }); await h.flush();
  const form = h.find(node => node.type === "form");
  form.props.onSubmit({ preventDefault() {} }); await h.flush();
  let params = new URL(requests.at(-1).url, "https://example.test").searchParams;
  assert.deepEqual([params.get("page"), params.get("q"), params.get("status")], ["1", "Cliente buscado", "all"]);

  button(h, "Siguiente").props.onClick(); await h.flush();
  params = new URL(requests.at(-1).url, "https://example.test").searchParams;
  assert.deepEqual([params.get("page"), params.get("q"), params.get("status")], ["2", "Cliente buscado", "all"]);

  statusTab(h, "created").props.onClick(); await h.flush();
  params = new URL(requests.at(-1).url, "https://example.test").searchParams;
  assert.deepEqual([params.get("page"), params.get("q"), params.get("status")], ["1", "Cliente buscado", "created"]);
  assert.equal(statusTab(h, "created").props["aria-selected"], true);
  const panel = h.find(node => node.props?.id === "sadmin-credit-results");
  assert.equal(panel.props.role, "tabpanel");
  assert.equal(panel.props["aria-labelledby"], "sadmin-status-created");
  assert.deepEqual(renderedIds(h), [91]);
  h.unmount();
});

test("exporta todos los resultados de la búsqueda y pestaña activas con estado de progreso y nombre del servidor", async () => {
  const requests = [];
  const pendingExport = deferred();
  const h = mount(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith("/api/aprobaciones/sadmin/export?")) return pendingExport.promise;
    const status = new URL(url, "https://example.test").searchParams.get("status");
    const item = status === "created"
      ? row(91, registration({ version: 4, codeudorCreado: true, creditoCreado: true, numeroCreditoConfirmado: true, numeroCredito: "000091", estado: "CREADO_SADMIN" }))
      : row(71);
    return json(page([item], 1, 1, { all: 2, pending: 1, created: 1 }));
  });
  await h.flush();

  const search = h.find(node => node.type === ui.Input && node.props.id === "sadmin-search");
  search.props.onChange({ target: { value: "Cliente exportado" } }); await h.flush();
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.flush();
  statusTab(h, "created").props.onClick(); await h.flush();

  button(h, "Exportar Excel").props.onClick(); await h.flush();
  const busy = button(h, "Generando Excel...");
  assert.equal(busy.props["aria-busy"], true);
  assert.equal(busy.props.disabled, true);
  const exportRequest = requests.at(-1);
  assert.equal(exportRequest.url, "/api/aprobaciones/sadmin/export?q=Cliente+exportado&status=created");
  assert.equal(exportRequest.options.cache, "no-store");
  assert.equal(new URL(exportRequest.url, "https://example.test").searchParams.has("page"), false);

  pendingExport.resolve(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=ignorado.xlsx; filename*=UTF-8''creacion-sadmin-creados-2026-09-24.xlsx",
    },
  }));
  await h.flush();

  assert.equal(button(h, "Exportar Excel").props["aria-busy"], false);
  assert.equal(h.downloads.objects.length, 1);
  assert.equal(h.downloads.objects[0].blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(h.downloads.links.length, 1);
  assert.equal(h.downloads.links[0].download, "creacion-sadmin-creados-2026-09-24.xlsx");
  assert.equal(h.downloads.links[0].href, h.downloads.objects[0].url);
  assert.deepEqual(
    [h.downloads.links[0].appended, h.downloads.links[0].clicked, h.downloads.links[0].removed],
    [true, true, true],
  );
  assert.deepEqual(h.downloads.revoked, [h.downloads.objects[0].url]);
  assert.deepEqual(renderedIds(h), [91], "la descarga no debe borrar ni cambiar la tabla");
  assert.equal(errors(h), "");
  h.unmount();
});

test("muestra fallos de exportación sin borrar la tabla ni iniciar una descarga", async () => {
  let exportResponse = json({ error: "La exportación supera 2.000 registros." }, 413);
  const h = mount(async (url) => {
    if (url.startsWith("/api/aprobaciones/sadmin/export?")) return exportResponse;
    return json(page([row(81)]));
  });
  await h.flush();
  button(h, "Exportar Excel").props.onClick(); await h.flush();
  assert.match(errors(h), /supera 2\.000 registros/);
  assert.deepEqual(renderedIds(h), [81]);
  assert.equal(h.downloads.objects.length, 0);

  exportResponse = new Response("contenido inesperado", { status: 200, headers: { "Content-Type": "text/html" } });
  button(h, "Exportar Excel").props.onClick(); await h.flush();
  assert.match(errors(h), /no devolvió un archivo Excel válido/);
  assert.deepEqual(renderedIds(h), [81]);
  assert.equal(h.downloads.objects.length, 0);
  h.unmount();
});

test("bloquea la exportación cuando existe un número SADMIN sin guardar", async () => {
  let exportCalls = 0;
  const h = mount(async (url) => {
    if (url.startsWith("/api/aprobaciones/sadmin/export?")) {
      exportCalls++;
      throw new Error("No debe exportar con un borrador");
    }
    return json(page([row(81)]));
  });
  await h.flush();
  await toggleCredit(h, 81);
  editNumber(h, 81, "00081-SIN-GUARDAR"); await h.flush();
  const exportButton = button(h, "Exportar Excel");
  assert.equal(exportButton.props.disabled, true);
  exportButton.props.onClick(); await h.flush();
  assert.equal(exportCalls, 0);
  assert.equal(h.downloads.objects.length, 0);
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
  await toggleCredit(h, 81);
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  editNumber(h, 81, "0007-A"); await h.flush();
  assert.equal(number(h, 81).props.value, "0007-A");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, true);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, true);
  for (const status of ["all", "pending", "created"]) assert.equal(statusTab(h, status).props.disabled, true);
  assert.equal(h.guardsLeaving(), true);
  await toggleCredit(h, 81);
  assert.equal(h.all(node => node.type === "fieldset").length, 0);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, true);
  assert.equal(h.guardsLeaving(), true);
  await toggleCredit(h, 81);
  assert.equal(number(h, 81).props.value, "0007-A");
  button(h, "Guardar número", fieldset(h, 81)).props.onClick(); await h.flush();
  assert.deepEqual(patches, [{ version: 0, field: "numeroCredito", value: "0007-A" }]);
  assert.equal(number(h, 81).props.value, "0007-A");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, false);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, false);
  assert.equal(h.guardsLeaving(), false);
  await toggleCredit(h, 81); await toggleCredit(h, 81);
  assert.equal(number(h, 81).props.value, "0007-A");
  assert.equal(check(h, 81, "NÚMERO DE CRÉDITO").props.disabled, false);
  h.unmount();
});

test("recarga el filtro pendiente cuando una verificación mueve el crédito a Creados", async () => {
  let stored = registration({ version: 1, numeroCredito: "00081" });
  let pendingReads = 0;
  const requests = [];
  const h = mount(async (url, options) => {
    requests.push({ url, options });
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      stored = { ...stored, [body.field]: body.value, version: stored.version + 1 };
      if (stored.codeudorCreado && stored.creditoCreado && stored.numeroCreditoConfirmado) {
        stored = { ...stored, estado: "CREADO_SADMIN", completedAt: "2026-09-17T14:00:00Z" };
      }
      return json({ ok: true, sadmin: stored });
    }
    const status = new URL(url, "https://example.test").searchParams.get("status");
    if (status === "pending") pendingReads++;
    const visible = status === "pending" && stored.estado === "PENDIENTE" ? [row(81, stored)] : [];
    const counts = stored.estado === "PENDIENTE" ? { all: 1, pending: 1, created: 0 } : { all: 1, pending: 0, created: 1 };
    return json(page(visible, 1, visible.length, counts));
  });
  await h.flush();
  statusTab(h, "pending").props.onClick(); await h.flush();
  await toggleCredit(h, 81);
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) {
    check(h, 81, label).props.onChange({ target: { checked: true } }); await h.flush();
  }
  assert.equal(pendingReads, 2);
  assert.deepEqual(renderedIds(h), []);
  assert.equal(statusTab(h, "pending").props["aria-selected"], true);
  assert.equal(content(statusTab(h, "pending")), "Pendientes0");
  assert.equal(requests.filter(request => request.options.method === "PATCH").length, 3);
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
  await toggleCredit(h, 81);
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) {
    check(h, 81, label).props.onChange({ target: { checked: true } }); await h.flush();
  }
  assert.deepEqual(patches.map(patch => patch.version), [1, 2, 3]);
  assert.equal(h.all(node => node.type === ui.Badge && content(node) === "CREADO SADMIN").length, 1);
  assert.equal(h.all(node => node.type === ui.Badge && content(node) === "3 de 3 verificaciones").length, 1);
  assert.equal(h.all(node => node.type === "strong" && content(node) === "00081").length, 1);
  assert.ok(content(creditButton(h, 81)).includes("00081"));
  assert.ok(!content(creditButton(h, 81)).includes("QA-81"));
  const identity = h.find(node => typeof node.type === "function" && node.type.name === "Facts" && node.props.items.some(([label]) => label === "Folio original"));
  assert.ok(content(identity.type(identity.props)).includes("QA-81"));
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) assert.equal(check(h, 81, label).props.checked, true);
  h.unmount();
});

test("abre un detalle a la vez y serializa callbacks retenidos de filas distintas", async () => {
  const pending = deferred(); const patches = [];
  const h = mount(async (url, options) => {
    if (options.method !== "PATCH") return json(page([row(81), row(82)]));
    patches.push({ url, body: JSON.parse(options.body) });
    return pending.promise;
  });
  await h.flush();
  await toggleCredit(h, 81);
  const first = check(h, 81, "CODEUDOR CREADO").props.onChange;
  await toggleCredit(h, 82);
  assert.equal(creditButton(h, 81).props["aria-expanded"], false);
  assert.equal(creditButton(h, 82).props["aria-expanded"], true);
  assert.equal(h.all(node => node.type === "fieldset").length, 1);
  assert.equal(h.all(node => node.props?.id === "sadmin-detail-81").length, 0);
  const second = check(h, 82, "CODEUDOR CREADO").props.onChange;
  first({ target: { checked: true } }); second({ target: { checked: true } }); await h.flush();
  assert.equal(patches.length, 1);
  assert.equal(fieldset(h, 82).props.disabled, true);
  assert.equal(button(h, "Volver a aprobaciones").props.disabled, true);
  pending.resolve(json({ ok: true, sadmin: registration({ version: 1, codeudorCreado: true }) })); await h.flush();
  assert.equal(fieldset(h, 82).props.disabled, false);
  assert.equal(check(h, 82, "CODEUDOR CREADO").props.checked, false);
  await toggleCredit(h, 81);
  assert.equal(fieldset(h, 81).props.disabled, false);
  assert.equal(check(h, 81, "CODEUDOR CREADO").props.checked, true);
  assert.equal(h.all(node => node.props?.id === "sadmin-detail-82").length, 0);
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
  await h.flush(); await toggleCredit(h, 81); editNumber(h, 81, "000-NUEVO"); await h.flush();
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
  await h.flush(); await toggleCredit(h, 81); editNumber(h, 81, "000-DUPLICADO"); await h.flush();
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
  await h.flush(); await toggleCredit(h, 81); editNumber(h, 81, "000-REINTENTO"); await h.flush();
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

test("clic en crédito abre toda la información y verificaciones, y cerrar oculta todo salvo número, fecha y estado", async () => {
  const stored = registration({ version: 4, codeudorCreado: true, creditoCreado: true, numeroCreditoConfirmado: true, numeroCredito: "00081-A", estado: "CREADO_SADMIN" });
  const fixture = { ...row(81, stored), numeroCreditoVisible: "00081-A", ultimoPago: "2026-09-16 · $ 45.000 · EFECTIVO" };
  let patches = 0;
  const h = mount(async (_url, options) => { if (options.method === "PATCH") patches++; return json(page([fixture])); });
  await h.flush();
  const toggle = () => creditButton(h, 81);
  assert.equal(toggle().props["aria-expanded"], false);
  assert.equal(toggle().props["aria-controls"], "sadmin-detail-81");
  assert.equal(h.all(node => node.props?.id === "sadmin-detail-81").length, 0);
  assert.equal(h.all(node => node.type === "thead").flatMap(nodes).filter(node => node.type === "th").length, 1);
  assert.equal(h.all(node => node.type === "fieldset").length, 0);
  assert.ok(content(toggle()).includes("00081-A"));
  assert.ok(!content(toggle()).includes("QA-81"));
  assert.doesNotMatch(content(h.find(node => node.type === "tbody")), /Cliente 81|Equipo de prueba|3 de 3 verificaciones|Folio/);
  toggle().props.onClick(); await h.flush();
  assert.equal(toggle().props["aria-expanded"], true);
  const detail = h.find(node => node.props?.id === "sadmin-detail-81");
  assert.equal(detail.props.role, "region"); assert.equal(detail.props["aria-labelledby"], "sadmin-credit-81");
  const sectionNames = nodes(detail).filter(node => node.type === "h3").map(content);
  assert.deepEqual(sectionNames.slice().sort(), ["Datos del cliente", "Crédito, equipo y origen", "Valores y plan", "Tasas", "Pagos", "Saldos", "Creación SADMIN"].sort());
  assert.ok(nodes(detail).includes(fieldset(h, 81)), "Las verificaciones están dentro del detalle desplegado");
  const facts = nodes(detail).filter(node => typeof node.type === "function" && node.type.name === "Facts");
  const fields = facts.flatMap(node => node.props.items);
  for (const label of ["Nombre", "Cédula", "Teléfono", "Correo", "Dirección", "Nacimiento", "Género", "Número de crédito", "Folio original", "Fecha crédito", "Creado", "Referencia", "IMEI", "Aliado", "Sede", "Valor venta", "Inicial", "Crédito autorizado", "N.º cuotas", "Valor cuota", "Frecuencia", "Interés mensual efectivo", "Fianza total del crédito", "Seguro por cuota", "Próximo pago", "Cuotas pagadas", "Cuotas pendientes", "Días vencidos", "Último pago", "Obligación", "Capital", "Fianza", "Intereses"]) {
    assert.ok(fields.some(([name]) => name === label), `Campo de detalle presente: ${label}`);
  }
  // Render the actual Facts leaf to confirm values are not only present in props.
  const renderedFacts = facts.map(node => content(node.type(node.props))).join(" ");
  for (const value of ["00081-A", "QA-81", fixture.clienteNombre, fixture.clienteTelefono, fixture.clienteDireccion, fixture.clienteCorreo, fixture.imei, fixture.referenciaEquipo, fixture.aliadoNombre, fixture.sedeNombre, fixture.ultimoPago]) assert.ok(renderedFacts.includes(value));
  toggle().props.onClick(); await h.flush();
  assert.equal(toggle().props["aria-expanded"], false); assert.equal(h.all(node => node.props?.id === "sadmin-detail-81").length, 0);
  assert.equal(h.all(node => node.type === "fieldset").length, 0);
  assert.doesNotMatch(content(h.find(node => node.type === "tbody")), /Cliente 81|Equipo de prueba|3 de 3 verificaciones|Folio/);
  toggle().props.onClick(); await h.flush();
  assert.equal(fieldset(h, 81).props["aria-label"], "Verificaciones SADMIN de 00081-A");
  for (const label of ["CODEUDOR CREADO", "CRÉDITO CREADO", "NÚMERO DE CRÉDITO"]) assert.equal(check(h, 81, label).props.checked, true);
  assert.equal(number(h, 81).props.value, "00081-A"); assert.equal(patches, 0);
  h.unmount();
});
