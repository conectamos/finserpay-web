import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const extension = {
  id: "00000000-0000-4000-8000-000000000044", expiresOn: "2026-10-20", reason: "Compromiso del cliente",
  approvedAt: "2026-10-18T13:00:00Z", approvedByName: "Responsable autorizado", installmentNumber: 4, installmentDueDate: "2026-10-17",
};
const capabilities = { canEdit: true, canCancel: true, centralAdmin: false, minExpiresOn: "2026-10-18", maxExpiresOn: "2026-10-21", editBlockedReason: null };
const requestItem = {
  ...extension, creditoId: 44, type: "PRORROGA", status: "APPROVED", version: 3,
  source: "ANALYST_REQUEST", centralDirect: false, promiseAmount: 156550, promiseDate: "2026-10-20",
  observation: "Contacto realizado", createdByUserId: 17, createdByName: "Analista de prueba", submittedAt: "2026-10-18T13:00:00Z",
  decidedByUserId: 9, decidedByName: "Responsable autorizado", decidedAt: "2026-10-18T13:00:00Z", decisionReason: null,
  cooldownBypassed: false, cooldownBypassReason: null, createdAt: "2026-10-18T13:00:00Z", updatedAt: "2026-10-18T13:00:00Z",
  paidTowardPromise: 0, conditionStatus: "PENDING",
};

