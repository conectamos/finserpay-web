import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const presentation = await jiti.import("../app/clientes/credit-dashboard-presentation.ts");
const displayNumber = await jiti.import("../lib/credit-display-number.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const source = readFileSync(new URL("../app/clientes/page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ClienteConsultaPage");
const hookNames = page.body.statements.filter(ts.isVariableStatement).flatMap((statement) =>
  statement.declarationList.declarations.filter((declaration) =>
    ts.isArrayBindingPattern(declaration.name) && ts.isCallExpression(declaration.initializer) &&
    declaration.initializer.expression.getText(parsed) === "useState"
  ).map((declaration) => declaration.name.elements[0].name.getText(parsed))
);
const output = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, error) => { resolve = ok; reject = error; });
  return { promise, resolve, reject };
}
function creditFixture(abonos = []) {
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_740_000, valorCuota: 137_000, plazoMeses: 20,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-08-17", today: "2026-09-26", abonos,
  });
  return {
    id: 81, folio: "0300000081", clienteNombre: "Ospino Vega", clienteDocumento: "12345678",
    clienteTelefono: "3001234567", referenciaEquipo: "IPHONE ARES", imei: "123456789012345",
    fechaCredito: "2026-08-01", montoCredito: 2_740_000, valorCuota: 137_000, sedeNombre: "Sede prueba",
    estadoPago: plan.estadoPago, saldoPendiente: plan.saldoPendiente, totalPagado: plan.totalPaid,
    cuotas: plan.installments, abonos: abonos.map((item, index) => ({ ...item, id: index + 1, metodoPago: "NEQUI" })),
    liquidacionAnticipada: { disponible: false, capitalPendiente: 0 },
  };
}
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}
const response = (body, ok = true) => ({ ok, json: async () => body });
const pendingCheckout = () => response({
  ok: true, paymentMode: "NEQUI_DIRECT", reference: "FINSER-81-NEQUI-TEST", status: "PENDING", amount: 411_000,
});

function harness() {
  let returnedCredit = creditFixture();
  let statusResponse = response({ ok: true, status: "PENDING", applied: false, alreadyProcessed: false });
  let nextCreditResponse = null;
  const checkoutQueue = [];
  const requests = [];
  const timers = [];
  const refs = [];
  const states = {
    documento: returnedCredit.clienteDocumento, activeDocumento: returnedCredit.clienteDocumento,
    items: [returnedCredit], openCreditId: returnedCredit.id, selectedLimit: { [returnedCredit.id]: 3 },
  };
  let stateCursor = 0;
  let refCursor = 0;
  const Dashboard = () => null;
  const Panel = () => null;
  const Dialog = () => null;
  const Empty = () => null;
  const react = {
    useState(initial) {
      const name = hookNames[stateCursor++];
      assert.ok(name, "El arnés debe corresponder a los hooks reales");
      if (!(name in states)) states[name] = typeof initial === "function" ? initial() : initial;
      return [states[name], (next) => { states[name] = typeof next === "function" ? next(states[name]) : next; }];
    },
    useRef(initial) {
      const index = refCursor++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useCallback: (callback) => callback,
    // Mount/polling effects remain inactive. Tests invoke user-facing refresh explicitly.
    useEffect: () => {},
  };
  const dependencies = {
    react, "react/jsx-runtime": jsxRuntime,
    "@/lib/credit-display-number": displayNumber,
    "./credit-dashboard-presentation": presentation,
    "@/app/clientes/client-active-credit-dashboard": { default: Dashboard },
    "@/app/clientes/client-credit-panel": { default: Panel },
    "@/app/clientes/client-login-screen": { default: Empty },
    "@/app/clientes/paid-credit-dashboard": { default: Empty },
    "@/app/clientes/client-nequi-payment-dialog": { default: Dialog },
    "./client-nequi-payment-dialog": { default: Dialog },
    "lucide-react": new Proxy({}, { get: () => Empty }),
  };
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports,
    require(name) { assert.ok(name in dependencies, "Dependencia no simulada: " + name); return dependencies[name]; },
    Date, Intl, URLSearchParams,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: () => {},
      location: { search: "", assign: () => { throw new Error("La prueba no debe navegar a un checkout real"); } },
    },
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/clientes/wompi-checkout") return checkoutQueue.shift() ?? pendingCheckout();
      if (url.startsWith("/api/clientes/wompi-status?")) return statusResponse;
      if (url.startsWith("/api/clientes/creditos?")) {
        const value = nextCreditResponse;
        nextCreditResponse = null;
        return value ?? response({ ok: true, items: [returnedCredit] });
      }
      throw new Error("URL no simulada: " + url);
    },
  }, { filename: "app/clientes/page.tsx" });
  let tree;
  function render() {
    stateCursor = 0;
    refCursor = 0;
    tree = loaded.exports.default();
    assert.equal(stateCursor, hookNames.length);
    return tree;
  }
  const dashboard = () => findNode(tree, (node) => node.type === Dashboard)?.props;
  const panel = () => findNode(tree, (node) => node.type === Panel)?.props;
  const dialog = () => findNode(tree, (node) => node.type === Dialog)?.props;
  function openAcceptedDialog() {
    dashboard().onPayInstallment();
    render();
    assert.ok(dialog(), "El pago se confirma en el diálogo");
    dialog().onTermsChange(true);
    render();
    assert.equal(dialog().acceptedTerms, true);
    return dialog();
  }
  async function sendPending() {
    openAcceptedDialog().onSubmit();
    await settle();
    render();
    assert.ok(panel()?.pendingPayment?.reference, "La solicitud debe conservar su referencia pendiente");
  }
  render();
  return {
    states, requests, timers, refs, render, dashboard, panel, dialog, openAcceptedDialog, sendPending,
    postCount: () => requests.filter((item) => item.method === "POST").length,
    enqueueCheckout: (value) => checkoutQueue.push(value),
    setStatus: (body, ok = true) => { statusResponse = response(body, ok); },
    setCredit: (credit) => { returnedCredit = credit; },
    deferCredit: (value) => { nextCreditResponse = value; },
  };
}

