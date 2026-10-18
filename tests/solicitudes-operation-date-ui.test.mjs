import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as solicitudes from "../lib/solicitudes.ts";
import * as creditNumbers from "../lib/credit-display-number.ts";
import * as exportState from "../app/dashboard/solicitudes/solicitudes-export-state.ts";

const require = createRequire(import.meta.url);
const filters = { q: "", plataforma: "", estado: "", desde: "", hasta: "", aliadoId: "", sedeId: "", asesorId: "" };
const credit = {
  id: "C-37", source: "CREDIT", numero: "CRED-37", clienteNombre: "Cliente de prueba",
  documento: null, imei: null, plataforma: "ANDROID", estado: "APROBADA", creadoPor: null,
  aliado: null, sede: null, asesor: null, actions: ["VER_DETALLE"],
  createdAt: "2026-10-13T15:30:00Z", operationAt: "2026-10-17T14:30:00Z", updatedAt: "2026-10-18T17:00:00Z",
};
const date = (value) => new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

function renderUI(filename, initialState, props, selectedId = "") {
  let stateIndex = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const position = stateIndex++;
      return [Object.hasOwn(initialState, position) ? initialState[position] : typeof initial === "function" ? initial() : initial, () => {}];
    },
  };
  const componentModule = { exports: {} };
  const passthrough = ({ children }) => React.createElement("div", null, children);
  const imports = {
    react: hooks,
    "next/link": { __esModule: true, default: ({ children, href }) => React.createElement("a", { href }, children) },
    "next/navigation": { useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(selectedId ? { id: selectedId } : {}) },
    "@/lib/solicitudes": solicitudes,
    "@/lib/credit-display-number": creditNumbers,
    "@/app/_components/finser-ui": new Proxy({}, { get: () => passthrough }),
    "@/app/_components/finser-confirm-dialog": { __esModule: true, default: () => null },
    "./solicitudes-list-view": { __esModule: true, default: () => null },
    "./solicitudes-export": { __esModule: true, default: () => null },
    "./solicitudes-export-state": exportState,
  };
  const source = readFileSync(new URL(`../app/dashboard/solicitudes/${filename}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  runInNewContext(code, {
    module: componentModule, exports: componentModule.exports, URLSearchParams,
    require: (name) => Object.hasOwn(imports, name) ? imports[name]
      : name.endsWith(".module.css") ? { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) } : require(name),
  });
  return renderToStaticMarkup(React.createElement(componentModule.exports.default, props));
}

function renderWall(item) {
  return renderUI("solicitudes-wall-client.tsx", {
    1: { items: [item], total: 1, page: 1, pageSize: 25, options: {} },
    2: item, 3: false,
  }, { viewerRole: "ADMIN" }, item.id);
}

test("tabla clásica, tarjeta móvil y detalle muestran la finalización del 17 y conservan la solicitud del 13 en trazabilidad", () => {
  const html = renderWall(credit);
  const trace = html.match(/<section[^>]*aria-labelledby="detail-dates-title"[^>]*>(.*?)<\/section>/)?.[1];
  assert.ok(trace);
  const list = html.slice(0, html.indexOf('aria-labelledby="solicitud-detail-title"'));
  assert.ok(list.includes("Fecha de operación"));
  assert.ok(list.includes('title="Fecha del crédito"'));
  assert.equal(list.split(date(credit.operationAt)).length - 1, 2, "tabla y tarjeta móvil comparten la fecha del crédito");
  assert.ok(!list.includes(date(credit.createdAt)));
  assert.match(trace, /Fecha del crédito/);
  assert.match(trace, /Fecha de solicitud/);
  assert.ok(trace.includes(date(credit.operationAt)));
  assert.ok(trace.includes(date(credit.createdAt)));
  assert.ok(trace.includes(date(credit.updatedAt)), "la actualización se conserva como un hito distinto");
});

test("el borrador mantiene su fecha de solicitud sin presentar una fecha de crédito", () => {
  const draft = { ...credit, id: "D-38", source: "DRAFT", estado: "PROCESO", operationAt: credit.createdAt };
  const html = renderWall(draft);
  assert.ok(html.includes(date(draft.operationAt)));
  assert.ok(html.includes("Fecha de solicitud"));
  assert.ok(!html.includes("Fecha del crédito"));
  assert.ok(!html.includes(date(credit.operationAt)));
});

test("la descarga explica la misma fecha de operación y conserva los rangos abiertos", () => {
  const appliedFilters = { ...filters, desde: "2026-10-17" };
  const html = renderUI("solicitudes-export.tsx", {
    0: true, 2: { scope: "CENTRAL_ADMIN", scopeLabel: "Alcance de prueba", options: { aliados: [], sedes: [], vendedores: [] } },
  }, { appliedFilters });
  assert.match(html, /fecha del crédito finalizado o a la fecha de solicitud si aún es un borrador/);
  assert.match(html, /hora de Bogotá/);
  assert.match(html, /Incluye completos los días inicial y final/);
  assert.match(html, /Puedes dejar un extremo vacío para no limitarlo/);
  assert.doesNotMatch(html, /fecha de creación de la solicitud/);
});
