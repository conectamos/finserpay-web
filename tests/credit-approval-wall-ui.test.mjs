import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "LoadingState", "MetricCard", "PageHeader", "StatusPill", "Select", "Tabs"].map((name) => [name, placeholder(name)]));
const parts = Object.fromEntries(["ConfirmDialog", "LastPdfPagePreview", "ApprovalEvidenceCorrection", "ApprovalSignatureReissue", "ApprovalNoveltyPanel", "PendingItemEditor", "ApprovalCallRecording", "SharedApprovalWorkspace"].map((name) => [name, placeholder(name)]));
const icons = new Proxy({}, { get: (_, key) => placeholder(String(key)) });

function load(path, dependencies, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, { module: loadedModule, exports: loadedModule.exports, console, AbortController,
    URLSearchParams, Response, Request, Intl, crypto: globalThis.crypto, ...globals, require(name) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "lucide-react") return icons;
      assert.ok(name in dependencies, `Unexpected dependency ${name} from ${path}`);
      return dependencies[name];
    } }, { filename: path });
  return loadedModule.exports;
}
const client = load("app/dashboard/aprobaciones/approval-client.ts", {});
const creditFactory = load("lib/credit-factory.ts", { "@/lib/colombia-date": load("lib/colombia-date.ts", {}) });
const pendingClient = load("app/dashboard/pendientes/pending-client.ts", {});

