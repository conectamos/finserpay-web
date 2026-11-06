import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cloneElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(file, dependencies, globals = {}, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams, AbortController,
    require(name) {
      if (name === "@/app/_components/finser-confirm-dialog") {
        return load("app/_components/finser-confirm-dialog.tsx", dependencies, globals, cache);
      }
      if (name === "@/lib/cut-risk-presentation") {
        return load("lib/cut-risk-presentation.ts", dependencies, globals, cache);
      }
      if (/^\.\/[a-z][\w-]*$/.test(name)) {
        return load(`${file.slice(0, file.lastIndexOf("/"))}/${name.slice(2)}.tsx`, dependencies, globals, cache);
      }
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  cache.set(file, testModule.exports);
  return testModule.exports;
}

const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const filters = { day: 2, month: 11, year: 2026, aliadoId: null, sedeId: null, status: "todos" };
const money = value => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

function reportFixture() {
  const rows = [
    { creditId: 10, installment: 1, received: 100, priorPayments: 50, status: "pagado" },
    { creditId: 10, installment: 2, received: 20, priorPayments: 0, status: "parcial" },
    { creditId: 20, installment: 1, received: 0, priorPayments: 0, status: "pendiente" },
  ].map((row) => ({
    ...row, key: `${row.creditId}:${row.installment}`, clientName: `Cliente ${row.creditId}`, document: `Documento ${row.creditId}`,
    folio: `C-${row.creditId}`, aliadoId: 4, aliado: "Aliado prueba", sedeId: 8, sede: "Sede prueba", dueDate: "2026-11-02",
    installmentAmount: 100, expected: 100, pending: 100 - row.received, priorReversals: 0,
    lastPaymentAt: row.received ? "2026-11-02T14:00:00Z" : null, warning: null,
    payments: row.received ? [{ id: row.creditId + row.installment, amount: row.received, paidAt: "2026-11-02T14:00:00Z", createdAt: "2026-11-02T14:00:00Z", method: "EFECTIVO", state: "APLICADO", appliedBefore: row.priorPayments, appliedNow: row.received, received: row.received, previous: false }] : [],
  }));
  return {
    ok: true, mode: "consulta", filters, cutDate: "2026-11-02", asOf: "2026-11-02T17:30:00Z",
    projection: null, history: [], historyPage: 0, historyHasMore: false, rows,
    summary: { creditsCount: 2, expected: 300, received: 120, pending: 180, completion: 40, pendingClients: 2, priorPayments: 50, priorReversals: 0, previousRecovery: 25, futureAdvances: 75 },
    options: { aliados: [{ id: 4, nombre: "Aliado prueba" }], sedes: [{ id: 8, nombre: "Sede prueba", aliadoId: 4 }] }, warnings: [],
  };
}

function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate)),
  ];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return text(node.props?.children);
}
function normalized(value) { return String(value).replace(/\s+/g, " ").trim(); }
function name(node) { return normalized(node.props["aria-label"] || text(node)); }

