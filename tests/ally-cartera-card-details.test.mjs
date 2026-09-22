import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function parseCarteraPage() {
  const pagePath = path.join(projectRoot, "app/dashboard/cartera/page.tsx");
  const source = readFileSync(pagePath, "utf8");

  return ts.createSourceFile(
    pagePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function jsxAttribute(element, name) {
  return element.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
}

function metricCard(sourceFile, expectedLabel) {
  let found = null;

  function visit(node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "MetricCard"
    ) {
      const label = jsxAttribute(node, "label");

      if (
        label?.initializer &&
        ts.isStringLiteral(label.initializer) &&
        label.initializer.text === expectedLabel
      ) {
        found = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function assertCentralOnlyDetail(sourceFile, label, expectedCentralDetail) {
  const card = metricCard(sourceFile, label);
  assert.ok(card, `Debe existir la tarjeta ${label}`);

  const detail = jsxAttribute(card, "detail");
  assert.ok(detail?.initializer, `${label} debe conservar su detalle para central`);
  assert.ok(
    ts.isJsxExpression(detail.initializer),
    `${label} debe controlar el detalle mediante una expresion`
  );

  const expression = detail.initializer.expression;
  assert.ok(
    expression && ts.isConditionalExpression(expression),
    `${label} debe ocultar su detalle segun adminCentral`
  );
  assert.equal(
    expression.condition.getText(sourceFile),
    "adminCentral",
    `${label} debe usar el alcance central de la sesion`
  );
  assert.match(
    expression.whenTrue.getText(sourceFile),
    expectedCentralDetail,
    `${label} debe conservar el detalle monetario o porcentual para central`
  );
  assert.equal(
    expression.whenFalse.getText(sourceFile),
    "undefined",
    `${label} no debe renderizar detalle para el administrador aliado`
  );
}

test("Cartera oculta al aliado los detalles financieros de salud y recuperacion", () => {
  const sourceFile = parseCarteraPage();

  assertCentralOnlyDetail(
    sourceFile,
    "Cartera al dia",
    /money\(totalSano\).*sin mora/s
  );
  assertCentralOnlyDetail(
    sourceFile,
    "Cartera en mora",
    /percent\(pctMora\).*saldo pendiente/s
  );
  assertCentralOnlyDetail(
    sourceFile,
    "Recuperado",
    /money\(totalPagado\)/
  );
});