// Run the actual parent component's handlers and effects with controlled promises.
// Child widgets stay opaque: their public callbacks drive the same parent state
// transitions that the browser uses, without depending on private hook indexes.
function mount(path, dependencies, props = {}) {
  const slots = [];
  const listeners = new Map();
  const intervals = new Map();
  let hookIndex = 0, dirty = true, effects = [], tree;
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial,
        set(value) { const next = typeof value === "function" ? value(slots[index].value) : value;
          if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; } } };
      return [slots[index].value, slots[index].set];
    },
    useRef(value) { const index = hookIndex++; slots[index] ||= { current: value }; return slots[index]; },
    useCallback(fn, deps) {
      const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const Component = load(path, { react: hooks, "@/app/_components/finser-ui": ui, ...dependencies }, {
    document: { visibilityState: "visible" },
    window: { addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
      setInterval: (callback) => { const id = Symbol(); intervals.set(id, callback); return id; },
      clearInterval: (id) => intervals.delete(id) },
  }).default;
  const nodes = (node) => {
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
    if (!node || typeof node !== "object") return [];
    return [node, ...nodes(node.props?.children), ...nodes(node.props?.actions)];
  };
  return {
    async flush() {
      for (let cycle = 0; cycle < 30; cycle++) {
        if (dirty) {
          dirty = false; hookIndex = 0; effects = []; tree = Component(props);
          for (const effect of effects) effect();
        }
        await setImmediate();
        if (!dirty) return;
      }
      assert.fail("Component did not settle");
    },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, "Expected rendered control"); return node; },
    all(predicate) { return nodes(tree).filter(predicate); },
    focus() { listeners.get("focus")?.(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const row = (id) => ({ id, folio: `QA-${id}`, clienteNombre: `Cliente ${id}`, clienteDocumento: String(id), aliadoNombre: "Aliado QA",
  fechaCredito: "2026-09-09T12:00:00Z", status: "PENDING", required: true });
const detail = (id, revision = 1) => ({ ...row(id), score: 800, initialPaymentPercentage: 20, cuotaInicial: 200,
  creditoAutorizado: 800, approvedLimit: 1000, valorVenta: 1000,
  review: { required: true, status: "PENDING", revision, reviewHash: String(revision).repeat(64), approvedAt: null, approvedByName: null },
  capabilities: { canCreateNovelty: true, canCorrectEvidence: true, canReissueSignature: true, correctionBlockedReason: null },
  reissue: { available: true, blocked: false, operation: null },
  novelties: { available: true, blocksApproval: false, blocksSettlement: false, pendingCount: 0, answeredCount: 0, novelty: null },
  callRecording: { available: true, required: true, canUpload: true, blockedReason: null, recording: { id: "call-" + revision, revision, reviewHash: String(revision).repeat(64), fileName: "llamada.wav", createdAt: "2026-09-09T12:00:00Z", actorName: "Analista" } },
  canApprove: true, blockingReasons: [], evidence: [], document: { available: true, href: `/doc/${id}`, fileName: "QA.pdf", processUuid: "QA-process" },
});
const page = (items) => ({ items, hasMore: false, nextCursor: null });
function wall(api = {}, props = {}) {
  return mount("app/dashboard/aprobaciones/approval-console.tsx", {
    "@/lib/credit-factory": creditFactory,
    "./approval-client": { ...client, readApprovalQueue: async () => page([row(81), row(82)]), readApprovalCredit: async (id) => detail(id),
      approveCreditReview: async () => ({ ok: true }), ...api },
    "@/app/_components/finser-confirm-dialog": { default: parts.ConfirmDialog },
    "./last-pdf-page-preview": { default: parts.LastPdfPagePreview },
    "./approval-evidence-correction": { default: parts.ApprovalEvidenceCorrection },
    "./approval-signature-reissue": { default: parts.ApprovalSignatureReissue },
    "./approval-call-recording": { default: parts.ApprovalCallRecording },
    "./approval-novelty-panel": { default: parts.ApprovalNoveltyPanel },
    "@/app/revision-creditos/shared-approval-workspace": { default: parts.SharedApprovalWorkspace },
  }, props);
}
const select = (h, id) => h.find((node) => node.props?.["aria-label"] === `Revisar crédito QA-${id}`).props.onClick();
const current = (h) => h.find((node) => node.type === parts.ApprovalNoveltyPanel).props;
const approveButton = (h) => h.find((node) => node.type === ui.Button && node.props.onClick?.name === "requestApproval");
const confirm = (h) => h.find((node) => node.type === parts.ConfirmDialog && node.props.title === "Aprobar para liquidación");

test("una ficha atrasada no reemplaza al crédito que se seleccionó después", async () => {
  const first = deferred(); let firstSignal;
  const h = wall({ readApprovalCredit: (id, signal) => id === 81 ? (firstSignal = signal, first.promise) : Promise.resolve(detail(id)) });
  await h.flush(); select(h, 81); await h.flush(); select(h, 82); await h.flush();
  assert.equal(firstSignal.aborted, true);
  first.resolve(detail(81)); await h.flush();
  assert.equal(current(h).detail.id, 82);
  approveButton(h).props.onClick(); await h.flush();
  assert.match(confirm(h).props.description, /QA-82/);
  h.unmount();
});

test("abrir un formulario aborta el refresco en vuelo y conserva la revisión observada", async () => {
  const background = deferred(); let calls = 0, backgroundSignal;
  const h = wall({ readApprovalCredit: (id, signal) => ++calls === 1 ? Promise.resolve(detail(id)) : (backgroundSignal = signal, background.promise) });
  await h.flush(); select(h, 81); await h.flush(); h.focus(); await h.flush();
  current(h).onBusyChange(true); await h.flush();
  assert.equal(backgroundSignal.aborted, true);
  background.resolve(detail(81, 2)); await h.flush();
  assert.equal(current(h).detail.review.revision, 1);
  assert.equal(approveButton(h).props.disabled, true);
  h.unmount();
});

test("el refresco en segundo plano espera una ficha manual en vuelo antes de consultar una nueva versión", async () => {
  const manual = deferred(); let calls = 0;
  const h = wall({ readApprovalCredit: () => ++calls === 1 ? manual.promise : Promise.resolve(detail(81, 2)) });
  await h.flush(); select(h, 81); await h.flush(); h.focus(); await h.flush();
  assert.equal(calls, 1, "La ficha manual y el auto-refresh no deben competir por la misma selección");
  manual.resolve(detail(81)); await h.flush();
  h.focus(); await h.flush();
  assert.equal(current(h).detail.review.revision, 2);
  assert.equal(approveButton(h).props.disabled, true, "La versión nueva requiere revisar de nuevo");
  h.unmount();
});

test("una capacidad de firma cambia en el refresco aunque revisión y hash sigan iguales", async () => {
  let fresh = detail(81);
  const h = wall({ readApprovalCredit: async () => fresh });
  await h.flush(); select(h, 81); await h.flush();
  assert.equal(approveButton(h).props.disabled, false);
  fresh = { ...fresh, canApprove: false, blockingReasons: ["Firma en proceso"],
    capabilities: { ...fresh.capabilities, canCreateNovelty: false, canCorrectEvidence: false, canReissueSignature: false },
    reissue: { available: true, blocked: true, operation: { id: "refirma", status: "PREPARING" } } };
  h.focus(); await h.flush();
  assert.equal(current(h).detail.reissue.blocked, true);
  assert.equal(current(h).detail.canApprove, false);
  assert.equal(approveButton(h).props.disabled, true);
  assert.equal(h.all((node) => node.type === "input" && node.props.type === "checkbox").length, 0, "Un cambio de capacidad no inventa revisión documental");
  fresh = detail(81); h.focus(); await h.flush();
  assert.equal(current(h).detail.reissue.blocked, false);
  assert.equal(approveButton(h).props.disabled, false);
  h.unmount();
});

test("la corrección recibida exige revisar la nueva versión y un solo OK quita el crédito del muro", async () => {
  let fresh = { ...detail(81), canApprove: false, blockingReasons: ["Foto pendiente del aliado"] };
  let queue = [row(81), row(82)]; const approvals = [];
  const h = wall({ readApprovalQueue: async () => page(queue), readApprovalCredit: async () => fresh,
    approveCreditReview: async (...args) => { approvals.push(args); queue = queue.filter((item) => item.id !== args[0]); return { ok: true }; } });
  await h.flush(); select(h, 81); await h.flush(); assert.equal(approveButton(h).props.disabled, true);
  fresh = detail(81, 2); h.focus(); await h.flush();
  assert.equal(approveButton(h).props.disabled, true);
  h.find((node) => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  await h.flush(); assert.equal(approveButton(h).props.disabled, false);
  approveButton(h).props.onClick(); await h.flush();
  const approve = confirm(h).props.onConfirm; approve(); approve(); await h.flush();
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0], [81, 2, "2".repeat(64), "call-2"]);
  assert.equal(h.all((node) => node.props?.["aria-label"] === "Revisar crédito QA-81").length, 0);
  assert.equal(h.all((node) => node.type === parts.ApprovalNoveltyPanel).length, 0);
  h.unmount();
});

test("un conflicto recarga la ficha y no vuelve a aprobar sin revisión y confirmación nuevas", async () => {
  let fresh = detail(81); let approvals = 0;
  const h = wall({ readApprovalCredit: async () => fresh, approveCreditReview: async () => {
    approvals++; fresh = detail(81, 2); throw new client.ApprovalRequestError("Cambió la foto", 409);
  } });
  await h.flush(); select(h, 81); await h.flush(); approveButton(h).props.onClick(); await h.flush();
  confirm(h).props.onConfirm(); await h.flush();
  assert.equal(approvals, 1); assert.equal(current(h).detail.review.revision, 2);
  assert.equal(confirm(h).props.open, false); assert.equal(approveButton(h).props.disabled, true);
  assert.equal(h.find((node) => node.type === "input" && node.props.type === "checkbox").props.checked, false);
  h.unmount();
});

test("si no se puede comprobar la ficha conserva selección pero bloquea el OK", async () => {
  let fail = false;
  const h = wall({ readApprovalCredit: async () => { if (fail) throw new Error("Sin conexión"); return detail(81); } });
  await h.flush(); select(h, 81); await h.flush(); fail = true;
  h.find((node) => node.type === ui.Button && node.props.children?.some?.((child) => child === "Actualizar expediente")).props.onClick();
  await h.flush();
  assert.equal(current(h).detail.id, 81); assert.equal(approveButton(h).props.disabled, true);
  assert.equal(current(h).disabled, true);
  h.unmount();
});

test("guardar desde PENDIENTES refresca automáticamente y bloquea solo la foto respondida", async () => {
  const open = { id: "photo-1", key: "foto-entrega", label: "Foto entrega", status: "OPEN", version: 1, reason: "Foto incompleta" };
  const second = { ...open, id: "photo-2", key: "foto-remision", label: "Foto remisión" };
  let fresh = { ...row(81), sedeNombre: "Sede QA", canRespond: true, blockedReason: null,
    novelty: { id: "case-1", status: "WAITING_ALLY", version: 1, pendingCount: 2, answeredCount: 0, items: [open, second] } };
  let reads = 0, lists = 0;
  const h = mount("app/dashboard/pendientes/pending-console.tsx", {
    "./pending-client": { ...pendingClient, listPendingCredits: async () => { lists++; return page([fresh]); },
      readPendingCredit: async () => { reads++; return fresh; } },
    "./pending-item-editor": { default: parts.PendingItemEditor },
  });
  await h.flush(); h.find((node) => node.props?.["aria-label"] === "Ver novedades del crédito QA-81").props.onClick(); await h.flush();
  const editor = h.find((node) => node.type === parts.PendingItemEditor && node.props.issue.id === "photo-1");
  editor.props.onBusyChange("photo-1", true); await h.flush();
  fresh = { ...fresh, novelty: { ...fresh.novelty, version: 2, pendingCount: 1, answeredCount: 1,
    items: [{ ...open, version: 2, status: "RESPONDED" }, second] } };
  await editor.props.onUpdated("Foto guardada: vuelve al analista"); await h.flush();
  // Child cleanup after its key changes releases the parent's draft lock.
  editor.props.onBusyChange("photo-1", false); await h.flush();
  assert.equal(reads, 2); assert.equal(lists, 2);
  const editors = h.all((node) => node.type === parts.PendingItemEditor);
  const answered = editors.find((node) => node.props.issue.id === "photo-1").props;
  const remaining = editors.find((node) => node.props.issue.id === "photo-2").props;
  assert.equal(pendingClient.canRespondToPendingIssue(answered.detail, answered.issue), false);
  assert.equal(pendingClient.canRespondToPendingIssue(remaining.detail, remaining.issue), true);
  assert.equal(remaining.disabled, false);
  assert.equal(remaining.detail.novelty.pendingCount, 1);
  h.unmount();
});


const metricValues = (h) => Object.fromEntries(h.all((node) => node.type === ui.MetricCard).map(({ props }) => [props.label, props]));

test("el resumen muestra contacto y valores del crédito sin cupo ni porcentaje de oferta", async () => {
  const summary = { ...detail(81), clienteNombre: "Cliente de prueba", clienteDocumento: "1030000001",
    clienteCorreo: "cliente@example.test", clienteTelefono: "+57 300 000 0001", clienteDireccion: "Carrera 7 # 10-20", score: 720,
    valorVenta: 1500000, cuotaInicial: 300000, creditoAutorizado: 1200000, approvedLimit: 6000000,
    numeroCuotas: 12, frecuenciaPago: "QUINCENAL", valorCuota: 137500, fechaPrimerPago: "2026-09-10" };
  const h = wall({ readApprovalCredit: async () => summary });
  try {
    await h.flush(); select(h, 81); await h.flush();
    assert.equal(h.find((node) => node.type === "h2" && node.props.children === "Cliente de prueba").props.children, summary.clienteNombre);
    assert.deepEqual(h.all((node) => node.type === "dt").map((node) => node.props.children), ["Cédula", "Correo", "Teléfono", "Dirección"]);
    assert.deepEqual(h.all((node) => node.type === "dd").map((node) => node.props.children), ["1030000001", "cliente@example.test", "+57 300 000 0001", "Carrera 7 # 10-20"]);
    const metrics = metricValues(h);
    assert.deepEqual(Object.keys(metrics), ["Score", "Valor de venta", "Inicial", "Crédito autorizado", "Plazo de financiación", "Valor de cuota", "Fecha de primer pago"]);
    assert.equal(metrics.Score.value, 720);
    const amount = (label) => metrics[label].value.replace(/\s+/g, " ");
    assert.equal(amount("Valor de venta"), "$ 1.500.000");
    assert.equal(amount("Inicial"), "$ 300.000");
    assert.equal(amount("Crédito autorizado"), "$ 1.200.000");
    assert.equal(amount("Valor de cuota"), "$ 137.500");
    assert.equal(metrics["Inicial"].detail, undefined);
    assert.equal(metrics["Plazo de financiación"].value, "12 cuotas");
    assert.equal(metrics["Plazo de financiación"].detail, "Frecuencia: Quincenal");
    assert.equal(metrics["Fecha de primer pago"].value, "10/09/2026");
    assert.equal(approveButton(h).props.disabled, false, "Los datos del resumen no cambian el flujo de aprobación");
  } finally { h.unmount(); }
});

test("el resumen distingue datos ausentes y conserva una inicial de cero", async () => {
  const h = wall({ readApprovalCredit: async () => ({ ...detail(81), clienteNombre: " ", clienteDocumento: null,
    clienteCorreo: "  ", clienteTelefono: null, clienteDireccion: " ", score: null, scoreLabel: null, valorVenta: null,
    cuotaInicial: 0, creditoAutorizado: null, numeroCuotas: null, frecuenciaPago: null, valorCuota: null, fechaPrimerPago: null }) });
  try {
    await h.flush(); select(h, 81); await h.flush();
    assert.ok(h.find((node) => node.type === "h2" && node.props.children === "No disponible"));
    assert.deepEqual(h.all((node) => node.type === "dd").map((node) => node.props.children), Array(4).fill("No disponible"));
    const metrics = metricValues(h);
    for (const label of ["Score", "Valor de venta", "Crédito autorizado", "Plazo de financiación", "Valor de cuota", "Fecha de primer pago"]) {
      assert.equal(metrics[label].value, "No disponible", label);
    }
    assert.equal(metrics["Inicial"].value.replace(/\s+/g, " "), "$ 0");
    assert.equal(metrics["Plazo de financiación"].detail, "Frecuencia: No disponible");
  } finally { h.unmount(); }
});

test("el plazo usa las frecuencias registradas y no asigna una frecuencia a un valor desconocido", async () => {
  for (const [value, label] of [["SEMANAL", "Semanal"], ["CATORCENAL", "Catorcenal"], ["QUINCENAL", "Quincenal"], ["MENSUAL", "Mensual"], ["DESCONOCIDA", "No disponible"]]) {
    const h = wall({ readApprovalCredit: async () => ({ ...detail(81), numeroCuotas: 1, frecuenciaPago: value }) });
    try {
      await h.flush(); select(h, 81); await h.flush();
      const metric = metricValues(h)["Plazo de financiación"];
      assert.equal(metric.value, "1 cuota");
      assert.equal(metric.detail, "Frecuencia: " + label);
    } finally { h.unmount(); }
  }
});

test("el primer pago conserva su día calendario UTC y rechaza fechas inexistentes", async () => {
  for (const [date, expected] of [["2028-02-29", "29/02/2028"], ["2026-01-01", "01/01/2026"], ["2026-02-29", "No disponible"], ["fecha-inválida", "No disponible"]]) {
    const h = wall({ readApprovalCredit: async () => ({ ...detail(81), fechaPrimerPago: date }) });
    try {
      await h.flush(); select(h, 81); await h.flush();
      assert.equal(metricValues(h)["Fecha de primer pago"].value, expected, date);
    } finally { h.unmount(); }
  }
});

const tab = (h, view) => h.find((node) => node.props?.id === "approval-tab-" + view);
const callCard = (h) => h.find((node) => node.type === parts.ApprovalCallRecording);

test("sin grabación no permite confirmar aunque los demás documentos estén completos", async () => {
  let fresh = detail(81); fresh.callRecording.recording = null;
  const h = wall({ readApprovalCredit: async () => fresh });
  try {
    await h.flush(); select(h, 81); await h.flush();
    assert.equal(approveButton(h).props.disabled, true);
    approveButton(h).props.onClick(); await h.flush(); assert.equal(confirm(h).props.open, false);
    fresh = detail(81); await callCard(h).props.onUpdated(); await h.flush();
    assert.equal(approveButton(h).props.disabled, false);
    assert.equal(confirm(h).props.open, false, "Cargar el audio no confirma por sí solo");
  } finally { h.unmount(); }
});

test("una grabación en preparación bloquea pestañas, novedades y OK", async () => {
  const h = wall();
  try {
    await h.flush(); select(h, 81); await h.flush();
    callCard(h).props.onBusyChange(true); await h.flush();
    assert.equal(tab(h, "approved").props.disabled, true);
    assert.equal(current(h).disabled, true);
    assert.equal(approveButton(h).props.disabled, true);
    tab(h, "approved").props.onClick(); await h.flush();
    assert.equal(tab(h, "pending").props["aria-selected"], true);
    callCard(h).props.onBusyChange(false); await h.flush();
    assert.equal(tab(h, "approved").props.disabled, false);
  } finally { h.unmount(); }
});

test("Aprobadas abre un OK vigente en lectura, incluso anterior sin audio", async () => {
  let approved = detail(81); approved.review = { ...approved.review, status: "APPROVED", approvedAt: "2026-09-09T12:00:00Z", approvedByName: "Analista QA" };
  approved.callRecording = { ...approved.callRecording, recording: null, canUpload: false, required: false };
  const queries = [];
  const h = wall({ readApprovalQueue: async (cursor, signal, view) => { queries.push(view); return page(view === "approved" ? [{ ...row(81), status: "APPROVED", approvedAt: approved.review.approvedAt, paid: true }] : []); }, readApprovalCredit: async () => approved });
  try {
    await h.flush(); tab(h, "approved").props.onClick(); await h.flush();
    assert.deepEqual(queries, ["pending", "approved"]);
    h.find((node) => node.props?.["aria-label"] === "Ver crédito QA-81").props.onClick(); await h.flush();
    assert.equal(callCard(h).props.readOnly, true);
    assert.equal(callCard(h).props.detail.review.status, "APPROVED");
    assert.equal(h.all((node) => [parts.ApprovalNoveltyPanel, parts.ApprovalEvidenceCorrection, parts.ApprovalSignatureReissue].includes(node.type)).length, 0);
    assert.equal(h.all((node) => node.type === ui.Button && node.props.onClick?.name === "requestApproval").length, 0);
    approved = detail(81); h.focus(); await h.flush();
    assert.equal(h.all((node) => node.type === parts.ApprovalCallRecording).length, 0, "El OK invalidado deja Aprobadas");
    assert.equal(h.all((node) => node.props?.["aria-label"] === "Ver crédito QA-81").length, 0, "Retira también la fila aunque el listado previo aún la incluyera");
  } finally { h.unmount(); }
});

test("cambiar pestaña aborta una ficha pendiente y no mezcla respuestas atrasadas", async () => {
  const stale = deferred(); let signal;
  const h = wall({ readApprovalQueue: async (cursor, abort, view) => page(view === "approved" ? [] : [row(81)]),
    readApprovalCredit: (id, abort) => { signal = abort; return stale.promise; } });
  try {
    await h.flush(); select(h, 81); await h.flush(); tab(h, "approved").props.onClick(); await h.flush();
    assert.equal(signal.aborted, true);
    stale.resolve(detail(81)); await h.flush();
    assert.equal(tab(h, "approved").props["aria-selected"], true);
    assert.equal(h.all((node) => node.type === parts.ApprovalCallRecording).length, 0);
  } finally { h.unmount(); }
});

test("el formulario guarda audio por acción explícita y conserva la operación si la respuesta se pierde", async () => {
  const calls = [], locks = []; let updates = 0, fail = true;
  const h = mount("app/dashboard/aprobaciones/approval-call-recording.tsx", {
    "./approval-client": { uploadApprovalCallRecording: async (id, data) => {
      calls.push({ id, data }); if (fail) throw new Error("Respuesta perdida"); return { ok: true };
    } },
  }, { detail: detail(81), disabled: false, onUpdated: async () => { updates++; }, onBusyChange: (busy) => locks.push(busy) });
  try {
    await h.flush();
    const file = new File(["audio"], "llamada.wav", { type: "audio/wav" });
    h.find((node) => node.type === "input" && node.props.type === "file").props.onChange({ target: { files: [file] } }); await h.flush();
    assert.equal(calls.length, 0); assert.equal(locks.at(-1), true);
    const save = () => h.find((node) => node.type === ui.Button && node.props.children?.includes("Guardar grabación")).props.onClick();
    save(); await h.flush();
    assert.equal(updates, 1); assert.equal(calls.length, 1); assert.equal(locks.at(-1), true);
    fail = false; save(); await h.flush();
    assert.equal(calls[0].data.idempotencyKey, calls[1].data.idempotencyKey);
    assert.equal(calls[0].data.file, file); assert.equal(updates, 2); assert.equal(locks.at(-1), false);
  } finally { h.unmount(); }
});

test("si pierde permiso de carga durante un error conserva una salida para actualizar el expediente", async () => {
  const observed = detail(81), locks = [];
  const h = mount("app/dashboard/aprobaciones/approval-call-recording.tsx", {
    "./approval-client": { uploadApprovalCallRecording: async () => { throw new Error("Firma en proceso"); } },
  }, { detail: observed, disabled: false, onUpdated: async () => { observed.callRecording.canUpload = false; }, onBusyChange: (busy) => locks.push(busy) });
  try {
    await h.flush(); h.find((node) => node.type === "input" && node.props.type === "file").props.onChange({ target: { files: [new File(["audio"], "llamada.wav")] } });
    await h.flush(); h.find((node) => node.type === ui.Button && node.props.children?.includes("Guardar grabación")).props.onClick(); await h.flush();
    const cancel = h.find((node) => node.type === ui.Button && node.props.children === "Cancelar");
    assert.equal(cancel.props.disabled, false); cancel.props.onClick(); await h.flush(); assert.equal(locks.at(-1), false);
  } finally { h.unmount(); }
});

test("la grabación aprobada puede reintentarse tras un error sin modificar la aprobación", async () => {
  const h = mount("app/dashboard/aprobaciones/approval-call-recording.tsx", { "./approval-client": {} },
    { detail: detail(81), disabled: false, readOnly: true, onUpdated: async () => {}, onBusyChange: () => {} });
  try {
    await h.flush(); const audio = h.find((node) => node.type === "audio");
    audio.props.onError(); await h.flush();
    h.find((node) => node.type === ui.Button && node.props.children === "Reintentar reproducción").props.onClick(); await h.flush();
    const retry = h.find((node) => node.type === "audio");
    assert.notEqual(retry.key, audio.key); assert.equal(retry.props.src, audio.props.src);
    assert.equal(h.all((node) => node.type === "input").length, 0);
  } finally { h.unmount(); }
});
const sharedProps = (h) => h.find(node => node.type === parts.SharedApprovalWorkspace).props;
const countedPage = (items, extra = {}) => ({ ...page(items), counts: { pending: 3, approved: 2 }, ...extra });

test("el panel administrativo usa el muro rediseñado y conserva la autoría personal", async () => {
  const calls = [];
  const h = wall({ readApprovalQueue: async (cursor, signal, view, options) => {
    calls.push({ cursor, view, options }); return countedPage([row(81)]);
  } }, { redesigned: true });
  await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), { query: "", counts: true });
  sharedProps(h).onSelect(81); await h.flush();
  assert.equal(sharedProps(h).signaturePanel.props.sharedAccess, false);
  assert.equal(sharedProps(h).noveltyPanel.props.compact, true);
  const ok = subtree(sharedProps(h).approvalPanel).find(node => node.type === ui.Button && node.props.onClick?.name === "requestApproval");
  ok.props.onClick(); await h.flush();
  assert.match(sharedProps(h).confirmationDialog.props.description, /registrado con tu usuario/);
  assert.doesNotMatch(sharedProps(h).confirmationDialog.props.description, /registrado por este acceso/);
  h.unmount();
});