function harness(respond = () => reportFixture()) {
  const components = new Map();
  let hooks;
  let cursor;
  let pendingEffects = [];
  const requests = [];
  const replacedUrls = [];
  const downloads = [];
  const hitPoints = [];
  let pointerHit = null;
  let tree;
  let html;
  const Component = load("app/dashboard/reportes/recaudo-por-corte/recaudo-por-corte-client.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const slots = hooks;
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
      },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useMemo(calculate, dependencies) {
        const index = cursor++;
        const previous = hooks[index];
        if (!previous || dependencies.some((value, dep) => !Object.is(value, previous.dependencies[dep]))) {
          hooks[index] = { dependencies, value: calculate() };
        }
        return hooks[index].value;
      },
      useEffect(callback, dependencies) {
        const slots = hooks;
        const index = cursor++;
        const old = slots[index];
        if (!old || !dependencies || dependencies.some((value, dependency) => !Object.is(value, old.dependencies[dependency]))) {
          const entry = slots[index] = { dependencies, cleanup: null };
          pendingEffects.push(() => {
            old?.cleanup?.();
            entry.cleanup = callback();
          });
        }
      },
    },
    "next/link": { default: ({ children, ...props }) => jsxRuntime.jsx("a", { ...props, children }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/app/_components/finser-ui": ui,
    "./recaudo-por-corte.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  }, {
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || "GET", cache: options?.cache,
        ...(options?.method === "POST" ? { headers: options.headers, body: options.body } : {}) });
      if (url.includes("format=xlsx")) return { ok: true, blob: async () => new Blob(["local test workbook"]) };
      if (url.includes("format=pdf")) return { ok: true, blob: async () => new Blob(["%PDF-QA local fixture"], { type: "application/pdf" }) };
      const data = await respond(url, options);
      return { ok: !data.error, json: async () => data };
    },
    crypto: { randomUUID },
    URL: { createObjectURL: () => "blob:local-test", revokeObjectURL: () => {} },
    document: {
      elementFromPoint: (x, y) => { hitPoints.push([x, y]); return pointerHit; },
      body: { appendChild: () => {} },
      createElement: () => ({ href: "", download: "", click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }),
    },
    window: {
      location: { pathname: "/dashboard/reportes/recaudo-por-corte" },
      history: { replaceState: (_state, _unused, url) => replacedUrls.push(url) },
      setTimeout: callback => { callback(); return 0; },
    },
  }).default;

  // Resolve the real client and its child components before inspecting DOM
  // controls. Hook state belongs to each component, including the detail pager.
  function expand(node, path) {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const instance = `${path}:${node.type.name}:${node.key ?? ""}`;
      if (!components.has(instance)) components.set(instance, []);
      hooks = components.get(instance);
      cursor = 0;
      return expand(node.type(node.props), instance);
    }
    // Expanding static JSX siblings turns them into arrays; preserve their
    // source position as a key when there wasn't an explicit one.
    return cloneElement(node, { key: node.key ?? path }, expand(node.props.children, `${path}/children`));
  }
  function render() {
    tree = expand(jsxRuntime.jsx(Component, { initialFilters: filters }), "root");
    html = renderToStaticMarkup(tree);
  }
  render();
  return {
    requests, replacedUrls, downloads, hitPoints, render,
    pointAt: element => { pointerHit = element; },
    html: () => html,
    text: () => normalized(text(tree)),
    find: predicate => nodes(tree, predicate),
    async settle() {
      const queued = pendingEffects;
      pendingEffects = [];
      queued.forEach(effect => effect());
      await new Promise(resolve => setImmediate(resolve));
      render();
    },
    change(label, value) {
      const field = nodes(tree, node => node.type === "label" && normalized(text(node)).startsWith(label))[0];
      const control = (field && nodes(field, node => ["select", "input"].includes(node.type))[0]) ||
        nodes(tree, node => ["select", "input"].includes(node.type) && node.props["aria-label"] === label)[0];
      assert.ok(control, label);
      control.props.onChange({ target: { value } });
      render();
    },
    async click(pattern) {
      const control = nodes(tree, node => (node.type === "button" || node.props.role === "radio") && pattern.test(name(node)))[0];
      assert.ok(control, `No se encontró el control ${pattern}`);
      assert.ok(!control.props.disabled, `El control ${pattern} está deshabilitado`);
      if (control.props.type === "submit") nodes(tree, node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
      else await control.props.onClick();
      render();
    },
  };
}

function expectMetric(app, label, value) {
  const region = app.find(node => node.props["aria-label"] === "Indicadores del corte con los filtros aplicados")[0];
  assert.ok(region, "Existe una región accesible para el balance del corte");
  const combinations = [`${label} ${value}`, `${value} ${label}`].map(normalized);
  assert.ok(nodes(region, node => combinations.includes(normalized(text(node)))).length, `${label}: ${value}`);
}

function tableRows(app) {
  const table = app.find(node => node.type === "table" && nodes(node, child => child.type === "tfoot").length)[0];
  assert.ok(table, "La tabla de cuotas tiene totales globales");
  return nodes(nodes(table, node => node.type === "tbody")[0], node => node.type === "tr");
}

function expectVisibleFilter(app, label) {
  const field = app.find(node => node.type === "label" && normalized(text(node)).startsWith(label))[0];
  assert.ok(field, `Existe el filtro ${label}`);
  assert.equal(app.find(node => (node.props.hidden || node.props["aria-hidden"] === true ||
    node.props["aria-hidden"] === "true" || node.props.style?.display === "none" ||
    node.props.style?.visibility === "hidden" || (node.type === "details" && !node.props.open)) &&
    nodes(node, child => child === field).length).length, 0, `${label} es visible sin abrir un panel`);
  assert.ok(!nodes(field, node => ["select", "input"].includes(node.type))[0].props.disabled,
    `${label} está disponible para editar`);
}

function reportWithRiskForUrl(url) {
  const query = new URL(url, "https://finserpay.test").searchParams;
  const report = reportFixture();
  const day = Number(query.get("day")) || report.filters.day;
  const month = Number(query.get("month")) || report.filters.month;
  const year = Number(query.get("year")) || report.filters.year;
  return { ...report,
    cutDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    filters: { ...report.filters, day, month, year, aliadoId: Number(query.get("aliadoId")) || null,
      sedeId: Number(query.get("sedeId")) || null, status: query.get("status") || "todos" },
    earlyRisk: ["DPF 3", "DPF 7", "DPF 15", "40/60"].map(label => ({ label, cases: 1, eligible: 2, pending: 0, unavailable: 0 })),
  };
}

