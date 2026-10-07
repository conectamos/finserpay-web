import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  });
  runInNewContext(outputText, {
    module: loaded,
    exports: loaded.exports,
    require: (name) => dependencies[name] ?? require(name),
  });
  return loaded.exports;
}
const ui = load("../app/_components/finser-ui.tsx");
const Workspace = load("../app/dashboard/cartera/detalle-mora/delinquency-workspace.tsx", {
  "@/app/_components/finser-ui": ui,
}).default;

function group(key, name, overdueCredits, overdueSharePercent, options = {}) {
  return {
    key, name, context: null, unassigned: false, activeCredits: 50,
    overdueCredits, overdueSharePercent, overduePortfolioPercent: overdueSharePercent * 0.06,
    ...options,
  };
}
function detail(options = {}) {
  return {
    activeCredits: 100, overdueCredits: 20, overduePortfolioPercent: 6,
    sites: [group("sede:1", "Sede principal", 9, 75), group("sede:2", "Sede norte", 11, 25)],
    sellers: [group("vendedor:1", "Ana Pérez", 4, 70), group("vendedor:2", "Juan Pérez", 16, 30)],
    leadingSiteKeys: ["sede:1"], leadingSellerKeys: ["vendedor:1"],
    ...options,
  };
}
function props(options = {}) {
  return {
    detail: detail(), canViewBalances: false, scopeLabel: "Aliado propio",
    exportHref: "/api/cartera/detalle-mora/exportar", updatedAt: "2026-10-06T19:12:00.000Z",
    ...options,
  };
}
const render = (options = {}) => renderToStaticMarkup(createElement(Workspace, props(options)));
const metrics = (html) => html.split('<section aria-label="Resumen de mora"')[1].split("</section>")[0];