test("el enlace compartido mantiene la autoría del acceso en el mismo diseño", async () => {
  const h = wall({ readApprovalQueue: async () => countedPage([row(81)]) }, { shared: true });
  await h.flush(); sharedProps(h).onSelect(81); await h.flush();
  assert.equal(sharedProps(h).signaturePanel.props.sharedAccess, true);
  const ok = subtree(sharedProps(h).approvalPanel).find(node => node.type === ui.Button && node.props.onClick?.name === "requestApproval");
  ok.props.onClick(); await h.flush();
  assert.match(sharedProps(h).confirmationDialog.props.description, /registrado por este acceso/);
  h.unmount();
});

test("el muro compartido busca en servidor y conserva el filtro al seleccionar y cambiar de vista", async () => {
  const calls = [];
  const h = wall({ readApprovalQueue: async (cursor, signal, view, options) => { calls.push({ cursor, view, options }); return countedPage(view === "approved" ? [] : [row(81), row(82)]); } }, { shared: true });
  await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), { query: "", counts: true });
  sharedProps(h).onSearch("Aliado QA"); await h.flush();
  assert.equal(calls.at(-1).options.query, "Aliado QA");
  sharedProps(h).onSelect(82); await h.flush();
  assert.equal(sharedProps(h).detail.id, 82);
  assert.equal(sharedProps(h).query, "Aliado QA");
  sharedProps(h).onView("approved"); await h.flush();
  assert.equal(sharedProps(h).query, "Aliado QA"); assert.equal(sharedProps(h).selectedId, null);
  assert.equal(calls.at(-1).view, "approved"); h.unmount();
});

