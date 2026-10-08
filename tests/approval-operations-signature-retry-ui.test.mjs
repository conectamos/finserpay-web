import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/aprobaciones/approval-operations.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(firstOutcome, { refreshFails = false } = {}) {
  const components = Object.fromEntries(["Badge", "Button", "Card", "Input", "LoadingState", "PageHeader", "Select", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null;
  const node = (type, props) => ({ type, props });
  const slots = [];
  let cursor = 0, tree, attempts = 0, uuidCalls = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect() { cursor++; },
  };
  const detail = {
    kind: "DRAFT", id: 44, number: "SOL-44", clientName: "Cliente corregido", document: "12345678",
    phone: "3001234567", email: "qa@example.test", status: "EN_FIRMA", equipment: "iPhone QA",
    imei: "111111111111111", updatedAt: "2026-10-08T12:00:00Z", timeline: [],
    signature: { status: "TECHNICAL_ERROR", rawStatus: "FAILED", processUuid: "source-44",
      sentPhone: "3001234567", sentEmail: "qa@example.test", sentAt: "2026-10-08T12:00:00Z", signedAt: null },
    enrollmentReviewId: null, requiresEnrollmentReapproval: false, pendingVersion: null,
    replacement: null, remission: null,
    capabilities: { preSettlementApprovalCreditId: null, canChangeImei: false,
      canDispatchSignatureWithImei: false, canFinalizeImei: false, canConfirmReplacement: false,
      canUpdateContact: false, canSendSignature: false, canResendSignature: true, reason: null },
  };
  const requests = [];
  const response = payload => ({ ok: true, json: async () => payload });
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date,
    crypto: { randomUUID: () => `operation-${++uuidCalls}` },
    fetch: async (url, options = {}) => {
      if (url.startsWith("/api/aprobaciones/operativo?q=")) return response({ ok: true, items: [detail] });
      if (url === "/api/aprobaciones/operativo/draft/44" && (!options.method || options.method === "GET")) {
        if (refreshFails && attempts === 1) throw new Error("No se pudo consultar el estado");
        return response({ ok: true, item: detail });
      }
      if (url === "/api/aprobaciones/operativo/draft/44/firma" && options.method === "POST") {
        const body = JSON.parse(options.body);
        requests.push(body);
        attempts++;
        if (attempts === 1) {
          if (firstOutcome === "NETWORK_ERROR") throw new Error("Se perdió la respuesta del envío");
          return response({ ok: true, operation: { id: body.idempotencyKey, status: firstOutcome,
            message: `Resultado de envío: ${firstOutcome}` } });
        }
        detail.signature = { ...detail.signature, status: "PENDING", rawStatus: "CREATED", processUuid: "new-44" };
        detail.capabilities.canResendSignature = false;
        return response({ ok: true, operation: { id: body.idempotencyKey, status: "AWAITING_SIGNATURE",
          message: "Nueva firma pendiente" } });
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
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? text(value.props?.children) : "";
  const render = () => { cursor = 0; tree = loaded.exports.default({ mode: "signature" }); return tree; };
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(item => item.type === components.Button && text(item.props.children).trim() === label);
  const input = id => find(item => item.type === components.Input && item.props.id === id);
  async function settle() { await setImmediate(); await setImmediate(); render(); }
  async function open() {
    render();
    input("approval-operations-search").props.onChange({ target: { value: "SOL-44" } });
    render();
    await find(item => item.type === "form" && item.props.role === "search").props.onSubmit({ preventDefault() {} });
    await settle();
    button("FirmaSeguro").props.onClick();
    render();
    button("Reenviar firma").props.onClick();
    render();
    input("approval-signature-reason").props.onChange({ target: { value: "Reenviar contrato con datos corregidos" } });
    render();
  }
  async function confirm({ doubleClick = false } = {}) {
    button("Continuar").props.onClick();
    render();
    const dialog = find(item => item.type === ConfirmDialog && item.props.open && item.props.title === "Reenviar firma");
    assert.ok(dialog, "se exige confirmación explícita para enviar");
    dialog.props.onConfirm();
    if (doubleClick) dialog.props.onConfirm();
    await settle();
  }
  return { open, confirm, input, text: () => text(tree), requests, get uuidCalls() { return uuidCalls; } };
}

for (const refreshFails of [false, true]) test(`FAILED_SAFE permite el siguiente reenvío con otra operación${refreshFails ? " aunque falle la consulta" : ""}`, async () => {
  const ui = harness("FAILED_SAFE", { refreshFails });
  await ui.open();
  await ui.confirm({ doubleClick: true });
  assert.equal(ui.requests.length, 1, "el doble clic inicia un único envío");
  assert.equal(ui.input("approval-signature-reason").props.value, "Reenviar contrato con datos corregidos");
  assert.match(ui.text(), refreshFails ? /No fue posible verificar el envío/ : /Resultado de envío: FAILED_SAFE/);
  await setImmediate();
  assert.equal(ui.requests.length, 1, "un fallo seguro nunca inicia un reintento automático");
  await ui.confirm();
  assert.equal(ui.requests.length, 2);
  assert.notEqual(ui.requests[1].idempotencyKey, ui.requests[0].idempotencyKey,
    "la operación terminal segura no se reproduce indefinidamente");
  assert.equal(ui.requests[1].expectedProcessUuid, "source-44");
  assert.equal(ui.requests[1].confirmed, true);
  assert.equal(ui.requests[1].reason, ui.requests[0].reason);
  assert.equal(ui.uuidCalls, 2);
  assert.match(ui.text(), /Nueva firma pendiente/);
});

for (const outcome of ["UNCERTAIN", "TECHNICAL_ERROR", "NETWORK_ERROR"]) test(`${outcome} conserva la idempotencia al verificar o reintentar explícitamente`, async () => {
  const ui = harness(outcome);
  await ui.open();
  await ui.confirm();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.input("approval-signature-reason").props.value, "Reenviar contrato con datos corregidos");
  assert.match(ui.text(), outcome === "NETWORK_ERROR" ? /No fue posible enviar la firma/ : new RegExp(`Resultado de envío: ${outcome}`));
  await setImmediate();
  assert.equal(ui.requests.length, 1, "no se despacha automáticamente otra firma tras una respuesta incierta");
  await ui.confirm();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].idempotencyKey, ui.requests[0].idempotencyKey,
    "un resultado incierto debe reconciliar la operación existente");
  assert.equal(ui.uuidCalls, 1);
});
