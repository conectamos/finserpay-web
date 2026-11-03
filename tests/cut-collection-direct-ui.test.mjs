import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams, AbortController,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return testModule.exports;
}

const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const filters = { day: 2, month: 11, year: 2026, aliadoId: null, sedeId: null, status: "todos" };
const money = value => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

function reportFixture() {
  const rows = [
    { creditId: 10, installment: 1, received: 100, priorPayments: 50, status: "pagado" },
    { creditId: 10, installment: 2, received: 50, priorPayments: 0, status: "parcial" },
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
    summary: { creditsCount: 2, expected: 300, received: 150, pending: 150, completion: 50, pendingClients: 2, priorPayments: 50, priorReversals: 0, previousRecovery: 25, futureAdvances: 75 },
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

function harness(respond = () => reportFixture()) {
  const states = [];
  const effects = [];
  let pendingEffects = [];
  let stateCursor = 0;
  let effectCursor = 0;
  const requests = [];
  const replacedUrls = [];
  const downloads = [];
  let tree;
  let html;
  const Component = load("app/dashboard/reportes/recaudo-por-corte/recaudo-por-corte-client.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const index = stateCursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useRef: () => ({ current: null }),
      useEffect(callback, dependencies) {
        const index = effectCursor++;
        const old = effects[index];
        if (!old || dependencies.some((value, dependency) => !Object.is(value, old.dependencies[dependency]))) {
          pendingEffects.push(() => {
            old?.cleanup?.();
            effects[index] = { dependencies, cleanup: callback() };
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
      requests.push({ url, method: options?.method || "GET", cache: options?.cache });
      if (url.includes("format=xlsx")) return { ok: true, blob: async () => new Blob(["local test workbook"]) };
      const data = await respond(url);
      return { ok: !data.error, json: async () => data };
    },
    URL: { createObjectURL: () => "blob:local-test", revokeObjectURL: () => {} },
    document: {
      body: { appendChild: () => {} },
      createElement: () => ({ href: "", download: "", click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }),
    },
    window: {
      location: { pathname: "/dashboard/reportes/recaudo-por-corte" },
      history: { replaceState: (_state, _unused, url) => replacedUrls.push(url) },
      setTimeout: callback => { callback(); return 0; },
    },
  }).default;

  function render() {
    stateCursor = 0;
    effectCursor = 0;
    tree = Component({ initialFilters: filters });
    html = renderToStaticMarkup(tree);
  }
  render();
  return {
    requests, replacedUrls, downloads, render,
    html: () => html,
    find: predicate => nodes(tree, predicate),
    async settle() {
      const queued = pendingEffects;
      pendingEffects = [];
      queued.forEach(effect => effect());
      await new Promise(resolve => setImmediate(resolve));
      render();
    },
    change(label, value) {
      const field = nodes(tree, node => node.type === "label" && node.props.children[0] === label)[0];
      assert.ok(field, label);
      field.props.children[1].props.onChange({ target: { value } });
      render();
    },
    submit() {
      nodes(tree, node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
      render();
    },
  };
}

test("la consulta inicial es GET y muestra seis totales sin guardar ni seleccionar versiones", async () => {
  const app = harness();
  assert.match(app.html(), /Consultando cronogramas y pagos/);
  await app.settle();
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0], { url: "/api/reportes/recaudo-por-corte?day=2&month=11&year=2026&status=todos", method: "GET", cache: "no-store" });
  const cards = app.find(node => node.type === ui.MetricCard);
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.map(card => [card.props.label, card.props.value]), [
    ["Créditos del corte", "2"], ["Recaudo esperado", money(300)], ["Recaudo recibido", money(150)],
    ["Pendiente por recaudar", money(150)], ["Cumplimiento", "50 %"], ["Clientes pendientes", "2"],
  ]);
  const footer = app.find(node => node.type === "tfoot")[0];
  assert.deepEqual(Array.from(footer.props.children.props.children.slice(1, 6), cell => cell.props.children), [money(300), money(50), money(300), money(150), money(150)]);
  assert.match(app.html(), /Anticipos incluidos en recibido/);
  assert.match(app.html(), /no se suman de nuevo/);
  assert.doesNotMatch(app.html(), /proyecci[oó]n|Vista previa|Historial y comparación|Guardar/i);
});

test("cambiar corte y filtros consulta directamente y exporta los mismos filtros sin POST", async () => {
  const app = harness();
  await app.settle();
  app.change("Corte", "17");
  app.change("Mes", "10");
  app.change("Año", "2025");
  app.change("Aliado", "4");
  app.change("Sede", "8");
  app.change("Estado", "parcial");
  app.submit();
  await app.settle();
  const expected = "day=17&month=10&year=2025&status=parcial&aliadoId=4&sedeId=8";
  assert.ok(app.requests[1].url.endsWith(`?${expected}`));
  assert.ok(app.replacedUrls[0].endsWith(`?${expected}`));
  const exportButton = app.find(node => node.type === ui.Button && node.props.children?.includes?.("Exportar a Excel"))[0];
  assert.ok(exportButton);
  await exportButton.props.onClick();
  assert.ok(app.requests.at(-1).url.endsWith(`?${expected}&format=xlsx`));
  assert.deepEqual(app.downloads, [{ href: "blob:local-test", name: "recaudo-por-corte-2026-11-02.xlsx" }]);
  assert.ok(app.requests.every(request => request.method === "GET"));
  assert.ok(app.requests.every(request => !/projectionId|historyPage/.test(request.url)));
});

test("el detalle mantiene la aplicación real del pago y distingue los anticipos incluidos", async () => {
  const app = harness();
  await app.settle();
  app.find(node => node.type === ui.Button && String(node.props["aria-label"]).startsWith("Ver pagos de"))[0].props.onClick();
  app.render();
  assert.match(app.html(), /Pagos de la cuota 1/);
  assert.match(app.html(), /Aplicado a esta cuota/);
  assert.match(app.html(), /EFECTIVO/);
  assert.match(app.html(), /antes, durante o después del vencimiento/);
  assert.doesNotMatch(app.html(), /al guardar|proyecci[oó]n/i);
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
  assert.equal(app.find(node => node.type === ui.MetricCard && node.props.label === "Recaudo recibido")[0].props.value, money(150));
  app.find(node => node.type === ui.Button && String(node.props["aria-label"]).startsWith("Ver pagos de"))[0].props.onClick();
  app.render();
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
  assert.equal(error.find(node => node.type === ui.MetricCard).length, 0);
});
