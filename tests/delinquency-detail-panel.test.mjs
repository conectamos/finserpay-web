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
const Panel = load("../app/dashboard/_components/delinquency-detail-panel.tsx", {
  "@/app/_components/finser-ui": ui,
}).default;
const render = (detail, scopeLabel = "Todos los aliados") =>
  renderToStaticMarkup(createElement(Panel, { detail, scopeLabel }));

function group(key, name, overdueCredits, overdueBalance, options = {}) {
  return {
    key, name, context: null, unassigned: false, activeCredits: 50,
    overdueCredits, overdueBalance,
    overduePercent: overdueCredits * 2,
    overdueSharePercent: overdueBalance / 60_000 * 100,
    overduePortfolioPercent: overdueBalance / 1_000_000 * 100,
    ...options,
  };
}
function detail(options = {}) {
  return {
    activeCredits: 100, overdueCredits: 20, overduePercent: 20,
    totalBalance: 1_000_000, overdueBalance: 60_000, overduePortfolioPercent: 6,
    sites: [group("sede:1", "Sede principal", 9, 45_000), group("sede:2", "Sede norte", 11, 15_000)],
    sellers: [group("vendedor:1", "Ana Pérez", 4, 42_000), group("vendedor:2", "Juan Pérez", 16, 18_000)],
    ...options,
  };
}
function summary(html) {
  return html.split("<details")[0];
}

test("desglosa el mismo saldo de mora de Salud de cartera con conteos y participación", () => {
  const html = render(detail());
  assert.match(html, /6% de la cartera activa/);
  assert.doesNotMatch(html, /20% de la cartera activa/);
  assert.match(html, /Créditos en mora<\/h3><p[^>]*>20<\/p>/);
  assert.match(html, /de 100 créditos activos/);
  assert.match(html, /\$\s*60\.000 de saldo en mora/);
  assert.match(summary(html), /Sede principal/);
  assert.doesNotMatch(summary(html), /Sede norte/);
  assert.match(summary(html), /9 créditos en mora/);
  assert.match(summary(html), /75%<\/strong> de la mora/);
  assert.match(summary(html), /Ana Pérez/);
  assert.doesNotMatch(summary(html), /Juan Pérez/);
  assert.match(summary(html), /4 créditos en mora/);
  assert.match(summary(html), /70%<\/strong> de la mora/);
  assert.match(html, /4,5 puntos/);
  assert.match(html, /1,5 puntos/);
  assert.match(html, /Se usa el saldo pendiente de los créditos en mora, igual que en Salud de cartera/);
  assert.match(html, /Cartera actual, independiente del mes seleccionado/);
});

test("cambia los líderes cuando cambia el saldo y no los escoge por mayor conteo o tasa propia", () => {
  const html = summary(render(detail({
    sites: [group("sede:2", "Sede norte", 11, 45_000), group("sede:1", "Sede principal", 9, 15_000)],
    sellers: [group("vendedor:2", "Juan Pérez", 16, 42_000), group("vendedor:1", "Ana Pérez", 4, 18_000)],
  })));
  assert.match(html, /Sede norte/);
  assert.match(html, /Juan Pérez/);
  assert.doesNotMatch(html, /Sede principal|Ana Pérez/);
  assert.match(html, /75%<\/strong> de la mora/);
});

test("identifica aliados y sedes homónimas y mantiene todas las filas del ranking", () => {
  const html = render(detail({
    sites: [
      group("sede:1", "Centro", 9, 45_000, { context: "Aliado Uno" }),
      group("sede:2", "Centro", 11, 15_000, { context: "Aliado Dos" }),
    ],
    sellers: [
      group("vendedor:1", "Ana", 4, 42_000, { context: "Centro · Aliado Uno" }),
      group("vendedor:2", "Ana", 16, 18_000, { context: "Centro · Aliado Dos" }),
    ],
  }));
  assert.match(summary(html), /Aliado Uno/);
  assert.doesNotMatch(summary(html), /Aliado Dos/);
  for (const name of ["Aliado Uno", "Aliado Dos", "Centro · Aliado Uno", "Centro · Aliado Dos"]) {
    assert.ok(html.includes(name), `${name} debe conservarse en el detalle`);
  }
  assert.equal((html.match(/<table /g) || []).length, 2);
  assert.equal((html.match(/<th scope="row"/g) || []).length, 4);
});

