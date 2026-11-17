import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const source = readFileSync(new URL("../app/clientes/client-credit-panel.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ["copyPaymentNumber", "CopyablePaymentNumber"].map((name) => {
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Expected the real ${name} function`);
  return declaration.getText(parsed);
});
const output = ts.transpileModule(
  `import { useState, useRef } from "react";\n${declarations.join("\n")}\nexport { CopyablePaymentNumber };`,
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const entries = [];
function collectEntries(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === "CopyablePaymentNumber") {
    entries.push(Object.fromEntries(node.attributes.properties.map((attribute) => {
      assert.ok(ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer));
      return [attribute.name.getText(parsed), attribute.initializer.text];
    })));
  }
  ts.forEachChild(node, collectEntries);
}
collectEntries(parsed);
assert.equal(entries.length, 2, "Both real payment cards expose a copy control");
const bank = entries.find((entry) => entry.copyLabel === "Copiar cuenta Bancolombia");
const breb = entries.find((entry) => entry.copyLabel === "Copiar llave BreB");
assert.ok(bank && breb);
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, error) => { resolve = ok; reject = error; });
  return { promise, resolve, reject };
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
function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(textContent).join("");
}

function harness({ writeText, legacyResult = false, legacyThrows = false } = {}) {
  const copied = [];
  const selected = [];
  const fields = [];
  const focus = [];
  let active;
  class Element {
    style = {};
    focus(options) { focus.push(options.preventScroll === true); }
    select() { selected.push(this.value); }
    remove() { this.removed = true; }
  }
  const previousFocus = new Element();
  const document = {
    activeElement: previousFocus,
    body: { appendChild(field) { fields.push(field); document.activeElement = field; } },
    createElement(tag) { assert.equal(tag, "textarea"); return new Element(); },
    execCommand(command) {
      assert.equal(command, "copy");
      if (legacyThrows) throw new Error("Legacy clipboard blocked");
      return legacyResult;
    },
  };
  const react = {
    useState(initial) {
      const instance = active;
      const index = instance.stateIndex++;
      if (!(index in instance.states)) instance.states[index] = initial;
      return [instance.states[index], (value) => { instance.states[index] = value; }];
    },
    useRef(initial) {
      const index = active.refIndex++;
      active.refs[index] ??= { current: initial };
      return active.refs[index];
    },
  };
  const loaded = { exports: {} };
  const dependencies = { react, "react/jsx-runtime": jsxRuntime };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
    styles: new Proxy({}, { get: (_, key) => String(key) }),
    Check: "svg", Copy: "svg", document, HTMLElement: Element,
    navigator: writeText ? { clipboard: { writeText(value) { copied.push(value); return writeText(value); } } } : {},
  });
  function instance(props) {
    const state = { props, states: [], refs: [], stateIndex: 0, refIndex: 0 };
    return {
      render() {
        active = state; state.stateIndex = 0; state.refIndex = 0;
        return loaded.exports.CopyablePaymentNumber(state.props);
      },
      button() { return findNode(this.render(), (node) => node.type === "button"); },
      status() { return textContent(findNode(this.render(), (node) => node.props?.role === "status")); },
    };
  }
  return { instance, copied, selected, fields, focus };
}

test("cada botón copia el valor real exacto, conservando el cero inicial de Bancolombia", async () => {
  const flow = harness({ writeText: async () => {} });
  for (const [props, expected] of [[bank, "06800016173"], [breb, "902052909"]]) {
    const control = flow.instance(props);
    assert.equal(props.value, expected);
    assert.ok(textContent(control.render()).includes(expected));
    assert.equal(control.button().props["aria-label"], props.copyLabel);
    control.button().props.onClick();
    await settle();
    assert.equal(flow.copied.at(-1), expected);
    assert.equal(typeof flow.copied.at(-1), "string");
    assert.equal(textContent(control.button()), "Copiado");
    assert.equal(control.status(), "Número copiado.");
  }
  assert.equal(flow.fields.length, 0, "Modern clipboard does not create a temporary field");
});

test("la copia pendiente no anuncia éxito y un doble clic antes del render comparte la operación", async () => {
  const pending = deferred();
  const flow = harness({ writeText: () => pending.promise });
  const control = flow.instance(bank);
  const previousButton = control.button();
  previousButton.props.onClick();
  previousButton.props.onClick();
  assert.deepEqual(flow.copied, ["06800016173"]);
  assert.equal(textContent(control.button()), "Copiando…");
  assert.equal(control.button().props.disabled, true);
  assert.equal(control.status(), "");
  pending.resolve();
  await settle();
  assert.equal(textContent(control.button()), "Copiado");
  assert.equal(control.button().props.disabled, false);
});

test("si Clipboard API rechaza, el respaldo selecciona el número exacto, limpia el campo y restaura el foco", async () => {
  const flow = harness({ writeText: async () => { throw new Error("Permission denied"); }, legacyResult: true });
  const control = flow.instance(bank);
  control.button().props.onClick();
  await settle();
  assert.deepEqual(flow.selected, ["06800016173"]);
  assert.equal(flow.fields[0].readOnly, true);
  assert.equal(flow.fields[0].removed, true);
  assert.deepEqual(flow.focus, [true]);
  assert.equal(textContent(control.button()), "Copiado");
});

test("cuando ambos mecanismos fallan, informa el error sin confirmar copia y permite reintentar", async (t) => {
  for (const legacyThrows of [false, true]) {
    await t.test(legacyThrows ? "execCommand lanza error" : "execCommand devuelve false", async () => {
      const flow = harness({ writeText: async () => { throw new Error("Unavailable"); }, legacyThrows });
      const control = flow.instance(breb);
      control.button().props.onClick();
      await settle();
      assert.equal(textContent(control.button()), "Copiar");
      assert.equal(control.button().props.disabled, false);
      assert.equal(control.status(), "No se pudo copiar. Selecciona el número y cópialo.");
      assert.equal(flow.fields[0].removed, true);
      control.button().props.onClick();
      await settle();
      assert.equal(flow.copied.length, 2, "A deliberate retry is available after failure");
    });
  }
});

test("sin Clipboard API usa el respaldo y cada medio conserva su propia confirmación", async () => {
  const legacy = harness({ legacyResult: true });
  const legacyControl = legacy.instance(breb);
  legacyControl.button().props.onClick();
  await settle();
  assert.deepEqual(legacy.selected, ["902052909"]);
  assert.equal(legacyControl.status(), "Número copiado.");

  const bankPending = deferred();
  const flow = harness({ writeText: (value) => value === bank.value ? bankPending.promise : Promise.resolve() });
  const bankControl = flow.instance(bank);
  const brebControl = flow.instance(breb);
  bankControl.button().props.onClick();
  brebControl.button().props.onClick();
  await settle();
  assert.equal(textContent(bankControl.button()), "Copiando…");
  assert.equal(brebControl.status(), "Número copiado.");
  bankPending.reject(new Error("Blocked"));
  await settle();
  assert.match(bankControl.status(), /No se pudo copiar/);
  assert.equal(brebControl.status(), "Número copiado.", "One method's error cannot clear the other's success");
});
