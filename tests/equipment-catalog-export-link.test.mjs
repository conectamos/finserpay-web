import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const loaded = { exports: {} };
const source = ts.transpileModule(readFileSync(new URL("../app/dashboard/catalogo-equipos/catalog-export-link.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
runInNewContext(source, {
  module: loaded, exports: loaded.exports, URLSearchParams,
  require(name) {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "lucide-react") return { Download: () => jsxRuntime.jsx("svg", { "aria-hidden": true }) };
    throw new Error("Unexpected dependency: " + name);
  },
});

test("la descarga comparte filtros de producto, búsqueda y estado, sin paginar la exportación", () => {
  const tree = loaded.exports.default({ product: "IPHONE", query: "  Pro & Max # ñ  ", status: "TODOS" });
  const url = new URL(tree.props.href, "https://finser.test");
  assert.equal(url.pathname, "/api/creditos/catalogo-equipos/exportar");
  assert.equal(url.searchParams.get("product"), "IPHONE");
  assert.equal(url.searchParams.get("q"), "Pro & Max # ñ");
  assert.equal(url.searchParams.get("status"), "TODOS");
  assert.equal(url.searchParams.has("page"), false);
  assert.equal(url.searchParams.has("pageSize"), false);
  assert.equal(tree.props.download, true);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Descargar Excel/);
  assert.match(html, /fp-ui-button is-secondary/);
});

test("sin búsqueda exporta todos los activos del producto aliado seleccionado", () => {
  const tree = loaded.exports.default({ product: "ANDROID", query: "  " });
  const url = new URL(tree.props.href, "https://finser.test");
  assert.equal(url.searchParams.get("product"), "ANDROID");
  assert.equal(url.searchParams.get("status"), "ACTIVOS");
  assert.equal(url.searchParams.has("q"), false);
});