function harness({ item = {}, permissions = {}, initialCapabilities = {}, deferGet = false, deferPatch = false, patchResponses = [], getResponses = [] } = {}) {
  const componentNames = ["Button", "Input", "LoadingState", "Select", "StatusPill", "Badge", "Card"];
  const components = Object.fromEntries(componentNames.map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const stubs = new Set(Object.values(components));
  const node = (type, props) => typeof type === "function" && !stubs.has(type) ? type(props) : ({ type, props });
  const slots = [], effects = [], requests = [], changed = [], busy = [], pendingGets = [], pendingPatches = [];
  let cursor = 0, dirty = false, tree, counter = 0;
  let currentItem = { ...requestItem, ...item }, currentPermissions = { ...capabilities, ...permissions };
  const props = { creditId: 44, extension: { ...extension }, capabilities: { ...capabilities, ...initialCapabilities },
    onBusyChange: value => busy.push(value), onChanged: value => { changed.push(value); } };
  const same = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, value => {
      const next = typeof value === "function" ? value(slots[index].value) : value;
      if (!Object.is(next, slots[index].value)) dirty = true; slots[index].value = next;
    }]; },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
      const previous = slots[index]; slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
    } },
    useMemo(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { dependencies, value: callback() }; return slots[index].value; },
    useCallback(callback, dependencies) { return hooks.useMemo(() => callback, dependencies); },
  };
  const response = ({ status = 200, ...payload }) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
  const loaded = { exports: {} };
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : ["2026-10-18T15:00:00Z"])); }
    static now() { return Date.parse("2026-10-18T15:00:00Z"); }
  }
  runInNewContext(compile("../app/dashboard/aprobaciones/cartera-mora/mora-portfolio-extension-actions.tsx"), {
    module: loaded, exports: loaded.exports, AbortController, URLSearchParams, Intl, Date: FixedDate,
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` },
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      requests.push({ url, method, cache: options.cache, body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
      assert.equal(url, "/api/aprobaciones/excepciones-mora/" + props.extension.id, "se consulta y modifica la autorización existente");
      if (method === "GET") {
        if (deferGet) await new Promise(resolve => pendingGets.push(resolve));
        return response(getResponses.shift() || { ok: true, item: { ...currentItem }, amendmentActions: { ...currentPermissions } });
      }
      assert.equal(method, "PATCH", "no se crea una nueva prórroga");
      if (deferPatch) await new Promise(resolve => pendingPatches.push(resolve));
      const supplied = patchResponses.shift();
      if (supplied instanceof Error) throw supplied;
      const body = JSON.parse(options.body);
      currentItem = { ...currentItem, ...body, status: body.action === "CANCEL" ? "CANCELLED" : "APPROVED", version: currentItem.version + 1 };
      return response(supplied || { ok: true, item: { ...currentItem }, moraSync: { ok: true, message: "Mora actualizada" } });
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/lib/colombia-date") return { colombiaDateKey: () => "2026-10-18" };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error("Unexpected import: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value : value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => { let count = 0; do { dirty = false; cursor = 0; tree = loaded.exports.default(props); effects.splice(0).forEach(callback => callback()); if (++count > 20) throw new Error("Render did not settle"); } while (dirty); return tree; };
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(item => item.type === components.Button && text(item).trim() === label);
  const field = id => find(item => item.props?.id === id);
  const form = label => find(item => item.type === "form" && (!label || item.props["aria-label"] === label));
  const change = (control, value) => { assert.ok(control, "el campo debe estar visible"); control.props.onChange({ target: { value, checked: value } }); render(); };
  async function settle() { for (let index = 0; index < 3; index++) { await setImmediate(); render(); } }
  async function click(label) { const control = button(label); assert.ok(control, `botón ${label}`); const pending = control.props.onClick?.(); render(); if (pending) await pending; await settle(); }
  async function submit(label) { assert.ok(form(label), "formulario visible"); await form(label).props.onSubmit({ preventDefault() {} }); await settle(); }
  const patchRequests = () => requests.filter(item => item.method === "PATCH");
  return { props, render, settle, button, field, form, change, click, submit, requests, patchRequests, changed, busy, nodes, find, text: () => text(tree),
    releaseGets: () => pendingGets.splice(0).forEach(resolve => resolve()), releasePatches: () => pendingPatches.splice(0).forEach(resolve => resolve()),
    setItem: value => { currentItem = { ...currentItem, ...value }; }, setPermissions: value => { currentPermissions = { ...currentPermissions, ...value }; },
    unmount: () => slots.forEach(slot => slot?.cleanup?.()) };
}

async function editable(ui) {
  ui.render(); await ui.click("Editar prórroga");
  ui.change(ui.field("mora-extension-audit-reason"), "Cliente solicita actualizar su compromiso");
}

test("las acciones no cargan formularios ni envían cambios antes de elegir una operación", () => {
  const ui = harness(); ui.render();
  assert.ok(ui.button("Editar prórroga")); assert.ok(ui.button("Cancelar prórroga"));
  assert.equal(ui.form(), undefined); assert.equal(ui.requests.length, 0);
  const blocked = harness({ initialCapabilities: { canEdit: false, canCancel: false, editBlockedReason: "Ya no está vigente" } }); blocked.render();
  assert.equal(blocked.button("Editar prórroga"), undefined); assert.equal(blocked.button("Cancelar prórroga"), undefined);
  assert.match(blocked.text(), /Ya no está vigente/);
});

test("el analista edita la autorización existente con fechas limitadas y sin modificar su valor", async () => {
  const ui = harness(); await editable(ui);
  assert.equal(ui.requests[0].method, "GET"); assert.equal(ui.requests[0].cache, "no-store");
  assert.equal(ui.field("mora-extension-expires-on").props.min, "2026-10-18");
  assert.equal(ui.field("mora-extension-expires-on").props.max, "2026-10-21");
  assert.equal(ui.field("mora-extension-promise-amount").props.readOnly, true);
  ui.change(ui.field("mora-extension-expires-on"), "2026-10-21");
  ui.change(ui.field("mora-extension-observation"), "Cliente contactado por llamada");
  await ui.submit("Editar prórroga");
  assert.equal(ui.patchRequests().length, 0, "revisar cambios exige confirmación posterior");
  assert.ok(ui.button("Confirmar cambios"));
  await ui.click("Confirmar cambios");
  const saved = ui.patchRequests()[0]; assert.equal(saved.method, "PATCH");
  assert.equal(saved.body.action, "EDIT"); assert.equal(saved.body.version, 3);
  assert.equal(saved.body.expiresOn, "2026-10-21"); assert.equal(saved.body.promiseDate, "2026-10-20");
  assert.equal(saved.body.observation, "Cliente contactado por llamada");
  assert.equal(saved.body.auditReason, "Cliente solicita actualizar su compromiso");
  assert.equal(saved.body.promiseAmount, undefined, "no se reenvía ni modifica el importe como analista");
  assert.ok(saved.body.idempotencyKey); assert.equal(ui.changed.length, 1);
  assert.equal(ui.changed[0].item.id, extension.id); assert.equal(ui.changed[0].item.creditoId, 44);
  assert.equal(ui.form(), undefined); assert.ok(ui.busy.includes(true)); assert.equal(ui.busy.at(-1), false);
});

test("el analista debe justificar el cambio y no puede revisar fechas fuera de plazo o inexistentes", async () => {
  const ui = harness(); ui.render(); await ui.click("Editar prórroga");
  await ui.submit("Editar prórroga"); assert.match(ui.text(), /mínimo 5 caracteres/); assert.equal(ui.button("Confirmar cambios"), undefined);
  ui.change(ui.field("mora-extension-audit-reason"), "Actualización autorizada");
  for (const invalid of ["2026-10-17", "2026-10-22", "2026-02-30", ""]) {
    ui.change(ui.field("mora-extension-expires-on"), invalid); await ui.submit("Editar prórroga");
    assert.match(ui.text(), /vencimiento dentro del plazo permitido/); assert.equal(ui.button("Confirmar cambios"), undefined);
  }
  assert.equal(ui.patchRequests().length, 0);
});

test("una prórroga anticipada conserva compromisos vigentes anteriores al vencimiento de la cuota", async () => {
  const ui = harness({ item: { expiresOn: "2026-11-06", promiseDate: "2026-10-20", installmentDueDate: "2026-11-02" },
    permissions: { minExpiresOn: "2026-11-03", maxExpiresOn: "2026-11-06" } });
  await editable(ui);
  assert.equal(ui.field("mora-extension-expires-on").props.min, "2026-11-03");
  assert.equal(ui.field("mora-extension-promise-date").props.min, "2026-10-18");
  await ui.submit("Editar prórroga"); assert.ok(ui.button("Confirmar cambios"));
  await ui.click("Confirmar cambios");
  assert.equal(ui.patchRequests()[0].body.promiseDate, "2026-10-20");
  assert.equal(ui.patchRequests()[0].body.expiresOn, "2026-11-06");
});

test("el motivo de la prórroga se valida antes de revisar y un guardado manual impide nuevas operaciones", async () => {
  const ui = harness(); await editable(ui);
  for (const value of ["", "abc"]) {
    ui.change(ui.field("mora-extension-reason"), value); await ui.submit("Editar prórroga");
    assert.equal(ui.button("Confirmar cambios"), undefined); assert.equal(ui.patchRequests().length, 0);
  }
  ui.change(ui.field("mora-extension-reason"), "Nuevo compromiso del cliente");
  ui.props.disabled = true; ui.render(); await ui.submit("Editar prórroga");
  assert.equal(ui.button("Confirmar cambios"), undefined);
  ui.props.disabled = false; ui.render(); await ui.submit("Editar prórroga");
  assert.ok(ui.button("Confirmar cambios"));
  ui.props.disabled = true; ui.render(); ui.button("Confirmar cambios").props.onClick(); await ui.settle();
  assert.equal(ui.patchRequests().length, 0);
});

test("acortar la prórroga ajusta la fecha del compromiso y exige coherencia antes de confirmar", async () => {
  const ui = harness(); await editable(ui);
  ui.change(ui.field("mora-extension-expires-on"), "2026-10-19");
  assert.equal(ui.field("mora-extension-promise-date").props.value, "2026-10-19");
  assert.equal(ui.field("mora-extension-promise-date").props.max, "2026-10-19");
  ui.change(ui.field("mora-extension-promise-date"), "2026-10-20"); await ui.submit("Editar prórroga");
  assert.match(ui.text(), /fecha del compromiso/); assert.equal(ui.button("Confirmar cambios"), undefined);
  ui.change(ui.field("mora-extension-promise-date"), "2026-10-19"); await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.patchRequests()[0].body.promiseDate, "2026-10-19");
});

test("el administrador central puede editar una autorización directa sin fecha límite", async () => {
  const ui = harness({ item: { centralDirect: true, source: "CENTRAL_DIRECT", expiresOn: null, promiseDate: null, promiseAmount: null },
    permissions: { centralAdmin: true, minExpiresOn: null, maxExpiresOn: null } });
  ui.render(); await ui.click("Editar prórroga");
  assert.equal(ui.field("mora-extension-expires-on"), undefined);
  const checkbox = ui.find(item => item.type === "input" && item.props.type === "checkbox");
  assert.equal(checkbox.props.checked, true); assert.equal(ui.field("mora-extension-audit-reason").props.required, false);
  assert.equal(ui.field("mora-extension-promise-amount"), undefined);
  await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.patchRequests()[0].body.expiresOn, null);
  assert.match(ui.patchRequests()[0].body.auditReason, /administrador central/);
});

test("la cancelación exige revisión y confirmación dentro del panel y conserva la trazabilidad", async () => {
  const ui = harness(); ui.render(); await ui.click("Cancelar prórroga");
  assert.equal(ui.field("mora-extension-expires-on"), undefined); assert.equal(ui.field("mora-extension-promise-amount"), undefined);
  await ui.submit("Cancelar prórroga"); assert.equal(ui.button("Confirmar cancelación"), undefined);
  ui.change(ui.field("mora-extension-audit-reason"), "Cliente completó el pago de la cuota");
  await ui.submit("Cancelar prórroga"); assert.equal(ui.patchRequests().length, 0);
  assert.ok(ui.find(item => item.props?.role === "group" && item.props["aria-label"] === "Confirmar cancelación de la prórroga"));
  assert.equal(ui.find(item => item.props?.role === "dialog"), undefined, "la confirmación no crea otra capa modal detrás del panel nativo");
  await ui.click("Confirmar cancelación");
  const saved = ui.patchRequests()[0].body; assert.equal(saved.action, "CANCEL"); assert.equal(saved.version, 3);
  assert.equal(saved.auditReason, "Cliente completó el pago de la cuota"); assert.equal(saved.expiresOn, undefined);
  assert.equal(ui.changed[0].item.status, "CANCELLED");
});

for (const mismatch of [{ creditoId: 45 }, { id: "different-request" }, { type: "EXCEPCION" }, { status: "CANCELLED" }]) {
  test(`el detalle obsoleto o de otra autorización no habilita cambios: ${JSON.stringify(mismatch)}`, async () => {
    const ui = harness({ item: mismatch }); ui.render(); await ui.click("Editar prórroga");
    assert.equal(ui.form(), undefined); assert.equal(ui.field("mora-extension-expires-on"), undefined);
    assert.match(ui.text(), /cambió o ya no está vigente/); assert.equal(ui.patchRequests().length, 0);
  });
}

test("el permiso consultado al abrir prevalece sobre una capacidad de lista obsoleta", async () => {
  const ui = harness({ permissions: { canEdit: false, editBlockedReason: "El plazo máximo ya venció" } });
  ui.render(); await ui.click("Editar prórroga"); assert.equal(ui.form(), undefined);
  assert.match(ui.text(), /plazo máximo ya venció/); assert.equal(ui.patchRequests().length, 0);
});

test("doble confirmación no duplica la operación en curso", async () => {
  const ui = harness({ deferPatch: true }); await editable(ui); await ui.submit("Editar prórroga");
  const confirmation = ui.button("Confirmar cambios"); confirmation.props.onClick(); ui.render();
  confirmation.props.onClick(); ui.render();
  assert.equal(ui.patchRequests().length, 1); assert.equal(ui.button("Guardando...").props.disabled, true);
  ui.releasePatches(); await ui.settle(); assert.equal(ui.changed.length, 1); assert.equal(ui.patchRequests().length, 1);
});

test("un reintento tras error de red conserva la misma operación y un cambio de contenido crea otra", async () => {
  const ui = harness({ patchResponses: [new Error("Red interrumpida"), { status: 503, ok: false, error: "Servicio temporalmente no disponible" }] });
  await editable(ui); await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.changed.length, 0); assert.equal(ui.field("mora-extension-audit-reason").props.value, "Cliente solicita actualizar su compromiso");
  await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.deepEqual(ui.patchRequests()[1].body, ui.patchRequests()[0].body, "el reintento no puede crear una segunda operación incierta");
  ui.change(ui.field("mora-extension-audit-reason"), "Motivo corregido después de revisar al cliente");
  await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.notEqual(ui.patchRequests()[2].body.idempotencyKey, ui.patchRequests()[0].body.idempotencyKey);
  assert.equal(ui.changed.length, 1);
});

test("un conflicto 409 bloquea el borrador y exige recargar la versión vigente", async () => {
  const ui = harness({ patchResponses: [{ status: 409, ok: false, error: "La solicitud cambió; actualiza la versión" }] });
  await editable(ui); await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.match(ui.text(), /actualiza la versión/); assert.equal(ui.find(item => item.type === "fieldset").props.disabled, true);
  await ui.submit("Editar prórroga"); assert.equal(ui.patchRequests().length, 1);
  ui.setItem({ version: 5, expiresOn: "2026-10-21" }); await ui.click("Actualizar prórroga");
  assert.equal(ui.field("mora-extension-expires-on").props.value, "2026-10-21");
  ui.change(ui.field("mora-extension-audit-reason"), "Confirmación después de actualizar la versión");
  await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.patchRequests()[1].body.version, 5);
  assert.notEqual(ui.patchRequests()[1].body.idempotencyKey, ui.patchRequests()[0].body.idempotencyKey);
});

test("una carga que termina después de cerrar el crédito no deja un formulario utilizable", async () => {
  const ui = harness({ deferGet: true }); ui.render(); ui.button("Editar prórroga").props.onClick(); ui.render();
  assert.equal(ui.requests.length, 1); ui.unmount(); assert.equal(ui.requests[0].signal.aborted, true);
  ui.releaseGets(); await ui.settle(); assert.equal(ui.form(), undefined); assert.equal(ui.field("mora-extension-expires-on"), undefined);
});

test("el resultado de otro crédito no provoca refresco ni una afirmación de éxito", async () => {
  const ui = harness({ patchResponses: [{ ok: true, item: { ...requestItem, creditoId: 45 } }] });
  await editable(ui); await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.changed.length, 0); assert.match(ui.text(), /verificar el resultado para este crédito/);
});

test("un fallo de sincronización conserva el éxito de la edición y comunica la advertencia al panel", async () => {
  const ui = harness({ patchResponses: [{ ok: true, item: { ...requestItem, version: 4 }, moraSync: { ok: false, message: "Cambio guardado; actualización de cartera pendiente" } }] });
  await editable(ui); await ui.submit("Editar prórroga"); await ui.click("Confirmar cambios");
  assert.equal(ui.changed.length, 1); assert.equal(ui.changed[0].warning, "Cambio guardado; actualización de cartera pendiente");
});
