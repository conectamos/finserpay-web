import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/aprobaciones/solicitudes/[id]/analyst-request-data-editor.tsx", import.meta.url), "utf8");
const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Button", "Input", "LoadingState", "Select"].map(name => [name, placeholder(name)]));
const SidePanel = placeholder("SidePanel"), Confirm = placeholder("Confirm"), Link = placeholder("Link");
const editableFields = ["clientePrimerNombre", "clienteSegundoApellido", "clienteFechaNacimiento", "clienteTelefono", "clienteCorreo", "clienteDireccion", "clienteDepartamento", "clienteCiudad"];
function snapshot(extra = {}) {
  return { revision: 4, reason: null, editableFields,
    values: { clienteDocumento: "77096448", clientePrimerNombre: "CARLOS", clientePrimerApellido: "RIVERA",
      clienteSegundoApellido: "RIVERA", clienteFechaNacimiento: "1985-05-18", clienteTelefono: "3004452838",
      clienteCorreo: "cliente@example.test", clienteDireccion: "DIRECCIÓN ORIGINAL", clienteDepartamento: "CESAR", clienteCiudad: "Valledupar" },
    requiresNewSignature: false, expectedProcessUuid: null, ...extra };
}
const stateResponse = (item) => ({ ok: true, item });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

// Exercise the real component and handlers with controlled transports and React
// lifecycle. Provider dispatches can finish after a request switches or unmounts.
function mount({ bodies = [stateResponse(snapshot())], requestId = "281" } = {}) {
  let hookIndex = 0, dirty = true, effects = [], tree, uuid = 0, refreshes = 0;
  const slots = [], requests = [];
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: initial, set(value) {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      } };
      return [slots[index].value, slots[index].set];
    },
    useRef(value) { const index = hookIndex++; slots[index] ||= { current: value }; return slots[index]; },
    useCallback(fn, deps) { const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: fn, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) { const index = hookIndex++;
      if (!slots[index] || changed(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, effect, cleanup: effect() };
      });
    },
  };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    assert.ok(bodies.length, "Unexpected request");
    const next = bodies.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Promise) return next;
    return Response.json(next.body ?? next, { status: next.status ?? 200 });
  };
  const dependencies = { react: hooks, "react/jsx-runtime": jsxRuntime, "next/link": { default: Link },
    "next/navigation": { useRouter: () => ({ refresh() { refreshes++; } }) },
    "lucide-react": Object.fromEntries(["PencilLine", "RefreshCw", "Save"].map(name => [name, placeholder(name)])),
    "@/app/_components/finser-ui": ui, "@/app/_components/finser-side-panel": { default: SidePanel },
    "@/app/_components/finser-confirm-dialog": { default: Confirm },
    "@/lib/colombia-locations": { COLOMBIA_DEPARTMENT_OPTIONS: [{ value: "CESAR", label: "Cesar" }, { value: "TOLIMA", label: "Tolima" }],
      getColombiaCityOptions: (department, value) => [...new Set([value, department === "CESAR" ? "Valledupar" : "Ibagué"].filter(Boolean))] },
    "./analyst-request-editor.module.css": { default: new Proxy({}, { get: (_, key) => key }) },
  };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, AbortController, fetch,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    require: name => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; } });
  const Component = loaded.exports.default;
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== "object" ? [] :
    [node, ...(node.type === SidePanel && !node.props.open || node.type === Confirm && !node.props.open ? [] : nodes(node.props?.children))];
  const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ?
    node.type === SidePanel && !node.props.open || node.type === Confirm && !node.props.open ? "" : text(node.props?.children) :
    node == null || typeof node === "boolean" ? "" : String(node);
  const find = predicate => { const result = nodes(tree).find(predicate); assert.ok(result, "Expected rendered control"); return result; };
  const page = {
    requests,
    async flush() { for (let cycle = 0; cycle < 30; cycle++) {
      if (dirty) { dirty = false; hookIndex = 0; effects = []; tree = Component({ requestId }); for (const effect of effects) effect(); }
      await setImmediate(); if (!dirty) return;
    } assert.fail("Component did not settle"); },
    find, all: predicate => nodes(tree).filter(predicate), text: () => text(tree), refreshes: () => refreshes,
    button: label => find(node => node.type === ui.Button && text(node) === label),
    field(label) { const wrapper = find(node => node.type === "label" && node.props.children[0] === label);
      const control = nodes(wrapper).find(node => [ui.Input, ui.Select, "textarea"].includes(node.type)); assert.ok(control); return control; },
    edit(label, value) { page.field(label).props.onChange({ target: { value } }); },
    submit() { find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); },
    confirm() { find(node => node.type === Confirm && node.props.open).props.onConfirm(); },
    close() { find(node => node.type === SidePanel && node.props.open).props.onClose(); },
    open() { page.button("Editar datos").props.onClick(); },
    changeRequest(next) { requestId = next; dirty = true; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
  return page;
}
async function edit(page, label = "Nombres", value = "CARLOS ALBERTO") {
  page.edit(label, value); page.edit("Motivo de la corrección", "Corrección solicitada por el asesor"); await page.flush();
}