function comparisonForUrl(url) {
  const query = new URL(url, "https://finserpay.test").searchParams;
  const report = reportWithRiskForUrl(url);
  return { reports: query.get("riskCuts").split(",").map((cutDate, index) => ({
    cutDate, queriedAt: report.asOf,
    earlyRisk: report.earlyRisk.map(metric => ({ ...metric, cases: index + 1, eligible: 10 })),
  })) };
}

function riskCutDates(app) {
  const list = app.find(node => node.type === "ul" && node.props["aria-label"] === "Cortes seleccionados para riesgo")[0];
  assert.ok(list);
  return nodes(list, node => node.type === "time").map(node => node.props.dateTime);
}

function riskMatrixDates(app) {
  const region = app.find(node => node.props.role === "region" && node.props["aria-label"]?.startsWith("Comparación de riesgo por corte"))[0];
  assert.ok(region, "La tabla de riesgo conserva una región desplazable con nombre accesible");
  assert.equal(region.props.tabIndex, 0);
  const body = nodes(region, node => node.type === "tbody")[0];
  return nodes(body, node => node.type === "time").map(node => node.props.dateTime);
}

function riskChip(app, cut) {
  return app.find(node => node.type === "li" && nodes(node, child => child.type === "time" && child.props.dateTime === cut).length)[0];
}

test("tres cortes agregados fuera de orden se comparan y se envían en el mismo orden cronológico", async () => {
  const app = harness((url, options) => {
    const query = new URL(url, "https://finserpay.test").searchParams;
    if (options?.method === "POST") return { ok: true, recipient: query.get("action") === "email" ? "aliado@example.test" : "+573001234567" };
    return query.get("format") === "risk" ? comparisonForUrl(url) : reportWithRiskForUrl(url);
  });
  await app.settle();
  app.change("Aliado", "4");
  app.change("Sede", "8");
  await app.click(/^Consultar corte$/);
  await app.settle();
  app.change("Mes para comparar", "10");
  app.change("Día para comparar", "17");
  await app.click(/^Agregar corte$/);
  app.change("Día para comparar", "2");
  await app.click(/^Agregar corte$/);
  const expected = ["2026-10-02", "2026-10-17", "2026-11-02"];
  assert.deepEqual(riskCutDates(app), expected);
  assert.ok(app.find(node => node.type === "button" && name(node) === "Descargar informe PDF")[0].props.disabled);
  await app.settle();
  const riskRequest = app.requests.filter(request => request.url.includes("format=risk")).at(-1);
  assert.equal(new URL(riskRequest.url, "https://finserpay.test").searchParams.get("riskCuts"), expected.join(","));
  assert.ok(app.text().includes("FPD 3") && app.text().includes("FPD 7") && app.text().includes("FPD 15"));
  assert.ok(!app.text().includes("DPF"));
  assert.deepEqual(riskMatrixDates(app), expected);
  assert.match(app.text(), /40\/60 6 cuotas en 3 meses/);
  await app.click(/^Descargar informe PDF$/);
  assert.equal(app.downloads.at(-1).name, "FINSERPAY_Riesgo_2026-10-02_a_2026-11-02.pdf");
  await app.click(/^Enviar por WhatsApp$/);
  await app.click(/^Enviar por correo$/);
  assert.match(app.text(), /Cortes de riesgo:/);
  const confirmation = app.find(node => node.props.role === "alertdialog")[0];
  assert.ok(!text(confirmation).includes("Estado:"));
  await app.click(/^Confirmar envío$/);
  const deliveries = app.requests.filter(request => request.method === "POST" || request.url.includes("format=pdf"));
  assert.equal(deliveries.length, 3);
  for (const request of deliveries) {
    const query = new URL(request.url, "https://finserpay.test").searchParams;
    assert.equal(query.get("riskCuts"), expected.join(","));
    assert.equal(query.get("aliadoId"), "4");
    assert.equal(query.get("sedeId"), "8");
  }
});

