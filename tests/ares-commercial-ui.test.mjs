import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
});
const { calculateFrenchAmortization } = jiti("../lib/credit-amortization.ts");
const { validateIphoneInstallmentLimit } = jiti("../lib/credit-factory.ts");
const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNodes(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return matches;
}

function declaration(name) {
  const matches = findNodes(node => ts.isVariableDeclaration(node) && node.name.getText(parsed) === name);
  assert.equal(matches.length, 1, name);
  return `const ${matches[0].getText(parsed)};`;
}

function execute(code, context = {}) {
  const exports = {};
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { require, exports, ...context }, { timeout: 1000 });
}

function plan(version = "ARES_FRANCES_V2", overrides = {}) {
  return calculateFrenchAmortization({
    calculoVersion: version, valorVenta: 2_600_000, cuotaInicial: 780_000, numeroCuotas: 40,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40, seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02", ...overrides,
  });
}

function presentation(amortizationPlan) {
  return execute([
    "financialPlan", "valorCuota", "valorCuotaExacta", "comercialEsCuotaPactada",
    "valorCuotaPactada", "cuotaPactadaLabel", "cuotaInternaLabel", "iphoneInstallmentLimit",
  ].map(declaration).join("\n") + "\n({ financialPlan, valorCuota, valorCuotaExacta, comercialEsCuotaPactada, valorCuotaPactada, cuotaPactadaLabel, cuotaInternaLabel, iphoneInstallmentLimit })", {
    amortizationPlan, saldoBaseFinanciado: amortizationPlan.valorFinanciado, tasaInteresEaNumero: 29.24,
    currentDevicePlatform: "IPHONE", iphoneFactoryRangeActive: true, iphoneMaxInstallmentValue: 160_000,
    validateIphoneInstallmentLimit,
  });
}

