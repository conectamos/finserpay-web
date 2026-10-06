import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Aprobaciones abre el detalle con cuenta nominal y no ofrece SADMIN al analista", () => {
  const operations = () => null;
  const consoleView = () => null;
  const sadmin = () => null;
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
      if (name === "./shared-access-control") return { default: () => null };
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
  const personalProps = { allowOperations: true, canManageSadmin: false, userName: "Analista Finser" };
  let tree = render(personalProps);
  assert.ok(has(tree, operations));
  assert.ok(has(tree, consoleView));
  assert.equal(findAll(tree, item => item.type === "h1")[0].props.children, "Bandeja de aprobaciones");
  assert.equal(findAll(tree, item => item.type === consoleView)[0].props.onOpenSadmin, undefined,
    "el analista no recibe el comando de control SADMIN");

  findAll(tree, item => item.type === "button" && item.props?.children === "Detalle del crédito")[0].props.onClick();
  tree = render(personalProps);
  assert.ok(has(tree, operations));
  assert.equal(findAll(tree, item => item.type === operations)[0].props.active, true,
    "el detalle operativo se abre bajo demanda");

  findAll(tree, item => item.type === operations)[0].props.onOpenApproval(42);
  tree = render(personalProps);
  assert.ok(has(tree, consoleView));
  assert.ok(has(tree, operations), "la ficha se mantiene montada para conservar el crédito seleccionado");
  assert.equal(findAll(tree, item => item.type === operations)[0].props.active, false);
  assert.equal(findAll(tree, item => item.type === consoleView)[0].props.focusCreditId, 42,
    "el botón de FirmaSeguro debe abrir el expediente exacto");

  states.length = 0;
  tree = render({ shared: true });
  assert.ok(has(tree, consoleView));
  assert.ok(!has(tree, operations));
});