test("el selector valida año, evita duplicados, limita seis fechas y permite retirar el corte principal", async () => {
  const app = harness(url => url.includes("format=risk") ? comparisonForUrl(url) : reportWithRiskForUrl(url));
  await app.settle();
  await app.click(/^Agregar corte$/);
  assert.match(app.text(), /Ese corte ya está en la comparación/);
  app.change("Año para comparar", "1999");
  await app.click(/^Agregar corte$/);
  assert.match(app.text(), /El año debe estar entre 2000 y 2200/);
  app.change("Año para comparar", "2201");
  await app.click(/^Agregar corte$/);
  assert.equal(riskCutDates(app).length, 1);
  app.change("Año para comparar", "2026");
  for (const [month, day] of [[10, 17], [10, 2], [9, 17], [9, 2], [8, 17]]) {
    app.change("Mes para comparar", String(month));
    app.change("Día para comparar", String(day));
    await app.click(/^Agregar corte$/);
  }
  assert.equal(riskCutDates(app).length, 6);
  assert.equal(app.find(node => node.type === "button" && name(node) === "Agregar corte")[0].props.disabled, true);
  const principal = riskChip(app, "2026-11-02");
  nodes(principal, node => node.type === "button" && name(node).startsWith("Quitar corte del"))[0].props.onClick();
  app.render();
  assert.ok(!riskCutDates(app).includes("2026-11-02"));
  const selected = riskCutDates(app);
  app.change("Mes", "12");
  await app.click(/^Consultar corte$/);
  await app.settle();
  assert.deepEqual(riskCutDates(app), selected, "La selección explícita persiste al cambiar el corte principal");
  await app.settle();
  await app.click(/^Usar corte consultado$/);
  assert.deepEqual(riskCutDates(app), ["2026-12-02"]);
  const onlyRemove = app.find(node => node.type === "button" && name(node).startsWith("Quitar corte del"))[0];
  assert.equal(onlyRemove.props.disabled, true);
  app.change("Mes", "10");
  await app.click(/^Consultar corte$/);
  await app.settle();
  assert.deepEqual(riskCutDates(app), ["2026-10-02"], "Sin selección explícita sigue al corte consultado");
});

test("flechas accesibles y arrastre fijan el orden manual para la tabla, el PDF y WhatsApp", async () => {
  const app = harness((url, options) => options?.method === "POST" ? { ok: true, recipient: "+573001234567" }
    : url.includes("format=risk") ? comparisonForUrl(url) : reportWithRiskForUrl(url));
  await app.settle();
  app.change("Aliado", "4");
  await app.click(/^Consultar corte$/);
  await app.settle();
  for (const day of [17, 2]) {
    app.change("Mes para comparar", "10");
    app.change("Día para comparar", String(day));
    await app.click(/^Agregar corte$/);
  }
  const moveEarlier = nodes(riskChip(app, "2026-11-02"), node => node.type === "button" && name(node).endsWith(" antes"))[0];
  assert.equal(moveEarlier.props.disabled, false);
  moveEarlier.props.onClick();
  app.render();
  assert.deepEqual(riskCutDates(app), ["2026-10-02", "2026-11-02", "2026-10-17"]);
  assert.match(app.text(), /movido a la posición 2 de 3/);
  const dragData = new Map();
  const dataTransfer = { setData: (type, value) => dragData.set(type, value) };
  assert.equal(riskChip(app, "2026-11-02").props.draggable, true);
  riskChip(app, "2026-11-02").props.onDragStart({ dataTransfer });
  app.render();
  assert.equal(dragData.get("text/plain"), "2026-11-02");
  riskChip(app, "2026-10-02").props.onDrop({ preventDefault() {} });
  app.render();
  app.change("Mes para comparar", "9");
  app.change("Día para comparar", "2");
  await app.click(/^Agregar corte$/);
  const expected = ["2026-11-02", "2026-10-02", "2026-10-17", "2026-09-02"];
  assert.deepEqual(riskCutDates(app), expected, "Agregar conserva el orden manual y coloca el nuevo corte al final");
  await app.settle();
  assert.deepEqual(riskMatrixDates(app), expected);
  await app.click(/^Descargar informe PDF$/);
  assert.equal(app.downloads.at(-1).name, "FINSERPAY_Riesgo_2026-09-02_a_2026-11-02.pdf");
  await app.click(/^Enviar por WhatsApp$/);
  for (const request of app.requests.filter(request => request.method === "POST" || request.url.includes("format=pdf"))) {
    assert.equal(new URL(request.url, "https://finserpay.test").searchParams.get("riskCuts"), expected.join(","));
  }
});

