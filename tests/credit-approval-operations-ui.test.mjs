import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Aprobaciones abre el detalle con cuenta personal y conserva el muro para acceso compartido", () => {
  const operations = () => null;
  const consoleView = () => null;
  const sadmin = () => null;
  const sharedAccess = () => null;
  const states = [];
  let cursor = 0;
  const node = (type, props) => ({ type, props });
  const source = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name === "react") return { useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      } };
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
  const render = props => { cursor = 0; return Workspace(props); };
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
  let tree = render(personalProps);
  assert.ok(has(tree, operations));
  assert.ok(!has(tree, sharedAccess), "la gestión del enlace no debe empujar el detalle");
  assert.equal(findAll(tree, item => item.type === "h1")[0].props.children, "Detalle del crédito");

  findAll(tree, item => item.type === operations)[0].props.onOpenApproval(42);
  tree = render(personalProps);
  assert.ok(has(tree, consoleView));
  assert.equal(findAll(tree, item => item.type === consoleView)[0].props.focusCreditId, 42,
    "el botón de FirmaSeguro debe abrir el expediente exacto");
  assert.ok(has(tree, sharedAccess), "el enlace compartido permanece en la bandeja");
  findAll(tree, item => item.type === "button" && item.props?.children === "Detalle del crédito")[0].props.onClick();
  assert.ok(has(render(personalProps), operations));

  states.length = 0;
  tree = render({ shared: true });
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
  assert.match(ui, /detail\?\.kind === "CREDIT" \? "Solicitar cambio y nueva remisión"/);
  assert.match(ui, /detail\.capabilities\.canConfirmReplacement/);
  assert.match(ui, /"PENDING_ENROLLMENT"/);
  assert.match(ui, /setConfirmation\("imei-confirm"\)/);
  assert.match(ui, /El enrolamiento del nuevo equipo fue aprobado/);
  assert.match(ui, /se regenerará una nueva versión del contrato/);
  assert.match(ui, /detail\.remission\?\.status !== "PENDING_REVIEW"/);
  assert.match(ui, /action === "REJECT" && \(note\.length < 5/);
});

test("la pantalla nunca presenta un fallo técnico de FirmaSeguro como rechazo", () => {
  const ui = read("app/dashboard/aprobaciones/approval-operations.tsx");
  assert.match(ui, /case "TECHNICAL_ERROR": return "Error técnico: requiere revisión"/);
  assert.doesNotMatch(ui, /firma rechazada|Firma rechazada/i);
});

