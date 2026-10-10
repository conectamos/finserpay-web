import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/api/creditos/route.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("credit-route.ts", source, ts.ScriptTarget.Latest, true);
let expression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "contratoSnapshot" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    const identity = node.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(ast) === "dataCreditoIdentity");
    if (identity) expression = identity.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);assert.ok(expression, "actual credit creation must preserve provider identity provenance");
const compiled = ts.transpileModule(`module.exports = (${expression});`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fullName = "María del Mar  De la Peña Muñoz";
function snapshot(recoveredCustomerIdentity, override = {}) {
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports,
    recoveredCustomerIdentity, dataCreditoFullNameOnly: recoveredCustomerIdentity?.effective.nameMode === "FULL_NAME_ONLY",
    clientePrimerNombre: "NO PROVIENE DEL PROVEEDOR", clientePrimerApellido: "DIGITADO",
    clienteSegundoApellido: "OTRO", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteDocumento: "123456789", clienteNombreFinal: fullName, ...override,
  });
  return JSON.parse(JSON.stringify(module.exports));
}

test("snapshot FULL_NAME_ONLY conserva campos ausentes y separa el documento consultado de lo devuelto", () => {
  const provider = { nameMode: "FULL_NAME_ONLY", fullName, names: "", firstSurname: "", secondSurname: "",
    documentNumber: "", documentType: "", missing: ["Número de documento", "Tipo de documento"] };
  const recovered = { querySurname: "DIGITADO", original: provider, effective: provider };
  const result = snapshot(recovered);
  assert.deepEqual(result.original, provider);assert.deepEqual(result.effective, provider);
  assert.deepEqual(result.queryContext, { source: "DATACREDITO_QUERY", documentNumber: "123456789", documentType: "CEDULA_DE_CIUDADANIA" });
  assert.deepEqual(recovered.effective, provider);
});

test("snapshot FULL_NAME_ONLY conserva corrección auditada y la procedencia de componentes conocidos", () => {
  const original = { nameMode: "FULL_NAME_ONLY", fullName, names: "María del Mar", firstSurname: "", secondSurname: "",
    documentNumber: "123456789", documentType: "", missing: ["Tipo de documento"] };
  const effective = { ...original, firstSurname: "De la Peña", manuallyCompleted: ["firstSurname"] };
  const result = snapshot({ original, effective, querySurname: "DIGITADO" });
  assert.deepEqual(result.original, original);assert.deepEqual(result.effective, effective);
  assert.notEqual(result.effective.firstSurname, "DIGITADO");assert.notEqual(result.effective.documentType, result.queryContext.documentType);
});

test("snapshot estructurado conserva datos efectivos del flujo previo y ausencia de identidad sigue siendo null", () => {
  const original = { names: "María", firstSurname: "De la Peña", secondSurname: "", fullName: "María De la Peña",
    documentNumber: "123456789", documentType: "CEDULA_DE_CIUDADANIA", missing: [] };
  const result = snapshot({ original, effective: original, querySurname: "DIGITADO" }, {
    clientePrimerNombre: "María del Mar", clientePrimerApellido: "De la Peña", clienteSegundoApellido: "Muñoz",
  });
  assert.equal(result.effective.names, "María del Mar");assert.equal(result.effective.firstSurname, "De la Peña");
  assert.equal(result.effective.secondSurname, "Muñoz");assert.equal(result.effective.fullName, fullName);
  assert.equal(Object.hasOwn(result, "queryContext"), false);assert.deepEqual(result.effective.missing, []);
  assert.equal(snapshot(null), null);
});