import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { validateCreditClientForm } = await jiti.import("../lib/credit-client-validation.ts");
const source = await readFile(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["getDataCreditoClientDisplayName", "DataCreditoClientNameBar"];
const declarations = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join("\n");
const fullName = "María del Mar José De la Peña Muñoz del Río";
const identity = { nameMode: "FULL_NAME_ONLY", names: "", firstSurname: "", secondSurname: "", fullName, documentNumber: "123456789", documentType: "CEDULA_DE_CIUDADANIA", missing: [] };
const approval = { documentNumber: "123456789", firstSurname: "NO VERIFICADO", identity: { original: identity, effective: identity } };
function load(extra = "", context = {}) {
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(declarations + "\n" + extra + "\nmodule.exports = { " + names.join(", ") + ", ...module.exports };", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  runInNewContext(outputText, { module, exports: module.exports, ...context, require: name => { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; } });
  return module.exports;
}
const props = { fullName, canEditComponents: false, editing: false, givenNames: "", secondSurname: "", onGivenNamesChange() {}, onSecondSurnameChange() {}, givenNamesInputProps: { id: "clientePrimerNombre" }, givenNamesError: null };

test("the single full-name bar preserves the provider identity and never splits it or trusts the query surname", () => {
  const functions = load();
  assert.equal(functions.getDataCreditoClientDisplayName(approval, "Otro valor"), fullName);
  assert.equal(functions.getDataCreditoClientDisplayName({ ...approval, identity: { original: identity, effective: { ...identity, fullName: "" } } }), fullName);
  assert.equal(identity.names, ""); assert.equal(identity.firstSurname, ""); assert.equal(identity.secondSurname, "");
  const html = renderToStaticMarkup(React.createElement(functions.DataCreditoClientNameBar, props));
  assert.ok(html.includes("NOMBRES Y APELLIDOS"));
  assert.ok(html.includes(fullName));
  assert.equal((html.match(/<input/g) || []).length, 1);
  assert.ok(html.includes('readOnly=""'));
  assert.ok(!html.includes("NO VERIFICADO"));
  assert.ok(!html.includes("Primer apellido"));
});

test("full-name-only mode cannot expose component editing, including stale toggle state", () => {
  const functions = load();
  const html = renderToStaticMarkup(React.createElement(functions.DataCreditoClientNameBar, { ...props, editing: true }));
  assert.equal((html.match(/<input/g) || []).length, 1);
  assert.ok(!html.includes("clientePrimerNombre"));
  assert.ok(!html.includes("clienteSegundoApellido"));
});

test("structured identity reveals only given names and optional second surname after editing is selected", () => {
  const functions = load();
  const updated = "María José De la Peña";
  assert.equal(functions.getDataCreditoClientDisplayName({ ...approval, identity: { original: { ...identity, nameMode: undefined }, effective: { ...identity, nameMode: undefined } } }, updated), updated);
  const before = renderToStaticMarkup(React.createElement(functions.DataCreditoClientNameBar, { ...props, canEditComponents: true }));
  assert.equal((before.match(/<input/g) || []).length, 1);
  const changes = [];
  const element = functions.DataCreditoClientNameBar({ ...props, canEditComponents: true, editing: true,
    givenNames: "María José", secondSurname: "Muñoz del Río", onSecondSurnameChange: value => changes.push(value),
  });
  const html = renderToStaticMarkup(element);
  assert.equal((html.match(/<input/g) || []).length, 3);
  assert.ok(html.includes("Nombre(s)")); assert.ok(html.includes("Segundo apellido (si aplica)"));
  assert.ok(!html.includes("Primer apellido"));
  function find(node) {
    if (!node || typeof node !== "object") return null;
    if (node.props?.id === "clienteSegundoApellido") return node;
    return React.Children.toArray(node.props?.children).map(find).find(Boolean);
  }
  find(element).props.onChange({ target: { value: "" } });
  assert.deepEqual(changes, [""]);
});

test("recomposing local fields never clears a recovered provider full name on reload", () => {
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("if (dataCreditoFullNameOnly)") && node.arguments[0].getText(ast).includes("preservedCanonicalClientNameRef")) callback = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  const seen = [];
  load("(" + callback.getText(ast) + ")();", {
    dataCreditoFullNameOnly: true, dataCreditoApproval: approval, setClienteNombre: value => seen.push(value),
    preservedCanonicalClientNameRef: { current: null }, clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "",
    composeCreditClientName: () => assert.fail("Cannot compose full-name-only identity from empty components"),
  });
  assert.deepEqual(seen, [fullName]);
});

test("the actual form validates a full provider name while retaining dates, contact and references requirements", () => {
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "clientFormValidation") callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  const values = { clientePrimerNombre: "", clientePrimerApellido: "", clienteNombre: fullName,
    clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", clienteDocumento: "123456789", clienteFechaExpedicion: "2010-01-01", clienteFechaNacimiento: "1990-01-01",
    clienteTelefono: "3001234567", clienteCorreo: "cliente@example.com", clienteDepartamento: "Antioquia", clienteCiudad: "Medellín", clienteGenero: "FEMENINO", clienteEstadoCivil: "SOLTERO", clienteEstrato: "2", clienteDireccion: "Calle 10 número 20",
    referenciaFamiliar1Nombre: "Ana", referenciaFamiliar1Parentesco: "Hermana", referenciaFamiliar1Telefono: "3011234567", referenciaFamiliar2Nombre: "José", referenciaFamiliar2Parentesco: "Padre", referenciaFamiliar2Telefono: "3021234567",
  };
  function execute(overrides = {}) {
    return load("module.exports.result = (" + callback.getText(ast) + ")();", { ...values, ...overrides, dataCreditoFullNameOnly: true, dataCreditoApproval: approval, validateCreditClientForm }).result;
  }
  assert.equal(execute().complete, true);
  assert.equal(execute({ clienteCorreo: "" }).complete, false);
  assert.equal(execute({ referenciaFamiliar1Telefono: "3001234567" }).complete, false);
  assert.equal(execute({ clienteFechaNacimiento: "" }).personalComplete, false);
});

