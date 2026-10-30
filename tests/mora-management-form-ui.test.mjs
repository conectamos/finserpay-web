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

function harness({ firstReference = "3001112233", secondReference = "3014445566", currentUserId = 17,
  creditOverrides = {}, detailOverrides = {}, deferSave = false, listTotal = 1, scope = "overdue", initialCreditId = null,
  extensionActions = { canEdit: true, canCancel: true, centralAdmin: false, minExpiresOn: "2026-10-09", maxExpiresOn: "2026-10-10", editBlockedReason: null } } = {}) {
  const componentNames = ["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState", "PageHeader", "Select", "StatusPill"];
  const components = Object.fromEntries(componentNames.map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const MoraSupports = () => null;
  const FinserSidePanel = Object.defineProperty(() => null, "name", { value: "FinserSidePanel" });
  const MoraPortfolioExtensionActions = Object.defineProperty(() => null, "name", { value: "MoraPortfolioExtensionActions" });
  const CreditCommunications = Object.defineProperty(() => null, "name", { value: "CreditCommunications" });
  const stubComponents = new Set([...Object.values(components), MoraSupports, FinserSidePanel, MoraPortfolioExtensionActions, CreditCommunications]);
  const node = (type, props) => type === FinserSidePanel && !props.open ? null :
    typeof type === "function" && !stubComponents.has(type) ? type(props) : ({ type, props });
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
    prorrogaActiva: null, estadoGestion: "PROMESA_PAGO", estadoCartera: "EN_MORA", saldoPendiente: 1200000,
    fechaProximoPago: "2026-10-17", ...creditOverrides,
  };
  const detailCredit = { ...credit, ...detailOverrides };
  const requests = [];
  const savedEvents = [];
  const fetchRequests = [];
  const pendingSaves = [];
  const response = payload => ({ ok: true, json: async () => payload });
  const apiBase = scope === "all" ? "/api/aprobaciones/gestion-cartera" : "/api/aprobaciones/cartera-mora";
  const loaded = { exports: {} };
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : ["2026-10-09T14:00:00Z"])); }
    static now() { return Date.parse("2026-10-09T14:00:00Z"); }
  }
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, URLSearchParams, Intl, Date: FixedDate,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(requests.length + 1).padStart(12, "0")}` },
    fetch: async (url, options = {}) => {
      fetchRequests.push({ url, method: options.method || "GET", cache: options.cache });
      if (url.startsWith(`${apiBase}?`)) {
        const query = new URLSearchParams(url.split("?")[1]);
        const currentPage = Number(query.get("page") || 1);
        const excluded = (query.get("status") === "PRORROGA" && !credit.prorrogaActiva) ||
          (query.get("financialStatus") && query.get("financialStatus") !== credit.estadoCartera);
        return response({ ok: true, items: excluded ? [] : [{ ...credit }],
          total: listTotal, page: currentPage, pageSize: 20, hasMore: currentPage * 20 < listTotal,
          counts: { total: listTotal, enMora: credit.estadoCartera === "EN_MORA" ? listTotal : 0,
            alDia: credit.estadoCartera === "AL_DIA" ? listTotal : 0, pagados: credit.estadoCartera === "PAGADO" ? listTotal : 0,
            anulados: credit.estadoCartera === "ANULADO" ? listTotal : 0 },
          allies: [{ id: 2, nombre: credit.aliadoNombre }], responsibles: [{ id: 17, nombre: "Marcos Gomez" }],
        });
      }
      if (url === `${apiBase}/44` && (!options.method || options.method === "GET")) return response({
        ok: true, credit: { ...detailCredit }, currentResponsible: { id: currentUserId, nombre: "Marcos Gomez" }, history: [...savedEvents, legacy],
        extensionActions,
        responsibles: [{ id: 17, nombre: "Marcos Gomez" }, { id: 99, nombre: "Otro usuario" }],
      });
      if (url === `${apiBase}/44` && options.method === "POST") {
        const input = JSON.parse(options.body);
        requests.push(input);
        if (deferSave) await new Promise(resolve => pendingSaves.push(resolve));
        const item = {
          ...input, id: `new-${requests.length}`, creditoId: 44, responsibleName: "Marcos Gomez",
          actorUserId: 17, actorName: "Marcos Gomez", createdAt: "2026-10-09T14:00:00Z",
          resultCode: input.result, result: "Resultado guardado por el servidor",
        };
        savedEvents.unshift(item);
        Object.assign(credit, { ultimaGestion: item, estadoGestion: credit.prorrogaActiva ? "PRORROGA" : item.managementStatus });
        Object.assign(detailCredit, { estadoGestion: detailCredit.prorrogaActiva ? "PRORROGA" : item.managementStatus });
        return response({ ok: true, unchanged: false, item });
      }
      throw new Error("Unexpected request: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-side-panel") return { default: FinserSidePanel, FinserSidePanel };
      if (name === "@/lib/analyst-mora-types") return typeModule.exports;
      if (name === "../mora-supports") return { default: MoraSupports };
      if (name === "./mora-portfolio-extension-actions") return { default: MoraPortfolioExtensionActions };
      if (name === "../gestion-cartera/credit-communications") return { default: CreditCommunications };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error("Unexpected import: " + name);
    },
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children), ...nodes(value.props?.actions)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => {
    let count = 0;
    do {
      dirty = false; cursor = 0; tree = loaded.exports.default({ scope, initialCreditId });
      effects.splice(0).forEach(callback => callback());
      if (++count > 20) throw new Error("Render did not settle");
    } while (dirty);
    return tree;
  };
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(item => item.type === components.Button && text(item.props.children).trim() === label);
  const field = id => find(item => item.props?.id === id);
  const form = () => find(item => item.type === "form" && item.props["aria-labelledby"] === "mora-management-form");
  const labelField = label => {
    const labelNode = nodes(form()).find(item => item.type === "label" && text(item.props.children).trim().startsWith(label));
    return nodes(labelNode).find(item => item.type === components.Input || item.type === components.Select || item.type === "textarea");
  };
  const filterForm = () => find(item => item.type === "form" && item.props["aria-label"] ===
    (scope === "all" ? "Filtros de gestión de cartera" : "Filtros de cartera en mora"));
  const filterField = label => {
    const labelNode = nodes(filterForm()).find(item => item.type === "label" && text(item.props.children).trim().startsWith(label));
    return nodes(labelNode).find(item => item.type === components.Input || item.type === components.Select);
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
  return { open, save, validManagement, field, labelField, filterField, filterForm, change, options, requests, fetchRequests,
    text: () => text(tree), nodeText: text, nodes, find, button, components, render, settle,
    setCredit: values => Object.assign(credit, values), setDetailCredit: values => Object.assign(detailCredit, values),
    setListTotal: value => { listTotal = value; },
    releaseSaves: () => pendingSaves.splice(0).forEach(resolve => resolve()),
    row: () => find(item => item.type === "tr" && text(item).includes(credit.numeroCreditoVisible)),
    sidePanel: () => find(item => item.type === FinserSidePanel),
    extensionActions: () => find(item => item.type === MoraPortfolioExtensionActions),
    communications: () => find(item => item.type === CreditCommunications),
  };
}

test("el enlace desde Atención abre el muro del crédito sin registrar otra gestión y permite cerrarlo", async () => {
  const ui = harness({ scope: "all", initialCreditId: 44 });
  ui.render(); await ui.settle();
  assert.ok(ui.sidePanel()?.props.open);
  assert.match(ui.text(), /Registro histórico que debe conservarse/);
  assert.equal(ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/gestion-cartera/44").length, 1);
  assert.ok(ui.fetchRequests.every(item => item.method === "GET"));
  assert.equal(ui.requests.length, 0);
  ui.sidePanel().props.onClose(); ui.render(); await ui.settle();
  assert.ok(!ui.sidePanel());
  assert.equal(ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/gestion-cartera/44").length, 1);
});

test("un enlace inválido o una cartera de mora no abre automáticamente otro expediente", async () => {
  for (const options of [{ scope: "all", initialCreditId: -1 }, { scope: "all", initialCreditId: 1.5 }, { scope: "overdue", initialCreditId: 44 }]) {
    const ui = harness(options); ui.render(); await ui.settle();
    assert.ok(!ui.sidePanel());
    assert.ok(ui.fetchRequests.every(item => item.url.includes("?")));
    assert.equal(ui.requests.length, 0);
  }
});

test("la nueva gestión conserva los dos medios de contacto, los resultados actuales y seis estados", async () => {
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
    { value: "LLAMADA_INCOMPLETA", label: "Llamada incompleta" },
  ]);
  assert.deepEqual(ui.options("mora-management-status"), [
    { value: "CONTACTADO", label: "Contactado" }, { value: "SIN_RESPUESTA", label: "Sin respuesta" },
    { value: "ACUERDO_PAGO", label: "Acuerdo de pago" }, { value: "CERRADO", label: "Cerrado" },
    { value: "SOLUCIONADO", label: "Solucionado" }, { value: "SEGUIMIENTO", label: "Seguimiento" },
  ]);
});

test("ambos medios conservan los mismos resultados en el orden actual y No contesta", async () => {
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
    { value: "LLAMADA_INCOMPLETA", label: "Llamada incompleta" },
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

const activeExtension = {
  id: "extension-active-44", expiresOn: "2026-10-10", reason: "Compromiso autorizado hasta el sábado",
  approvedAt: "2026-10-09T08:30:00-05:00", approvedByName: "Responsable autorizado",
  installmentNumber: 3, installmentDueDate: "2026-10-06",
};

const rowStatus = ui => [...new Set(ui.nodes(ui.row()).filter(item => item.type === ui.components.StatusPill)
  .map(item => ui.nodeText(item).trim()))];

test("la mesa agrupa la información sin abrir formularios antes de seleccionar un crédito", async () => {
  const ui = harness(); ui.render(); await ui.settle();
  assert.equal(ui.sidePanel(), undefined);
  assert.equal(ui.field("mora-management-action"), undefined);
  const headings = ui.nodes(ui.find(item => item.type === "table")).filter(item => item.type === "th");
  assert.equal(headings.length, 7, "la mesa presenta columnas agrupadas y abre el resto del detalle bajo demanda");
  for (const value of ["0100000044", "Cliente de prueba", "111222333", "Aliado de prueba", "IPHONE 13 128GB", "351168083278358", "Analista anterior"]) {
    assert.ok(ui.nodeText(ui.row()).includes(value), `el listado conserva ${value}`);
  }
});

test("una prórroga vigente muestra Prórroga y su vencimiento en la fila y el panel", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  await ui.open();
  assert.deepEqual(rowStatus(ui), ["Prórroga"]);
  assert.match(ui.nodeText(ui.row()), /10.*2026/, "el vencimiento debe verse sin abrir el crédito");
  assert.ok(ui.sidePanel(), "el detalle se abre en el panel compartido");
  const panelText = ui.nodeText(ui.sidePanel());
  assert.match(panelText, /Prórroga activa/);
  assert.match(panelText, /10.*2026/);
  assert.match(panelText, /Compromiso autorizado hasta el sábado/);
  assert.match(panelText, /Responsable autorizado/);
  assert.doesNotMatch(ui.options("mora-management-status").map(item => item.value).join(" "), /PRORROGA/,
    "Prórroga es el estado derivado de una autorización vigente y no un estado manual de gestión");
});

test("sin autorización vigente el resultado histórico no se presenta como Prórroga", async () => {
    const ui = harness({ creditOverrides: {
      prorrogaActiva: null, estadoGestion: "SEGUIMIENTO",
      ultimaGestion: { managementStatus: "SEGUIMIENTO", result: "Prórroga aprobada 4 días", resultCode: "PRORROGA_APROBADA" },
    } });
    await ui.open();
    assert.deepEqual(rowStatus(ui), ["Seguimiento"]);
    assert.doesNotMatch(ui.nodeText(ui.sidePanel()), /Prórroga activa/);
    assert.match(ui.nodeText(ui.row()), /Prórroga aprobada 4 días/, "se conserva el resultado histórico sin inventar una prórroga vigente");
});

test("un estado Prórroga obsoleto sin autorización vuelve al estado real de la gestión", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: null, estadoGestion: "PRORROGA",
    ultimaGestion: { managementStatus: "SIN_RESPUESTA", result: "No contesta" } } });
  await ui.open();
  assert.deepEqual(rowStatus(ui), ["Sin respuesta"]);
  assert.doesNotMatch(ui.nodeText(ui.sidePanel()), /Prórroga activa/);
});

test("la autorización central sin vencimiento muestra Sin fecha límite sin inventar una fecha", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: { ...activeExtension, expiresOn: null }, estadoGestion: "PRORROGA" } });
  await ui.open();
  assert.deepEqual(rowStatus(ui), ["Prórroga"]);
  assert.match(ui.nodeText(ui.row()), /Sin fecha límite/);
  assert.match(ui.nodeText(ui.sidePanel()), /Sin fecha límite/);
  assert.doesNotMatch(ui.nodeText(ui.sidePanel()), /1970|Invalid Date/);
});

test("el filtro Prórroga envía PRORROGA al servidor y conserva los otros filtros operativos", async () => {
  const ui = harness(); await ui.open();
  const statusOptions = ui.nodes(ui.filterField("Estado")).filter(item => item.type === "option");
  assert.ok(statusOptions.some(item => item.props.value === "PRORROGA" && ui.nodeText(item) === "Prórroga"));
  for (const [label, value] of Object.entries({ Buscar: "111222333", Aliado: "2", Responsable: "17", Estado: "PRORROGA", "Próxima gestión": "2026-10-10", "Mora desde": "5", "Mora hasta": "20" })) {
    ui.change(ui.filterField(label), value);
  }
  ui.filterForm().props.onSubmit({ preventDefault() {} }); await ui.settle();
  const listRequests = ui.fetchRequests.filter(item => item.url.startsWith("/api/aprobaciones/cartera-mora?"));
  const query = new URLSearchParams(listRequests.at(-1).url.split("?")[1]);
  assert.equal(query.get("status"), "PRORROGA");
  assert.equal(query.get("q"), "111222333"); assert.equal(query.get("ally"), "2");
  assert.equal(query.get("responsible"), "17"); assert.equal(query.get("followUp"), "2026-10-10");
  assert.equal(query.get("minDays"), "5"); assert.equal(query.get("maxDays"), "20");
  assert.equal(listRequests.at(-1).cache, "no-store");
});

test("Actualizar retira la prórroga cancelada de lista y detalle sin borrar una gestión en edición", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  await ui.open(); ui.validManagement();
  const comment = ui.labelField("Comentario").props.value;
  ui.setCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" });
  ui.setDetailCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" });
  const beforeDetailLoads = ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/cartera-mora/44").length;
  ui.button("Actualizar").props.onClick(); await ui.settle();
  assert.deepEqual(rowStatus(ui), ["Seguimiento"]);
  assert.doesNotMatch(ui.nodeText(ui.sidePanel()), /Prórroga activa/);
  assert.equal(ui.labelField("Comentario").props.value, comment);
  const detailLoads = ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/cartera-mora/44");
  assert.ok(detailLoads.length > beforeDetailLoads, "la actualización consulta también la autorización del detalle abierto");
  assert.ok(detailLoads.every(item => item.cache === "no-store"));
});

test("guardar el resultado Prórroga aprobada no crea una autorización inexistente ni duplica la gestión", async () => {
  const ui = harness({ deferSave: true }); await ui.open(); ui.validManagement("PRORROGA_APROBADA");
  const firstSave = ui.save(); ui.render();
  assert.equal(ui.requests.length, 1);
  await ui.save();
  assert.equal(ui.requests.length, 1, "no hay una segunda solicitud mientras se guarda");
  ui.releaseSaves(); await firstSave;
  assert.equal(ui.requests.length, 1);
  assert.ok(!rowStatus(ui).includes("Prórroga"), "solo la autorización vigente puede convertir el estado en Prórroga");
  assert.doesNotMatch(ui.nodeText(ui.sidePanel()), /Prórroga activa/);
  await ui.save();
  assert.equal(ui.requests.length, 1, "no se duplica la misma gestión después de guardar");
});

test("las acciones de prórroga están en el detalle seleccionado y reciben los permisos del servidor", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  ui.render(); await ui.settle();
  assert.equal(ui.extensionActions(), undefined, "no hay formularios ni acciones de otro crédito antes de seleccionarlo");
  await ui.open();
  const action = ui.extensionActions();
  assert.ok(action, "el panel operativo contiene las acciones sin navegar a otro módulo");
  assert.equal(action.props.creditId, 44);
  assert.equal(action.props.extension.id, activeExtension.id);
  assert.equal(action.props.capabilities.canEdit, true);
  assert.equal(action.props.capabilities.canCancel, true);
  assert.equal(action.props.capabilities.centralAdmin, false, "el analista también puede gestionar una prórroga autorizada");
});

test("editar o cancelar una prórroga actualiza lista y detalle conservando la gestión manual en edición", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  await ui.open(); ui.validManagement("ACUERDO_PAGO");
  ui.change(ui.field("mora-management-agreement-date"), "2026-10-12");
  ui.change(ui.field("mora-management-agreement-amount"), "125000");
  const comment = ui.labelField("Comentario").props.value;
  const listLoads = ui.fetchRequests.filter(item => item.url.startsWith("/api/aprobaciones/cartera-mora?")).length;
  const detailLoads = ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/cartera-mora/44").length;
  ui.setCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" });
  ui.setDetailCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" });
  await ui.extensionActions().props.onChanged({ item: { id: activeExtension.id, creditoId: 44, status: "CANCELLED", version: 2 }, message: "Prórroga cancelada.", warning: null });
  await ui.settle();
  assert.deepEqual(rowStatus(ui), ["Seguimiento"]);
  assert.equal(ui.extensionActions(), undefined);
  assert.equal(ui.field("mora-management-agreement-date").props.value, "2026-10-12");
  assert.equal(ui.field("mora-management-agreement-amount").props.value, "125000");
  assert.equal(ui.labelField("Comentario").props.value, comment);
  assert.ok(ui.fetchRequests.filter(item => item.url.startsWith("/api/aprobaciones/cartera-mora?")).length > listLoads);
  assert.ok(ui.fetchRequests.filter(item => item.url === "/api/aprobaciones/cartera-mora/44").length > detailLoads);
  assert.equal(ui.requests.length, 0, "editar la prórroga no guarda ni altera la gestión manual");
});

test("guardar la prórroga bloquea el cierre, la navegación y el guardado simultáneo de gestión", async () => {
  const ui = harness({ creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  await ui.open(); ui.validManagement();
  ui.extensionActions().props.onBusyChange(true); ui.render();
  assert.equal(ui.sidePanel().props.busy, true);
  assert.equal(ui.button("Actualizar").props.disabled, true);
  assert.equal(ui.button("Guardar gestión").props.disabled, true);
  assert.equal(ui.field("mora-management-result").props.disabled, true);
  ui.sidePanel().props.onClose(); ui.render(); assert.ok(ui.sidePanel(), "el panel no se cierra con un cambio en curso");
  await ui.save(); assert.equal(ui.requests.length, 0, "el guardado manual no compite con la autorización");
  ui.extensionActions().props.onBusyChange(false); ui.render();
  assert.equal(ui.sidePanel().props.busy, false);
  await ui.save(); assert.equal(ui.requests.length, 1, "después del cambio se permite guardar el borrador manual");
});

test("cancelar la última prórroga de una página filtrada regresa a una página válida y conserva el detalle", async () => {
  const ui = harness({ listTotal: 21, creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } });
  await ui.open();
  ui.change(ui.filterField("Estado"), "PRORROGA"); ui.filterForm().props.onSubmit({ preventDefault() {} }); await ui.settle();
  ui.button("Siguiente").props.onClick(); await ui.settle();
  let latestList = ui.fetchRequests.filter(item => item.url.startsWith("/api/aprobaciones/cartera-mora?")).at(-1);
  assert.equal(new URLSearchParams(latestList.url.split("?")[1]).get("page"), "2");
  ui.validManagement(); const comment = ui.labelField("Comentario").props.value;
  ui.setCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" });
  ui.setDetailCredit({ prorrogaActiva: null, estadoGestion: "SEGUIMIENTO" }); ui.setListTotal(20);
  await ui.extensionActions().props.onChanged({ item: { id: activeExtension.id, creditoId: 44, status: "CANCELLED", version: 2 }, message: "Prórroga cancelada.", warning: null });
  await ui.settle();
  latestList = ui.fetchRequests.filter(item => item.url.startsWith("/api/aprobaciones/cartera-mora?")).at(-1);
  const query = new URLSearchParams(latestList.url.split("?")[1]);
  assert.equal(query.get("status"), "PRORROGA"); assert.equal(query.get("page"), "1");
  assert.equal(ui.row(), undefined, "la prórroga cancelada deja el filtro de vigentes");
  assert.ok(ui.sidePanel(), "el detalle del crédito sigue abierto");
  assert.equal(ui.labelField("Comentario").props.value, comment);
});

const financialView = (ui, label) => ui.find(item => item.type === "button" && item.props.type === "button" &&
  Object.hasOwn(item.props, "aria-pressed") && ui.nodeText(item).trim().startsWith(label));

test("Gestión de cartera consulta todos los créditos y separa estado financiero de seguimiento", async () => {
  const ui = harness({ scope: "all" }); ui.render(); await ui.settle();
  assert.equal(ui.find(item => item.type === ui.components.PageHeader).props.title, "Gestión de cartera");
  assert.ok(ui.fetchRequests.some(item => item.url === "/api/aprobaciones/gestion-cartera?page=1"));
  assert.ok(ui.fetchRequests.every(item => !item.url.includes("/cartera-mora")), "el módulo completo no hereda el filtro de mora");
  for (const label of ["Todos", "En mora", "Al día", "Pagados", "Anulados"]) assert.ok(financialView(ui, label), label);
  const headings = ui.nodes(ui.find(item => item.type === "table")).filter(item => item.type === "th").map(ui.nodeText);
  assert.ok(headings.includes("Estado de cartera")); assert.ok(headings.includes("Estado de gestión"));
  assert.ok(ui.filterField("Estado de gestión"));
  assert.equal(ui.communications(), undefined, "no se ofrecen envíos sin seleccionar un crédito");
});

test("pasar de mora a estar al día conserva la misma línea de tiempo y permite añadir seguimiento", async () => {
  const ui = harness({ scope: "all" }); await ui.open();
  const oldHistory = "Registro histórico que debe conservarse";
  assert.match(ui.nodeText(ui.sidePanel()), new RegExp(oldHistory));
  ui.validManagement("PAGO_REALIZADO"); await ui.save();
  assert.equal(ui.requests.length, 1);
  ui.setCredit({ estadoCartera: "AL_DIA", enMora: false, diasMora: 0, valorVencido: 0 });
  ui.setDetailCredit({ estadoCartera: "AL_DIA", enMora: false, diasMora: 0, valorVencido: 0 });
  ui.button("Actualizar").props.onClick(); await ui.settle();
  assert.ok(ui.row(), "el crédito sigue en el listado cuando deja de estar en mora");
  assert.match(ui.nodeText(ui.row()), /Al día/);
  assert.doesNotMatch(ui.nodeText(ui.row()), /0 días en mora/);
  assert.match(ui.nodeText(ui.sidePanel()), new RegExp(oldHistory));
  assert.match(ui.nodeText(ui.sidePanel()), /Resultado guardado por el servidor/);
  ui.validManagement("RECORDATORIO_PAGO");
  ui.change(ui.field("mora-management-action"), "MSJ_TEXTO");
  ui.change(ui.labelField("Comentario"), "Recordatorio de la próxima cuota, crédito ya al día");
  await ui.save();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].result, "RECORDATORIO_PAGO");
  const history = ui.find(item => item.type === "section" && item.props["aria-labelledby"] === "mora-history-title");
  const events = ui.nodes(history).filter(item => item.type === "li");
  assert.equal(events.length, 3, "el registro histórico, el pago y el recordatorio permanecen juntos");
  assert.equal(events.filter(item => ui.nodeText(item).includes(oldHistory)).length, 1);
  assert.match(ui.nodeText(history), /Recordatorio de la próxima cuota, crédito ya al día/);
  assert.ok(ui.fetchRequests.every(item => !item.url.includes("/cartera-mora")));
});

test("los créditos pagados y anulados siguen disponibles para consultar o registrar su historial", async () => {
  for (const estadoCartera of ["PAGADO", "ANULADO"]) {
    const ui = harness({ scope: "all", creditOverrides: { estadoCartera, enMora: false, diasMora: 0, valorVencido: 0, saldoPendiente: 0 } });
    await ui.open();
    assert.match(ui.nodeText(ui.row()), estadoCartera === "PAGADO" ? /Pagado/ : /Anulado/);
    assert.match(ui.nodeText(ui.row()), /Historial disponible/);
    assert.match(ui.nodeText(ui.sidePanel()), /Registro histórico que debe conservarse/);
    ui.validManagement("PAGO_REALIZADO"); await ui.save();
    assert.equal(ui.requests.length, 1);
    assert.match(ui.nodeText(ui.sidePanel()), /Resultado guardado por el servidor/);
    assert.match(ui.nodeText(ui.sidePanel()), /Registro histórico que debe conservarse/);
  }
});

test("filtrar Al día no sustituye el estado de gestión y Todos recupera el alcance financiero", async () => {
  const ui = harness({ scope: "all", creditOverrides: { estadoCartera: "AL_DIA", enMora: false, diasMora: 0, valorVencido: 0 } });
  await ui.open();
  ui.change(ui.filterField("Estado de gestión"), "SEGUIMIENTO");
  ui.change(ui.filterField("Buscar"), "111222333");
  ui.filterForm().props.onSubmit({ preventDefault() {} }); await ui.settle();
  financialView(ui, "Al día").props.onClick(); await ui.settle();
  let query = new URLSearchParams(ui.fetchRequests.filter(item => item.url.includes("gestion-cartera?")).at(-1).url.split("?")[1]);
  assert.equal(query.get("financialStatus"), "AL_DIA"); assert.equal(query.get("status"), "SEGUIMIENTO");
  assert.equal(query.get("q"), "111222333");
  assert.equal(financialView(ui, "Al día").props["aria-pressed"], true);
  financialView(ui, "Todos").props.onClick(); await ui.settle();
  query = new URLSearchParams(ui.fetchRequests.filter(item => item.url.includes("gestion-cartera?")).at(-1).url.split("?")[1]);
  assert.equal(query.has("financialStatus"), false);
  assert.equal(query.get("status"), "SEGUIMIENTO");
  assert.equal(financialView(ui, "Todos").props["aria-pressed"], true);
});

test("Recordatorio de pago está disponible en todos los créditos y conserva el contrato anterior de mora", async () => {
  const all = harness({ scope: "all" }); await all.open();
  assert.ok(all.options("mora-management-result").some(item => item.value === "RECORDATORIO_PAGO" && item.label === "Recordatorio de pago"));
  all.validManagement("RECORDATORIO_PAGO"); await all.save();
  assert.equal(all.requests[0].result, "RECORDATORIO_PAGO");
  assert.equal(all.fetchRequests.filter(item => item.method === "POST").length, 1, "registrar una gestión no dispara una llamada ni un mensaje");
  assert.match(all.nodeText(all.sidePanel()), /Guardar este formulario no envía una comunicación/);
  const overdue = harness(); await overdue.open();
  assert.equal(overdue.options("mora-management-result").some(item => item.value === "RECORDATORIO_PAGO"), false);
  assert.equal(overdue.communications(), undefined);
});

test("iniciar comunicaciones usa el crédito seleccionado, bloquea operaciones simultáneas y conserva el borrador manual", async () => {
  const ui = harness({ scope: "all", creditOverrides: { prorrogaActiva: activeExtension, estadoGestion: "PRORROGA" } }); await ui.open(); ui.validManagement();
  const draft = ui.labelField("Comentario").props.value;
  const communications = ui.communications();
  assert.equal(communications.props.creditId, 44);
  assert.equal(communications.props.phone, "3209998877");
  communications.props.onBusyChange(true); ui.render();
  assert.equal(ui.sidePanel().props.busy, true);
  assert.equal(ui.extensionActions().props.disabled, true, "la comunicación impide editar la prórroga simultáneamente");
  await ui.save(); assert.equal(ui.requests.length, 0);
  ui.sidePanel().props.onClose(); ui.render(); assert.ok(ui.sidePanel());
  ui.communications().props.onBusyChange(false); ui.render();
  assert.equal(ui.extensionActions().props.disabled, false);
  const loadsBefore = ui.fetchRequests.length;
  ui.communications().props.onChanged(); await ui.settle();
  assert.ok(ui.fetchRequests.length > loadsBefore);
  assert.equal(ui.labelField("Comentario").props.value, draft);
  assert.match(ui.nodeText(ui.sidePanel()), /Registro histórico que debe conservarse/);
  assert.equal(ui.requests.length, 0, "la actualización del proveedor no guarda el borrador manual");
});