test("permite corregir identidad y contacto tras validar o firmar, pero protege apellido y cédula", async () => {
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-anterior",
    editableFields: [...editableFields, "clienteDocumento", "clientePrimerApellido", "valorEquipoTotal"] });
  const page = mount({ bodies: [stateResponse(item)] }); await page.flush(); page.open(); await page.flush();
  assert.equal(page.field("Cédula").props.readOnly, true); assert.equal(page.field("Primer apellido").props.readOnly, true);
  for (const label of ["Nombres", "Segundo apellido", "Fecha de nacimiento", "Celular", "Correo", "Dirección", "Departamento", "Ciudad o municipio"]) {
    assert.equal(page.field(label).props.disabled, false, label);
  }
  page.edit("Primer apellido", "CAMBIO NO AUTORIZADO"); page.edit("Cédula", "99999999"); await page.flush();
  assert.equal(page.field("Primer apellido").props.value, "RIVERA"); assert.equal(page.field("Cédula").props.value, "77096448");
  assert.match(page.text(), /primer apellido y la cédula permanecen protegidos/);
  assert.match(page.text(), /condiciones financieras se conservarán/);
  assert.equal(page.all(node => node.type === ui.Input && node.props.value === "valorEquipoTotal").length, 0);
  page.unmount();
});

test("guarda sin nueva firma si el contrato no comenzó y envía solo los datos corregidos", async () => {
  const next = snapshot({ revision: 5 }); next.values.clienteTelefono = "3001111111";
  const page = mount({ bodies: [stateResponse(snapshot()), stateResponse(next)] });
  await page.flush(); page.open(); await page.flush(); await edit(page, "Celular", "3001111111");
  page.submit(); await page.flush();
  assert.equal(page.requests.length, 2); const body = JSON.parse(page.requests[1].body);
  assert.deepEqual(body.values, { clienteTelefono: "3001111111" }); assert.deepEqual(body.expectedValues, { clienteTelefono: "3004452838" });
  assert.equal(body.expectedRevision, 4); assert.equal(body.idempotencyKey, undefined); assert.equal(body.confirmed, undefined);
  assert.equal(page.all(node => node.type === Confirm && node.props.open).length, 0);
  assert.match(page.text(), /Datos corregidos/); assert.equal(page.refreshes(), 1); page.unmount();
});

test("exige confirmar la nueva firma y mantiene el resultado pendiente y su enlace", async () => {
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-original" });
  const next = snapshot({ ...item, revision: 5, signature: { status: "AWAITING_SIGNATURE", id: "version-2", message: "Nueva firma enviada al cliente.", saved: true } });
  next.values = { ...item.values, clientePrimerNombre: "CARLOS ALBERTO" };
  const page = mount({ bodies: [stateResponse(item), stateResponse(next)] }); await page.flush(); page.open(); await page.flush(); await edit(page);
  page.submit(); await page.flush(); assert.equal(page.requests.length, 1);
  const confirm = page.find(node => node.type === Confirm && node.props.open);
  assert.match(confirm.props.description, /contrato anterior quedará archivado/); assert.match(confirm.props.description, /primer pago se conservarán/);
  confirm.props.onCancel(); await page.flush(); assert.equal(page.requests.length, 1);
  page.submit(); await page.flush(); page.confirm(); page.confirm(); await page.flush();
  assert.equal(page.requests.length, 2); const body = JSON.parse(page.requests[1].body);
  assert.equal(body.confirmed, true); assert.equal(body.expectedProcessUuid, "firma-original"); assert.match(body.idempotencyKey, /^[\da-f-]{36}$/);
  assert.deepEqual(body.values, { clientePrimerNombre: "CARLOS ALBERTO" });
  assert.match(page.text(), /Nueva firma enviada al cliente/);
  assert.equal(page.find(node => node.type === Link && node.props.children === "Gestionar firma").props.href, "/dashboard/aprobaciones/firma-seguro?caso=281");
  assert.equal(page.button("Guardar y enviar nueva firma").props.disabled, true);
  page.close(); await page.flush(); assert.match(page.text(), /Nueva firma enviada al cliente/); page.unmount();
});