test("el agarre usa captura y coordenadas de puntero, valida destino y mueve una sola vez", async () => {
  const app = harness(url => url.includes("format=risk") ? comparisonForUrl(url) : reportWithRiskForUrl(url));
  await app.settle();
  for (const day of [17, 2]) {
    app.change("Mes para comparar", "10");
    app.change("Día para comparar", String(day));
    await app.click(/^Agregar corte$/);
  }
  const listNode = app.find(node => node.type === "ul" && node.props["data-risk-cut-list"] === "")[0];
  const localList = {};
  listNode.props.ref.current = localList;
  const hit = (cut, list = localList) => ({ closest: selector => {
    assert.equal(selector, "[data-risk-cut]");
    return { dataset: { riskCut: cut }, closest: parentSelector => {
      assert.equal(parentSelector, "[data-risk-cut-list]");
      return list;
    } };
  } });
  const captured = new Set();
  const releases = [];
  const gripElement = {
    setPointerCapture: pointerId => captured.add(pointerId),
    hasPointerCapture: pointerId => captured.has(pointerId),
    releasePointerCapture: pointerId => { releases.push(pointerId); captured.delete(pointerId); },
  };
  const pointer = (pointerId = 7) => ({ pointerId, pointerType: "mouse", button: 0, isPrimary: true,
    clientX: 144, clientY: 320, currentTarget: gripElement, preventDefault() {}, stopPropagation() {} });
  const grip = cut => nodes(riskChip(app, cut), node => node.type === "button" && name(node).startsWith("Arrastrar corte del"))[0];
  grip("2026-11-02").props.onPointerDown(pointer());
  assert.ok(captured.has(7));
  let nativeBlocked = false;
  riskChip(app, "2026-11-02").props.onDragStart({ preventDefault() { nativeBlocked = true; }, dataTransfer: { setData() { assert.fail("No debe iniciar un segundo arrastre nativo"); } } });
  assert.equal(nativeBlocked, true);
  app.pointAt(hit("2026-10-02"));
  grip("2026-11-02").props.onPointerMove(pointer());
  app.render();
  assert.equal(riskChip(app, "2026-10-02").props["data-drop-target"], true);
  const sourceGrip = grip("2026-11-02");
  sourceGrip.props.onPointerUp(pointer());
  sourceGrip.props.onPointerUp(pointer());
  sourceGrip.props.onLostPointerCapture(pointer());
  riskChip(app, "2026-10-17").props.onDrop({ preventDefault() {} });
  app.render();
  const expected = ["2026-11-02", "2026-10-02", "2026-10-17"];
  assert.deepEqual(riskCutDates(app), expected);
  assert.deepEqual(releases, [7]);
  assert.deepEqual(app.hitPoints.at(-1), [144, 320]);

  // A matching date in another list is not a valid drop target.
  grip("2026-10-17").props.onPointerDown(pointer(8));
  app.pointAt(hit("2026-11-02", {}));
  grip("2026-10-17").props.onPointerMove(pointer(8));
  grip("2026-10-17").props.onPointerUp(pointer(8));
  app.render();
  assert.deepEqual(riskCutDates(app), expected);

  // Cancelling a captured touch gesture must not commit its hovered target.
  const touch = { ...pointer(9), pointerType: "touch" };
  grip("2026-10-17").props.onPointerDown(touch);
  app.pointAt(hit("2026-11-02"));
  grip("2026-10-17").props.onPointerMove(touch);
  grip("2026-10-17").props.onPointerCancel(touch);
  grip("2026-10-17").props.onPointerUp(touch);
  app.render();
  assert.deepEqual(riskCutDates(app), expected);
  assert.equal(captured.size, 0);
  await app.settle();
  assert.deepEqual(riskMatrixDates(app), expected);
});

test("una comparación fallida impide exportar o enviar hasta reintentar con éxito", async () => {
  let fail = true;
  const app = harness(url => url.includes("format=risk")
    ? fail ? { error: "No se pudo consultar riesgo." } : comparisonForUrl(url)
    : reportWithRiskForUrl(url));
  await app.settle();
  app.change("Aliado", "4");
  await app.click(/^Consultar corte$/);
  await app.settle();
  app.change("Mes para comparar", "10");
  await app.click(/^Agregar corte$/);
  await app.settle();
  assert.match(app.text(), /No se pudo consultar riesgo/);
  for (const label of ["Descargar informe PDF", "Enviar por WhatsApp", "Enviar por correo"]) {
    assert.equal(app.find(node => node.type === "button" && name(node) === label)[0].props.disabled, true);
  }
  fail = false;
  await app.click(/^Reintentar comparación$/);
  await app.settle();
  assert.equal(app.find(node => node.type === "button" && name(node) === "Descargar informe PDF")[0].props.disabled, false);
});