const currency = value => `$${Number(value).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
const exactCurrency = value => `$${Number(value).toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function installmentCard(amortizationPlan, internal) {
  const candidates = findNodes(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === "div" && node.getText(parsed).includes("? currency(valorCuota) :"));
  candidates.sort((a, b) => a.getText(parsed).length - b.getText(parsed).length);
  assert.ok(candidates.length);
  return renderToStaticMarkup(execute(`(${candidates[0].getText(parsed)})`, {
    ...presentation(amortizationPlan), amortizationPlan, financialPreviewReady: true,
    frecuenciaPagoLabel: "Quincenal", canSeeInternalPricing: internal, currency, exactCurrency,
  }));
}

test("el ejemplo ARES muestra y pacta 90.850; la referencia exacta no se convierte en obligación", () => {
  const current = presentation(plan());
  assert.equal(current.valorCuota, 90_850);
  assert.equal(current.valorCuotaPactada, 90_850);
  assert.equal(current.financialPlan.montoCreditoTotal, 3_634_000);
  assert.ok(Math.abs(current.valorCuotaExacta - 90_887.54120958316) < 0.000001);
  assert.equal(current.cuotaPactadaLabel, "Valor de cada cuota");
  assert.equal(current.iphoneInstallmentLimit.outsideRange, false);
});

test("V1 conserva presentación comercial y obligación exacta histórica", () => {
  const legacyPlan = plan("ARES_FRANCES_V1");
  const legacy = presentation(legacyPlan);
  assert.equal(legacy.valorCuota, legacyPlan.cuotaComercial);
  assert.equal(legacy.valorCuotaPactada, legacyPlan.cuotaTotal);
  assert.equal(legacy.financialPlan.montoCreditoTotal, legacyPlan.montoTotal);
  assert.equal(legacy.cuotaPactadaLabel, "Valor exacto por cuota");
  assert.equal(legacy.cuotaInternaLabel, "Cuota exacta para recaudo");
});

test("vendedor y supervisor ven solo 90.850; el administrador distingue referencia matemática", () => {
  const seller = installmentCard(plan(), false);
  assert.match(seller, />\$90\.850<\/strong>/);
  assert.doesNotMatch(seller, /90\.887|Referencia matemática|Cuota exacta|Fianza|Seguro/);
  const admin = installmentCard(plan(), true);
  assert.match(admin, />\$90\.850<\/strong>/);
  assert.match(admin, /Referencia matemática \(no se cobra\).*90\.887,54/);
  assert.doesNotMatch(admin, /Cuota exacta para recaudo/);
});

test("los contratos de la interfaz usan la cuota pactada; V1 conserva la exacta", () => {
  const contractRows = findNodes(node => ts.isJsxElement(node) && ["li", "p"].includes(node.openingElement.tagName.getText(parsed)) && node.getText(parsed).includes("{cuotaPactadaLabel}"));
  assert.equal(contractRows.length, 4);
  for (const row of contractRows) {
    const current = renderToStaticMarkup(execute(`(${row.getText(parsed)})`, { ...presentation(plan()), exactCurrency }));
    assert.match(current, /Valor de cada cuota.*90\.850,00/);
    assert.doesNotMatch(current, /90\.887/);
    const legacy = renderToStaticMarkup(execute(`(${row.getText(parsed)})`, { ...presentation(plan("ARES_FRANCES_V1")), exactCurrency }));
    assert.match(legacy, /Valor exacto por cuota.*90\.887,54/);
  }
  assert.equal((source.match(/!comercialEsCuotaPactada \? " La ultima cuota podra ajustarse por centavos\."/g) || []).length, 2);
  const promissoryRows = findNodes(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === "p" && node.getText(parsed).includes("La obligacion sera pagada en"));
  assert.equal(promissoryRows.length, 2);
  for (const row of promissoryRows) {
    const current = renderToStaticMarkup(execute(`(${row.getText(parsed)})`, { ...presentation(plan()), exactCurrency, plazoMesesNumero: 40, frecuenciaPagoLabel: "Quincenal" }));
    assert.match(current, /40 cuotas de \$90\.850,00/);
    assert.doesNotMatch(current, /ajustarse por centavos|90\.887/);
  }
});

test("los filtros iPhone validan la cuota cobrable V2, no la referencia anterior al piso", () => {
  const current = plan();
  assert.equal(presentation({ ...current, cuotaCobro: 160_000, cuotaTotal: 160_049 }).iphoneInstallmentLimit.outsideRange, false);
  assert.equal(presentation({ ...current, cuotaCobro: 89_950, cuotaTotal: 89_999 }).iphoneInstallmentLimit.outsideRange, true);
  assert.equal(presentation({ ...current, cuotaCobro: 90_000, cuotaTotal: 90_049 }).iphoneInstallmentLimit.outsideRange, false);
  assert.match(declaration("creditInstallmentOptions"), /valorCuota:\s*candidatePlan\.cuotaCobro/);
  assert.match(declaration("creditInstallmentOptions"), /if \(iphoneFactoryTermsLocked\) return policyInstallmentOptions/);
});

test("el detalle de amortización distingue cuota pactada y descuento, protegido como información interna", () => {
  const tableSource = readFileSync(new URL("../app/dashboard/creditos/credit-amortization-table.tsx", import.meta.url), "utf8");
  const exports = {};
  execute(tableSource, { exports });
  const current = renderToStaticMarkup(createElement(exports.default, { plan: plan() }));
  assert.match(current, /Cuota pactada/);
  assert.match(current, /Descuento total por redondeo/);
  assert.match(current, /No se agrega el descuento a la última cuota/);
  assert.match(current, /3\.634\.000,00/);
  const legacy = renderToStaticMarkup(createElement(exports.default, { plan: plan("ARES_FRANCES_V1") }));
  assert.match(legacy, /Cuota exacta/);
  assert.doesNotMatch(legacy, /Descuento total por redondeo|Cuota pactada/);
  assert.match(source, /canSeeInternalPricing && amortizationPlan \? \(\s*<CreditAmortizationTable/);
});
