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
  const sharedAccess = () => null;
  let currentView;
  const node = (type, props) => ({ type, props });
  const source = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name === "react") return { useState: initial => [currentView ?? initial, value => { currentView = value; }] };
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return { Bell: () => null };
      if (name === "./approval-console") return { default: consoleView };
      if (name === "./approval-operations") return { default: operations };
      if (name === "./sadmin-credit-table") return { default: sadmin };
      if (name === "./shared-access-control") return { default: sharedAccess };
      throw new Error("Unexpected import: " + name);
    },
  });
  const Workspace = loaded.exports.default;
  function findAll(tree, predicate) {
    const matches = [];
    function visit(value) {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (predicate(value)) matches.push(value);
      visit(value.props?.children);
    }
    visit(tree);
    return matches;
  }
  const has = (tree, type) => findAll(tree, item => item.type === type).length > 0;
  const personalProps = { allowOperations: true, manageSharedAccess: true, userName: "Analista Finser" };
  let tree = Workspace(personalProps);
  assert.ok(has(tree, operations));
  assert.ok(!has(tree, sharedAccess), "la gestión del enlace no debe empujar el detalle");
  assert.equal(findAll(tree, item => item.type === "h1")[0].props.children, "Detalle del crédito");

  findAll(tree, item => item.type === "button" && item.props?.["aria-label"] === "Abrir bandeja de aprobaciones")[0].props.onClick();
  tree = Workspace(personalProps);
  assert.ok(has(tree, consoleView));
  assert.ok(has(tree, sharedAccess), "el enlace compartido permanece en la bandeja");
  findAll(tree, item => item.type === "button" && item.props?.children === "Detalle del crédito")[0].props.onClick();
  assert.ok(has(Workspace(personalProps), operations));

  currentView = undefined;
  tree = Workspace({ shared: true });
  assert.ok(has(tree, consoleView));
  assert.ok(!has(tree, operations));
  assert.ok(!has(tree, sharedAccess));
});

test("detalle operativo se ofrece solo en la sesión nominal de aprobaciones", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  const workspace = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const sharedPage = read("app/revision-creditos/page.tsx");
  assert.match(page, /allowOperations=\{sharedContext === undefined\}/);
  assert.match(workspace, /view === "operations" && allowOperations/);
  assert.doesNotMatch(page, /AdminWorkspaceTopbar/);
  assert.match(page, /manageSharedAccess=\{canManageApprovalAnalysts\(user\)\}/);
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