test("WhatsApp envía directamente al aliado aplicado con los filtros consultados y sin destinatario del cliente", async () => {
  const app = harness((url, options) => options?.method === "POST"
    ? { ok: true, recipient: "+573001234567" } : reportWithRiskForUrl(url));
  await app.settle();
  assert.equal(app.find(node => node.type === "button" && name(node) === "Enviar por WhatsApp").length, 0);
  app.change("Aliado", "4");
  assert.equal(app.find(node => node.type === "button" && name(node) === "Enviar por WhatsApp").length, 0,
    "Cambiar el borrador no habilita un envío a un aliado aún no consultado");
  app.change("Sede", "8");
  app.change("Estado", "parcial");
  await app.click(/^Consultar corte$/);
  await app.settle();
  app.change("Estado", "pagado");
  await app.click(/^Enviar por WhatsApp$/);
  const requests = app.requests.filter(request => request.method === "POST");
  assert.equal(requests.length, 1);
  const query = new URL(requests[0].url, "https://finserpay.test").searchParams;
  for (const [key, expected] of Object.entries({ day: "2", month: "11", year: "2026", status: "parcial", aliadoId: "4", sedeId: "8", action: "whatsapp" })) {
    assert.equal(query.get(key), expected, key);
  }
  assert.equal(query.has("recipient"), false);
  assert.equal(query.has("phone"), false);
  assert.equal(requests[0].body, undefined);
  assert.equal(requests[0].headers["Content-Type"], "application/json");
  assert.match(requests[0].headers["Idempotency-Key"], /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(app.find(node => node.props.role === "alertdialog").length, 0);
  assert.match(app.text(), /Envío por WhatsApp aceptado para \+573001234567/);
  assert.equal(app.downloads.length, 0);
  assert.ok(!app.text().includes("Compartir por WhatsApp") && !app.text().includes("adjunta el archivo"));
});

test("WhatsApp bloquea envíos simultáneos mientras el servidor responde", async () => {
  let finishSend;
  const app = harness((url, options) => options?.method === "POST"
    ? new Promise(resolve => { finishSend = resolve; }) : reportWithRiskForUrl(url));
  await app.settle();
  app.change("Aliado", "4");
  await app.click(/^Consultar corte$/);
  await app.settle();
  const button = app.find(node => node.type === "button" && name(node) === "Enviar por WhatsApp")[0];
  const first = button.props.onClick();
  await button.props.onClick();
  app.render();
  assert.equal(app.requests.filter(request => request.method === "POST").length, 1);
  const pendingButton = app.find(node => node.type === "button" && name(node) === "Enviando por WhatsApp…")[0];
  assert.equal(pendingButton.props.disabled, true);
  finishSend({ ok: true, recipient: "+573001234567" });
  await first;
  app.render();
  assert.equal(app.find(node => node.type === "button" && name(node) === "Enviar por WhatsApp")[0].props.disabled, false);
});

test("un fallo de red de WhatsApp informa incertidumbre y conserva la clave al repetir el mismo envío", async () => {
  let fail = true;
  const app = harness((url, options) => {
    if (options?.method !== "POST") return reportWithRiskForUrl(url);
    if (fail) throw new Error("QA offline");
    return { ok: true, recipient: "+573001234567" };
  });
  await app.settle();
  app.change("Aliado", "4");
  await app.click(/^Consultar corte$/);
  await app.settle();
  await app.click(/^Enviar por WhatsApp$/);
  assert.match(app.text(), /No fue posible confirmar el envío por WhatsApp\. Verifica si llegó antes de repetirlo/);
  assert.ok(!app.text().includes("QA offline"));
  assert.ok(app.find(node => node.props.role === "alert").length);
  fail = false;
  await app.click(/^Enviar por WhatsApp$/);
  const requests = app.requests.filter(request => request.method === "POST");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  assert.match(app.text(), /Envío por WhatsApp aceptado/);
});

test("la consulta inicial es GET y presenta los seis indicadores financieros sin depender de su orden", async () => {
  const app = harness();
  assert.match(app.html(), /Consultando cronogramas y pagos/);
  await app.settle();
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0], { url: "/api/reportes/recaudo-por-corte?day=2&month=11&year=2026&status=todos", method: "GET", cache: "no-store" });
  for (const [label, value] of [
    ["Créditos del corte", "2"], ["Recaudo esperado", money(300)], ["Recaudo recibido", money(120)],
    ["Pendiente por recaudar", money(180)], ["Cumplimiento", "40 %"], ["Clientes pendientes", "2"],
  ]) expectMetric(app, label, value);
  const footer = app.find(node => node.type === "tfoot")[0];
  const footerText = normalized(text(footer));
  for (const value of [300, 50, 120, 180]) assert.ok(footerText.includes(normalized(money(value))));
  assert.match(app.text(), /Incluido en recibido Anticipos del corte/);
  assert.match(app.text(), /Fuera del corte Recuperación de cuotas anteriores/);
  assert.match(app.text(), /Fuera del corte Anticipos de cuotas futuras/);
  assert.doesNotMatch(app.html(), /proyecci[oó]n|Vista previa|Historial y comparación|Guardar/i);
});

