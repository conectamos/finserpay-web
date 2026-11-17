import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const visibility = await jiti.import("../lib/credit-client-data-visibility.ts");
const { parseColombiaDate, COLOMBIA_TIME_ZONE } = await jiti.import("../lib/colombia-date.ts");
const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), variables = new Map();
let stepOne;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(tree));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.getText(tree));
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "data-factory-step" &&
    attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "1")) stepOne = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(stepOne, "El test debe renderizar el Paso 1 real del expediente");
const renderSource = [
  ...["dateOnly", "dossierText", "dossierOptionLabel", "dossierDate", "DossierInfoField"].map(name => {
    assert.ok(functions.has(name), name); return functions.get(name);
  }),
  "function Summary({ selectedCredit }) {",
  ...["dossierClientField", "selectedCreditDocumentTypeLabel", "selectedCreditGenderLabel", "selectedCreditMaritalStatusLabel", "selectedCreditDepartmentLabel"].map(name => {
    assert.ok(variables.has(name), name); return `const ${variables.get(name)};`;
  }),
  `return (${stepOne}); }`,
  "module.exports = Summary;",
].join("\n");
const code = ts.transpileModule(renderSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} }).outputText;
const loaded = { exports: {} };
runInNewContext(code, {
  module: loaded, exports: loaded.exports, React, ...visibility, parseColombiaDate, COLOMBIA_TIME_ZONE,
  parseDisplayDate: value => new Date(value), humanizeConstant: value => value,
  getColombiaDepartmentLabel: value => value,
  DOCUMENT_TYPE_OPTIONS: [{ value: "CC", label: "Cédula" }],
  GENDER_OPTIONS: [{ value: "FEMENINO", label: "Femenino" }],
  MARITAL_STATUS_OPTIONS: [{ value: "SOLTERO", label: "Soltero" }],
  UserRound: () => null, IdCard: () => null,
});
const Summary = loaded.exports;
const credit = changes => ({
  clienteNombre: "PERSONA DE PRUEBA", clientePrimerNombre: "PERSONA", clientePrimerApellido: "DE PRUEBA",
  clienteTipoDocumento: "CC", clienteDocumento: "100000001", clienteFechaExpedicion: "2020-01-02",
  clienteFechaNacimiento: "1990-01-02", clienteGenero: "FEMENINO", clienteEstadoCivil: "SOLTERO",
  clienteEstrato: "3", clienteTelefono: "3000000001", clienteCorreo: "synthetic@example.test",
  clienteDepartamento: "Departamento sintético", clienteCiudad: "Ciudad sintética", clienteDireccion: "Dirección sintética",
  referenciasFamiliares: [{ nombre: "Referencia sintética", parentesco: "FAMILIAR", telefono: "3000000002" }],
  redactedClientFields: [], ...changes,
});
function render(item) {
  const before = JSON.stringify(item);
  const html = renderToStaticMarkup(React.createElement(Summary, { selectedCredit: item }));
  assert.equal(JSON.stringify(item), before, "La presentación no modifica los datos del crédito");
  return html;
}
function fields(html) {
  return new Map([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map(match => [match[1], match[2]]));
}

test("el contrato compartido enumera exclusivamente los ocho campos redactados", () => {
  assert.deepEqual([...visibility.CREDIT_CLIENT_REDACTED_FIELDS], ["clienteDireccion", "clienteFechaNacimiento",
    "clienteFechaExpedicion", "clienteCorreo", "clienteGenero", "clienteEstadoCivil", "clienteEstrato", "referenciasFamiliares"]);
  assert.equal(visibility.isCreditClientFieldRedacted(undefined, "clienteCorreo"), false);
  assert.equal(visibility.creditClientFieldDisplay({}, "clienteCorreo", "No registrado"), "No registrado");
});

test("Paso 1 distingue datos restringidos y referencias ocultas sin atribuir ausencia al asesor", () => {
  const item = credit({ redactedClientFields: [...visibility.CREDIT_CLIENT_REDACTED_FIELDS],
    ...Object.fromEntries(visibility.CREDIT_CLIENT_REDACTED_FIELDS.map(key => [key, key === "referenciasFamiliares" ? [] : null])) });
  const html = render(item), values = fields(html);
  for (const label of ["Dirección completa", "Fecha de nacimiento", "Fecha de expedición", "Correo electrónico", "Género", "Estado civil", "Estrato"])
    assert.equal(values.get(label), "No visible para este perfil", label);
  assert.match(html, /Referencias no visibles para este perfil/);
  assert.doesNotMatch(html, /No hay referencias registradas/);
  assert.equal(values.get("Número de documento"), "100000001");
  assert.equal(values.get("Primer nombre"), "PERSONA");
  assert.equal(values.get("Ciudad de residencia"), "Ciudad sintética");
});

test("la marca de redacción prevalece sobre valores residuales y no expone referencias anteriores", () => {
  const html = render(credit({ redactedClientFields: [...visibility.CREDIT_CLIENT_REDACTED_FIELDS] }));
  for (const value of ["synthetic@example.test", "Dirección sintética", "Referencia sintética", "3000000002"])
    assert.ok(!html.includes(value), value);
  assert.match(html, /Referencias no visibles para este perfil/);
});

test("sin campos redactados se conservan datos visibles y ausencias reales, incluso con DTO antiguo", () => {
  const visible = fields(render(credit()));
  assert.equal(visible.get("Correo electrónico"), "synthetic@example.test");
  assert.equal(visible.get("Dirección completa"), "Dirección sintética");
  const missing = render(credit({ redactedClientFields: undefined, clienteCorreo: null, referenciasFamiliares: [] }));
  assert.equal(fields(missing).get("Correo electrónico"), "No registrado");
  assert.match(missing, /No hay referencias registradas en este crédito/);
  assert.doesNotMatch(missing, /No visible para este perfil/);
});

test("nombre completo sin partes se explica únicamente con FULL_NAME_ONLY y nunca se descompone", () => {
  const item = credit({ clientePrimerNombre: null, clientePrimerApellido: " ", dataCreditoIdentityNameMode: "FULL_NAME_ONLY" });
  const result = fields(render(item));
  assert.equal(result.get("Nombre completo"), "PERSONA DE PRUEBA");
  assert.equal(result.get("Primer nombre"), "Registrado como nombre completo");
  assert.equal(result.get("Primer apellido"), "Registrado como nombre completo");
  const withoutMode = fields(render({ ...item, dataCreditoIdentityNameMode: null }));
  assert.equal(withoutMode.get("Primer nombre"), "No registrado");
  assert.equal(withoutMode.get("Primer apellido"), "No registrado");
  assert.equal(visibility.creditClientNamePartDisplay(" NOMBRE  GUARDADO ", "FULL_NAME_ONLY"), "NOMBRE GUARDADO");
});
