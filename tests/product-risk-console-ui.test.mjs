import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, dependencies = {}, globals = {}) {
  const loaded = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports,
    require: (name) => dependencies[name] ?? require(name),
    ...globals,
  });
  return loaded.exports;
}
const ui = load("../app/_components/finser-ui.tsx");
const risk = load("../lib/product-risk.ts");
const styles = new Proxy({}, { get: (_, name) => String(name) });

function credit(id, changes = {}) {
  return {
    id, folio: `FC-${id}`, numeroCreditoVisible: `01000${id}`, cliente: `Cliente ${id}`,
    marca: "IPHONE", referencia: "IPHONE 13", tipo: "IPHONE", aliado: "Aliado propio", sede: "Sede principal",
    fecha: "2026-10-01", activo: true, capital: 1_234_567, saldo: 765_432, vencido: 123_456,
    dias: 10, gestion: "Llamada realizada", gestionFecha: "2026-10-06T15:00:00.000Z", ...changes,
  };
}
const rawCredits = [
  credit(1),
  credit(2, { activo: false, saldo: 0, vencido: 0, dias: 0, gestion: null }),
  credit(3, { marca: "SAMSUNG", referencia: "GALAXY A55", tipo: "ANDROID", sede: "Sede norte", dias: 0 }),
];
const safeCredits = rawCredits.map((item) => {
  const safe = { ...item };
  delete safe.capital;
  delete safe.saldo;
  delete safe.vencido;
  return safe;
});

