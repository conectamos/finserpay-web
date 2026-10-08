import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(path, dependencies, globals = {}) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, URL, Date, Intl, AbortController,
    require(name) { assert.ok(name in dependencies, "Unexpected dependency " + name); return dependencies[name]; },
    ...globals,
  }, { filename: path });
  return compiledModule.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const call = (patch = {}) => ({ id: "event-one", creditId: 72, status: "COMPLETED", source: "NORMAL", providerCallId: "call-one",
  createdAt: "2026-10-08T15:00:00Z", dispatchedAt: "2026-10-08T15:00:00Z", completedAt: "2026-10-08T15:02:00Z",
  durationSeconds: 94, identityVerified: false, summary: "Se conversó con el cliente.", doubts: "Revisar una fecha.",
  recordingUrl: "https://app.dapta.ai/call-log/private-one", audioStorage: "DAPTA_PRIVATE_LINK", resultCode: "CUSTOMER_DISCREPANCY",
  ...patch,
});
function fixture({ items = [call()], loading = false, error = "", fetch } = {}) {
  const states = [loading ? null : { creditId: 72, revision: 0, items, error }, 0]; const effects = []; const changes = [];
  let index = 0;
  const hooks = { useState: () => { const slot = index++; return [states[slot], value => { changes.push({ slot, value }); }]; },
    useEffect: callback => effects.push(callback) };
  const Icon = () => null;
  const Component = load("app/dashboard/aprobaciones/credit-welcome-voice-result.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "lucide-react": { ExternalLink: Icon, Headphones: Icon, RefreshCw: Icon },
    "@/app/_components/finser-ui": ui,
  }, { fetch }).default;
  const render = (creditId = 72) => { index = 0; return renderToStaticMarkup(createElement(Component, { creditId })); };
  return { render, effects, changes };
}

test("voice result renders actual outcome and a private Dapta link while explaining manual audio download", () => {
  const html = fixture().render();
  assert.match(html, /Llamada finalizada/); assert.match(html, /Diferencia por revisar/);
  assert.match(html, /Sin verificación registrada/); assert.doesNotMatch(html, /Verificada en FINSER PAY/);
  assert.match(html, /1 min 34 s/); assert.match(html, /Revisar una fecha/);
  assert.match(html, /href="https:\/\/app\.dapta\.ai\/call-log\/private-one"/);
  assert.match(html, /Abrir llamada en Dapta/); assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.match(html, /El audio permanece en Dapta y se descarga manualmente allí/);
  assert.match(html, /no guarda el archivo de audio/); assert.doesNotMatch(html, /<audio|type="file"|Enviar llamada/);
});

test("voice result never renders an untrusted recording URL or interprets summaries as HTML", () => {
  for (const url of ["javascript:alert(1)", "https://public-recordings.test/file.mp3", "https://app.dapta.ai.attacker.test/call", "https://user:password@app.dapta.ai/call"]) {
    const html = fixture({ items: [call({ recordingUrl: url, summary: "<img src=x onerror=alert(1)>", doubts: "<script>bad()</script>" })] }).render();
    assert.doesNotMatch(html, /href=|<img|<script/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
    assert.match(html, /No hay un enlace privado disponible/);
  }
});

test("loading, error, empty and wrong-credit results do not expose stale conversation content", () => {
  assert.match(fixture({ loading: true }).render(), /Consultando llamada de bienvenida/);
  assert.doesNotMatch(fixture({ loading: true }).render(), /Se conversó con el cliente/);
  assert.match(fixture({ error: "No se pudo consultar." }).render(), /role="alert"/);
  assert.doesNotMatch(fixture({ error: "No se pudo consultar." }).render(), /Se conversó con el cliente/);
  assert.match(fixture({ items: [] }).render(), /Sin llamada registrada/);
  assert.doesNotMatch(fixture({ items: [call({ creditId: 99, summary: "Other customer private summary" })] }).render(), /Other customer/);
});

test("closing/changing the credit aborts its read so a late response cannot overwrite the visible result", async () => {
  let resolveResponse; let options;
  const f = fixture({ fetch: (_url, supplied) => { options = supplied; return new Promise(resolve => { resolveResponse = resolve; }); } });
  f.render(); const close = f.effects[0]();
  assert.equal(options.cache, "no-store"); close(); assert.equal(options.signal.aborted, true);
  resolveResponse({ ok: true, json: async () => ({ ok: true, items: [call()] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.changes.length, 0);
});