test("una grabación o novedad pendiente impide cambiar selección, filtros y volver a la lista compartida", async () => {
  const h = wall({ readApprovalQueue: async () => countedPage([row(81), row(82)]) }, { shared: true });
  await h.flush(); sharedProps(h).onSelect(81); await h.flush();
  for (const panel of ["callPanel", "noveltyPanel"]) {
    sharedProps(h)[panel].props.onBusyChange(true); await h.flush();
    assert.equal(sharedProps(h).busy, true);
    sharedProps(h).onSelect(82); sharedProps(h).onView("approved"); sharedProps(h).onSearch("Otro"); sharedProps(h).onBack(); await h.flush();
    assert.equal(sharedProps(h).selectedId, 81); assert.equal(sharedProps(h).view, "pending"); assert.equal(sharedProps(h).query, "");
    sharedProps(h)[panel].props.onBusyChange(false); await h.flush();
  }
  h.unmount();
});

test("actualizar el muro compartido conserva páginas cargadas y expediente seleccionado", async () => {
  const cursors = [];
  const h = wall({ readApprovalQueue: async cursor => { cursors.push(cursor); return cursor ? countedPage([row(82)]) : countedPage([row(81)], { nextCursor: "next-page", hasMore: true }); } }, { shared: true });
  await h.flush(); sharedProps(h).onMore(); await h.flush();
  assert.deepEqual(Array.from(sharedProps(h).items, item => item.id), [81, 82]);
  sharedProps(h).onSelect(82); await h.flush(); sharedProps(h).onRefresh(); await h.flush();
  assert.equal(sharedProps(h).selectedId, 82); assert.equal(sharedProps(h).detail.id, 82);
  assert.deepEqual(Array.from(sharedProps(h).items, item => item.id), [81, 82]);
  assert.deepEqual(cursors, [null, "next-page", null, "next-page"]); h.unmount();
});

