import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(path, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(code, { module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams, AbortController, Error,
    require(name) {
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    }, ...globals,
  });
  return testModule.exports;
}

const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const risk = load("lib/cut-risk-presentation.ts", {});
const initialQuery = "day=2&month=11&year=2026&aliadoId=4&sedeId=8&status=parcial";
const money = value => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
const metric = (cases = 5, eligible = 100, pending = 0, label = "DPF 3") => ({ label, cases, eligible, pending, unavailable: 0 });
const summary = (received = 650, expected = 1000) => ({ expected, received, pending: expected - received, completion: expected ? received / expected * 100 : null, pendingClients: 20, creditsCount: 100, priorPayments: 100, priorReversals: 0, previousRecovery: 0, futureAdvances: 0 });
function fixture() {
  return {
    ok: true, cutDate: "2026-11-02", asOf: "2026-11-06T14:00:00Z",
    filters: { day: 2, month: 11, year: 2026, aliadoId: 4, sedeId: 8, status: "parcial" },
    collectionBasis: { mode: "current_accumulated", sameAgeAvailable: false, referenceAgeDays: 4, reason: "NO_COMPLETE_HISTORICAL_LEDGER" },
    cuts: [
      { cutDate: "2026-11-02", ageDays: 4, summary: summary(), earlyRisk: [metric(5, 100, 20), metric(0, 0, 100, "DPF 7"), metric(0, 0, 100, "DPF 15")], unavailableCredits: 0 },
      { cutDate: "2026-10-17", ageDays: 20, summary: summary(900), earlyRisk: [metric(10), metric(4, 100, 0, "DPF 7"), metric(2, 100, 0, "DPF 15")], unavailableCredits: 0 },
    ],
    priorities: {
      allies: [1, 2, 3, 4, 5, 6].map(id => ({ id, name: `Aliado ${id}`, expected: 1000, received: 100, pending: 900 + id,
        collectiblePending: id === 6 ? 2000 : id * 100, creditsCount: 20, pendingClients: 15, fpd3: metric(id === 6 ? 0 : id, id === 6 ? 0 : 100), fpd3Rate: id === 6 ? null : id })),
      sites: [{ id: 8, name: "Sede Centro", aliadoId: 4, aliado: "Aliado propietario", expected: 1000, received: 500, pending: 500,
        collectiblePending: 200, creditsCount: 10, pendingClients: 5, fpd3: metric(1), fpd3Rate: 1 }],
    }, warnings: [],
  };
}
function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate))];
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join(" ");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? content(node.props?.children) : String(node);
}
const normalized = value => String(value).replace(/\s+/g, " ").trim();

function harness(respond = async () => fixture()) {
  const instances = new Map();
  let slots, cursor, tree, query = initialQuery;
  let effects = [];
  const requests = [];
  const Component = load("app/dashboard/reportes/recaudo-por-corte/cut-automatic-analysis.tsx", {
    "react/jsx-runtime": jsxRuntime, "@/app/_components/finser-ui": ui, "@/lib/cut-risk-presentation": risk,
    react: {
      useState(initial) {
        const current = slots, position = cursor++;
        if (!(position in current)) current[position] = typeof initial === "function" ? initial() : initial;
        return [current[position], next => { current[position] = typeof next === "function" ? next(current[position]) : next; }];
      },
      useEffect(callback, dependencies) {
        const current = slots, position = cursor++, old = current[position];
        if (!old || dependencies.some((value, index) => !Object.is(value, old.dependencies[index]))) {
          const entry = current[position] = { dependencies, cleanup: null };
          effects.push(() => { old?.cleanup?.(); entry.cleanup = callback(); });
        }
      },
    },
  }, { fetch: async (url, options) => {
    requests.push({ url, ...options });
    const data = await respond(url, options);
    return { ok: !data.error, json: async () => data };
  } }).default;
  function expand(node, path) {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = `${path}:${node.type.name}:${node.key ?? ""}`;
      if (!instances.has(key)) instances.set(key, []);
      slots = instances.get(key); cursor = 0;
      return expand(node.type(node.props), key);
    }
    return cloneElement(node, { key: node.key ?? path }, expand(node.props.children, `${path}/children`));
  }
  function render() { tree = expand(jsxRuntime.jsx(Component, { filtersQuery: query }), "root"); }
  render();
  return {
    requests, find: predicate => nodes(tree, predicate), text: () => normalized(content(tree)), html: () => renderToStaticMarkup(tree),
    setQuery(value) { query = value; render(); },
    async settle() { const pending = effects; effects = []; pending.forEach(callback => callback()); await new Promise(resolve => setImmediate(resolve)); render(); },
    click(label) { const button = nodes(tree, node => node.type === "button" && normalized(content(node)) === label)[0]; assert.ok(button, label); button.props.onClick(); render(); },
    order(value) { const select = nodes(tree, node => node.type === "select")[0]; select.props.onChange({ target: { value } }); render(); },
  };
}