test("las gestiones se abren bajo demanda y la remisión firmada requiere revisión explícita", async () => {
  const components = Object.fromEntries(["Badge", "Button", "Card", "Input", "LoadingState", "Select", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null;
  const node = (type, props) => ({ type, props });
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect() { cursor++; },
  };
  const caseDetail = {
    kind: "CREDIT", id: 8, number: "CR-8", clientName: "Cliente QA", document: "12345678",
    phone: "3001234567", email: "qa@example.com", status: "FINALIZADO", equipment: "iPhone QA",
    imei: "111111111111111", updatedAt: "2026-10-04T12:00:00Z", timeline: [],
    signature: { status: "SIGNED", rawStatus: "SIGNED", processUuid: "process-8", sentPhone: "3001234567",
      sentEmail: "qa@example.com", sentAt: null, signedAt: "2026-10-04T12:00:00Z" },
    enrollmentReviewId: null, requiresEnrollmentReapproval: false, pendingVersion: null,
    replacement: null, remission: null,
    capabilities: { preSettlementApprovalCreditId: 8, canChangeImei: true, canDispatchSignatureWithImei: false,
      canFinalizeImei: false, canConfirmReplacement: false, canUpdateContact: false,
      canResendSignature: false, reason: null },
  };
  let openedCreditId = null;
  let remissionRequest = null;
  const response = payload => ({ ok: true, json: async () => payload });
  const source = read("app/dashboard/aprobaciones/approval-operations.tsx");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date, crypto: globalThis.crypto,
    fetch: async (url, init) => {
      if (url.startsWith("/api/aprobaciones/operativo?q=")) return response({ ok: true, items: [caseDetail] });
      if (url === "/api/aprobaciones/operativo/credit/8") return response({ ok: true, item: caseDetail });
      if (url === "/api/aprobaciones/operativo/credit/8/remision" && init?.method === "POST") {
        remissionRequest = JSON.parse(init.body);
        return response({ ok: true, remission: caseDetail.remission });
      }
      throw new Error("Unexpected request: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: ConfirmDialog };
      if (name === "./approval-operations.module.css") return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error("Unexpected import: " + name);
    },
  });
  const render = () => { cursor = 0; return loaded.exports.default({ onOpenApproval: id => { openedCreditId = id; } }); };
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const textOf = value => Array.isArray(value) ? value.map(textOf).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? textOf(value.props?.children) : "";
  const find = (tree, predicate) => nodes(tree).find(predicate);
  const button = (tree, label) => find(tree, item => item.type === components.Button && textOf(item.props.children).includes(label));
  const card = (tree, id) => find(tree, item => item.type === components.Card && item.props.id === id);

  let tree = render();
  assert.equal(card(tree, "approval-imei-panel"), undefined);
  assert.equal(card(tree, "approval-signature-panel"), undefined);
  find(tree, item => item.type === components.Input && item.props.id === "approval-operations-search")
    .props.onChange({ target: { value: "CR-8" } });
  tree = render();
  await find(tree, item => item.type === "form" && item.props.role === "search")
    .props.onSubmit({ preventDefault() {} });
  await setImmediate();
  tree = render();
  assert.ok(button(tree, "Cambio de IMEI"));
  assert.ok(button(tree, "FirmaSeguro"));
  assert.equal(card(tree, "approval-imei-panel"), undefined, "el formulario no aparece automáticamente");
  button(tree, "Cambio de IMEI").props.onClick();
  tree = render();
  assert.ok(card(tree, "approval-imei-panel"));
  assert.equal(find(tree, item => item.type === components.Select && item.props.id === "approval-imei-reason")?.props.value, "Garantía");
  assert.equal(find(tree, item => item.type === components.Input && item.props.id === "approval-new-imei")?.props.disabled, false);

  button(tree, "FirmaSeguro").props.onClick();
  tree = render();
  assert.equal(card(tree, "approval-imei-panel"), undefined);
  assert.ok(card(tree, "approval-signature-panel"));
  button(tree, "Gestionar firma en aprobaciones").props.onClick();
  assert.equal(openedCreditId, 8);

  caseDetail.capabilities.canChangeImei = false;
  caseDetail.replacement = { id: "replacement-8", status: "PENDING_ENROLLMENT", previousImei: caseDetail.imei,
    newImei: "222222222222222", reason: "Garantía", createdAt: "2026-10-04T12:00:00Z" };
  caseDetail.remission = { id: "remission-8", replacementId: "replacement-8", version: 1,
    status: "PENDING_REVIEW", photoSha256: "a".repeat(64), requestedAt: "2026-10-04T12:00:00Z",
    uploadedAt: "2026-10-04T13:00:00Z", reviewedAt: null, uploadedByName: "Aliado QA" };
  button(tree, "Cambio de IMEI").props.onClick();
  tree = render();
  assert.equal(find(tree, item => item.type === components.Input && item.props.id === "approval-new-imei"), undefined,
    "la gestión pendiente no muestra un campo inutilizable");
  assert.match(find(tree, item => item.type === "a" && textOf(item.props.children).includes("Ver foto de remisión"))?.props.href || "",
    /replacementId=replacement-8/);
  button(tree, "Solicitar nueva foto").props.onClick();
  tree = render();
  find(tree, item => item.type === components.Input && item.props.id === "approval-remission-note")
    .props.onChange({ target: { value: "Falta la firma del cliente" } });
  tree = render();
  button(tree, "Continuar").props.onClick();
  tree = render();
  find(tree, item => item.type === ConfirmDialog && item.props.title === "Solicitar otra foto de remisión")
    .props.onConfirm();
  await setImmediate();
  assert.equal(remissionRequest.replacementId, "replacement-8");
  assert.equal(remissionRequest.action, "REJECT");
  assert.equal(remissionRequest.note, "Falta la firma del cliente");
});