test("cambiar la búsqueda compartida aborta la ficha anterior y descarta su respuesta tardía", async () => {
  const pending = deferred(); let signal;
  const h = wall({ readApprovalQueue: async () => countedPage([row(81)]), readApprovalCredit: (id, incoming) => { signal = incoming; return pending.promise; } }, { shared: true });
  await h.flush(); sharedProps(h).onSelect(81); await h.flush();
  sharedProps(h).onSearch("Otro aliado"); await h.flush(); assert.equal(signal.aborted, true);
  pending.resolve(detail(81)); await h.flush(); assert.equal(sharedProps(h).detail, null); assert.equal(sharedProps(h).selectedId, null); h.unmount();
});

function subtree(node) {
  if (Array.isArray(node)) return node.flatMap(subtree);
  if (!node || typeof node !== "object") return [];
  return [node, ...subtree(node.props?.children)];
}
test("actualizar manualmente una nueva revisión compartida exige confirmar la relectura", async () => {
  let currentDetail = detail(81);
  const h = wall({ readApprovalQueue: async () => countedPage([row(81)]), readApprovalCredit: async () => currentDetail }, { shared: true });
  await h.flush(); sharedProps(h).onSelect(81); await h.flush();
  const ok = () => subtree(sharedProps(h).approvalPanel).find(node => node.type === ui.Button && node.props.onClick?.name === "requestApproval");
  assert.equal(ok().props.disabled, false);
  currentDetail = detail(81, 2); sharedProps(h).onRefresh(); await h.flush();
  assert.equal(sharedProps(h).detail.review.revision, 2); assert.equal(ok().props.disabled, true);
  const rereview = subtree(sharedProps(h).approvalPanel).find(node => node.type === "input" && node.props.type === "checkbox");
  assert.ok(rereview); rereview.props.onChange({ target: { checked: true } }); await h.flush();
  assert.equal(ok().props.disabled, false); h.unmount();
});