test("mantiene la mora sin asignación en tablas sin atribuirla a un vendedor identificado", () => {
  const html = render(detail({
    sites: [group("sede:sin", "Sin sede asignada", 15, 50_000, { unassigned: true }), group("sede:1", "Sede norte", 5, 10_000)],
    sellers: [group("vendedor:sin", "Sin vendedor asignado", 20, 60_000, { unassigned: true })],
  }));
  assert.match(summary(html), /Sede norte/);
  assert.match(summary(html), /Entre las sedes identificadas/);
  assert.match(summary(html), /Mora sin vendedor asignado/);
  assert.doesNotMatch(summary(html), /100%<\/strong> de la mora/);
  assert.match(html, /Sin vendedor asignado/);
  assert.match(html, /Sin sede asignada/);
  assert.match(html, /100%<\/td>/);
});

test("explica empates en saldo sin presentar un ganador exclusivo", () => {
  const html = render(detail({
    sites: [group("sede:1", "Sede norte", 12, 30_000), group("sede:2", "Sede sur", 8, 30_000)],
    sellers: [group("vendedor:1", "Ana", 10, 20_000), group("vendedor:2", "Juan", 8, 20_000), group("vendedor:3", "Pedro", 2, 20_000)],
  }));
  assert.match(summary(html), /Empate en saldo con 1 otra sede/);
  assert.match(summary(html), /Empate en saldo con 2 otros vendedores/);
  assert.match(html, /Sede sur/);
  assert.match(html, /Juan/);
  assert.match(html, /Pedro/);
});

test("cartera sin mora o vacía muestra cero sin falsos líderes ni porcentajes inválidos", () => {
  for (const activeCredits of [0, 100]) {
    const html = render(detail({
      activeCredits, overdueCredits: 0, overdueBalance: 0, overduePortfolioPercent: 0,
      sites: activeCredits ? [group("sede:1", "Sede norte", 0, 0)] : [],
      sellers: activeCredits ? [group("vendedor:1", "Ana", 0, 0)] : [],
    }));
    assert.match(html, /0% de la cartera activa/);
    assert.equal((summary(html).match(/Sin créditos en mora/g) || []).length, 2);
    assert.doesNotMatch(summary(html), /Sede norte|Ana|Empate/);
    assert.doesNotMatch(html, /NaN|Infinity/);
  }
});

test("el detalle faltante no inventa métricas y el expandible es accesible sin JavaScript", () => {
  const unavailable = render(undefined);
  assert.match(unavailable, /El detalle de mora aún no está disponible/);
  assert.doesNotMatch(unavailable, /0%|<table/);
  const html = render(detail());
  assert.match(html, /role="region" aria-labelledby="delinquency-detail-title"/);
  assert.match(html, /<details[^>]*><summary[^>]*>Ver detalle por sede y vendedor/);
  assert.equal((html.match(/scope="col"/g) || []).length, 10);
  assert.match(html, /<caption class="sr-only">Sede, créditos en mora/);
  assert.match(html, /fp-ui-card/);
  assert.equal((html.match(/fp-ui-table/g) || []).length, 2);
});

test("nombres largos mantienen el texto completo y la tabla permite desplazamiento en móvil", () => {
  const name = "Sucursal " + "nombre-largo-".repeat(15);
  const html = render(detail({ sites: [group("sede:1", name, 20, 60_000)] }), "Aliado propio");
  assert.ok(html.includes(name));
  assert.match(html, /break-words \[overflow-wrap:anywhere\]/);
  assert.match(html, /sm:grid-cols-3/);
  assert.match(html, /min-w-\[600px\]/);
  assert.match(html, /Aliado propio · Cartera actual/);
});
