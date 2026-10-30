import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props) => ({ type, props: props || {} });

// Execute both real components with deterministic effects and the DOM methods they use.
// Native dialog cancel is dispatched only when keydown has not prevented its default.
function mount({ keepMounted = true, open = false } = {}) {
  const listeners = new Map(), elements = new Map();
  const document = {
    body: { style: { overflow: "auto" } }, activeElement: null,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  };
  class Element {
    constructor(type) { this.type = type; this.props = {}; this.children = []; this.isConnected = true; this.open = false; this.value = ""; }
    focus() { document.activeElement = this; for (const fn of listeners.get("focusin") || []) fn({ target: this }); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    hasAttribute(name) { return Object.hasOwn(this.props, name); }
    getAttribute(name) { return this.props[name]; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => ["button", "input", "textarea", "select"].includes(child.type) && !child.props.disabled); }
    querySelector(selector) {
      assert.equal(selector, '[role="alertdialog"][aria-modal="true"]');
      const visit = node => node.props.role === "alertdialog" && node.props["aria-modal"] === "true" ? node : node.children.map(visit).find(Boolean);
      return this.children.map(visit).find(Boolean) || null;
    }
    getBoundingClientRect() { return { left: 100, top: 0, right: 500, bottom: 800 }; }
    showModal() { assert.equal(this.open, false); this.open = true; }
    close() { this.open = false; }
  }
  const launcher = new Element("button"); launcher.focus();
  function load(name) {
    let cursor = 0, effects = [];
    const slots = [];
    const react = {
      useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
      useId() { cursor++; return `test-${name}`; },
      useEffect(run, deps) {
        const index = cursor++, previous = slots[index];
        if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects.push(() => {
          previous?.cleanup?.(); slots[index] = { deps, cleanup: run() };
        });
      },
    };
    const loaded = { exports: {} };
    const source = readFileSync(new URL(`../app/_components/${name}.tsx`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    runInNewContext(outputText, {
      module: loaded, exports: loaded.exports, document, HTMLElement: Element, Node: Element,
      require(module) {
        if (module === "react") return react;
        if (module === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (module === "lucide-react") return { X: "svg" };
        if (module.endsWith("finser-ui")) return { Button: "button" };
        if (module.endsWith(".css")) return { default: {} };
        throw new Error(`Unexpected module ${module}`);
      },
    });
    return {
      render(props) { cursor = 0; effects = []; return loaded.exports.default(props); },
      commit() { effects.forEach(run => run()); effects = []; },
      unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    };
  }
  const panel = load("finser-side-panel"), confirm = load("finser-confirm-dialog");
  let confirmation = false, busy = false, closeCount = 0, root;
  function commit(node, path, seen) {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((child, index) => commit(child, `${path}.${index}`, seen));
    let element = elements.get(path);
    if (!element || element.type !== node.type) { element = new Element(node.type); element.value = node.props.defaultValue || ""; elements.set(path, element); }
    seen.add(path); element.isConnected = true; element.props = node.props;
    element.children = commit(node.props.children, `${path}.child`, seen);
    if (node.props.ref) node.props.ref.current = element;
    return [element];
  }
  function render() {
    const nested = confirm.render({ open: confirmation, busy, title: "Confirmar", description: "Operación", confirmLabel: "Aplicar", onCancel() { confirmation = false; }, onConfirm() {} });
    const tree = panel.render({ open, keepMounted, busy, title: "Ficha", onClose() { closeCount++; open = false; }, children: [jsx("input", { defaultValue: "" }), nested] });
    const seen = new Set(); root = commit(tree, "panel", seen)[0] || null;
    for (const [path, element] of elements) if (!seen.has(path)) { element.isConnected = false; elements.delete(path); }
    panel.commit(); confirm.commit();
  }
  const cancel = () => { let prevented = false; root?.props.onCancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); };
  render();
  return {
    document, launcher, listeners,
    get root() { return root; }, get closeCount() { return closeCount; },
    get input() { return root?.querySelectorAll().find(node => node.type === "input"); },
    set(patch) { if ("open" in patch) open = patch.open; if ("confirmation" in patch) confirmation = patch.confirmation; if ("busy" in patch) busy = patch.busy; render(); },
    cancel() { cancel(); render(); },
    closeButton() { root.querySelectorAll().find(node => node.props["aria-label"] === "Cerrar panel").props.onClick(); render(); },
    backdrop() { root.props.onClick({ target: root, currentTarget: root, clientX: 10, clientY: 10 }); render(); },
    escape() {
      const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of listeners.get("keydown") || []) listener(event);
      if (!event.defaultPrevented && root?.open) cancel();
      render();
    },
    unmount() { confirm.unmount(); panel.unmount(); },
  };
}

test("keepMounted conserva el formulario al cerrar y restaura foco y overflow", () => {
  const f = mount(); const input = f.input;
  assert.ok(f.root); assert.equal(f.root.open, false); assert.equal(f.document.body.style.overflow, "auto");
  f.set({ open: true }); input.value = "Nota sin guardar"; input.focus();
  assert.equal(f.document.body.style.overflow, "hidden");
  f.cancel();
  assert.equal(f.closeCount, 1); assert.equal(f.root.open, false); assert.equal(f.input, input);
  assert.equal(f.document.activeElement, f.launcher); assert.equal(f.document.body.style.overflow, "auto");
  f.set({ open: true }); assert.equal(f.input.value, "Nota sin guardar"); assert.equal(f.input, input);
  f.unmount(); assert.equal(f.document.body.style.overflow, "auto"); assert.equal(f.document.activeElement, f.launcher);
});

test("sin keepMounted conserva el comportamiento anterior de desmontar al cerrar", () => {
  const f = mount({ keepMounted: false }); assert.equal(f.root, null);
  f.set({ open: true }); const input = f.input; input.value = "Descartado";
  f.closeButton(); assert.equal(f.root, null); assert.equal(input.isConnected, false);
  f.set({ open: true }); assert.notEqual(f.input, input); assert.equal(f.input.value, ""); f.unmount();
});

test("confirmación anidada bloquea cancel, X y backdrop; Escape cierra solo el diálogo superior", () => {
  const f = mount({ open: true }); const input = f.input; input.value = "Compromiso pendiente"; input.focus();
  f.set({ confirmation: true }); assert.equal(f.listeners.get("keydown").size, 1);
  f.cancel(); f.closeButton(); f.backdrop();
  assert.equal(f.root.open, true); assert.equal(f.closeCount, 0);
  f.escape();
  assert.equal(f.root.open, true); assert.equal(f.closeCount, 0); assert.equal(f.document.activeElement, input);
  assert.equal(f.listeners.get("keydown").size, 0); assert.equal(f.listeners.get("focusin").size, 0);
  f.escape(); assert.equal(f.root.open, false); assert.equal(f.closeCount, 1); assert.equal(f.document.activeElement, f.launcher);
  f.set({ open: true }); assert.equal(f.input.value, "Compromiso pendiente"); f.unmount();
});

test("busy impide cerrar incluso si el diálogo superior no consume Escape", () => {
  const f = mount({ open: true }); f.set({ confirmation: true, busy: true });
  f.escape(); f.backdrop(); f.cancel();
  assert.equal(f.root.open, true); assert.equal(f.closeCount, 0); assert.equal(f.listeners.get("keydown").size, 1);
  f.set({ busy: false }); f.escape(); f.escape(); assert.equal(f.closeCount, 1); f.unmount();
});