test("actualizar Aprobadas conserva la selección y actualiza la marca de liquidado", async () => {
  let paid = false;
  const approved = { ...detail(81), review: { ...detail(81).review, status: "APPROVED" } };
  const h = wall({ readApprovalQueue: async (cursor, signal, view) => countedPage(view === "approved" ? [{ ...row(81), status: "APPROVED", paid }] : []), readApprovalCredit: async () => approved }, { shared: true });
  await h.flush(); sharedProps(h).onView("approved"); await h.flush(); sharedProps(h).onSelect(81); await h.flush();
  assert.equal(sharedProps(h).selectedItem.paid, false);
  paid = true; sharedProps(h).onRefresh(); await h.flush();
  assert.equal(sharedProps(h).selectedId, 81); assert.equal(sharedProps(h).selectedItem.paid, true); h.unmount();
});

test("una novedad compartida conserva el borrador y reintenta exactamente la operación incierta", async () => {
  const calls = [], locks = []; let fail = true;
  const observed = detail(81);
  const h = mount("app/dashboard/aprobaciones/approval-novelty-panel.tsx", {
    "./approval-client": { createApprovalNovelty: async (id, input) => { calls.push({ id, input }); if (fail) throw new Error("Respuesta perdida"); return { ok: true }; } },
    "@/app/_components/finser-confirm-dialog": { default: parts.ConfirmDialog },
  }, { detail: observed, compact: true, onBusyChange: busy => locks.push(busy), onUpdated: async () => { observed.review = { ...observed.review, revision: 2, reviewHash: "2".repeat(64) }; } });
  await h.flush();
  h.find(node => node.type === ui.Button && node.props.onClick?.name === "open").props.onClick(); await h.flush();
  h.find(node => node.type === ui.Select).props.onChange({ target: { value: "GENERAL" } });
  h.find(node => node.type === "textarea").props.onChange({ target: { value: "Confirmar información con el cliente" } }); await h.flush();
  const submit = label => h.find(node => node.type === ui.Button && node.props.children === label).props.onClick();
  submit("Guardar y enviar al aliado"); await h.flush();
  h.find(node => node.type === parts.ConfirmDialog).props.onConfirm(); await h.flush();
  assert.equal(h.find(node => node.type === "textarea").props.value, "Confirmar información con el cliente");
  assert.equal(h.find(node => node.type === "textarea").props.disabled, true); assert.equal(locks.at(-1), true); assert.equal(calls.length, 1);
  fail = false; submit("Reintentar confirmación"); await h.flush(); h.find(node => node.type === parts.ConfirmDialog).props.onConfirm(); await h.flush();
  assert.equal(calls.length, 2); assert.equal(calls[0].input, calls[1].input); assert.equal(calls[1].input.revision, 1); assert.equal(locks.at(-1), false); h.unmount();
});