test("análisis: acumula con anticipos, explica la referencia 90 y compara FPD a la misma edad con base parcial", async () => {
  const app = harness();
  assert.match(app.text(), /Analizando el corte/);
  await app.settle();
  assert.equal(app.requests.length, 1);
  const params = new URL(app.requests[0].url, "https://finserpay.test").searchParams;
  for (const [key, value] of new URLSearchParams(initialQuery)) assert.equal(params.get(key), value);
  assert.equal(params.get("format"), "analysis");
  assert.equal(app.requests[0].cache, "no-store");
  assert.match(app.text(), /Estado del corte 65 % Por debajo de la referencia/);
  assert.ok(app.text().includes(normalized(`Brecha al 90 % ${money(250)}`)));
  assert.match(app.text(), /Importe adicional para alcanzar la referencia operativa del 90 %/);
  assert.match(app.text(), /incluidos anticipos/);
  assert.match(app.text(), /Sin historial completo a la misma edad/);
  assert.match(app.text(), /Todos los estados de cuota, con el aliado y la sede aplicados/);
  assert.match(app.text(), /5 puntos porcentuales por debajo.*día 3 en ambos cortes.*base disponible/);
  const table = app.find(node => node.type === "table")[0];
  assert.deepEqual(nodes(table, node => node.type === "thead").flatMap(head => nodes(head, node => node.type === "th").map(node => normalized(content(node)))), ["Corte y edad", "Cumplimiento Acumulado", "FPD 3 Al día 3", "FPD 7 Al día 7", "FPD 15 Al día 15"]);
  assert.deepEqual(nodes(table, node => node.type === "time").map(node => node.props.dateTime), ["2026-10-17", "2026-11-02"]);
  assert.match(normalized(content(table)), /20 días transcurridos.*4 días transcurridos/);
  assert.doesNotMatch(app.text(), /\d+ de \d+|Por madurar:\s*\d+|Sin datos:\s*\d+/);
  assert.doesNotMatch(app.html(), /NaN|Infinity/);
});

test("análisis: 89,97 % mantiene su precisión y no parece alcanzar la referencia del 90 %", async () => {
  const data = fixture(); data.cuts[0].summary = summary(899.7);
  const app = harness(async () => data); await app.settle();
  assert.match(app.text(), /Estado del corte 89,97 % Por debajo de la referencia/);
  assert.ok(app.text().includes(normalized(`Brecha al 90 % ${money(0.3)}`)));
});

