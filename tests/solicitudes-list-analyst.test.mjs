import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as solicitudes from "../lib/solicitudes.ts";

const require = createRequire(import.meta.url);
const componentModule = { exports: {} };
const source = readFileSync(new URL("../app/dashboard/solicitudes/solicitudes-list-view.tsx", import.meta.url), "utf8");
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, {
  module: componentModule, exports: componentModule.exports,
  require: (name) => name === "next/link" ? { __esModule: true, default: (props) => { const anchorProps = { ...props }; delete anchorProps.prefetch; return React.createElement("a", anchorProps); } }
    : name === "@/lib/solicitudes" ? solicitudes
    : name.endsWith(".module.css") ? { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) } : require(name),
});
const View = componentModule.exports.default;
const filters = { q: "", plataforma: "", estado: "", desde: "", hasta: "", aliadoId: "", sedeId: "", asesorId: "" };
const noop = () => {};
const props = {
  loading: false, error: "", notice: "", filters, appliedFilters: filters,
  list: { total: 1, page: 1, pageSize: 25, options: {}, items: [{ id: "draft-7", source: "DRAFT", estado: "PROCESO", clienteNombre: "Cliente de prueba", actions: ["ABRIR_SOLICITUD", "VER_DETALLE", "ABRIR_FABRICA", "DESISTIR"] }] },
  setFilters: noop, quickFilter: noop, applyFilters: noop, clearFilters: noop, refresh: noop, dismissNotice: noop,
  goToPage: noop, setPageSize: noop, openDetail: noop, desist: noop,
  factoryHref: () => "/dashboard/creditos?draft=7", replacementHref: () => "/replacement", displayNumber: () => "SOL-7",
};

test("el diseño compartido dirige al analista al expediente y excluye operaciones comerciales", () => {
  const html = renderToStaticMarkup(React.createElement(View, { ...props, requestHref: () => "/dashboard/aprobaciones/solicitudes/draft-7?returnTo=filtered" }));
  assert.match(html, /\/dashboard\/aprobaciones\/solicitudes\/draft-7\?returnTo=filtered/);
  for (const label of ["Ingresar", "Ver resumen", "Más filtros", "En proceso", "Rechazadas", "Cliente / Solicitud"]) assert.ok(html.includes(label));
  assert.ok(!html.includes("/dashboard/creditos?draft=7"));
  assert.ok(html.includes("Desistir solicitud"));
  assert.ok(!html.includes("Cambio por garantía"));
});

test("el menú del analista no permite desistir si el servidor no autoriza la acción", () => {
  const items = [{ ...props.list.items[0], source: "CREDIT", estado: "APROBADA", actions: ["ABRIR_SOLICITUD", "VER_DETALLE"] }];
  const html = renderToStaticMarkup(React.createElement(View, { ...props, list: { ...props.list, items }, requestHref: () => "/dashboard/aprobaciones/solicitudes/C-7" }));
  assert.ok(html.includes("Ver detalle"));
  assert.ok(!html.includes("Desistir solicitud"));
});

test("el visor comercial conserva Continuar hacia la fábrica", () => {
  const html = renderToStaticMarkup(React.createElement(View, props));
  assert.ok(html.includes("/dashboard/creditos?draft=7"));
  assert.ok(html.includes("Continuar"));
  assert.ok(html.includes("Desistir"));
});