test("cambiar corte y filtros consulta directamente y exporta los mismos filtros sin POST", async () => {
  const app = harness(url => {
    const report = reportFixture();
    const query = new URL(url, "https://example.test").searchParams;
    if (query.get("day") === "17") {
      report.cutDate = "2025-10-17";
      report.filters = { day: 17, month: 10, year: 2025, aliadoId: 4, sedeId: 8, status: "parcial" };
    }
    return report;
  });
  await app.settle();
  assert.deepEqual(app.find(node => node.type === "input" && node.props.type === "radio").map(node => [node.props.value, node.props.checked]), [[2, true], [17, false]]);
  for (const label of ["02", "17", "Mes", "Año", "Aliado", "Sede", "Estado"]) expectVisibleFilter(app, label);
  assert.equal(app.find(node => node.type === "button" && /Más filtros/.test(name(node))).length, 0);
  app.change("17", "17");
  app.change("Mes", "10");
  app.change("Año", "2025");
  app.change("Aliado", "4");
  app.change("Sede", "8");
  app.change("Estado", "parcial");
  assert.equal(app.requests.length, 1, "Los filtros en edición no disparan consultas");
  await app.click(/^Consultar corte$/);
  await app.settle();
  const expected = "day=17&month=10&year=2025&status=parcial&aliadoId=4&sedeId=8";
  assert.ok(app.requests[1].url.endsWith(`?${expected}`));
  assert.ok(app.replacedUrls[0].endsWith(`?${expected}`));
  await app.click(/^Exportar a Excel$/);
  assert.ok(app.requests.at(-1).url.endsWith(`?${expected}&format=xlsx`));
  assert.deepEqual(app.downloads, [{ href: "blob:local-test", name: "recaudo-por-corte-2025-10-17.xlsx" }]);
  assert.ok(app.requests.every(request => request.method === "GET"));
  assert.ok(app.requests.every(request => !/projectionId|historyPage/.test(request.url)));
});

test("el detalle mantiene la aplicación real del pago y distingue los anticipos incluidos", async () => {
  const app = harness();
  await app.settle();
  await app.click(/^Ver pagos de/);
  assert.match(app.html(), /Pagos de la cuota 1/);
  assert.match(app.html(), /Aplicado a esta cuota/);
  assert.match(app.html(), /EFECTIVO/);
  assert.match(app.html(), /antes, durante o después del vencimiento/);
  assert.doesNotMatch(app.html(), /al guardar|proyecci[oó]n/i);
  await app.click(/^Cerrar detalle de pagos$/);
  assert.doesNotMatch(app.html(), /Pagos de la cuota 1/);
});

test("el selector de sede sólo muestra opciones autorizadas para el aliado escogido y limpia la selección anterior", async () => {
  const report = reportFixture();
  report.options.aliados.push({ id: 5, nombre: "Segundo aliado autorizado" });
  report.options.sedes.push({ id: 9, nombre: "Segunda sede autorizada", aliadoId: 5 });
  const app = harness(() => report);
  await app.settle();
  for (const label of ["Aliado", "Sede", "Estado"]) expectVisibleFilter(app, label);
  const sede = () => nodes(app.find(node => node.type === "label" && normalized(text(node)).startsWith("Sede"))[0], node => node.type === "select")[0];
  const options = () => nodes(sede(), node => node.type === "option").map(node => String(node.props.value));
  assert.deepEqual(options(), ["", "8", "9"]);
  app.change("Aliado", "4");
  assert.deepEqual(options(), ["", "8"]);
  app.change("Sede", "8");
  app.change("Aliado", "5");
  assert.equal(sede().props.value, "");
  assert.deepEqual(options(), ["", "9"]);
  assert.equal(app.requests.length, 1);
});