function consoleCallback(name) {
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback, `Missing console callback ${name}`);
  return callback.getText(ast);
}

function callbackSetters(callback, seen) {
  return Object.fromEntries([...new Set(callback.match(/\bset[A-Z]\w+/g) || [])]
    .map(name => [name, value => seen.set(name, value)]));
}

test("a Veriff refresh never reads or derives names when the DataCredito identity is locked", () => {
  const callback = consoleCallback("applyVeriffIdentityData");
  const seen = new Map();
  const lockedIdentity = { documentNumber: "123456789", dateOfBirth: null, gender: null };
  for (const name of ["fullName", "firstName", "lastName"]) {
    Object.defineProperty(lockedIdentity, name, { get() { assert.fail(`Locked identity cannot read ${name}`); } });
  }
  const apply = load("module.exports.callback = (" + callback + ");", {
    ...callbackSetters(callback, seen), veriffExpectedDraftId: 2883, dataCreditoApproval: approval,
    dataCreditoAssessmentId: 55, auditedIdentityCorrectionRef: { current: false }, applyingVeriffIdentityRef: { current: false },
    veriffApprovalCanUnlockClient: (validation, draft, document) => validation.approved && draft === 2883 && document === "123456789",
    dateOnly: value => value || "", normalizeVeriffGender: () => "",
  }).callback;
  apply({ approved: true, identityData: lockedIdentity });
  for (const name of ["setClienteNombre", "setClientePrimerNombre", "setClientePrimerApellido", "setClienteSegundoApellido", "setClienteDocumento", "setClienteTipoDocumento"]) {
    assert.equal(seen.has(name), false, name);
  }
});

test("restoring a full-name-only saved credit preserves exact components without deriving them", () => {
  const callback = consoleCallback("applyClientDataFromCredit");
  const seen = new Map();
  const preservedCanonicalClientNameRef = { current: null };
  const apply = load("module.exports.callback = (" + callback + ");", {
    ...callbackSetters(callback, seen), preservedCanonicalClientNameRef,
    splitStoredCreditClientName: () => assert.fail("A provider full name cannot be divided while restoring a credit"),
    composeCreditClientName: parts => [parts.firstNames, parts.firstSurname, parts.secondSurname].filter(Boolean).join(" "),
    DOCUMENT_TYPE_OPTIONS: [{ value: "CEDULA_DE_CIUDADANIA" }], dateOnly: value => value || "",
  }).callback;
  apply({ clienteNombre: fullName, clientePrimerNombre: "", clientePrimerApellido: "De la Peña", clienteSegundoApellido: null,
    dataCreditoIdentityNameMode: "FULL_NAME_ONLY", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", referenciasFamiliares: [] });
  assert.equal(seen.get("setClienteNombre"), fullName);
  assert.equal(seen.get("setClientePrimerNombre"), "");
  assert.equal(seen.get("setClientePrimerApellido"), "De la Peña");
  assert.equal(seen.get("setClienteSegundoApellido"), "");
  assert.equal(preservedCanonicalClientNameRef.current.fullName, fullName);
});

test("creating Veriff from a full-name-only form saves the canonical draft and does not require fabricated components", async () => {
  const callback = consoleCallback("validateIdentityWithVeriff");
  const seen = new Map(); const saved = []; const requests = [];
  const payload = { clienteNombre: fullName, clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "",
    clienteDocumento: "123456789", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", dataCreditoAssessmentId: 55 };
  const requestInFlight = { current: false };
  const submit = load("module.exports.callback = (" + callback + ");", {
    ...callbackSetters(callback, seen), veriffRequestInFlightRef: requestInFlight, veriffRefreshGenerationRef: { current: 0 },
    veriffRefreshFlightRef: { current: null }, veriffConfig: { configured: true }, dataCreditoApproval: approval,
    draftId: 2883, factoryDraftPayload: payload, createClientMode: true, simulatorMode: false, deliveryMode: false,
    wizardStep: 3, mobileCaptureSession: null,
    saveDraftPayloadForVeriff: async (value, step, id) => { saved.push({ value, step, id }); return { id, payload: value }; },
    requestJson: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: false, data: { error: "Respuesta simulada" } }; },
  }).callback;
  await submit();
  assert.equal(saved.length, 1); assert.equal(saved[0].value.clienteNombre, fullName);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, "/api/creditos/veriff");
  assert.equal(requests[0].body.draftId, 2883);
  assert.equal(requests[0].body.clientePrimerNombre, ""); assert.equal(requests[0].body.clientePrimerApellido, "");
  assert.equal(requests[0].body.clienteDocumento, "123456789");
  assert.equal(requestInFlight.current, false);
});