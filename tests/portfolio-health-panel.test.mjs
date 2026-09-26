import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] ?? require(name) });
  return module.exports;
}
const ui = load("../app/_components/finser-ui.tsx");
const chart = load("../app/dashboard/_components/product-health-chart.tsx", { "@/app/_components/finser-ui": ui });
const Panel = load("../app/dashboard/_components/portfolio-health-panel.tsx", {
  "@/app/_components/finser-ui": ui, "./product-health-chart": chart,
}).default;
const health = load("../lib/product-portfolio-health.ts");
function data(iphone, android) {
  return { healthyPercent: 50, earlyPercent: 5, criticalPercent: 45,
    productHealth: health.summarizeProductPortfolioHealth([
      { platform: "IPHONE", bucket: "alDia", saldoPendiente: 1000 - iphone },
      { platform: "IPHONE", bucket: "temprana", saldoPendiente: iphone },
      { platform: "ANDROID", bucket: "alDia", saldoPendiente: 1000 - android },
      { platform: "ANDROID", bucket: "critica", saldoPendiente: android },
    ]), unclassifiedPortfolioBalance: 0 };
}
const render = props => renderToStaticMarkup(createElement(Panel, { data: props }));
const product = (html, id) => html.split(`<section aria-labelledby="health-${id}"`)[1].split("</section>")[0];
test("destaca el porcentaje mayor sobre saldo propio y cambia con los datos del panel", () => {
  for (const [iphone, android, winner, loser] of [[100,900,"android","iphone"],[900,100,"iphone","android"]]) {
    const html=render(data(iphone,android));
    assert.match(product(html,winner), /Mayor nivel de mora/);
    assert.doesNotMatch(product(html,loser), /Mayor nivel de mora/);
    assert.match(product(html,winner), /90,0%/);
    assert.match(product(html,winner), /Saldo en mora/);
    assert.match(product(html,winner), /\$\s*900/);
    assert.match(html, /Cartera general: Al día 50,0%, Mora temprana 5,0%, Mora crítica 45,0%/);
    assert.match(html, /1–15 días/); assert.match(html, /Más de 15 días/);
  }
});
test("sin aviso en empates, incluido el redondeo visible, ni cuando falta un producto", () => {
  for(const [iphone,android] of [[0,0],[100,100],[100.1,100.2]]) assert.doesNotMatch(render(data(iphone,android)), /Mayor nivel de mora/);
  const one = data(100,900);
  one.productHealth.IPHONE = health.summarizeProductPortfolioHealth([]).IPHONE;
  assert.doesNotMatch(render(one), /Mayor nivel de mora/);
});
test("cartera vacía sin barras rojas ficticias y saldo sin producto conservado", () => {
  const empty = { healthyPercent:0,earlyPercent:0,criticalPercent:0,productHealth:health.summarizeProductPortfolioHealth([]),unclassifiedPortfolioBalance:50 };
  const html=render(empty);
  assert.equal((html.match(/sin saldo pendiente"/g)||[]).length,3);
  assert.doesNotMatch(html, /NaN|Mayor nivel de mora|width:100%/);
  assert.match(html, /Saldo sin producto identificado/);
  assert.match(html, /\$\s*50/);
});