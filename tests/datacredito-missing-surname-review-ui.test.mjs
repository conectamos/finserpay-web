import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = await readFile(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["canCompleteMissingDataCreditoSurname", "reviewMissingDataCreditoSurname", "DataCreditoMissingSurnameReview"];
const declarations = names.map(name => {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, name);
  return found.getText(ast);
}).join("\n");
const original = { names: "", firstSurname: "", secondSurname: "", documentType: "CEDULA_DE_CIUDADANIA", documentNumber: "123456789", fullName: "María del Mar De la Peña Muñoz", missing: ["Nombre(s)", "Primer apellido"] };
const approval = { assessmentId: "12345678-1234-4234-8234-123456789012", documentNumber: "123456789", firstSurname: "DIGITADO NO VERIFICADO", identity: { original, effective: original } };
const reviewed = { original, effective: { ...original, firstSurname: "De la Peña", fullName: "De la Peña", missing: ["Nombre(s)"], manuallyCompleted: ["firstSurname"] } };

function load({ fetch, states = [], onCleanup = () => {} } = {}) {
  let stateIndex = 0;
  const requestRef = { current: null };
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(declarations + "\nmodule.exports = { " + names.join(", ") + " };", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  runInNewContext(outputText, {
    module, exports: module.exports, fetch, AbortController,
    useState: initial => [states[stateIndex++] ?? initial, () => {}],
    useRef: () => requestRef, useEffect: effect => onCleanup(effect()),
    Button: ({ children, variant: _variant, ...props }) => React.createElement("button", props, children),
    Input: props => React.createElement("input", props),
    require: name => { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; },
  });
  return { ...module.exports, requestRef };
}

test("only an administrator sees completion for a primary surname actually absent from the provider and effective identity", () => {
  for (const [canAdmin, result, visible] of [
    [true, approval, true], [false, approval, false],
    [true, { ...approval, identity: { original: { ...original, firstSurname: "Proveedor" }, effective: original } }, false],
    [true, { ...approval, identity: reviewed }, false],
    [true, { ...approval, identity: null }, false],
  ]) {
    const functions = load();
    assert.equal(functions.canCompleteMissingDataCreditoSurname(canAdmin, result), visible);
    const element = functions.DataCreditoMissingSurnameReview({ canAdmin, approval: result, onCompleted() {} });
    const html = renderToStaticMarkup(element);
    assert.equal(html.includes("Completar datos faltantes con revisión autorizada"), visible);
  }
  const functions = load({ states: [true, "", false, ""] });
  const html = renderToStaticMarkup(functions.DataCreditoMissingSurnameReview({ canAdmin: true, approval, onCompleted() {} }));
  assert.ok(html.includes('value=""'));
  assert.ok(!html.includes(approval.firstSurname));
  assert.ok(!html.includes(original.fullName));
  assert.ok(html.includes("no se marcará como verificado por DataCrédito"));
});

test("manual review preserves compound surname and accents, sends only PATCH, and keeps the provider original", async () => {
  const requests = [];
  const functions = load({ fetch: async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ ok: true, identity: reviewed });
  } });
  const before = JSON.stringify(approval);
  const result = await functions.reviewMissingDataCreditoSurname({ canAdmin: true, approval, firstSurname: "  De   la  Peña  " });
  assert.equal(result.effective.firstSurname, "De la Peña");
  assert.equal(result.original.firstSurname, "");
  assert.ok(result.effective.manuallyCompleted.includes("firstSurname"));
  assert.equal(JSON.stringify(approval), before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].url, "/api/creditos/datacredito/evaluaciones/" + approval.assessmentId);
  assert.deepEqual(JSON.parse(requests[0].body), { firstSurname: "De la Peña" });
});

test("an advisor, a completed identity or invalid manual input never dispatches an update", async () => {
  const functions = load({ fetch: () => assert.fail("Unexpected request") });
  for (const input of [
    { canAdmin: false, approval, firstSurname: "Otro" },
    { canAdmin: true, approval: { ...approval, identity: reviewed }, firstSurname: "Otro" },
    { canAdmin: true, approval, firstSurname: "" },
    { canAdmin: true, approval, firstSurname: "<script>" },
  ]) await assert.rejects(functions.reviewMissingDataCreditoSurname(input));
});

test("a rejected administrative update retains the original identity", async () => {
  const before = JSON.stringify(approval);
  const functions = load({ fetch: async () => Response.json({ error: "Requiere revisión de un administrador autorizado" }, { status: 403 }) });
  await assert.rejects(functions.reviewMissingDataCreditoSurname({ canAdmin: true, approval, firstSurname: "De la Peña" }), /administrador autorizado/);
  assert.equal(JSON.stringify(approval), before);
});

test("switching clients cancels an outstanding review and never applies its response to the next client", async () => {
  let resolveResponse;
  let cleanup;
  let completed = 0;
  const functions = load({ states: [true, "De la Peña", false, ""],
    onCleanup: callback => { cleanup = callback; },
    fetch: () => new Promise(resolve => { resolveResponse = resolve; }),
  });
  const element = functions.DataCreditoMissingSurnameReview({ canAdmin: true, approval, onCompleted() { completed++; } });
  function findSave(node) {
    if (!node || typeof node !== "object") return null;
    if (node.props?.children === "Guardar revisión autorizada") return node;
    return React.Children.toArray(node.props?.children).map(findSave).find(Boolean);
  }
  const button = findSave(element);
  assert.ok(button);
  button.props.onClick();
  assert.ok(functions.requestRef.current);
  cleanup();
  assert.equal(functions.requestRef.current.signal.aborted, true);
  resolveResponse(Response.json({ ok: true, identity: reviewed }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, 0);
});