test("el aliado recibe métricas de mora, distribución por sede y ranking completo sin montos", () => {
  const html = render();
  assert.match(html, /<h1>Detalle de mora<\/h1>/);
  assert.match(html, /Cartera \/ Mora actual/);
  assert.match(metrics(html), /Mora actual/);
  assert.match(metrics(html), /6%/);
  assert.match(metrics(html), />20<\/strong>/);
  assert.match(metrics(html), /de 100 créditos activos/);
  assert.match(metrics(html), /Sede principal/);
  assert.match(metrics(html), /9 créditos · 75% de la mora/);
  assert.doesNotMatch(metrics(html), /Sede norte/);
  assert.equal((metrics(html).match(/fp-ui-metric/g) || []).length, 3);
  assert.match(html, /Distribución de la mora/);
  assert.match(html, /Vendedores con mayor mora/);
  assert.match(html, /Ana Pérez/);
  assert.match(html, /Juan Pérez/);
  assert.match(html, /4,5 puntos/);
  assert.match(html, /1,5 puntos/);
  assert.doesNotMatch(html, /Saldo en mora|\bCOP\b|\$|RD\$|title="[^\"]*saldo/i);
});

test("el aliado no renderiza saldos incluso si accidentalmente los recibe en las propiedades", () => {
  const unsafe = detail({ overdueBalance: 987_654_321.98 });
  unsafe.sites[0].overdueBalance = 123_456_789.87;
  unsafe.sellers[0].overdueBalance = 456_789_123.65;
  const html = render({ detail: unsafe, canViewBalances: false });
  assert.doesNotMatch(html, /987|654|321|123\.456|456\.789|Saldo en mora|\$/);
  assert.doesNotMatch(html, /overdueBalance|data-.*balance/);
  assert.match(html, /aria-label="Sede principal: 75% de la mora"/);
});

test("central conserva saldos de resumen, distribución, ranking y detalle sin centavos visibles", () => {
  const full = detail({ overdueBalance: 60_000 });
  full.sites[0].overdueBalance = 45_000;
  full.sites[1].overdueBalance = 15_000;
  full.sellers[0].overdueBalance = 42_000;
  full.sellers[1].overdueBalance = 18_000;
  const html = render({ detail: full, canViewBalances: true, scopeLabel: "Todos los aliados" });
  assert.equal((metrics(html).match(/fp-ui-metric/g) || []).length, 4);
  assert.match(html, /Saldo en mora/);
  for (const amount of ["60.000", "45.000", "15.000", "42.000", "18.000"]) assert.ok(html.includes(amount));
  assert.match(html, /Todos los aliados/);
  assert.doesNotMatch(html, /\.000,00/);
});

test("los enlaces de exportación y créditos llevan únicamente a los destinos suministrados", () => {
  const html = render({
    exportHref: "/api/cartera/detalle-mora/exportar?aliadoId=7",
    creditLinks: {
      "sede:1": "/dashboard/cartera/detalle-mora?aliadoId=7&sede=1",
      "seller:vendedor:1": "/dashboard/cartera/detalle-mora?aliadoId=7&vendedor=1",
    },
  });
  assert.match(html, /href="\/api\/cartera\/detalle-mora\/exportar\?aliadoId=7"/);
  assert.match(html, /Exportar Excel/);
  assert.match(html, /href="\/dashboard\/cartera\/detalle-mora\?aliadoId=7&amp;sede=1"/);
  assert.match(html, /href="\/dashboard\/cartera\/detalle-mora\?aliadoId=7&amp;vendedor=1"/);
  assert.match(html, /aria-label="Ver créditos en mora de Sede principal"/);
  assert.match(html, /aria-label="Ver créditos en mora de Ana Pérez"/);
  assert.equal((html.match(/>Ver créditos /g) || []).length, 2);
  assert.doesNotMatch(render(), /Ver créditos|>Acciones<|href="#"/);
});

test("no introduce un filtro mensual ficticio y muestra la actualización en hora de Bogotá", () => {
  const html = render({ filters: createElement("div", null, "Selector de aliados autorizado") });
  assert.match(html, /Selector de aliados autorizado/);
  assert.match(html, /<time dateTime="2026-10-06T19:12:00.000Z">/);
  assert.match(html, /2:12/);
  assert.doesNotMatch(html, /19:12<|Abr 2025|Últimos 7 días|month=|type="month"/);
  assert.match(render({ updatedAt: "fecha-inválida" }), /Actualizado: al consultar/);
});

test("las filas sin asignación tienen destinos distintos para sede y vendedor", () => {
  const data = detail({
    sites: [group("unassigned", "Sin sede asignada", 20, 100, { unassigned: true })],
    sellers: [group("unassigned", "Sin vendedor asignado", 20, 100, { unassigned: true })],
    leadingSiteKeys: [], leadingSellerKeys: [],
  });
  const html = render({ detail: data, creditLinks: {
    unassigned: "/dashboard/cartera/detalle-mora?site=unassigned#creditos-en-mora",
    "seller:unassigned": "/dashboard/cartera/detalle-mora?seller=unassigned#creditos-en-mora",
  } });
  assert.match(html, /href="\/dashboard\/cartera\/detalle-mora\?site=unassigned#creditos-en-mora" aria-label="Ver créditos en mora de Sin sede asignada"/);
  assert.match(html, /href="\/dashboard\/cartera\/detalle-mora\?seller=unassigned#creditos-en-mora" aria-label="Ver créditos en mora de Sin vendedor asignado"/);
});

test("un cero real y una cartera vacía no inventan un líder, porcentaje ni barras de mora", () => {
  const empty = detail({
    activeCredits: 0, overdueCredits: 0, overduePortfolioPercent: 0,
    sites: [], sellers: [], leadingSiteKeys: [], leadingSellerKeys: [],
  });
  const html = render({ detail: empty });
  assert.match(metrics(html), />0%<\/span>/);
  assert.match(metrics(html), />0<\/strong>/);
  assert.match(html, /Sin sede con mora/);
  assert.match(html, /Sin cartera activa/);
  assert.match(html, /Sin vendedores con cartera activa/);
  assert.match(html, /Sin sedes con cartera activa/);
  assert.doesNotMatch(html, /NaN|Infinity|width:100%|Sede principal/);
  const noOverdue = detail({
    overdueCredits: 0, overduePortfolioPercent: 0,
    sites: [group("sede:1", "Sede principal", 0, 0)],
    sellers: [group("vendedor:1", "Ana", 0, 0)], leadingSiteKeys: [], leadingSellerKeys: [],
  });
  const noOverdueHtml = render({ detail: noOverdue });
  assert.match(noOverdueHtml, /style="width:0%"/);
  assert.match(metrics(noOverdueHtml), /Sin sede con mora/);
});

test("las claves de líderes del servidor resuelven empates sin comparar porcentajes redondeados", () => {
  const tie = detail({
    sites: [group("sede:1", "Centro", 12, 50), group("sede:2", "Sur", 8, 50)],
    leadingSiteKeys: ["sede:1", "sede:2"],
  });
  assert.match(metrics(render({ detail: tie })), /Empate con 1 otra sede/);
  const rounded = detail({
    sites: [group("sede:1", "Centro", 12, 50), group("sede:2", "Sur", 8, 50)],
    leadingSiteKeys: ["sede:2"],
  });
  assert.match(metrics(render({ detail: rounded })), /Sur/);
  assert.doesNotMatch(metrics(render({ detail: rounded })), /Centro|Empate/);
});

test("la mora sin asignación se conserva en la distribución y ranking sin coronar un grupo desconocido", () => {
  const data = detail({
    sites: [group("sede:sin", "Sin sede asignada", 15, 90, { unassigned: true }), group("sede:2", "Sede norte", 5, 10)],
    sellers: [group("vendedor:sin", "Sin vendedor asignado", 20, 100, { unassigned: true })],
    leadingSiteKeys: ["sede:2"], leadingSellerKeys: [],
  });
  const html = render({ detail: data });
  assert.match(metrics(html), /Sede norte/);
  assert.doesNotMatch(metrics(html), /Sin sede asignada/);
  assert.match(metrics(html), /Entre las sedes identificadas/);
  assert.match(html, /Sin sede asignada/);
  assert.match(html, /Sin vendedor asignado/);
  assert.match(html, /100%/);
});

test("identidades homónimas, nombres largos y todas las filas conservan contexto y acceso móvil", () => {
  const name = "Sucursal " + "nombre largo ".repeat(12);
  const data = detail({
    sites: [group("sede:1", name, 9, 75, { context: "Aliado Uno" }), group("sede:2", name, 11, 25, { context: "Aliado Dos" })],
    sellers: Array.from({ length: 15 }, (_, index) => group(`vendedor:${index + 1}`, `Ana ${index + 1}`, index ? 0 : 20, index ? 0 : 100, { context: `Sede ${index + 1} · Aliado propio` })),
  });
  const html = render({ detail: data });
  assert.ok(html.includes(name));
  assert.match(html, /Aliado Uno/);
  assert.match(html, /Aliado Dos/);
  assert.match(html, /Ana 15/);
  assert.match(html, /Sede 15 · Aliado propio/);
  assert.equal((html.match(/<th scope="row"/g) || []).length, 17);
  assert.match(html, /break-words \[overflow-wrap:anywhere\]/);
  assert.match(html, /xl:grid-cols-3/);
  assert.match(html, /min-w-\[650px\]/);
  assert.equal((html.match(/fp-ui-table/g) || []).length, 2);
  assert.match(html, /role="region" aria-labelledby="mora-distribution-title"/);
});