test("un fallo seguro sin guardar conserva la corrección y crea otra operación solo al confirmar el reintento", async () => {
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-original" });
  const failed = { ...item, signature: { status: "FAILED_SAFE", id: "version-2", saved: false, message: "El proveedor rechazó el envío. Puedes intentar nuevamente." } };
  const page = mount({ bodies: [stateResponse(item), stateResponse(failed), stateResponse(failed)] });
  await page.flush(); page.open(); await page.flush(); await edit(page);
  page.submit(); await page.flush(); page.confirm(); await page.flush();
  assert.match(page.text(), /Los datos aún no se guardaron/); assert.equal(page.field("Nombres").props.value, "CARLOS ALBERTO");
  assert.equal(page.button("Guardar y enviar nueva firma").props.disabled, false);
  page.submit(); await page.flush(); page.confirm(); await page.flush();
  assert.notEqual(JSON.parse(page.requests[1].body).idempotencyKey, JSON.parse(page.requests[2].body).idempotencyKey);
  page.unmount();
});

test("un envío incierto conserva el resultado visible y bloquea otro envío, incluso al consultar datos", async () => {
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-original" });
  const uncertain = { ...item, signature: { status: "UNCERTAIN", id: "version-2", saved: false, message: "Consulta el estado de la nueva firma antes de continuar." } };
  const page = mount({ bodies: [stateResponse(item), stateResponse(uncertain), stateResponse(item)] });
  await page.flush(); page.open(); await page.flush(); await edit(page); page.submit(); await page.flush(); page.confirm(); await page.flush();
  assert.match(page.text(), /Consulta el estado de la nueva firma/); assert.equal(page.button("Guardar y enviar nueva firma").props.disabled, true);
  page.submit(); await page.flush(); assert.equal(page.requests.length, 2);
  page.button("Actualizar datos").props.onClick(); await page.flush();
  assert.equal(page.requests[2].method, undefined); assert.equal(page.button("Guardar y enviar nueva firma").props.disabled, true);
  assert.ok(page.find(node => node.type === Link && node.props.children === "Gestionar firma")); page.unmount();
});

test("un corte de red después de enviar no provoca reintento automático ni pierde la advertencia", async () => {
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-original" });
  const page = mount({ bodies: [stateResponse(item), new Error("Conexión interrumpida"), stateResponse(item)] });
  await page.flush(); page.open(); await page.flush(); await edit(page); page.submit(); await page.flush(); page.confirm(); await page.flush();
  assert.match(page.text(), /No pudimos confirmar el resultado/); assert.equal(page.button("Guardar y enviar nueva firma").props.disabled, true);
  page.button("Actualizar datos").props.onClick(); await page.flush(); page.submit(); await page.flush(); assert.equal(page.requests.length, 3);
  page.close(); await page.flush(); assert.match(page.text(), /No pudimos confirmar el resultado/); page.unmount();
});

test("actualizar otra solicitud aborta el envío previo y descarta su resultado tardío", async () => {
  const pending = deferred();
  const item = snapshot({ requiresNewSignature: true, expectedProcessUuid: "firma-original" });
  const another = snapshot(); another.values = { ...another.values, clientePrimerNombre: "ANA", clienteDocumento: "100000001" };
  const page = mount({ bodies: [stateResponse(item), pending.promise, stateResponse(another)] });
  await page.flush(); page.open(); await page.flush(); await edit(page); page.submit(); await page.flush(); page.confirm(); await page.flush();
  page.changeRequest("282"); await page.flush(); assert.equal(page.requests[1].signal.aborted, true); assert.equal(page.button("Editar datos").props.disabled, false);
  page.open(); await page.flush();
  pending.resolve(Response.json(stateResponse({ ...item, signature: { status: "AWAITING_SIGNATURE", id: "old", saved: true, message: "RESULTADO DE OTRA SOLICITUD" } }))); await page.flush();
  assert.equal(page.field("Nombres").props.value, "ANA"); assert.doesNotMatch(page.text(), /RESULTADO DE OTRA/); assert.equal(page.refreshes(), 0);
  page.unmount();
});

test("desmontar durante la mutación aborta el transporte e ignora la respuesta del servidor", async () => {
  const pending = deferred(); const page = mount({ bodies: [stateResponse(snapshot()), pending.promise] });
  await page.flush(); page.open(); await page.flush(); await edit(page); page.submit(); await page.flush(); page.unmount();
  assert.equal(page.requests[1].signal.aborted, true);
  pending.resolve(Response.json(stateResponse(snapshot({ revision: 5 })))); await page.flush();
  assert.equal(page.refreshes(), 0); assert.doesNotMatch(page.text(), /Datos corregidos/);
});