function assertUnpaid(flow) {
  assert.equal(flow.states.items[0].totalPagado, 0);
  assert.equal(flow.dashboard().paidInstallments, 0);
  assert.equal(flow.dashboard().statusTone, "overdue");
  assert.equal(flow.dashboard().overduePayment.amount, 411_000);
  assert.doesNotMatch(flow.states.notice?.text || "", /aprobado y aplicado|quedaron actualizados/i);
}

test("cancelar la confirmación antes de enviar no inicia una transacción", () => {
  const flow = harness();
  flow.openAcceptedDialog().onCancel();
  flow.render();
  assert.equal(flow.dialog(), undefined);
  assert.equal(flow.postCount(), 0);
  assert.equal(flow.states.paymentReturn, null);
  assertUnpaid(flow);
});

test("doble clic antes de un render produce un solo POST y conserva el diálogo mientras envía", async () => {
  const flow = harness();
  const request = deferred();
  flow.enqueueCheckout(request.promise);
  const dialog = flow.openAcceptedDialog();
  dialog.onSubmit();
  dialog.onSubmit();
  assert.equal(flow.postCount(), 1, "El bloqueo debe ser síncrono, sin esperar al render");
  dialog.onCancel();
  flow.render();
  assert.ok(flow.dialog(), "Enviar no debe ocultar prematuramente la confirmación");
  assert.equal(flow.dialog().submitting, true);
  assertUnpaid(flow);
  request.resolve(pendingCheckout());
  await settle();
  flow.render();
  assert.equal(flow.postCount(), 1);
  assert.ok(flow.panel()?.pendingPayment?.reference);
  assert.match(flow.states.notice.text, /Nequi/);
  assertUnpaid(flow);
});

test("una solicitud Nequi pendiente impide retransmitir desde callbacks anteriores o volver a confirmar", async () => {
  const flow = harness();
  const stale = flow.openAcceptedDialog();
  stale.onSubmit();
  await settle();
  flow.render();
  stale.onSubmit();
  flow.panel().onPaySelected();
  flow.render();
  flow.dialog()?.onSubmit();
  await settle();
  assert.equal(flow.postCount(), 1, "La referencia pendiente bloquea nuevos POST");
  assertUnpaid(flow);
});

for (const status of ["PENDING", "APPROVED"]) {
  test(`${status} sin conciliación no anuncia un pago aplicado ni modifica las cuotas`, async () => {
    const flow = harness();
    await flow.sendPending();
    flow.setStatus({ ok: true, status, applied: false, alreadyProcessed: false });
    flow.panel().onRefreshPayment();
    await settle();
    flow.render();
    assert.ok(flow.panel()?.pendingPayment?.reference);
    assert.equal(flow.postCount(), 1);
    assertUnpaid(flow);
  });
}

for (const status of ["DECLINED", "ERROR", "VOIDED", "CANCELED", "CANCELLED", "EXPIRED"]) {
  test(`el estado terminal ${status} libera la espera sin marcar cuotas como pagadas`, async () => {
    const flow = harness();
    await flow.sendPending();
    flow.setStatus({ ok: true, status, applied: false, alreadyProcessed: false });
    flow.panel().onRefreshPayment();
    await settle();
    flow.render();
    assert.equal(flow.states.paymentReturn, null);
    assert.equal(flow.panel().pendingPayment, null);
    assert.equal(flow.states.notice.tone, "red");
    assert.match(flow.states.notice.text, /rechaz|cancel|venci|expir|error|no se|no fue|no pudo/i);
    assertUnpaid(flow);
    flow.openAcceptedDialog().onSubmit();
    await settle();
    flow.render();
    assert.equal(flow.postCount(), 2, "Un fallo definitivo permite una nueva solicitud explícita");
  });
}

