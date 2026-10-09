import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../app/enrolamiento-iphone/iphone-enrollment-portal.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

const submitted = { document: "1001234567", imei: "351168083278358" };
const candidate = (patch = {}) => ({
  source: "APPLICATION", sourceId: "74", solicitudId: 74, solicitudNumero: "SOL-000074", creditoId: null, creditoFolio: null,
  clienteNombre: "Cliente guardado", document: "1001234567", imei: "351168083278358", currentStep: 4,
  stepLabel: "Identidad y firma", status: "ABIERTO", platform: "IPHONE", matchedBy: "BOTH",
  updatedAt: "2026-10-09T17:15:00Z", pendingReason: "La solicitud está en Identidad y firma. Todavía no está en Enrolamiento y entrega.", ...patch,
});

function harness({ mode = "ANALYST", lookup, sessionStatus = 200, initialDocument = submitted.document, initialImei = submitted.imei } = {}) {
  const components = Object.fromEntries(["Badge", "Button", "Card", "EmptyState", "Input", "LoadingState", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null, FinserBrand = () => null, Image = () => null;
  const stubComponents = new Set([...Object.values(components), ConfirmDialog, FinserBrand, Image]);
  const node = (type, props) => typeof type === "function" && !stubComponents.has(type) ? type(props) :
    type === ConfirmDialog && !props.open ? null : ({ type, props: type === components.EmptyState ? { ...props, children: [props.title, props.description] } : props });
  const slots = [], effects = [], requests = [], historyReplacements = [];
  let cursor = 0, dirty = false, tree;
  const same = (before, after) => before?.length === after?.length && before.every((value, index) => Object.is(value, after[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++; slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) dirty = true;
        slots[index].value = next;
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const previous = slots[index]; slots[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const item = { solicitudId: 74, solicitudNumero: "SOL-000074", clienteNombre: "Cliente guardado", documento: submitted.document,
    imei: submitted.imei, equipo: "IPHONE 13 128GB", sede: "Sede principal", aliado: "Aliado de prueba", creditDecision: "APROBADA", enrollmentStatus: "LISTO_PARA_ENROLAR", review: null };
  const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, URLSearchParams, Intl, Date, Error,
    document: { activeElement: null, body: { style: { overflow: "" } } },
    window: { location: { hash: "#acceso=shared-token", pathname: "/dashboard/aprobaciones/enrolamiento", search: "" }, history: { replaceState: (...args) => historyReplacements.push(args) },
      requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options, ...(options.body ? { payload: JSON.parse(options.body) } : {}) });
      if (url.endsWith("/session") || url.endsWith("/access")) return response(sessionStatus, sessionStatus === 200 ? {
        ok: true, authorized: true, analyst: { name: "Analista nominal", externalId: "USER-17" },
      } : { ok: false, error: "La cuenta no está autorizada." });
      if (url.endsWith("/cases")) return lookup ? response(lookup.status, lookup.payload) : response(200, { ok: true, item, caseToken: "case-token-for-test" });
      if (url.endsWith("/cases/approve")) return response(200, { ok: true, review: {
        id: "review-74", decision: "APROBADO", analystName: "Analista nominal", analystExternalId: "USER-17", approvedAt: "2026-10-09T18:00:00Z", checklistVersion: "v1",
      } });
      throw new Error("Petición inesperada: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "react-dom") return { createPortal: content => content };
      if (name === "next/image") return { default: Image };
      if (name === "next/link") return { default: props => node("a", props) };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-brand") return { default: FinserBrand };
      if (name === "@/app/_components/finser-confirm-dialog") return { default: ConfirmDialog };
      if (name === "@/app/_components/finser-ui") return components;
      throw new Error("Importación inesperada: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" || typeof value === "number" ? String(value) : value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => {
    let count = 0;
    do {
      dirty = false; cursor = 0; tree = loadedModule.exports.default({ mode, initialDocument, initialImei }); effects.splice(0).forEach(callback => callback());
      if (++count > 20) throw new Error("Render no estable");
    } while (dirty);
    return tree;
  };
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(value => value.type === components.Button && text(value.props.children).trim() === label);
  const input = field => find(value => value.type === components.Input && value.props["aria-describedby"] === `iphone-enrollment-${field}-help`);
  const change = (field, value) => { const control = input(field); assert.ok(control); control.props.onChange({ target: { value } }); render(); };
  const settle = async () => { for (let index = 0; index < 4; index++) { await setImmediate(); render(); } };
  const open = async () => { render(); await settle(); };
  const search = async () => { const form = find(value => value.type === "form"); assert.ok(form); await form.props.onSubmit({ preventDefault() {} }); await settle(); };
  const checkAll = () => { nodes(tree).filter(value => value.type === "input" && value.props.type === "checkbox").forEach(control => control.props.onChange({ target: { checked: true } })); render(); };
  const progress = () => find(value => value.type === "li" && value.props["aria-current"] === "step");
  return { open, search, button, input, change, checkAll, settle, render, progress, requests, historyReplacements, find, nodes: () => nodes(tree), text: () => text(tree), ConfirmDialog, FinserBrand };
}

test("el portal nominal verifica cuenta por API privada, conserva la precarga y no consulta automáticamente", async () => {
  const ui = harness(); await ui.open();
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].url, "/api/aprobaciones/enrolamiento/session");
  assert.equal(ui.requests[0].method, "POST"); assert.deepEqual(ui.requests[0].payload, {});
  assert.equal(ui.historyReplacements.length, 0, "no consume ni modifica el fragmento del acceso compartido");
  assert.equal(ui.input("document").props.value, submitted.document); assert.equal(ui.input("imei").props.value, submitted.imei);
  assert.equal(ui.find(value => value.type === ui.FinserBrand), undefined);
  assert.equal(ui.button("Cerrar sesión"), undefined);
  assert.match(ui.text(), /Consulta pendiente/);
});

test("el modo público conserva su cabecera y acceso compartido originales", async () => {
  const ui = harness({ mode: "PUBLIC" }); await ui.open();
  assert.equal(ui.requests[0].url, "/api/public/iphone-enrollment/access");
  assert.deepEqual(ui.requests[0].payload, { token: "shared-token" }); assert.equal(ui.historyReplacements.length, 1);
  assert.ok(ui.find(value => value.type === ui.FinserBrand)); assert.ok(ui.button("Cerrar sesión"));
});

test("una cuenta nominal rechazada no ofrece buscar ni aprobar y no pide un enlace compartido", async () => {
  const ui = harness({ sessionStatus: 403 }); await ui.open();
  assert.equal(ui.input("document"), undefined); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
  assert.doesNotMatch(ui.text(), /enlace compartido|Acceso compartido requerido/);
});

test("un diagnóstico exacto muestra etapa y valores guardados junto con los datos consultados sin habilitar aprobación", async () => {
  const ui = harness({ lookup: { status: 404, payload: { ok: false, error: "La solicitud no está lista para enrolamiento.", submitted,
    diagnostics: { kind: "EXACT_MATCH", candidates: [candidate()], hasMore: false } } } });
  await ui.open(); await ui.search();
  assert.equal(ui.requests[1].url, "/api/aprobaciones/enrolamiento/cases"); assert.deepEqual(ui.requests[1].payload, submitted);
  for (const value of [submitted.document, submitted.imei, "SOL-000074", "Cliente guardado", "Identidad y firma", "En proceso", "IPHONE"]) assert.ok(ui.text().includes(value), value);
  assert.match(ui.text(), /La solicitud está en Identidad y firma/);
  assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
  assert.equal(ui.nodes().some(value => value.type === "input" && value.props.type === "checkbox"), false);
  assert.equal(ui.find(value => value.type === ui.ConfirmDialog), undefined);
  assert.ok(ui.find(value => value.type === "a" && value.props.href === "/dashboard/aprobaciones/solicitudes/D-74"), "abre el borrador con el identificador de solicitud permitido");
});

test("un diagnóstico de diferencia mantiene visibles cédula e IMEI enviados y los valores reales de cada coincidencia", async () => {
  const candidates = [candidate({ imei: "351168083278999", matchedBy: "DOCUMENT" }),
    candidate({ sourceId: "75", solicitudId: 75, solicitudNumero: "SOL-000075", document: "0099887766", clienteNombre: "Otra cliente", matchedBy: "IMEI", currentStep: 2, stepLabel: "Equipo", pendingReason: "La solicitud está en Equipo." })];
  const ui = harness({ lookup: { status: 404, payload: { ok: false, error: "La cédula y el IMEI no coinciden.", submitted, diagnostics: { kind: "MISMATCH", candidates, hasMore: false } } } });
  await ui.open(); await ui.search();
  for (const value of [submitted.document, submitted.imei, "351168083278999", "0099887766", "SOL-000074", "SOL-000075", "Equipo"]) assert.ok(ui.text().includes(value), value);
  assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
});

test("la falta de coincidencias informa los identificadores enviados sin acciones de aprobación", async () => {
  const ui = harness({ lookup: { status: 404, payload: { ok: false, error: "No se encontró una solicitud con esos datos.", submitted, diagnostics: { kind: "NOT_FOUND", candidates: [], hasMore: false } } } });
  await ui.open(); await ui.search();
  assert.ok(ui.text().includes(submitted.document)); assert.ok(ui.text().includes(submitted.imei));
  assert.match(ui.text(), /No se encontró/); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
});

for (const field of ["document", "imei"]) {
  test(`cambiar ${field} elimina el diagnóstico anterior y exige consultar de nuevo`, async () => {
    const ui = harness({ lookup: { status: 404, payload: { ok: false, error: "Etapa pendiente", submitted, diagnostics: { kind: "EXACT_MATCH", candidates: [candidate()], hasMore: false } } } });
    await ui.open(); await ui.search(); assert.ok(ui.text().includes("SOL-000074"));
    ui.change(field, field === "document" ? "0099887766" : "351168083278999");
    assert.doesNotMatch(ui.text(), /SOL-000074|Cliente guardado|Etapa pendiente/); assert.match(ui.text(), /Consulta pendiente/);
    assert.equal(ui.requests.length, 2); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
  });
}

test("los resultados diagnósticos nunca aparecen en el portal público aunque una respuesta los incluya", async () => {
  const ui = harness({ mode: "PUBLIC", lookup: { status: 404, payload: { ok: false, error: "Consulta no disponible", submitted,
    diagnostics: { kind: "MISMATCH", candidates: [candidate()], hasMore: false } } } });
  await ui.open(); await ui.search();
  assert.doesNotMatch(ui.text(), /SOL-000074|Cliente guardado|Identidad y firma/); assert.match(ui.text(), /Consulta no disponible/);
});

test("el caso autorizado avanza a validar y solo permite confirmar tras las cuatro verificaciones", async () => {
  const ui = harness(); await ui.open(); await ui.search();
  assert.equal(ui.requests.length, 2); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO").props.disabled, true);
  assert.match(ui.text(), /SOL-000074|Verificación del analista/);
  assert.equal(ui.progress().props.children[1].props.children, "Validar");
  ui.checkAll(); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO").props.disabled, false);
  assert.equal(ui.progress().props.children[1].props.children, "Confirmar");
  ui.button("CONFIRMAR ENROLAMIENTO").props.onClick(); ui.render(); assert.equal(ui.requests.length, 2);
  assert.ok(ui.find(value => value.type === ui.ConfirmDialog));
  ui.change("imei", "351168083278999");
  assert.equal(ui.find(value => value.type === ui.ConfirmDialog), undefined); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
  assert.match(ui.text(), /Consulta pendiente/);
});

test("el diagnóstico presenta las etapas reales y tipos de registro sin confundirlos con casos aprobables", async () => {
  for (const data of [
    { currentStep: 1, stepLabel: "Cliente" }, { currentStep: 2, stepLabel: "Equipo" },
    { currentStep: 3, stepLabel: "Identidad y evidencias" }, { currentStep: 4, stepLabel: "Identidad y firma" },
    { currentStep: 5, stepLabel: "Enrolamiento y entrega" },
    { source: "CREDIT", sourceId: "90", creditoId: 90, creditoFolio: "FC-000090", currentStep: null, stepLabel: "Crédito creado", status: "ACTIVO" },
    { source: "DEVICE_REPLACEMENT", sourceId: "replacement-90", creditoId: 90, creditoFolio: "FC-000090", currentStep: null, stepLabel: "Enrolamiento por garantía", status: "PENDING_ENROLLMENT" },
  ]) {
    const ui = harness({ lookup: { status: 404, payload: { ok: false, error: "Caso pendiente de validación", submitted,
      diagnostics: { kind: "EXACT_MATCH", candidates: [candidate({ ...data, pendingReason: "Estado registrado que requiere revisión." })], hasMore: false } } } });
    await ui.open(); await ui.search();
    assert.ok(ui.text().includes(data.stepLabel), data.stepLabel); assert.match(ui.text(), /Estado registrado que requiere revisión/);
    assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
    if (data.creditoFolio) assert.ok(ui.text().includes(data.creditoFolio));
  }
});

test("una sesión nominal vencida al consultar bloquea la gestión y pide verificar la cuenta personal", async () => {
  const ui = harness({ lookup: { status: 401, payload: { ok: false, error: "Sesión vencida" } } });
  await ui.open(); await ui.search();
  assert.equal(ui.input("document"), undefined); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
  assert.match(ui.text(), /Actualiza la página para verificar tu cuenta/); assert.doesNotMatch(ui.text(), /enlace compartido/);
});

test("la confirmación autorizada utiliza el mismo endpoint nominal y únicamente el token del caso validado", async () => {
  const ui = harness(); await ui.open(); await ui.search(); ui.checkAll();
  ui.button("CONFIRMAR ENROLAMIENTO").props.onClick(); ui.render();
  const dialog = ui.find(value => value.type === ui.ConfirmDialog); assert.ok(dialog);
  dialog.props.onConfirm(); await ui.settle();
  assert.equal(ui.requests.length, 3); assert.equal(ui.requests[2].url, "/api/aprobaciones/enrolamiento/cases/approve");
  assert.deepEqual(ui.requests[2].payload, { caseToken: "case-token-for-test", enrollmentApproved: true });
  assert.match(ui.text(), /ENROLADO CORRECTAMENTE/); assert.equal(ui.button("CONFIRMAR ENROLAMIENTO"), undefined);
});
