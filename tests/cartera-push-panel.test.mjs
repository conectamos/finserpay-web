import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ui, nodes, text } from "./cartera-ui-harness.mjs";

const source = readFileSync(new URL("../app/dashboard/cartera/push-massive-panel.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const summary = { checked: 3, failed: 0, noToken: 1, sent: 0, targetCredits: 3, wouldSend: 2, excludedActiveMoraProtection: 4 };
const response = (data = summary, status = 200) => Response.json({ ok: status === 200, summary: data }, { status });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ confirm = true, fetchResponse = () => response() } = {}) {
  let cursor = 0;
  let tree;
  const slots = [];
  const calls = [];
  const confirmations = [];
  const Icon = props => jsxRuntime.jsx("svg", props);
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const dependencies = {
    react: hooks,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/app/_components/finser-ui": ui,
    "./push-massive-panel.module.css": { default: new Proxy({}, { get: (_, name) => String(name) }) },
  };
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
    window: { confirm: message => { confirmations.push(message); return confirm; } },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return fetchResponse(calls.at(-1));
    },
  });
  const render = () => { cursor = 0; tree = loaded.exports.default(); return renderToStaticMarkup(tree); };
  const button = label => nodes(tree, node => node.type === ui.Button && text(node).includes(label))[0];
  const field = label => {
    const wrapper = nodes(tree, node => node.type === "label" && text(node).startsWith(label))[0];
    return nodes(wrapper, node => node.type === ui.Input || node.type === ui.Select)[0];
  };
  render();
  return {
    calls, confirmations, render, button, field,
    click(label) { const onClick = button(label).props.onClick; onClick(); return render(); },
    change(label, value) { field(label).props.onChange({ target: { value } }); return render(); },
  };
}

test("does not contact the server on render and requires an explicit preview before dispatch", async () => {
  const app = harness();
  assert.equal(app.calls.length, 0);
  assert.equal(app.button("Enviar masivo").props.disabled, true);
  app.click("Enviar masivo");
  assert.equal(app.calls.length, 0);
  assert.equal(app.confirmations.length, 0);
  app.click("Previsualizar");
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, "/api/creditos/push-manual");
  assert.deepEqual(app.calls[0].body, { body: "", dryRun: true, filter: "MORA", mode: "bulk", preset: "mora", title: "FINSER PAY" });
  await flush();
  const html = app.render();
  assert.match(html, /4 crédito\(s\) con prórroga o excepción vigente excluidos/);
  assert.match(html, /Previsualización lista: 2 dispositivo/);
  assert.equal(app.button("Enviar masivo").props.disabled, false);
});

test("every recipient or message change invalidates the preview and disables dispatch", async () => {
  const app = harness();
  for (const [label, value] of [["Grupo", "TODOS_APP"], ["Mensaje", "custom"], ["Título", "Título corregido"], ["Personalizado", "Mensaje corregido"]]) {
    if (label === "Título") app.change("Personalizado", "Mensaje de prueba");
    app.click("Previsualizar");
    await flush();
    app.render();
    assert.equal(app.button("Enviar masivo").props.disabled, false);
    const before = app.calls.length;
    const html = app.change(label, value);
    assert.equal(app.button("Enviar masivo").props.disabled, true);
    assert.doesNotMatch(html, /Resultado de la previsualización/);
    app.click("Enviar masivo");
    assert.equal(app.calls.length, before);
  }
});

test("immediate repeated clicks cannot create duplicate previews or dispatches", async () => {
  let release;
  const app = harness({ fetchResponse: () => new Promise(resolve => { release = resolve; }) });
  const previewClick = app.button("Previsualizar").props.onClick;
  previewClick();
  previewClick();
  assert.equal(app.calls.length, 1);
  app.render();
  assert.equal(app.button("Revisando").props.disabled, true);
  assert.equal(app.field("Grupo").props.disabled, true);
  release(response());
  await flush();
  app.render();
  const sendClick = app.button("Enviar masivo").props.onClick;
  sendClick();
  sendClick();
  assert.equal(app.calls.length, 2);
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.calls[1].body.dryRun, false);
  release(response({ ...summary, sent: 2, wouldSend: 0 }));
  await flush();
  const html = app.render();
  assert.match(html, /Enviadas: 2/);
  assert.equal(app.button("Enviar masivo").props.disabled, true);
  sendClick();
  assert.equal(app.calls.length, 2, "a completed batch requires a fresh preview");
});

test("cancelled confirmation and empty custom content never dispatch notifications", async () => {
  const app = harness({ confirm: false });
  app.change("Mensaje", "custom");
  const html = app.click("Previsualizar");
  assert.match(html, /role="alert"/);
  assert.equal(app.calls.length, 0);
  app.change("Personalizado", "Conservar este contenido");
  app.click("Previsualizar");
  await flush();
  app.render();
  app.click("Enviar masivo");
  assert.equal(app.calls.length, 1);
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.field("Personalizado").props.value, "Conservar este contenido");
});

test("server errors preserve the form and do not retry a possibly completed dispatch automatically", async () => {
  let fail = false;
  const app = harness({ fetchResponse: () => fail ? Response.json({ error: "Servicio temporalmente no disponible" }, { status: 503 }) : response() });
  app.change("Mensaje", "custom");
  app.change("Título", "Mi título");
  app.change("Personalizado", "Mi mensaje");
  app.click("Previsualizar");
  await flush();
  app.render();
  fail = true;
  app.click("Enviar masivo");
  await flush();
  const html = app.render();
  assert.match(html, /role="alert"/);
  assert.match(html, /Servicio temporalmente no disponible/);
  assert.equal(app.field("Título").props.value, "Mi título");
  assert.equal(app.field("Personalizado").props.value, "Mi mensaje");
  assert.equal(app.button("Enviar masivo").props.disabled, true);
  assert.equal(app.calls.length, 2);
});

test("stale responses cannot enable dispatch after the pending input was changed", async () => {
  let release;
  const app = harness({ fetchResponse: () => new Promise(resolve => { release = resolve; }) });
  app.click("Previsualizar");
  app.change("Grupo", "VENCE_HOY");
  release(response());
  await flush();
  const html = app.render();
  assert.equal(app.button("Enviar masivo").props.disabled, true);
  assert.doesNotMatch(html, /Resultado de la previsualización/);
});

test("an empty target preview is visible but does not enable dispatch", async () => {
  const app = harness({ fetchResponse: () => response({ ...summary, wouldSend: 0, noToken: 3, excludedActiveMoraProtection: 0 }) });
  app.click("Previsualizar");
  await flush();
  const html = app.render();
  assert.match(html, /No hay dispositivos disponibles/);
  assert.doesNotMatch(html, /prórroga o excepción vigente excluidos/);
  assert.equal(app.button("Enviar masivo").props.disabled, true);
});
