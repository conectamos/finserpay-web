import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const financialDisplay = await jiti.import("../lib/credit-offer-financial-display.ts");
const creditFactory = await jiti.import("../lib/credit-factory.ts");
const contactPhones = await jiti.import("../lib/credit-contact-phones.ts");
function load(file, dependencies) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path.join(projectRoot, file), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module: testModule, exports: testModule.exports, Intl,
    require(name) {
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return testModule.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate))];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? text(node.props?.children) : String(node);
}
const normalized = value => String(value).replace(/\s+/g, " ").trim();
function renderConditions(offer, platform) {
  let cursor = 0;
  const state = [];
  const Component = load("app/dashboard/creditos/customer-details-form.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
        return [state[index], next => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
      },
      useRef(initial) { const index = cursor++; return state[index] ??= { current: initial }; },
    },
    "next/image": { default: props => jsxRuntime.jsx("img", props) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/app/_components/finser-ui": ui,
    "@/lib/credit-factory": creditFactory,
    "@/lib/credit-contact-phones": contactPhones,
    "@/lib/credit-offer-financial-display": financialDisplay,
  }).default;
  const props = {
    approval: { offer, platform, identity: { effective: {} } }, values: { clienteDocumento: "12345678" },
    validation: { personalComplete: true, contactComplete: true, referencesComplete: true }, nameFields: "Cliente de prueba",
    canEdit: false, editing: false, onEdit() {}, onChange() {}, fieldProps: field => ({ id: field, onBlur() {} }), fieldError: () => "",
    documentOptions: [], departmentOptions: [], genderOptions: [], maritalOptions: [], strata: [], cities: [],
  };
  function expand(node, key = "root") {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${key}/${index}`));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props), `${key}/component`);
    return cloneElement(node, { key: node.key ?? key }, expand(node.props.children, `${key}/children`));
  }
  const render = () => { cursor = 0; return expand(jsxRuntime.jsx(Component, props)); };
  let tree = render();
  const button = nodes(tree, node => node.type === "button" && normalized(text(node)) === "Ver condiciones")[0];
  assert.ok(button);
  button.props.onClick(); tree = render();
  const conditions = nodes(tree, node => node.props.id === "customer-approved-conditions")[0];
  assert.ok(conditions);
  return { text: normalized(text(conditions)), html: renderToStaticMarkup(tree) };
}

const policy = { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } };
const offer = { initialPaymentPercentage: 10, maxFinancedAmount: 1800000, installmentCount: 16, suretyPercentage: 60, financialSettings: policy };

test("Cliente muestra fianza75 de política junto con EA29.24 y seguro0.03, conservando los límites autorizados Android/iPhone", () => {
  const before = JSON.stringify(offer);
  for (const platform of ["ANDROID", "IPHONE"]) {
    for (const tierSurety of [60, 80]) {
      const result = renderConditions({ ...offer, suretyPercentage: tierSurety }, platform);
      assert.match(result.text, /Inicial mínima 10\s*%/);
      assert.match(result.text, /Crédito máximo \$\s*1\.800\.000/);
      assert.match(result.text, /Plazo máximo 16 cuotas/);
      assert.match(result.text, /Fianza total 75%/);
      assert.match(result.text, /Tasa efectiva anual 29\.24\s*%/);
      assert.match(result.text, /Seguro por cuota 0\.03\s*%/);
      assert.doesNotMatch(result.text, /60%|80%/);
    }
  }
  assert.equal(JSON.stringify(offer), before, "La lectura no modifica la oferta ni sus condiciones almacenadas");
});

test("la modalidad histórica POR_CUOTA se muestra con su unidad y no se convierte en fianza total", () => {
  const result = renderConditions({ ...offer, financialSettings: { calculoVersion: "FRANCES_V1", tasaInteresEa: 25, fianzaCuotaPorcentaje: 2.083333, seguroCuotaPorcentaje: 0.04, frecuenciaPago: "QUINCENAL" } }, "ANDROID");
  assert.match(result.text, /Fianza por cuota 2\.083333%/);
  assert.match(result.text, /Tasa efectiva anual 25\s*%/);
  assert.match(result.text, /Seguro por cuota 0\.04\s*%/);
  assert.doesNotMatch(result.text, /Fianza total|60%|75%/);
});

test("una oferta sin parámetros conserva la fianza histórica; no inventa interés ni seguro actuales", () => {
  const result = renderConditions({ ...offer, financialSettings: undefined }, "IPHONE");
  assert.match(result.text, /Fianza total \(oferta histórica\) 60%/);
  assert.doesNotMatch(result.text, /Tasa efectiva anual|Seguro por cuota|75%/);
  const noValue = financialDisplay.getCreditOfferFinancialDisplay({ suretyPercentage: null });
  assert.equal(noValue.fianzaPorcentaje, null);
});

test("parámetros inválidos no cambian silenciosamente a la banda y la política con cero se respeta", () => {
  const invalid = renderConditions({ ...offer, financialSettings: { ...policy, fianzaTotalPorcentaje: 300 } }, "ANDROID");
  assert.match(invalid.text, /Fianza No disponible/);
  assert.doesNotMatch(invalid.text, /60%|300%/);
  const zero = renderConditions({ ...offer, financialSettings: { ...policy, fianzaTotalPorcentaje: 0, tasaInteresEa: 0, seguroCuotaPorcentaje: 0 } }, "ANDROID");
  assert.match(zero.text, /Fianza total 0%/);
  assert.match(zero.text, /Tasa efectiva anual 0\s*%/);
  assert.match(zero.text, /Seguro por cuota 0\s*%/);
});
