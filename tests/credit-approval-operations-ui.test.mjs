import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Aprobaciones abre el detalle con cuenta personal y conserva el muro para acceso compartido", () => {
  const operations = () => null;
  const consoleView = () => null;
  const sadmin = () => null;
  const node = (type, props) => ({ type, props });
  const source = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name === "react") return { useState: initial => [initial, () => undefined] };
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "@/app/_components/finser-ui") return { Button: () => null };
      if (name === "./approval-console") return { default: consoleView };
      if (name === "./approval-operations") return { default: operations };
      if (name === "./sadmin-credit-table") return { default: sadmin };
      throw new Error("Unexpected import: " + name);
    },
  });
  const Workspace = loaded.exports.default;
  const children = (props) => Workspace(props).props.children;
  assert.equal(children({ allowOperations: true })[1].type, operations);
  assert.equal(children({ shared: true })[1].type, consoleView);
});

test("detalle operativo se ofrece solo en la sesión nominal de aprobaciones", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  const workspace = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const sharedPage = read("app/revision-creditos/page.tsx");
  assert.match(page, /allowOperations=\{sharedContext === undefined\}/);
  assert.match(workspace, /view === "operations" && allowOperations/);
  assert.match(sharedPage, /<ApprovalWorkspace shared\s*\/>/);
  assert.doesNotMatch(sharedPage, /allowOperations/);
});

test("la vista distingue el cambio por garantía pendiente de enrolamiento del envío de una nueva firma", () => {
  const ui = read("app/dashboard/aprobaciones/approval-operations.tsx");
  assert.match(ui, /detail\?\.kind === "CREDIT" \? "Solicitar cambio por garantía"/);
  assert.match(ui, /detail\.capabilities\.canConfirmReplacement/);
  assert.match(ui, /"PENDING_ENROLLMENT"/);
  assert.match(ui, /setConfirmation\("imei-confirm"\)/);
  assert.match(ui, /El enrolamiento del nuevo equipo fue aprobado/);
  assert.match(ui, /se regenerará una nueva versión del contrato/);
});

test("la pantalla nunca presenta un fallo técnico de FirmaSeguro como rechazo", () => {
  const ui = read("app/dashboard/aprobaciones/approval-operations.tsx");
  assert.match(ui, /case "TECHNICAL_ERROR": return "Error técnico: requiere revisión"/);
  assert.doesNotMatch(ui, /firma rechazada|Firma rechazada/i);
});
