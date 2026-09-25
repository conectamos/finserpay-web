import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { core, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";

const require = createRequire(import.meta.url);
const bulkCore = loadBlacklistModule("lib/document-blacklist-bulk-core.ts", { "@/lib/document-blacklist-core": core });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "app/dashboard/lista-negra/blacklist-clear-panel.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function createHarness() {
  const hooks = [];
  const fetches = [];
  const responses = [];
  const busy = [];
  let completed = 0;
  let cursor = 0;
  const ui = Object.fromEntries(["Button", "Card"].map((name) => [name, name]));
  const compiledModule = { exports: {} };
  const context = vm.createContext({
    module: compiledModule,
    exports: compiledModule.exports,
    Error,
    TypeError,
    SyntaxError,
    crypto: { randomUUID },
    fetch: async (url, options) => {
      fetches.push({ url, ...options, body: options?.body ? JSON.parse(options.body) : undefined });
      const next = responses.shift();
      assert.ok(next, `Unexpected fetch: ${url}`);
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    },
    require(name) {
      if (name === "react") return {
        useState(initial) {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = initial;
          return [hooks[index], (value) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
        },
        useRef(initial) {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = { current: initial };
          return hooks[index];
        },
      };
      if (name === "react/jsx-runtime") return require(name);
      if (name === "@/lib/document-blacklist-bulk-core") return bulkCore;
      if (name === "lucide-react") return { Trash2: "Trash2" };
      if (name === "@/app/_components/finser-ui") return ui;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  new vm.Script(compiled).runInContext(context);
  return {
    fetches, responses, busy,
    completed: () => completed,
    render(disabled = false) {
      cursor = 0;
      return compiledModule.exports.default({ disabled, onBusyChange: (value) => busy.push(value), onCompleted: () => { completed += 1; } });
    },
  };
}

function nodes(tree) {
  if (tree == null || typeof tree === "boolean") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== "object") return [tree];
  return [tree, ...nodes(tree.props?.children)];
}
function find(tree, predicate) { const result = nodes(tree).find(predicate); assert.ok(result, "Expected UI element"); return result; }
function text(tree) { return nodes(tree).filter((node) => typeof node === "string" || typeof node === "number").join(" ").replace(/\s+/g, " "); }
function field(harness, label) { return find(find(harness.render(), (node) => node.type === "label" && text(node).includes(label)), (node) => node.type === "textarea"); }
function setField(harness, label, value) { field(harness, label).props.onChange({ target: { value } }); }
function button(harness, label) { return find(harness.render(), (node) => node.type === "Button" && text(node).includes(label)); }
function dialog(harness) { return find(harness.render(), (node) => node.type === "ConfirmDialog"); }
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }
const preview = { ok: true, total: 394, active: 390, inactive: 4, fingerprint: "a".repeat(64) };
async function prepare(h, body = preview) {
  h.responses.push({ status: 200, body });
  button(h, "Eliminar todas las cédulas").props.onClick();
  await settle();
}
async function confirm(h) {
  setField(h, "Motivo de la limpieza", "Depuración autorizada de prueba");
  button(h, "Revisar eliminación").props.onClick();
}

test("revisa toda la lista sin filtros; requiere motivo y confirmación; cancelar no escribe", async () => {
  const h = createHarness();
  await prepare(h);
  assert.equal(h.fetches[0].url, "/api/lista-negra/limpiar");
  assert.equal(h.fetches[0].method, undefined);
  assert.match(text(h.render()), /394 cédulas registradas/);
  assert.equal(button(h, "Revisar eliminación").props.disabled, true);
  await confirm(h);
  assert.equal(h.fetches.length, 1);
  assert.equal(dialog(h).props.open, true);
  assert.match(dialog(h).props.description, /394.*390.*todos los aliados/);
  dialog(h).props.onCancel();
  button(h, "Cancelar").props.onClick();
  assert.equal(h.fetches.length, 1);
  assert.deepEqual(h.busy, [true, false]);
});

test("doble clic y respuesta perdida conservan la operación; reintento actualiza la consola", async () => {
  const h = createHarness();
  await prepare(h); await confirm(h);
  h.responses.push(new Error("Se perdió la conexión"));
  const first = dialog(h);
  first.props.onConfirm(); first.props.onConfirm();
  await settle();
  assert.equal(h.fetches.length, 2);
  assert.match(text(h.render()), /Se perdió la conexión/);
  assert.equal(field(h, "Motivo de la limpieza").props.disabled, true);
  button(h, "Reintentar limpieza").props.onClick();
  h.responses.push({ status: 200, body: { ok: true, removed: 394, unblocked: 390, idempotent: true } });
  dialog(h).props.onConfirm(); await settle();
  assert.deepEqual(h.fetches[2].body, h.fetches[1].body);
  assert.equal(h.fetches[1].body.confirmed, true);
  assert.equal(h.completed(), 1);
  assert.equal(h.busy.at(-1), false);
  assert.match(text(h.render()), /Se eliminaron 394/);
});

test("si cambió la lista exige revisar el nuevo total y confirmar otra vez", async () => {
  const h = createHarness();
  await prepare(h); await confirm(h);
  h.responses.push({ status: 409, body: { ok: false, code: "CLEAR_PREVIEW_CHANGED", error: "La lista cambió" } });
  dialog(h).props.onConfirm(); await settle();
  assert.match(text(h.render()), /La lista cambió/);
  h.responses.push({ status: 200, body: { ...preview, total: 395, fingerprint: "b".repeat(64) } });
  button(h, "Revisar total actualizado").props.onClick(); await settle();
  assert.match(text(h.render()), /395 cédulas/);
  button(h, "Revisar eliminación").props.onClick();
  assert.match(dialog(h).props.description, /395/);
  assert.equal(h.fetches.length, 3, "la nueva vista previa no ejecuta eliminación");
});

test("lista vacía, errores de lectura y operaciones externas no permiten eliminar", async () => {
  const h = createHarness();
  assert.equal(find(h.render(true), n => n.type === "Button").props.disabled, true);
  await prepare(h, { ...preview, total: 0, active: 0, inactive: 0 });
  assert.match(text(h.render()), /está vacía/);
  assert.equal(nodes(h.render()).some(n => n.type === "Button" && text(n) === "Revisar eliminación"), false);
  button(h, "Cancelar").props.onClick();
  h.responses.push(new Error("Sin servicio"));
  button(h, "Eliminar todas las cédulas").props.onClick(); await settle();
  assert.match(text(h.render()), /Sin servicio/);
  assert.equal(h.completed(), 0);
});