test("página 2 mantiene totales globales y Excel exporta todo el corte filtrado sin paginación", async () => {
  const report = reportFixture();
  const count = 27;
  report.rows = Array.from({ length: count }, (_, index) => ({ ...report.rows[1], key: `${index + 1}:1`,
    creditId: index + 1, installment: 1, document: `DOC${index + 1}`, folio: `CRE${index + 1}`,
    clientName: `Cliente simulado ${String(index + 1).padStart(2, "0")}` }));
  report.summary = { ...report.summary, creditsCount: count, pendingClients: count,
    expected: count * 100, received: count * 20, pending: count * 80, completion: 20, priorPayments: 0 };
  const app = harness(url => {
    const query = new URL(url, "https://example.test").searchParams;
    return { ...report, filters: { ...report.filters, status: query.get("status"), aliadoId: Number(query.get("aliadoId")) || null,
      sedeId: Number(query.get("sedeId")) || null } };
  });
  await app.settle();
  app.change("Aliado", "4");
  app.change("Sede", "8");
  app.change("Estado", "parcial");
  await app.click(/^Consultar corte$/);
  await app.settle();

  assert.equal(tableRows(app).length, 25);
  assert.match(app.text(), /Mostrando 1\s*–\s*25 de 27 cuotas/);
  const totals = () => normalized(text(app.find(node => node.type === "tfoot")[0]));
  const firstPageTotals = totals();
  for (const value of [report.summary.expected, report.summary.received, report.summary.pending]) {
    assert.ok(firstPageTotals.includes(normalized(money(value))));
  }
  await app.click(/^Página siguiente$/);
  assert.equal(tableRows(app).length, 2);
  assert.match(normalized(text(tableRows(app))), /Cliente simulado 26.*Cliente simulado 27/);
  assert.match(app.text(), /Mostrando 26\s*–\s*27 de 27 cuotas/);
  assert.equal(totals(), firstPageTotals);
  expectMetric(app, "Recaudo recibido", money(report.summary.received));
  expectMetric(app, "Créditos del corte", String(count));
  assert.equal(app.requests.length, 2, "Cambiar de página no consulta otro corte");

  app.change("17", "17");
  await app.click(/^Exportar a Excel$/);
  const exported = new URL(app.requests.at(-1).url, "https://example.test");
  assert.deepEqual(Object.fromEntries(exported.searchParams), {
    day: "2", month: "11", year: "2026", status: "parcial", aliadoId: "4", sedeId: "8", format: "xlsx",
  });
  assert.equal(app.downloads.length, 1);
  assert.equal(totals(), firstPageTotals);
  assert.ok(app.requests.every(request => request.method === "GET"));
});

test("el recibido conciliado sin fecha individual conserva su valor sin presentarse como anticipo", async () => {
  const data = reportFixture();
  data.summary.unclassifiedReceived = 50;
  data.rows[0].unclassifiedReceived = 50;
  data.rows[0].reconciledReceived = 50;
  data.rows[0].payments[0] = { ...data.rows[0].payments[0], amount: 50, appliedNow: 50, received: 50, previous: true, paidAt: "2026-11-01T14:00:00Z" };
  data.rows[0].sourcePayments = [{ id: 99, paidAt: "2026-11-02T14:00:00Z", createdAt: "2026-11-02T14:00:00Z", method: "EFECTIVO", state: "APLICADO", amount: 900 }];
  const app = harness(() => data);
  await app.settle();
  assert.match(app.html(), /no permite separar su fecha individual; no se clasifica como anticipo/);
  expectMetric(app, "Recaudo recibido", money(120));
  await app.click(/^Ver pagos de/);
  assert.equal(data.rows[0].received, data.rows[0].payments.reduce((total, payment) => total + payment.received, 0) + data.rows[0].reconciledReceived);
  assert.match(app.html(), /Efectivo conciliado por cuota \(incluido en recibido\): <strong>\$ 50<\/strong>/);
  assert.match(app.html(), /Abonos fuente de la conciliación/);
  assert.match(app.html(), /no equivalen al importe aplicado a esta cuota/);

  data.rows[0].reconciledReceived = data.rows[0].received;
  data.rows[0].payments = [];
  app.render();
  assert.match(app.html(), /Sin recibos con asignación individual/);
  assert.doesNotMatch(app.html(), /Esta cuota aún no tiene pagos/);
});

test("vacío, esperado cero y error se muestran sin pedir guardar una proyección", async () => {
  const empty = harness(() => ({ ...reportFixture(), rows: [], summary: { ...reportFixture().summary, creditsCount: 0, expected: 0, received: 0, pending: 0, completion: null, pendingClients: 0, priorPayments: 0 } }));
  await empty.settle();
  assert.match(empty.html(), /No hay cuotas con estos filtros/);
  assert.match(empty.html(), /No aplica/);
  assert.doesNotMatch(empty.html(), /NaN|Infinity|guardar|proyecci[oó]n/i);
  const error = harness(() => ({ ok: false, error: "No fue posible consultar las cuotas" }));
  await error.settle();
  assert.match(error.html(), /role="alert"/);
  assert.match(error.html(), /Reintentar consulta/);
  assert.equal(error.find(node => node.props["aria-label"] === "Indicadores del corte con los filtros aplicados").length, 0);
});