for (const flag of ["applied", "alreadyProcessed"]) {
  test(`${flag} actualiza el dashboard desde la cartera y anuncia éxito después de refrescarla`, async () => {
    const flow = harness();
    await flow.sendPending();
    flow.setStatus({ ok: true, status: "APPROVED", applied: flag === "applied", alreadyProcessed: flag === "alreadyProcessed" });
    const refresh = deferred();
    flow.deferCredit(refresh.promise);
    flow.panel().onRefreshPayment();
    await settle();
    flow.render();
    assertUnpaid(flow);
    const realUpdatedCredit = creditFixture([{ valor: 411_000, fechaAbono: "2026-09-26" }]);
    refresh.resolve(response({ ok: true, items: [realUpdatedCredit] }));
    await settle();
    flow.render();
    assert.deepEqual(snapshot(flow.states.items), [snapshot(realUpdatedCredit)]);
    assert.equal(flow.dashboard().paidInstallments, 3);
    assert.equal(flow.dashboard().statusTone, "current");
    assert.equal(flow.states.paymentReturn, null);
    assert.match(flow.states.notice.text, /aprobado y aplicado/i);
    assert.equal(flow.postCount(), 1);
    flow.openAcceptedDialog().onSubmit();
    await settle();
    flow.render();
    assert.equal(flow.postCount(), 2, "Después de aplicar el pago se puede solicitar la próxima cuota real");
    assert.deepEqual(flow.requests.filter((item) => item.method === "POST")[1].body.cuotaNumeros, [4]);
  });
}

test("fallar el envío conserva la confirmación y permite un reintento explícito", async () => {
  const flow = harness();
  flow.enqueueCheckout(response({ error: "Nequi no respondió" }, false));
  flow.openAcceptedDialog().onSubmit();
  await settle();
  flow.render();
  assert.ok(flow.dialog());
  assert.equal(flow.dialog().submitting, false);
  assert.equal(flow.states.paymentReturn, null);
  assert.equal(flow.states.notice.tone, "red");
  assert.match(flow.states.notice.text, /Nequi no respondió/);
  assertUnpaid(flow);
  flow.dialog().onSubmit();
  await settle();
  flow.render();
  assert.equal(flow.postCount(), 2);
  assert.ok(flow.panel()?.pendingPayment?.reference);
  assertUnpaid(flow);
});

test("un error al verificar no libera la referencia ni permite otra solicitud pendiente", async () => {
  const flow = harness();
  await flow.sendPending();
  flow.setStatus({ error: "No se pudo verificar el pago" }, false);
  flow.panel().onRefreshPayment();
  await settle();
  flow.render();
  assert.ok(flow.panel()?.pendingPayment?.reference);
  assert.equal(flow.states.notice.tone, "red");
  flow.panel().onPaySelected();
  flow.render();
  flow.dialog()?.onSubmit();
  await settle();
  assert.equal(flow.postCount(), 1);
  assertUnpaid(flow);
});
test("si cartera falla después de applied se conservan cuotas y referencia hasta verificar otra vez", async () => {
  const flow = harness();
  await flow.sendPending();
  const previousCredit = snapshot(flow.states.items[0]);
  const previousReference = flow.states.paymentReturn.reference;
  flow.setStatus({ ok: true, status: "APPROVED", applied: true, alreadyProcessed: false });
  flow.deferCredit(response({ error: "No se pudo actualizar la cartera" }, false));
  flow.panel().onRefreshPayment();
  await settle();
  flow.render();
  assert.deepEqual(snapshot(flow.states.items), [previousCredit], "Un error de refresco no borra ni inventa la cartera consultada");
  assert.equal(flow.panel().pendingPayment.reference, previousReference);
  assert.equal(flow.states.paymentReturn.reference, previousReference);
  assert.equal(flow.states.notice.tone, "red");
  assert.match(flow.states.notice.text, /No se pudo actualizar la cartera/);
  assertUnpaid(flow);
  flow.panel().onPaySelected();
  flow.render();
  flow.dialog()?.onSubmit();
  await settle();
  assert.equal(flow.postCount(), 1, "No se permite reenviar mientras falte actualizar y verificar");

  const realUpdatedCredit = creditFixture([{ valor: 411_000, fechaAbono: "2026-09-26" }]);
  flow.setCredit(realUpdatedCredit);
  flow.panel().onRefreshPayment();
  await settle();
  flow.render();
  assert.deepEqual(snapshot(flow.states.items), [snapshot(realUpdatedCredit)]);
  assert.equal(flow.states.paymentReturn, null);
  assert.equal(flow.dashboard().paidInstallments, 3);
  assert.match(flow.states.notice.text, /aprobado y aplicado/i);
  assert.equal(flow.postCount(), 1);
});