test("análisis: Top 5 usa saldo cobrable, reordena por FPD evaluable; sedes conservan aliado", async () => {
  const app = harness(); await app.settle();
  const names = () => app.find(node => node.type === "ol").flatMap(list => nodes(list, node => node.type === "li").map(item => nodes(item, node => node.type === "strong")[0]).map(content));
  assert.deepEqual(names(), ["Aliado 6", "Aliado 5", "Aliado 4", "Aliado 3", "Aliado 2"]);
  assert.ok(app.text().includes(normalized(money(2000))));
  assert.match(app.text(), /excluye créditos con paz y salvo/);
  app.order("risk");
  assert.deepEqual(names(), ["Aliado 5", "Aliado 4", "Aliado 3", "Aliado 2", "Aliado 1"]);
  app.click("Sedes");
  assert.deepEqual(names(), ["Sede Centro"]);
  assert.match(app.text(), /Sede Centro Aliado propietario/);
  assert.ok(app.text().includes(normalized(`Saldo pendiente ${money(200)}`)));
  assert.equal(app.requests.length, 1, "Los controles locales no vuelven a consultar ni envían mensajes");
});

test("análisis: no prioriza grupos sin saldo ni riesgo y no llama parcial a una base aún no evaluable", async () => {
  const data = fixture();
  data.priorities.allies.forEach(item => { item.collectiblePending = 0; item.fpd3 = metric(0); item.fpd3Rate = 0; });
  data.cuts[0].earlyRisk = [metric(0, 0, 100)];
  const app = harness(async () => data); await app.settle();
  assert.match(app.text(), /Sin saldo cobrable para priorizar/);
  assert.doesNotMatch(app.text(), /Base parcial|Comparación parcial/);
  app.order("risk");
  assert.match(app.text(), /Sin casos evaluables de FPD 3/);
  assert.equal(app.find(node => node.type === "ol").length, 0);
});

test("análisis: corte futuro y esperado cero son neutrales; conciliación incompleta no presenta cero inventado", async () => {
  const data = fixture(); data.cuts[0].ageDays = -2; data.cuts[0].summary = summary(950);
  const app = harness(async () => data); await app.settle();
  const status = app.find(node => node.type === "span" && normalized(content(node)) === "Corte por vencer")[0];
  assert.match(status.props.className, /is-neutral/);
  assert.doesNotMatch(app.text(), /Por debajo de la referencia/);
  data.cuts[0].summary = summary(0, 0);
  app.setQuery(`${initialQuery}&test=zero`); await app.settle();
  assert.match(app.text(), /Estado del corte No aplica Sin valor programado/);
  assert.match(app.text(), /Brecha al 90 % No aplica/);
  data.cuts[0].summary = null;
  app.setQuery(`${initialQuery}&test=missing`); await app.settle();
  assert.match(app.text(), /Estado del corte Pendiente Conciliación pendiente/);
  assert.doesNotMatch(app.html(), /NaN|Infinity/);
});

test("análisis: un cambio de filtros oculta lo anterior y aborta la respuesta tardía", async () => {
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  const latest = fixture(); latest.priorities.allies[0].name = "Filtro nuevo";
  const app = harness(async url => url.includes("aliadoId=9") ? latest : old);
  await app.settle();
  app.setQuery(initialQuery.replace("aliadoId=4", "aliadoId=9"));
  assert.match(app.text(), /Analizando el corte/);
  await app.settle();
  assert.equal(app.requests[0].signal.aborted, true);
  assert.equal(app.requests[1].signal.aborted, false);
  app.order("risk");
  assert.match(app.text(), /Filtro nuevo/);
  finishOld(fixture()); await app.settle();
  assert.match(app.text(), /Filtro nuevo/);
});

test("análisis: error reintentable y respuesta sin corte muestran estados honestos", async () => {
  let fail = true;
  const app = harness(async () => fail ? { error: "Consulta temporalmente no disponible" } : { ...fixture(), cuts: [] });
  await app.settle();
  assert.match(app.text(), /Consulta temporalmente no disponible/);
  assert.ok(app.find(node => node.props.role === "alert").length);
  fail = false; app.click("Reintentar análisis");
  assert.match(app.text(), /Analizando el corte/);
  await app.settle();
  assert.match(app.text(), /Sin análisis disponible/);
  assert.equal(app.requests.length, 2);
});
