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
const source = readFileSync(path.join(root, "app/dashboard/lista-negra/blacklist-bulk-panel.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function createHarness() {
  const hooks = [];
  const fetches = [];
  const responses = [];
  const busy = [];
  let completed = 0;
  let cursor = 0;
  const ui = Object.fromEntries(["Badge", "Button", "DataTable", "LoadingState", "StatusPill"].map((name) => [name, name]));
  const compiledModule = { exports: {} };
  const context = vm.createContext({
    module: compiledModule,
    exports: compiledModule.exports,
    Error,
    TypeError,
    SyntaxError,
    crypto: { randomUUID },
    fetch: async (url, options) => {
      fetches.push({ url, ...options, body: JSON.parse(options.body) });
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
      if (name === "lucide-react") return { ClipboardList: "ClipboardList" };
      if (name === "@/app/_components/finser-ui") return ui;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  new vm.Script(compiled).runInContext(context);
  return {
    fetches, responses, busy,
    completed: () => completed,
    render() {
      cursor = 0;
      return compiledModule.exports.default({ onBusyChange: (value) => busy.push(value), onCompleted: () => { completed += 1; } });
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
const summary = { total: 4, nuevas: 1, reactivar: 1, yaBloqueadas: 1, duplicadas: 1, invalidas: 0 };
function previewBody(overrides = {}) {
  return { ok: true, summary, rows: [{ position: 1, input: "123456", documento: "123456", status: "NUEVA", message: "Se bloqueará" }], fingerprint: "preview-1", motivo: "Motivo común", canConfirm: true, maxEntries: 500, ...overrides };
}
async function preparePreview(harness, body = previewBody()) {
  setField(harness, "Cédulas para bloquear", "123456\n234567\n345678\n123456");
  setField(harness, "Motivo común del bloqueo", "Motivo común");
  harness.responses.push({ status: 200, body });
  find(harness.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
}

test("la carga masiva requiere preview y confirmación global antes de enviar", async () => {
  const h = createHarness();
  assert.equal(button(h, "Previsualizar lista").props.disabled, true);
  await preparePreview(h);
  assert.equal(h.fetches[0].url, "/api/lista-negra/masivo/previsualizar");
  button(h, "Revisar importación").props.onClick();
  const confirmation = dialog(h);
  assert.equal(confirmation.props.open, true);
  assert.match(confirmation.props.description, /1 bloqueos nuevos.*1 bloqueos inactivos/);
  assert.match(confirmation.props.description, /ningún aliado/);
  assert.deepEqual(h.busy, [true]);
  assert.equal(h.fetches.length, 1);
  confirmation.props.onCancel();
  assert.equal(dialog(h).props.open, false);
  assert.deepEqual(h.busy, [true, false]);
});

test("editar texto o motivo invalida la preview y descarta respuestas antiguas", async () => {
  const h = createHarness();
  await preparePreview(h);
  setField(h, "Motivo común del bloqueo", "Otro motivo");
  assert.equal(nodes(h.render()).some((node) => node.type === "section" && node.props["aria-labelledby"] === "blacklist-bulk-preview-title"), false);
  let release;
  h.responses.push(() => new Promise((resolve) => { release = resolve; }));
  find(h.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  setField(h, "Cédulas para bloquear", "987654");
  release({ ok: true, status: 200, json: async () => previewBody() });
  await settle();
  assert.equal(nodes(h.render()).some((node) => node.type === "section" && node.props["aria-labelledby"] === "blacklist-bulk-preview-title"), false);
});

test("los límites no truncan el texto pegado y las filas inválidas impiden guardar", async () => {
  const h = createHarness();
  setField(h, "Cédulas para bloquear", Array.from({ length: 501 }, () => "123456").join("\n"));
  setField(h, "Motivo común del bloqueo", "Motivo común");
  assert.equal(button(h, "Previsualizar lista").props.disabled, true);
  assert.match(text(h.render()), /más de 500/);
  const large = "123456 ".repeat(8_000);
  setField(h, "Cédulas para bloquear", large);
  assert.equal(field(h, "Cédulas para bloquear").props.value, large);
  assert.equal(button(h, "Previsualizar lista").props.disabled, true);
  await preparePreview(h, previewBody({ canConfirm: false, summary: { ...summary, invalidas: 1 } }));
  assert.equal(button(h, "Revisar importación").props.disabled, true);
  assert.match(text(h.render()), /corrige las entradas inválidas/);
});

test("500 cédulas con encabezado cuentan como 500 y permiten previsualizar usando el helper real", async () => {
  const h = createHarness();
  const texto = ["Cédula", ...Array.from({ length: 500 }, (_, index) => String(1_000_000 + index))].join("\n");
  setField(h, "Cédulas para bloquear", texto);
  setField(h, "Motivo común del bloqueo", "Motivo común");
  assert.equal(bulkCore.countBlacklistBulkEntries(texto), 500);
  assert.match(text(h.render()), /500 \/ 500 entradas/);
  assert.equal(button(h, "Previsualizar lista").props.disabled, false);
  h.responses.push({ status: 200, body: previewBody() });
  find(h.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].body.texto, texto);
});

test("un resultado incierto conserva mutationId y evita doble envío al reintentar", async () => {
  const h = createHarness();
  await preparePreview(h);
  button(h, "Revisar importación").props.onClick();
  h.responses.push(new TypeError("Network interrupted"));
  const firstDialog = dialog(h);
  firstDialog.props.onConfirm();
  firstDialog.props.onConfirm();
  await settle();
  assert.equal(h.fetches.length, 2);
  const firstBody = h.fetches[1].body;
  assert.equal(firstBody.confirmed, true);
  assert.equal(firstBody.fingerprint, "preview-1");
  assert.match(text(h.render()), /Reintenta la misma importación/);
  button(h, "Revisar importación").props.onClick();
  h.responses.push({ status: 200, body: { ok: true, importId: "batch-1", summary, createdAt: "2026-09-08T20:00:00Z", actorName: "Admin", idempotent: true } });
  dialog(h).props.onConfirm();
  await settle();
  assert.equal(h.fetches[2].body.mutationId, firstBody.mutationId);
  assert.equal(h.completed(), 1);
  assert.match(text(h.render()), /Se recuperó el resultado de una carga ya registrada; no se volvió a aplicar/);
  assert.match(text(h.render()), /estados vigentes/);
  assert.doesNotMatch(text(h.render()), /Los bloqueos se aplicaron a todos los aliados/);
});

test("un cambio concurrente exige nueva previsualización", async () => {
  const h = createHarness();
  await preparePreview(h);
  button(h, "Revisar importación").props.onClick();
  h.responses.push({ status: 409, body: { ok: false, code: "BULK_PREVIEW_CHANGED", error: "Changed" } });
  dialog(h).props.onConfirm();
  await settle();
  assert.match(text(h.render()), /No se aplicó esta carga; previsualiza nuevamente/);
  assert.equal(nodes(h.render()).some((node) => node.type === "section" && node.props["aria-labelledby"] === "blacklist-bulk-preview-title"), false);
  assert.equal(h.completed(), 0);
});

test("la tabla masiva pagina el detalle y la consola conserva el panel al cambiar de pestaña", async () => {
  const h = createHarness();
  const rows = Array.from({ length: 500 }, (_, index) => ({ position: index + 1, input: String(1_000_000 + index), documento: String(1_000_000 + index), status: "NUEVA", message: "Nuevo bloqueo" }));
  await preparePreview(h, previewBody({ rows, summary: { total: 500, nuevas: 500, reactivar: 0, yaBloqueadas: 0, duplicadas: 0, invalidas: 0 } }));
  assert.equal(nodes(h.render()).filter((node) => node.type === "tr").length, 26);
  assert.match(text(h.render()), /Página 1 de 20/);
  button(h, "Siguiente").props.onClick();
  assert.match(text(h.render()), /Página 2 de 20/);
  const consoleSource = readFileSync(path.join(root, "app/dashboard/lista-negra/blacklist-console.tsx"), "utf8");
  assert.match(consoleSource, /hidden=\{registrationMode !== "bulk"\}/);
  assert.match(consoleSource, /const busy = saving \|\| Boolean\(confirmation\) \|\| bulkBusy/);
  assert.match(consoleSource, /onBusyChange=\{setBulkBusy\}/);
  assert.match(consoleSource, /setFilters\(\{ q: "", estado: "ACTIVA", page: 1 \}\)/);
});
