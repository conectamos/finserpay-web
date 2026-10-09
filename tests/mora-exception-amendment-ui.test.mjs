import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../app/dashboard/aprobaciones/excepciones-mora/mora-exception-requests-client.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ centralAdmin = true, status = "APPROVED", type = "EXCEPCION", centralDirect = true, failFirst = false, syncWarning = false, deferred = false } = {}) {
  const components = Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "Select", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null;
  const MoraSupports = () => null;
  const stubComponents = new Set([...Object.values(components), ConfirmDialog, MoraSupports]);
  const node = (component, props) => typeof component === "function" && !stubComponents.has(component) ? component(props) :
    component === ConfirmDialog && !props.open ? null : ({ type: component, props });
  const slots = [], effects = [], requests = [];
  let cursor = 0, dirty = false, tree, uuid = 0, resolveSave;
  const same = (before, after) => before?.length === after?.length && before.every((value, index) => Object.is(value, after[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) dirty = true;
        slots[index].value = next;
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { dependencies, value: callback };
      return slots[index].value;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const previous = slots[index]; slots[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const credit = { id: 77, folio: "FC-77", numeroSadmin: "0100000077", clienteNombre: "Cliente de prueba", clienteDocumento: "111222333", clienteTelefono: "3209998877", equipo: "IPHONE 13", imei: "351168083278358", aliadoNombre: "Aliado de prueba" };
  let item = { id: "00000000-0000-4000-8000-000000000077", creditoId: 77, type, status, version: 4, centralDirect,
    source: centralDirect ? "CENTRAL_DIRECT" : "ANALYST_REQUEST", expiresOn: "2026-10-21", reason: "Motivo original", observation: "Observación original",
    promiseAmount: centralDirect ? null : 150000, promiseDate: centralDirect ? null : "2026-10-21", installmentNumber: null, installmentDueDate: null,
    createdByName: "Administrador original", decidedByName: "Administrador original", submittedAt: "2026-10-09T14:00:00Z", createdAt: "2026-10-09T14:00:00Z",
    decidedAt: "2026-10-09T14:00:00Z", decisionReason: "Autorización original", paidTowardPromise: 0, conditionStatus: "NOT_APPLICABLE", credit };
  const history = [{ id: "prior", action: "APPROVED", actorName: "Administrador original", createdAt: "2026-10-09T14:00:00Z", toStatus: status, payload: { reason: "Autorización anterior que se conserva" } }];
  const response = payload => ({ ok: true, json: async () => payload });
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, AbortController, URLSearchParams, Intl, Date, Number, Error,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    fetch: async (url, options = {}) => {
      if (url.startsWith("/api/aprobaciones/excepciones-mora?")) return response({ ok: true, items: [item], page: 1, pageSize: 25, total: 1, totalPages: 1 });
      if (url.endsWith(item.id) && (!options.method || options.method === "GET")) return response({ ok: true, item, history: [...history], credit });
      if (url.endsWith(item.id) && options.method === "PATCH") {
        const input = JSON.parse(options.body); requests.push(input);
        if (failFirst && requests.length === 1) throw new Error("No se pudo confirmar el envío. Intenta de nuevo.");
        if (deferred) await new Promise(resolve => { resolveSave = resolve; });
        const before = item;
        item = { ...item, ...(input.action === "EDIT" ? { expiresOn: input.expiresOn, reason: input.reason, observation: input.observation,
          ...(input.promiseAmount !== undefined ? { promiseAmount: input.promiseAmount, promiseDate: input.promiseDate } : {}) } : { status: "CANCELLED" }), version: item.version + 1 };
        history.push({ id: `new-${requests.length}`, action: input.action === "EDIT" ? "EDITED" : "CANCELLED", actorName: "Administrador actual", createdAt: "2026-10-09T15:00:00Z", toStatus: item.status,
          payload: { auditReason: input.auditReason, before, after: item } });
        return response({ ok: true, item, ...(syncWarning ? { moraSync: { ok: false, message: "Cambio guardado; la sincronización de mora está pendiente." } } : {}) });
      }
      throw new Error("Petición inesperada: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "next/link") return { default: props => node("a", props) };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: ConfirmDialog };
      if (name === "@/app/_components/finser-side-panel") return { default: props => props.open ? node("aside", props) : null };
      if (name === "@/lib/colombia-date") return { colombiaDateKey: () => "2026-10-09" };
      if (name === "../mora-supports") return { default: MoraSupports };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => key }) };
      throw new Error("Importación inesperada: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value : value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => {
    let count = 0;
    do {
      dirty = false; cursor = 0; tree = loadedModule.exports.default({ centralAdmin }); effects.splice(0).forEach(callback => callback());
      if (++count > 20) throw new Error("Render no estable");
    } while (dirty);
    return tree;
  };
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(value => value.type === components.Button && text(value.props.children).trim() === label);
  const form = () => find(value => value.type === "form" && value.props["aria-labelledby"] === "mora-amendment-title");
  const field = label => {
    const controlLabel = nodes(form()).find(value => value.type === "label" && text(value.props.children).trim().replace(/\s+/g, " ").startsWith(label));
    return nodes(controlLabel).find(value => [components.Input, "textarea", "input"].includes(value.type));
  };
  const change = (label, value) => { const input = field(label); assert.ok(input, label); input.props.onChange({ target: { value, checked: value } }); render(); };
  const click = label => { const action = button(label); assert.ok(action, label); assert.equal(Boolean(action.props.disabled), false); action.props.onClick(); render(); };
  const dialog = () => find(value => value.type === ConfirmDialog);
  const settle = async () => { for (let index = 0; index < 4; index++) { await setImmediate(); render(); } };
  const open = async () => { render(); await settle(); click("Ver detalle"); await settle(); };
  const review = () => { assert.ok(form()); form().props.onSubmit({ preventDefault() {} }); render(); };
  const confirm = async () => { assert.ok(dialog()); dialog().props.onConfirm(); await settle(); };
  return { open, click, change, button, field, form, dialog, review, confirm, settle, render, requests, text: () => text(tree), resolve: () => resolveSave?.() };
}

for (const type of ["EXCEPCION", "PRORROGA"]) {
  for (const status of ["PENDING", "APPROVED"]) {
    test(`central puede editar y cancelar ${type} ${status} desde el detalle`, async () => {
      const ui = harness({ type, status }); await ui.open();
      assert.ok(ui.button("Editar solicitud")); assert.ok(ui.button("Cancelar solicitud"));
      assert.equal(ui.form(), undefined, "el editor solo aparece tras una acción explícita");
    });
  }
}

for (const status of ["REJECTED", "EXPIRED", "REPLACED", "CANCELLED"]) {
  test(`una solicitud ${status} no ofrece editar ni cancelar`, async () => {
    const ui = harness({ status }); await ui.open();
    assert.equal(ui.button("Editar solicitud"), undefined); assert.equal(ui.button("Cancelar solicitud"), undefined);
    if (status === "CANCELLED") assert.match(ui.text(), /Cancelada/);
  });
}

test("el analista consulta el detalle y conserva observaciones sin acciones centrales", async () => {
  const ui = harness({ centralAdmin: false, status: "PENDING" }); await ui.open();
  assert.equal(ui.button("Editar solicitud"), undefined); assert.equal(ui.button("Cancelar solicitud"), undefined);
  assert.equal(ui.button("Aprobar"), undefined); assert.equal(ui.button("Rechazar"), undefined);
  assert.ok(ui.button("Guardar observación"));
});

test("editar prórroga central no impone cuatro días ni requiere compromiso y confirma antes de guardar", async () => {
  const ui = harness({ type: "PRORROGA" }); await ui.open(); ui.click("Editar solicitud");
  assert.equal(ui.field("Vencimiento").props.value, "2026-10-21");
  assert.equal(ui.field("Vencimiento").props.min, undefined); assert.equal(ui.field("Vencimiento").props.max, undefined);
  assert.equal(ui.field("Valor del compromiso"), undefined);
  assert.equal(ui.field("Motivo del cambio").props.required, undefined);
  ui.change("Vencimiento", "2035-12-31"); ui.change("Motivo de la solicitud", "Nota corregida"); ui.change("Observación", "Nueva observación");
  ui.review(); assert.equal(ui.requests.length, 0); assert.equal(ui.dialog().props.danger, false);
  await ui.confirm(); assert.equal(ui.requests.length, 1);
  assert.deepEqual(Object.keys(ui.requests[0]).sort(), ["action", "auditReason", "expiresOn", "idempotencyKey", "observation", "reason", "version"]);
  assert.equal(ui.requests[0].action, "EDIT"); assert.equal(ui.requests[0].version, 4);
  assert.equal(ui.requests[0].expiresOn, "2035-12-31"); assert.equal(ui.requests[0].reason, "Nota corregida");
  assert.match(ui.requests[0].auditReason, /administrador central/);
  assert.equal(ui.form(), undefined); assert.match(ui.text(), /Cambios guardados/); assert.match(ui.text(), /Solicitud editada/);
  assert.match(ui.text(), /Autorización anterior que se conserva/);
  assert.match(ui.text(), /Antes:\s+21\/10\/2026/); assert.match(ui.text(), /Después:\s+31\/12\/2035/);
  assert.match(ui.text(), /Administrador actual/); assert.match(ui.text(), /09\/10\/2026/);
});

test("central puede retirar el vencimiento de su autorización sin añadir campos obligatorios", async () => {
  const ui = harness(); await ui.open(); ui.click("Editar solicitud"); ui.change("Sin vencimiento", true);
  assert.equal(ui.field("Vencimiento"), undefined); ui.review(); await ui.confirm();
  assert.equal(ui.requests[0].expiresOn, null); assert.match(ui.text(), /Sin vencimiento/);
});

test("el editor conserva y actualiza el compromiso de una solicitud del analista", async () => {
  const ui = harness({ centralDirect: false }); await ui.open(); ui.click("Editar solicitud");
  assert.equal(ui.field("Sin vencimiento"), undefined); assert.equal(ui.field("Valor del compromiso").props.value, "150000");
  assert.equal(ui.field("Fecha del compromiso").props.value, "2026-10-21");
  ui.change("Valor del compromiso", "180000"); ui.change("Fecha del compromiso", "2026-10-20");
  ui.change("Motivo del cambio", "Cliente confirmó el nuevo compromiso"); ui.review(); await ui.confirm();
  assert.equal(ui.requests[0].promiseAmount, 180000); assert.equal(ui.requests[0].promiseDate, "2026-10-20");
  assert.equal(ui.requests[0].auditReason, "Cliente confirmó el nuevo compromiso");
});

test("el compromiso existente no se envía incompleto o con un valor inválido", async () => {
  const ui = harness({ centralDirect: false }); await ui.open(); ui.click("Editar solicitud");
  for (const value of ["", "0", "invalido"]) {
    ui.change("Valor del compromiso", value); ui.review();
    assert.equal(ui.dialog(), undefined); assert.equal(ui.requests.length, 0);
  }
});

test("cancelar requiere confirmación explícita y conserva la autorización anterior en el historial", async () => {
  const ui = harness(); await ui.open(); ui.click("Cancelar solicitud");
  assert.equal(ui.field("Vencimiento"), undefined); ui.change("Motivo de cancelación", "Autorización duplicada");
  ui.review(); assert.equal(ui.requests.length, 0); assert.equal(ui.dialog().props.danger, true);
  ui.dialog().props.onCancel(); ui.render(); assert.equal(ui.requests.length, 0); assert.ok(ui.form());
  ui.review(); await ui.confirm();
  assert.equal(ui.requests.length, 1); assert.deepEqual(Object.keys(ui.requests[0]).sort(), ["action", "auditReason", "idempotencyKey", "version"]);
  assert.equal(ui.requests[0].action, "CANCEL"); assert.equal(ui.requests[0].auditReason, "Autorización duplicada");
  assert.match(ui.text(), /Cancelada/); assert.match(ui.text(), /Solicitud cancelada/); assert.match(ui.text(), /Autorización anterior que se conserva/);
  assert.equal(ui.button("Editar solicitud"), undefined); assert.equal(ui.button("Cancelar solicitud"), undefined);
});

for (const action of ["EDIT", "CANCEL"]) {
  test(`${action}: un error conserva los datos, la versión y la misma llave al reintentar`, async () => {
    const ui = harness({ failFirst: true }); await ui.open(); ui.click(action === "EDIT" ? "Editar solicitud" : "Cancelar solicitud");
    if (action === "EDIT") ui.change("Vencimiento", "2026-11-17");
    ui.change(action === "EDIT" ? "Motivo del cambio" : "Motivo de cancelación", "Corrección auditada");
    ui.review(); await ui.confirm(); assert.match(ui.text(), /No se pudo confirmar/); assert.ok(ui.form());
    if (action === "EDIT") assert.equal(ui.field("Vencimiento").props.value, "2026-11-17");
    ui.review(); await ui.confirm(); assert.equal(ui.requests.length, 2); assert.deepEqual(ui.requests[1], ui.requests[0]);
  });
}

test("cambiar la intención después de un error genera otra llave de idempotencia", async () => {
  const ui = harness({ failFirst: true }); await ui.open(); ui.click("Editar solicitud"); ui.review(); await ui.confirm();
  ui.change("Vencimiento", "2026-11-02"); ui.review(); await ui.confirm();
  assert.notEqual(ui.requests[0].idempotencyKey, ui.requests[1].idempotencyKey); assert.equal(ui.requests[1].version, 4);
});

test("guardar bloquea envíos duplicados y muestra la confirmación ocupada", async () => {
  const ui = harness({ deferred: true }); await ui.open(); ui.click("Editar solicitud"); ui.review();
  const confirm = ui.dialog().props.onConfirm; confirm(); confirm(); await ui.settle();
  assert.equal(ui.requests.length, 1); assert.equal(ui.dialog().props.busy, true);
  assert.equal(ui.button("Guardando…").props.disabled, true);
  ui.resolve(); await ui.settle(); assert.equal(ui.form(), undefined);
});

test("un aviso de sincronización no reabre ni vuelve a enviar una mutación ya guardada", async () => {
  const ui = harness({ syncWarning: true }); await ui.open(); ui.click("Cancelar solicitud"); ui.review(); await ui.confirm();
  assert.equal(ui.requests.length, 1); assert.equal(ui.form(), undefined);
  assert.match(ui.text(), /Solicitud cancelada/); assert.match(ui.text(), /sincronización de mora está pendiente/);
});