test("detalle operativo se ofrece en la sesión nominal y SADMIN depende del administrador central", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  const workspace = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const sharedPage = read("app/revision-creditos/page.tsx");
  assert.match(page, /allowOperations=\{sharedContext === undefined\}/);
  assert.match(page, /canManageSadmin=\{centralAdmin && sharedContext === undefined\}/);
  assert.match(workspace, /view === "operations" && allowOperations/);
  assert.doesNotMatch(page, /AdminWorkspaceTopbar/);
  assert.match(workspace, /onOpenSadmin=\{canManageSadmin \? \(\) => setView\("sadmin"\) : undefined\}/);
  assert.doesNotMatch(workspace, /manageSharedAccess/);
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
  let contactRequest = null;
  let signatureRequest = null;
  let approvalReviewReads = 0;
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
      if (url === "/api/aprobaciones/8/datos") {
        approvalReviewReads++;
        return response({ ok: true, item: { review: { revision: 3, reviewHash: "a".repeat(64) } } });
      }
      if (url === "/api/aprobaciones/operativo/credit/8/contacto" && init?.method === "PATCH") {
        contactRequest = JSON.parse(init.body);
        caseDetail.phone = contactRequest.phone;
        caseDetail.email = contactRequest.email;
        return response({ ok: true, message: "Contacto actualizado" });
      }
      if (url === "/api/aprobaciones/operativo/credit/8/firma" && init?.method === "POST") {
        signatureRequest = JSON.parse(init.body);
        caseDetail.signature.status = "PENDING";
        return response({ ok: true, operation: { id: "signature-8", status: "REQUESTED", message: "Solicitud enviada" } });
      }
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

  caseDetail.capabilities.canUpdateContact = true;
  caseDetail.capabilities.canResendSignature = true;
  tree = render();
  button(tree, "Actualizar contacto").props.onClick();
  tree = render();
  find(tree, item => item.type === components.Input && item.props.id === "approval-signature-phone")
    .props.onChange({ target: { value: "3119876543" } });
  find(tree, item => item.type === components.Input && item.props.id === "approval-signature-email")
    .props.onChange({ target: { value: "nuevo@example.com" } });
  find(tree, item => item.type === components.Input && item.props.id === "approval-contact-reason")
    .props.onChange({ target: { value: "Corrección de contacto solicitada" } });
  tree = render();
  assert.equal(button(tree, "Reenviar firma")?.props.disabled, true,
    "no permite enviar antes de guardar el contacto editado");
  button(tree, "Guardar contacto").props.onClick();
  await setImmediate();
  assert.equal(contactRequest.expectedRevision, 3);
  assert.equal(contactRequest.expectedReviewHash, "a".repeat(64));

  tree = render();
  button(tree, "Reenviar firma").props.onClick();
  tree = render();
  find(tree, item => item.type === components.Input && item.props.id === "approval-signature-reason")
    .props.onChange({ target: { value: "Nueva versión solicitada" } });
  tree = render();
  button(tree, "Continuar").props.onClick();
  tree = render();
  const reissueConfirm = find(tree, item => item.type === ConfirmDialog && item.props.title === "Reenviar firma");
  assert.match(reissueConfirm.props.description, /3119876543.*nuevo@example\.com/);
  reissueConfirm.props.onConfirm();
  await setImmediate();
  assert.equal(approvalReviewReads, 2, "el cliente obtiene la revisión vigente antes de cada acción");
  assert.equal(signatureRequest.expectedRevision, 3);
  assert.equal(signatureRequest.expectedReviewHash, "a".repeat(64));
  assert.equal(signatureRequest.expectedProcessUuid, "process-8");
  assert.equal(caseDetail.signature.status, "PENDING", "el POST no adelanta la firma a completada");

  caseDetail.signature.status = "NOT_SENT";
  caseDetail.capabilities.canResendSignature = false;
  caseDetail.capabilities.signatureReason = "Error técnico: requiere revisión. No se pudo verificar el origen contractual.";
  tree = render();
  assert.equal(button(tree, "Enviar firma"), undefined,
    "un crédito sin firma verificable no puede ofrecer un envío que el servidor no autoriza");
  assert.ok(textOf(tree).includes(caseDetail.capabilities.signatureReason));
  assert.ok(button(tree, "Abrir revisión"));

  caseDetail.capabilities.canSendSignature = true;
  caseDetail.capabilities.signatureReason = null;
  caseDetail.signature.processUuid = null;
  tree = render();
  assert.ok(button(tree, "Enviar firma"), "la firma inicial se habilita solo cuando el servidor expone la capacidad");
  button(tree, "Enviar firma").props.onClick();
  tree = render();
  find(tree, item => item.type === components.Input && item.props.id === "approval-signature-reason")
    .props.onChange({ target: { value: "Firma inicial del contrato" } });
  tree = render();
  button(tree, "Continuar").props.onClick();
  tree = render();
  find(tree, item => item.type === ConfirmDialog && item.props.title === "Enviar firma")
    .props.onConfirm();
  await setImmediate();
  assert.equal(signatureRequest.expectedRevision, 3);
  assert.equal(signatureRequest.expectedReviewHash, "a".repeat(64));
  assert.equal(signatureRequest.expectedProcessUuid, null);
  assert.equal(caseDetail.signature.status, "PENDING");

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

test("FirmaSeguro permite corregir contacto y enviar una firma inicial sin anticipar la aprobación", async () => {
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
    kind: "DRAFT", id: 12, number: "B-12", clientName: "Cliente QA", document: "12345678",
    phone: "3001234567", email: "qa@example.com", status: "EN_FIRMA", equipment: "iPhone QA",
    imei: "111111111111111", updatedAt: "2026-10-04T12:00:00Z", timeline: [],
    signature: { status: "NOT_SENT", rawStatus: null, processUuid: null, sentPhone: null,
      sentEmail: null, sentAt: null, signedAt: null },
    enrollmentReviewId: null, requiresEnrollmentReapproval: false, pendingVersion: null,
    replacement: null, remission: null,
    capabilities: { preSettlementApprovalCreditId: null, canChangeImei: false,
      canDispatchSignatureWithImei: false, canFinalizeImei: false, canConfirmReplacement: false,
      canUpdateContact: true, canSendSignature: true, canResendSignature: false, reason: null },
  };
  const requests = [];
  const response = payload => ({ ok: true, json: async () => payload });
  const compiled = ts.transpileModule(read("app/dashboard/aprobaciones/approval-operations.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date,
    crypto: { randomUUID: () => "operation-12" },
    fetch: async (url, init) => {
      if (url.startsWith("/api/aprobaciones/operativo?q=")) return response({ ok: true, items: [caseDetail] });
      if (url === "/api/aprobaciones/operativo/draft/12" && (!init || !init.method)) return response({ ok: true, item: caseDetail });
      if (url === "/api/aprobaciones/operativo/draft/12/contacto" && init?.method === "PATCH") {
        const body = JSON.parse(init.body);
        requests.push({ action: "contact", body });
        caseDetail.phone = body.phone;
        caseDetail.email = body.email;
        return response({ ok: true, message: "Contacto actualizado" });
      }
      if (url === "/api/aprobaciones/operativo/draft/12/firma" && init?.method === "POST") {
        const body = JSON.parse(init.body);
        requests.push({ action: "signature", body });
        caseDetail.signature.status = "PENDING";
        return response({ ok: true, operation: { id: "operation-12", status: "REQUESTED", message: "Solicitud enviada" } });
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
  const render = () => { cursor = 0; return loaded.exports.default({}); };
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const textOf = value => Array.isArray(value) ? value.map(textOf).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? textOf(value.props?.children) : "";
  const find = (tree, predicate) => nodes(tree).find(predicate);
  const button = (tree, label) => find(tree, item => item.type === components.Button && textOf(item.props.children).includes(label));
  const input = (tree, id) => find(tree, item => item.type === components.Input && item.props.id === id);

  let tree = render();
  input(tree, "approval-operations-search").props.onChange({ target: { value: "B-12" } });
  tree = render();
  await find(tree, item => item.type === "form" && item.props.role === "search")
    .props.onSubmit({ preventDefault() {} });
  await setImmediate();
  tree = render();
  button(tree, "FirmaSeguro").props.onClick();
  tree = render();
  assert.ok(button(tree, "Actualizar contacto"));
  assert.ok(button(tree, "Enviar firma"));
  assert.equal(button(tree, "Reenviar firma"), undefined);
  assert.equal(textOf(tree).includes("El cambio por garantía requiere"), false);

  button(tree, "Actualizar contacto").props.onClick();
  tree = render();
  assert.equal(input(tree, "approval-signature-phone").props.readOnly, false);
  input(tree, "approval-signature-phone").props.onChange({ target: { value: "3119876543" } });
  input(tree, "approval-signature-email").props.onChange({ target: { value: "nuevo@example.com" } });
  input(tree, "approval-contact-reason").props.onChange({ target: { value: "Corrección solicitada por cliente" } });
  tree = render();
  button(tree, "Guardar contacto").props.onClick();
  await setImmediate();
  assert.equal(requests[0].action, "contact");
  assert.equal(requests[0].body.phone, "3119876543");
  assert.equal(requests[0].body.email, "nuevo@example.com");

  tree = render();
  button(tree, "Enviar firma").props.onClick();
  tree = render();
  input(tree, "approval-signature-reason").props.onChange({ target: { value: "Firma inicial con contacto corregido" } });
  tree = render();
  button(tree, "Continuar").props.onClick();
  tree = render();
  const confirm = find(tree, item => item.type === ConfirmDialog && item.props.title === "Enviar firma");
  assert.match(confirm.props.description, /3119876543.*nuevo@example\.com/);
  confirm.props.onConfirm();
  await setImmediate();
  assert.equal(requests[1].action, "signature");
  assert.equal(requests[1].body.confirmed, true);
  assert.equal(requests[1].body.expectedProcessUuid, null);
  assert.equal(caseDetail.signature.status, "PENDING", "el envío no se presenta como firma aprobada");
});

test("una firma terminal fallida se redirige y reintenta con la misma idempotencia sin tocar el contacto ordinario", async () => {
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
  const previousProcessUuid = "20000000-0000-4000-8000-000000000002";
  const nextProcessUuid = "30000000-0000-4000-8000-000000000003";
  const caseDetail = {
    kind: "DRAFT", id: 22, number: "SOL-22", clientName: "Cliente pendiente", document: "1052962070",
    phone: "3218928117", email: "cliente@example.com", status: "EN_FIRMA", equipment: "iPhone QA",
    imei: "111111111111111", updatedAt: "2026-10-05T20:27:00Z", timeline: [],
    signature: { status: "TECHNICAL_ERROR", rawStatus: null, processUuid: previousProcessUuid,
      sentPhone: "3218928117", sentEmail: "cliente@example.com", sentAt: "2026-10-05T20:27:00Z", signedAt: null },
    enrollmentReviewId: null, requiresEnrollmentReapproval: false, pendingVersion: null,
    replacement: null, remission: null,
    capabilities: { preSettlementApprovalCreditId: null, canChangeImei: false,
      canDispatchSignatureWithImei: false, canFinalizeImei: false, canConfirmReplacement: false,
      canUpdateContact: false, canSendSignature: false, canResendSignature: false,
      canRedirectPendingSignature: true, pendingSignatureRedirectReason: null,
      reason: null, signatureReason: null },
  };
  const requests = [];
  let postAttempts = 0;
  let uuidCalls = 0;
  const response = (payload, ok = true) => ({ ok, json: async () => payload });
  const compiled = ts.transpileModule(read("app/dashboard/aprobaciones/approval-operations.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date,
    crypto: { randomUUID: () => { uuidCalls++; return "10000000-0000-4000-8000-000000000001"; } },
    fetch: async (url, init) => {
      if (url.startsWith("/api/aprobaciones/operativo?q=")) return response({ ok: true, items: [caseDetail] });
      if (url === "/api/aprobaciones/operativo/draft/22" && (!init || !init.method))
        return response({ ok: true, item: caseDetail });
      if (url === "/api/aprobaciones/operativo/draft/22/firma/redireccion" && init?.method === "POST") {
        const body = JSON.parse(init.body);
        requests.push({ url, body });
        postAttempts++;
        if (postAttempts === 1) return response({ ok: false, error: "FirmaSeguro no respondió" }, false);
        caseDetail.phone = body.phone;
        caseDetail.signature = { ...caseDetail.signature, status: "PENDING", rawStatus: "CREATED", processUuid: nextProcessUuid,
          sentPhone: body.phone, sentAt: "2026-10-05T20:30:00Z" };
        return response({ ok: true, operation: { id: body.idempotencyKey, status: "AWAITING_SIGNATURE",
          message: "Firma reenviada", processUuid: nextProcessUuid } });
      }
      if (url.endsWith("/contacto")) throw new Error("La redirección no debe usar PATCH contacto");
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
  const render = () => { cursor = 0; return loaded.exports.default({}); };
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const textOf = value => Array.isArray(value) ? value.map(textOf).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? textOf(value.props?.children) : "";
  const find = (tree, predicate) => nodes(tree).find(predicate);
  const button = (tree, label) => find(tree, item => item.type === components.Button && textOf(item.props.children).includes(label));
  const input = (tree, id) => find(tree, item => item.type === components.Input && item.props.id === id);

  let tree = render();
  input(tree, "approval-operations-search").props.onChange({ target: { value: "1052962070" } });
  tree = render();
  await find(tree, item => item.type === "form" && item.props.role === "search")
    .props.onSubmit({ preventDefault() {} });
  await setImmediate();
  tree = render();
  button(tree, "FirmaSeguro").props.onClick();
  tree = render();
  assert.equal(input(tree, "approval-signature-phone").props.readOnly, true);
  assert.equal(input(tree, "approval-signature-email").props.readOnly, true);
  assert.ok(button(tree, "Cambiar número y reenviar firma"));

  button(tree, "Cambiar número y reenviar firma").props.onClick();
  tree = render();
  assert.equal(button(tree, "Cambiar número y reenviar firma").props.disabled, true,
    "sin celular y motivo no se puede confirmar");
  input(tree, "approval-signature-redirect-phone").props.onChange({ target: { value: "3218928117" } });
  input(tree, "approval-signature-redirect-reason").props.onChange({ target: { value: "Número anterior sin WhatsApp" } });
  tree = render();
  assert.equal(button(tree, "Cambiar número y reenviar firma").props.disabled, true,
    "el mismo celular del envío anterior no es un destino nuevo");
  input(tree, "approval-signature-redirect-phone").props.onChange({ target: { value: "+57 311 987 6543" } });
  tree = render();
  assert.equal(button(tree, "Cambiar número y reenviar firma").props.disabled, false);
  button(tree, "Cambiar número y reenviar firma").props.onClick();
  tree = render();
  let confirm = find(tree, item => item.type === ConfirmDialog && item.props.title === "Cambiar número y reenviar firma");
  assert.match(confirm.props.description, /3218928117/);
  assert.match(confirm.props.description, /3119876543/);
  assert.match(confirm.props.description, /conservará las mismas condiciones y valores/);
  confirm.props.onConfirm();
  confirm.props.onConfirm();
  await setImmediate();
  await setImmediate();
  assert.equal(requests.length, 1, "un doble clic no inicia dos POST");
  assert.deepEqual(requests[0].body, {
    phone: "3119876543", reason: "Número anterior sin WhatsApp",
    idempotencyKey: "10000000-0000-4000-8000-000000000001",
    expectedProcessUuid: previousProcessUuid, confirmed: true,
  });

  tree = render();
  button(tree, "Cambiar número y reenviar firma").props.onClick();
  tree = render();
  confirm = find(tree, item => item.type === ConfirmDialog && item.props.title === "Cambiar número y reenviar firma");
  confirm.props.onConfirm();
  await setImmediate();
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.idempotencyKey, requests[0].body.idempotencyKey,
    "el retry de red conserva la misma clave idempotente");
  assert.equal(uuidCalls, 1);
  assert.equal(caseDetail.signature.processUuid, nextProcessUuid);
  assert.equal(caseDetail.signature.sentPhone, "3119876543");
  assert.equal(caseDetail.signature.status, "PENDING", "el reenvío no anticipa una firma completada");
});
