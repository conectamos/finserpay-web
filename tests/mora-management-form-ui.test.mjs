import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = compile("../app/dashboard/aprobaciones/cartera-mora/mora-portfolio-client.tsx");
const typeModule = { exports: {} };
runInNewContext(compile("../lib/analyst-mora-types.ts"), { module: typeModule, exports: typeModule.exports });

function harness({ firstReference = "3001112233", secondReference = "3014445566", currentUserId = 17 } = {}) {
  const componentNames = ["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "PageHeader", "Select", "StatusPill"];
  const components = Object.fromEntries(componentNames.map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const MoraSupports = () => null;
  const stubComponents = new Set([...Object.values(components), MoraSupports]);
  const node = (type, props) => typeof type === "function" && !stubComponents.has(type) ? type(props) : ({ type, props });
  const slots = [];
  let cursor = 0, tree, dirty = false;
  const effects = [];
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
    useMemo(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index] = { dependencies, value: callback() };
      }
      return slots[index].value;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const previous = slots[index];
        slots[index] = { dependencies, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const legacy = {
    id: "history-legacy", creditoId: 44, action: "WHATSAPP", actedAt: "2026-10-08T14:00:00-05:00",
    responsibleUserId: 8, responsibleName: "Analista anterior", result: "Prometió abonar cuando reciba su nómina",
    comment: "Registro histórico que debe conservarse", nextFollowUpAt: "2026-10-12T09:00:00-05:00",
    managementStatus: "PROMESA_PAGO", idempotencyKey: "old-operation", actorUserId: 8,
    actorName: "Analista anterior", createdAt: "2026-10-08T14:01:00-05:00",
  };
  const credit = {
    id: 44, folio: "FC-44", numeroCreditoVisible: "0100000044", clienteNombre: "Cliente de prueba",
    clienteDocumento: "111222333", clienteTelefono: "3209998877", aliadoId: 2, aliadoNombre: "Aliado de prueba",
    equipo: "IPHONE 13 128GB", imei: "351168083278358", valorVencido: 150000, diasMora: 7,
    ultimoPago: "2026-09-17T15:00:00-05:00", fechaCredito: "2026-08-21", ultimaGestion: legacy,
    referenciaFamiliar1Telefono: firstReference, referenciaFamiliar2Telefono: secondReference, enMora: true,
  };
  const requests = [];
  const response = payload => ({ ok: true, json: async () => payload });
  const loaded = { exports: {} };
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : ["2026-10-09T14:00:00Z"])); }
    static now() { return Date.parse("2026-10-09T14:00:00Z"); }
  }
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, URLSearchParams, Intl, Date: FixedDate,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(requests.length + 1).padStart(12, "0")}` },
    fetch: async (url, options = {}) => {
      if (url.startsWith("/api/aprobaciones/cartera-mora?")) return response({
        ok: true, items: [credit], total: 1, page: 1, pageSize: 20, hasMore: false,
        allies: [{ id: 2, nombre: credit.aliadoNombre }], responsibles: [{ id: 17, nombre: "Marcos Gomez" }],
      });
      if (url === "/api/aprobaciones/cartera-mora/44" && (!options.method || options.method === "GET")) return response({
        ok: true, credit, currentResponsible: { id: currentUserId, nombre: "Marcos Gomez" }, history: [legacy],
        responsibles: [{ id: 17, nombre: "Marcos Gomez" }, { id: 99, nombre: "Otro usuario" }],
      });
      if (url === "/api/aprobaciones/cartera-mora/44" && options.method === "POST") {
        const input = JSON.parse(options.body);
        requests.push(input);
        return response({ ok: true, unchanged: false, item: {
          ...input, id: `new-${requests.length}`, creditoId: 44, responsibleName: "Marcos Gomez",
          actorUserId: 17, actorName: "Marcos Gomez", createdAt: "2026-10-09T14:00:00Z",
          resultCode: input.result, result: "Resultado guardado por el servidor",
        } });
      }
      throw new Error("Unexpected request: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/lib/analyst-mora-types") return typeModule.exports;
      if (name === "../mora-supports") return { default: MoraSupports };
      throw new Error("Unexpected import: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => {
    let count = 0;
    do {
      dirty = false; cursor = 0; tree = loaded.exports.default();
      effects.splice(0).forEach(callback => callback());
      if (++count > 20) throw new Error("Render did not settle");
    } while (dirty);
    return tree;
  };
  const find = predicate => nodes(tree).find(predicate);
  const field = id => find(item => item.props?.id === id);
  const form = () => find(item => item.type === "form" && item.props["aria-labelledby"] === "mora-management-form");
  const labelField = label => {
    const labelNode = nodes(form()).find(item => item.type === "label" && text(item.props.children).trim().startsWith(label));
    return nodes(labelNode).find(item => item.type === components.Input || item.type === components.Select || item.type === "textarea");
  };
  const change = (control, value) => { assert.ok(control, "el control debe estar visible"); control.props.onChange({ target: { value } }); render(); };
  async function settle() { for (let index = 0; index < 3; index++) { await setImmediate(); render(); } }
  async function open() {
    render(); await settle();
    const button = find(item => item.type === components.Button && text(item.props.children).trim() === "Gestionar");
    assert.ok(button); button.props.onClick(); await settle();
  }
  async function save() { await form().props.onSubmit({ preventDefault() {} }); await settle(); }
  function validManagement(result = "SIN_RESPUESTA") {
    change(field("mora-management-result"), result);
    change(labelField("Fecha y hora de gestión"), "2026-10-09T09:00");
    change(labelField("Comentario"), "Se registró la llamada y el resultado obtenido");
    change(labelField("Próxima gestión"), "2026-10-10T10:00");
    change(field("mora-management-status"), "SEGUIMIENTO");
  }
  const options = id => JSON.parse(JSON.stringify(nodes(field(id)?.props.children).filter(item => item.type === "option")
    .map(item => ({ value: item.props.value, label: text(item.props.children).trim() }))));
  return { open, save, validManagement, field, labelField, change, options, requests, text: () => text(tree), find, components };
}

test("la nueva gestión separa los dos medios de contacto, siete resultados y seis estados", async () => {
  const ui = harness(); await ui.open();
  assert.deepEqual(ui.options("mora-management-action"), [
    { value: "LLAMADA", label: "Llamada" }, { value: "MSJ_TEXTO", label: "Msj de texto" },
  ]);
  assert.deepEqual(ui.options("mora-management-result").filter(item => item.value), [
    { value: "MEDIOS_PAGO", label: "Medios de pago" },
    { value: "NUMERO_SIN_WHATSAPP", label: "Número sin WhatsApp" },
    { value: "SIN_RESPUESTA", label: "No contesta" },
    { value: "ACUERDO_PAGO", label: "Acuerdo de pago" },
    { value: "PAGO_REALIZADO", label: "Ya realizó el pago" },
    { value: "VISITA_PENDIENTE", label: "Visita pendiente" },
    { value: "PRORROGA_APROBADA", label: "Prórroga aprobada 4 días" },
  ]);
  assert.deepEqual(ui.options("mora-management-status"), [
    { value: "CONTACTADO", label: "Contactado" }, { value: "SIN_RESPUESTA", label: "Sin respuesta" },
    { value: "ACUERDO_PAGO", label: "Acuerdo de pago" }, { value: "CERRADO", label: "Cerrado" },
    { value: "SOLUCIONADO", label: "Solucionado" }, { value: "SEGUIMIENTO", label: "Seguimiento" },
  ]);
});

test("ambos medios muestran los mismos siete resultados en el orden solicitado y No contesta", async () => {
  const ui = harness(); await ui.open();
  const callResults = ui.options("mora-management-result").filter(item => item.value);
  ui.change(ui.field("mora-management-action"), "MSJ_TEXTO");
  assert.deepEqual(ui.options("mora-management-result").filter(item => item.value), callResults);
  assert.deepEqual(ui.options("mora-management-result").filter(item => item.value), [
    { value: "MEDIOS_PAGO", label: "Medios de pago" },
    { value: "NUMERO_SIN_WHATSAPP", label: "Número sin WhatsApp" },
    { value: "SIN_RESPUESTA", label: "No contesta" },
    { value: "ACUERDO_PAGO", label: "Acuerdo de pago" },
    { value: "PAGO_REALIZADO", label: "Ya realizó el pago" },
    { value: "VISITA_PENDIENTE", label: "Visita pendiente" },
    { value: "PRORROGA_APROBADA", label: "Prórroga aprobada 4 días" },
  ]);
});

for (const result of ["MEDIOS_PAGO", "NUMERO_SIN_WHATSAPP"]) {
  test(`${result} se guarda con cualquiera de los dos medios y se conserva al cambiar de medio`, async () => {
    const ui = harness(); await ui.open();
    ui.change(ui.field("mora-management-action"), "MSJ_TEXTO");
    ui.validManagement(result);
    await ui.save();
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].action, "MSJ_TEXTO");
    assert.equal(ui.requests[0].result, result);
    assert.ok(ui.requests[0].agreementDate == null);
    assert.ok(ui.requests[0].agreementAmount == null);
    ui.change(ui.field("mora-management-action"), "LLAMADA");
    assert.equal(ui.field("mora-management-result").props.value, result);
    assert.equal(ui.options("mora-management-result").some(item => item.value === result), true);
    await ui.save();
    assert.equal(ui.requests.length, 2);
    assert.equal(ui.requests[1].action, "LLAMADA");
    assert.equal(ui.requests[1].result, result);
    assert.notEqual(ui.requests[1].idempotencyKey, ui.requests[0].idempotencyKey);
  });
}

test("acuerdo de pago exige fecha y valor positivo y guarda ambos como datos estructurados", async () => {
  const ui = harness(); await ui.open(); ui.validManagement("ACUERDO_PAGO");
  assert.equal(ui.field("mora-management-agreement-date").props.required, true);
  assert.equal(ui.field("mora-management-agreement-amount").props.required, true);
  await ui.save(); assert.equal(ui.requests.length, 0, "no guarda un acuerdo incompleto");
  ui.change(ui.field("mora-management-agreement-date"), "2026-10-12");
  ui.change(ui.field("mora-management-agreement-amount"), "0");
  await ui.save(); assert.equal(ui.requests.length, 0, "no guarda un acuerdo sin valor positivo");
  ui.change(ui.field("mora-management-agreement-amount"), "125000");
  await ui.save(); assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].result, "ACUERDO_PAGO");
  assert.equal(ui.requests[0].agreementDate, "2026-10-12");
  assert.equal(ui.requests[0].agreementAmount, 125000);
  assert.equal(ui.requests[0].responsibleUserId, 17);
  assert.equal(ui.requests[0].actedAt, "2026-10-09T09:00:00-05:00");
  assert.equal(ui.requests[0].nextFollowUpAt, "2026-10-10T10:00:00-05:00");
  assert.match(ui.text(), /Gestión guardada/);
});

test("acuerdo de pago no admite una fecha inexistente ni anterior a la gestión", async () => {
  const ui = harness(); await ui.open(); ui.validManagement("ACUERDO_PAGO");
  ui.change(ui.field("mora-management-agreement-amount"), "125000");
  for (const value of ["2026-10-08", "2026-02-30", "2026-13-12"]) {
    ui.change(ui.field("mora-management-agreement-date"), value);
    await ui.save();
    assert.equal(ui.requests.length, 0, `no guarda la fecha inválida ${value}`);
  }
});

test("el resultado es obligatorio y no acepta texto libre en lugar de una opción", async () => {
  const ui = harness(); await ui.open(); ui.validManagement();
  for (const value of ["", "El cliente no contesta"]) {
    ui.change(ui.field("mora-management-result"), value);
    await ui.save();
    assert.equal(ui.requests.length, 0);
    assert.match(ui.text(), /Completa.*resultado/);
  }
});

for (const result of ["PAGO_REALIZADO", "SIN_RESPUESTA", "VISITA_PENDIENTE", "PRORROGA_APROBADA"]) {
  test(`${result} se registra sin exigir fecha o valor de acuerdo`, async () => {
    const ui = harness(); await ui.open(); ui.validManagement(result);
    assert.equal(ui.field("mora-management-agreement-date"), undefined);
    assert.equal(ui.field("mora-management-agreement-amount"), undefined);
    await ui.save();
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].result, result);
    assert.ok(ui.requests[0].agreementDate == null);
    assert.ok(ui.requests[0].agreementAmount == null);
  });
}

test("cambiar un acuerdo a otro resultado no envía ni recupera fecha o valor antiguos", async () => {
  const ui = harness(); await ui.open(); ui.validManagement("ACUERDO_PAGO");
  ui.change(ui.field("mora-management-agreement-date"), "2026-10-12");
  ui.change(ui.field("mora-management-agreement-amount"), "125000");
  ui.change(ui.field("mora-management-result"), "SIN_RESPUESTA");
  assert.equal(ui.field("mora-management-agreement-date"), undefined);
  assert.equal(ui.field("mora-management-agreement-amount"), undefined);
  await ui.save(); assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].result, "SIN_RESPUESTA");
  assert.ok(ui.requests[0].agreementDate == null);
  assert.ok(ui.requests[0].agreementAmount == null);
  ui.change(ui.field("mora-management-result"), "ACUERDO_PAGO");
  assert.equal(ui.field("mora-management-agreement-date").props.value, "");
  assert.equal(ui.field("mora-management-agreement-amount").props.value, "");
});

test("el resumen muestra los dos teléfonos de referencia disponibles", async () => {
  const ui = harness(); await ui.open();
  assert.match(ui.text(), /3001112233/);
  assert.match(ui.text(), /3014445566/);
});

test("una referencia ausente no se presenta como un teléfono adicional vacío", async () => {
  const ui = harness({ firstReference: null, secondReference: "3014445566" }); await ui.open();
  const summary = ui.find(item => item.type === "section" && item.props["aria-labelledby"] === "mora-credit-summary");
  const dtLabels = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (value.type === "dt") dtLabels.push(value.props.children);
    walk(value.props?.children);
  };
  walk(summary);
  assert.equal(dtLabels.filter(label => /referencia/i.test(String(label))).length, 1);
  assert.match(ui.text(), /3014445566/);
  assert.doesNotMatch(ui.text(), /3001112233/);
});

test("sin teléfonos de referencia no aparecen referencias vacías en el resumen", async () => {
  const ui = harness({ firstReference: null, secondReference: null }); await ui.open();
  const summary = ui.find(item => item.type === "section" && item.props["aria-labelledby"] === "mora-credit-summary");
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? text(value.props?.children) : "";
  assert.doesNotMatch(text(summary), /referencia/i);
  assert.match(text(summary), /3209998877/, "el teléfono propio del cliente se conserva");
});

test("el historial conserva acciones, estados y resultados escritos antes del cambio", async () => {
  const ui = harness(); await ui.open();
  assert.match(ui.text(), /WhatsApp/);
  assert.match(ui.text(), /Promesa de pago/);
  assert.match(ui.text(), /Prometió abonar cuando reciba su nómina/);
  assert.match(ui.text(), /Registro histórico que debe conservarse/);
  ui.validManagement("PAGO_REALIZADO"); await ui.save();
  assert.equal(ui.requests.length, 1);
  assert.match(ui.text(), /Prometió abonar cuando reciba su nómina/);
  assert.match(ui.text(), /Resultado guardado por el servidor/);
});

test("el responsable nominal permanece protegido y la próxima gestión debe ser posterior", async () => {
  const ui = harness(); await ui.open(); ui.validManagement();
  const responsible = ui.labelField("Responsable");
  assert.equal(responsible.props.value, "Marcos Gomez");
  assert.equal(responsible.props.readOnly, true);
  ui.change(ui.labelField("Próxima gestión"), "2026-10-09T08:59");
  await ui.save(); assert.equal(ui.requests.length, 0);
  assert.match(ui.text(), /La próxima gestión debe programarse después/);
  ui.change(ui.labelField("Próxima gestión"), "2026-10-10T10:00");
  await ui.save(); assert.equal(ui.requests[0].responsibleUserId, 17);
});

test("no se registra una gestión sin un responsable nominal válido", async () => {
  const ui = harness({ currentUserId: 0 }); await ui.open(); ui.validManagement();
  await ui.save(); assert.equal(ui.requests.length, 0);
  assert.match(ui.text(), /responsable/);
});