function nodes(tree, predicate) {
  if (tree == null || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}
function harness(options = {}) {
  const states = [];
  let cursor = 0;
  let scrollCalls = 0;
  const hooks = {
    useMemo: (calculate) => calculate(),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
  };
  const Console = load("../app/dashboard/riesgo-referencia/risk-console.tsx", {
    react: hooks,
    "@/app/_components/finser-ui": ui,
    "@/lib/product-risk": risk,
    "./risk.module.css": { default: styles },
  }, {
    requestAnimationFrame: (callback) => callback(),
    document: { getElementById: () => ({ scrollIntoView: () => { scrollCalls++; } }) },
  }).default;
  const props = { credits: safeCredits, cutoff: "06/10/2026", scopeLabel: "Aliado propio", ...options };
  let tree;
  const render = () => { cursor = 0; tree = Console(props); return renderToStaticMarkup(tree); };
  const filter = (label, value) => {
    const control = nodes(tree, (node) => node.type === "label" && text(node.props.children).startsWith(label))[0];
    assert.ok(control, `Existe filtro ${label}`);
    const input = nodes(control, (node) => node.type === ui.Select || node.type === ui.Input)[0];
    input.props.onChange({ target: { value } });
    return render();
  };
  const open = (name) => {
    const target = nodes(tree, (node) => node.type === "button" && node.props.className === "reference" && text(node) === name)[0];
    assert.ok(target, `Existe referencia ${name}`);
    target.props.onClick();
    return render();
  };
  const close = () => {
    const target = nodes(tree, (node) => node.type === ui.Button && text(node) === "Cerrar detalle")[0];
    target.props.onClick();
    return render();
  };
  return { render, filter, open, close, scrollCalls: () => scrollCalls, tree: () => tree };
}
function aggregateTable(html) {
  return html.split('<div class="fp-ui-table tableWrap">')[1].split("</table>")[0];
}
function detailTable(html) {
  return html.split('id="reference-detail"')[1]?.split("</table>")[0] ?? "";
}
const financialLabels = /Capital colocado|Saldo pendiente por cobrar|Valor vencido|Valor financiado|<th>Saldo<\/th>|\$|\bCOP\b/;

test("el aliado ve unidades y porcentajes con su identidad de cartera sin columnas financieras", () => {
  const flow = harness();
  const html = flow.render();
  assert.match(html, /<div class="fp-ui-eyebrow">Cartera<\/div>/);
  assert.match(html, /Mora por producto · Aliado propio · Cartera al 06\/10\/2026/);
  assert.doesNotMatch(html, /Admin Central FINSER/);
  assert.doesNotMatch(html, financialLabels);
  assert.match(html, /Unidades financiadas/);
  assert.match(html, /Unidades activas/);
  assert.match(html, /Unidades en mora/);
  assert.match(html, /Financiadas vs\. en mora/);
  assert.match(html, /33,33%/);
  assert.match(aggregateTable(html), /50,00%/);
  assert.equal((aggregateTable(html).match(/<th /g) || []).length, 9);
});

test("el aliado no expone montos aunque por error reciba datos financieros, incluido el detalle", () => {
  const flow = harness({ credits: rawCredits });
  const html = flow.render();
  assert.doesNotMatch(html, financialLabels);
  assert.doesNotMatch(html, /1\.234\.567|765\.432|123\.456/);
  const selected = flow.open("IPHONE 13");
  assert.doesNotMatch(selected, financialLabels);
  assert.doesNotMatch(selected, /1\.234\.567|765\.432|123\.456/);
  assert.match(detailTable(selected), /010001/);
  assert.match(detailTable(selected), /010002/);
  assert.match(detailTable(selected), /Última gestión de cartera/);
});

test("central conserva todas las columnas e importes en agregación y detalle de créditos", () => {
  const flow = harness({ adminCentral: true, credits: rawCredits, scopeLabel: "Todos los aliados" });
  const html = flow.render();
  assert.match(html, /Todos los aliados/);
  for (const label of ["Capital colocado", "Saldo pendiente por cobrar", "Valor vencido"]) assert.ok(html.includes(label));
  assert.equal((aggregateTable(html).match(/<th /g) || []).length, 12);
  const selected = flow.open("IPHONE 13");
  assert.match(detailTable(selected), /Valor financiado/);
  assert.match(detailTable(selected), /<th>Saldo<\/th>/);
  assert.match(detailTable(selected), /1\.234\.567/);
  assert.match(detailTable(selected), /765\.432/);
  assert.match(detailTable(selected), /\$/);
});

test("los filtros activo, pagado, al día y mora funcionan sin saldos en el DTO aliado", () => {
  const flow = harness();
  flow.render();
  const active = flow.filter("Estado de cartera", "activo");
  assert.match(active, /2 créditos en la selección actual/);
  assert.match(active, /1 en mora de 2 financiadas/);
  const paid = flow.filter("Estado de cartera", "pagado");
  assert.match(paid, /1 créditos en la selección actual/);
  assert.match(paid, /0 en mora de 1 financiadas/);
  assert.doesNotMatch(aggregateTable(paid), /GALAXY A55/);
  const current = flow.filter("Estado de cartera", "alDia");
  assert.match(current, /1 créditos en la selección actual/);
  assert.match(aggregateTable(current), /GALAXY A55/);
  assert.doesNotMatch(aggregateTable(current), /IPHONE 13/);
  const overdue = flow.filter("Estado de cartera", "mora");
  assert.match(overdue, /1 créditos en la selección actual/);
  assert.match(overdue, /1 en mora de 1 financiadas/);
  assert.match(overdue, /Esta selección limita el denominador a créditos en mora/);
  assert.doesNotMatch(overdue, financialLabels);
});

test("seleccionar una referencia conserva su detalle operativo y modificar filtros lo cierra", () => {
  const flow = harness();
  flow.render();
  const selected = flow.open("IPHONE 13");
  assert.match(detailTable(selected), /Cliente 1/);
  assert.match(detailTable(selected), /Cliente 2/);
  assert.doesNotMatch(detailTable(selected), /Cliente 3/);
  assert.match(detailTable(selected), /Llamada realizada/);
  assert.equal(flow.scrollCalls(), 1);
  assert.doesNotMatch(flow.close(), /id="reference-detail"/);
  flow.open("IPHONE 13");
  const filtered = flow.filter("Sede", "Sede norte");
  assert.doesNotMatch(filtered, /id="reference-detail"/);
  assert.match(aggregateTable(filtered), /GALAXY A55/);
  assert.doesNotMatch(aggregateTable(filtered), /IPHONE 13/);
});

test("mantiene filtros de fecha y rangos inválidos sin cambios en los cálculos ni exposición de valores", () => {
  const flow = harness();
  flow.render();
  const later = flow.filter("Venta desde", "2026-10-02");
  assert.match(later, /Sin créditos para esta selección/);
  const invalid = flow.filter("Venta hasta", "2026-10-01");
  assert.match(invalid, /role="alert">El inicio del rango debe ser menor o igual al final/);
  assert.doesNotMatch(invalid, financialLabels);
});

test("default seguro, cartera vacía y cero de mora no inventan tasas ni filas financieras", () => {
  const flow = harness({ credits: [] });
  const html = flow.render();
  assert.match(html, /Sin mora/);
  assert.match(html, /0,00%/);
  assert.match(html, /Sin créditos para esta selección/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(html, financialLabels);
  const nonOverdue = harness({ credits: [safeCredits[2]] }).render();
  assert.match(nonOverdue, /0 en mora de 1 financiadas/);
  assert.match(nonOverdue, /0,00%/);
});
