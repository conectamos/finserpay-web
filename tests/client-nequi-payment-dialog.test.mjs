import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const source = readFileSync(new URL("../app/clientes/client-nequi-payment-dialog.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const money = (value) => new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
}).format(value).replace(/\s+/g, " ");

function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, predicate))];
}
function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(textContent).join(" ").replace(/\s+/g, " ").trim();
}

function dialogHarness(overrides = {}) {
  const calls = { cancel: 0, submit: 0, phones: [], terms: [] };
  const props = {
    amount: 411_000, installmentLabel: "Cuotas 1 a 3", product: "INFINIX SMART 20 128GB",
    imei: "359111122223333", document: "1234567890", phone: "3001234567",
    acceptedTerms: false, submitting: false, notice: null,
    onPhoneChange: (value) => calls.phones.push(value),
    onTermsChange: (value) => calls.terms.push(value),
    onCancel: () => { calls.cancel += 1; },
    onSubmit: () => { calls.submit += 1; },
    ...overrides,
  };
  const refs = [];
  let cursor = 0;
  let tree;
  const Empty = () => null;
  const dependencies = {
    react: {
      useId: () => "test-payment",
      useEffect: () => {},
      useRef(initial) {
        const index = cursor++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    },
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": new Proxy({}, { get: () => Empty }),
    "@/app/_components/finser-ui": { Button: "button", Input: "input" },
    "./client-nequi-payment-dialog.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const testModule = { exports: {} };
  runInNewContext(output, {
    module: testModule, exports: testModule.exports, Date, Intl,
    require: (name) => { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; },
  });
  function render(nextProps = {}) {
    Object.assign(props, nextProps);
    cursor = 0;
    tree = testModule.exports.default(props);
    return tree;
  }
  function find(predicate) {
    const matches = nodes(tree, predicate);
    assert.equal(matches.length, 1, "Debe existir un único control para la interacción probada");
    return matches[0];
  }
  function submit() {
    find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  }
  render();
  return { calls, props, render, find, submit, get tree() { return tree; } };
}
const sendButton = (node) => node.type === "button" && /Enviar solicitud a Nequi|Enviando solicitud/.test(textContent(node));
const phoneInput = (node) => node.type === "input" && node.props.type === "tel";
const termsInput = (node) => node.type === "input" && node.props.type === "checkbox";
const cancelButton = (node) => node.type === "button" && textContent(node) === "Cancelar";

// These tests execute the actual component and real interaction callbacks.
// Financial amounts are supplied by the parent; this UI cannot create payments.
test("el diálogo accesible muestra el saldo, las cuotas y el equipo reales en el orden esperado", () => {
  const flow = dialogHarness();
  const dialog = flow.find((node) => node.props?.role === "dialog");
  assert.equal(String(dialog.props["aria-modal"]), "true");
  assert.ok(dialog.props["aria-labelledby"]);
  assert.equal(textContent(flow.find((node) => node.props?.id === dialog.props["aria-labelledby"])), "Pagar con Nequi");
  const text = textContent(flow.tree);
  assert.ok(text.includes(money(411_000)));
  assert.ok(text.includes("Cuotas 1 a 3"));
  assert.ok(text.includes("INFINIX SMART 20 128GB"));
  assert.ok(text.indexOf("Total a pagar") < text.indexOf("Producto"));
  assert.ok(text.indexOf("Producto") < text.indexOf("Número Nequi"));
  assert.ok(text.includes("Recibirás una solicitud en la app Nequi para aprobar el pago"));
  const input = flow.find(phoneInput);
  assert.equal(input.props.inputMode, "numeric");
  assert.equal(input.props.autoComplete, "tel-national");
  assert.ok(flow.find((node) => node.type === "label" && node.props.htmlFor === input.props.id));
  flow.render({ amount: 361_000, installmentLabel: "Cuota 7", product: "Equipo del crédito B" });
  assert.ok(textContent(flow.tree).includes(money(361_000)));
  assert.ok(!textContent(flow.tree).includes(money(411_000)));
  assert.ok(textContent(flow.tree).includes("Cuota 7"));
  assert.ok(textContent(flow.tree).includes("Equipo del crédito B"));
});

test("IMEI y documento están enmascarados y se contempla el IMEI no registrado", () => {
  const flow = dialogHarness();
  const serialized = JSON.stringify(flow.tree);
  assert.ok(!serialized.includes(flow.props.imei));
  assert.ok(!serialized.includes(flow.props.document));
  const text = textContent(flow.tree);
  assert.ok(text.includes("3333"));
  assert.ok(text.includes("7890"));
  flow.render({ imei: null });
  assert.ok(textContent(flow.tree).includes("No registrado"));
});

test("se requiere un teléfono de diez dígitos y aceptación de términos para enviar", () => {
  for (const phone of ["", "300123456", "30012345678", "300123456x"]) {
    const flow = dialogHarness({ acceptedTerms: true, phone });
    assert.equal(flow.find(sendButton).props.disabled, true, `Teléfono inválido: ${phone}`);
    flow.submit();
    assert.equal(flow.calls.submit, 0);
  }
  const withoutTerms = dialogHarness();
  assert.equal(withoutTerms.find(sendButton).props.disabled, true);
  withoutTerms.submit();
  assert.equal(withoutTerms.calls.submit, 0);
  const ready = dialogHarness({ acceptedTerms: true });
  assert.equal(ready.find(sendButton).props.disabled, false);
  ready.submit();
  assert.equal(ready.calls.submit, 1);
});

test("los controles devuelven sus valores al padre y cancelar no solicita un pago", () => {
  const flow = dialogHarness();
  flow.find(phoneInput).props.onChange({ target: { value: "3019876543" } });
  flow.find(termsInput).props.onChange({ target: { checked: true } });
  assert.deepEqual(flow.calls.phones, ["3019876543"]);
  assert.deepEqual(flow.calls.terms, [true]);
  flow.find(cancelButton).props.onClick();
  assert.equal(flow.calls.cancel, 1);
  assert.equal(flow.calls.submit, 0);
  const close = dialogHarness();
  close.find((node) => node.type === "button" && node.props["aria-label"] === "Cerrar pago con Nequi").props.onClick();
  assert.equal(close.calls.cancel, 1);
  assert.equal(close.calls.submit, 0);
});

test("durante el envío se conserva el diálogo, se informa el progreso y no permite cerrar ni enviar nuevamente", () => {
  const flow = dialogHarness({ acceptedTerms: true, submitting: true });
  assert.ok(flow.find((node) => node.props?.role === "dialog"));
  assert.match(textContent(flow.find(sendButton)), /Enviando solicitud/);
  assert.equal(flow.find(sendButton).props.disabled, true);
  assert.equal(flow.find(cancelButton).props.disabled, true);
  assert.equal(flow.find(phoneInput).props.disabled, true);
  assert.equal(flow.find(termsInput).props.disabled, true);
  flow.submit();
  flow.find(cancelButton).props.onClick();
  assert.equal(flow.calls.submit, 0);
  assert.equal(flow.calls.cancel, 0);
});

test("el bloqueo inmediato impide un segundo envío o cerrar antes de que el padre actualice el estado", () => {
  const flow = dialogHarness({ acceptedTerms: true });
  flow.submit();
  flow.submit();
  flow.find(cancelButton).props.onClick();
  assert.equal(flow.calls.submit, 1);
  assert.equal(flow.calls.cancel, 0);
});

test("los errores del pago permanecen visibles sin afirmar que el pago fue aprobado", () => {
  const flow = dialogHarness({ notice: { tone: "red", text: "Nequi rechazó la solicitud. Intenta nuevamente." } });
  assert.ok(textContent(flow.tree).includes("Nequi rechazó la solicitud. Intenta nuevamente."));
  assert.ok(!textContent(flow.tree).includes("Pago aprobado"));
  assert.ok(flow.find((node) => node.props?.role === "alert"));
});