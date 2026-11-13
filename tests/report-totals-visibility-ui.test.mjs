import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const Empty = () => null;
const Link = ({ children, ...props }) => jsxRuntime.jsx("a", { ...props, children });
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Intl, Date,
    require(name) {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "next/link") return { default: Link };
      if (name === "lucide-react") return new Proxy({}, { get: () => Empty });
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (["@/lib/payment-report", "@/lib/payment-methods", "@/lib/credit-report-identifiers"].includes(name)) return load(`${name.slice(2)}.ts`);
      throw new Error(`Dependencia inesperada: ${name}`);
    },
  }, { filename: file });
  cache.set(file, loaded.exports);
  return loaded.exports;
}
const ReportCenter = load("app/dashboard/reportes/report-center.tsx").default;
const PaymentReportView = load("app/dashboard/reportes/abonos/payment-report-view.tsx").default;
const { paymentReportMoney } = load("lib/payment-report.ts");
const render = (Component, props) => renderToStaticMarkup(jsxRuntime.jsx(Component, props));
const normalize = value => value.replace(/\s/g, "");
function indicators(html, label) {
  const section = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>(.*?)</section>`))?.[0];
  assert.ok(section, `Sección ${label}`);
  return {
    html: section,
    labels: Array.from(section.matchAll(/<span>(.*?)<\/span>/g), match => match[1]),
    values: Array.from(section.matchAll(/<strong[^>]*>(.*?)<\/strong>/g), match => match[1]),
  };
}
const centerProps = {
  admin: true, adminCentral: false, period: "month", selectedSedeId: "7", initialQuery: "",
  sedes: [{ id: 7, nombre: "Sede QA" }],
  reports: [{ kind: "payments", title: "Recaudos", description: "Pagos de la operación", formats: ["Excel"], href: "/dashboard/reportes/abonos" }],
  metrics: { activeCredits: "32", collected: "$ 123.456", portfolioBalance: "$ 987.654.321", mora: "87,65%" },
};
const noop = () => {};
const paymentProps = {
  isAdmin: true, isCentralAdmin: false, loading: false, error: false, exporting: false, message: "",
  sedeNombre: "Sede QA", search: "", from: "2026-11-01", to: "2026-11-13", aliadoId: "5", sedeId: "7",
  aliados: [{ id: 5, nombre: "Aliado QA" }], sedes: [{ id: 7, nombre: "Sede QA" }],
  setSearch: noop, setFrom: noop, setTo: noop, setAliado: noop, setSede: noop, apply: noop,
  exportExcel: noop, annul: noop, remove: noop, annullingId: null, deletingId: null,
  summary: { totalAbonos: 12, totalRecaudadoPeriodo: 123456, totalPendientePorCobrar: 987654321, totalRecaudadoGeneral: 876543210, totalCreditos: 32, creditosAlDia: 21 },
  byDay: [],
  items: [{ id: 71, valor: 20000, metodoPago: "EFECTIVO", estado: "ACTIVO", fechaAbono: "2026-11-13T15:00:00Z",
    credito: { id: 9, folio: "FC-QA-9", numeroSadmin: "SADMIN-QA-9", clienteNombre: "Cliente QA", clienteDocumento: "100001" },
    sede: { id: 7, nombre: "Sede QA", aliado: { id: 5, nombre: "Aliado QA" } }, usuario: { nombre: "Recaudador QA" }, vendedor: null }],
};

test("Centro aliado conserva dos indicadores aunque reciba los totales de un payload central antiguo", () => {
  for (const admin of [true, false]) {
    const html = render(ReportCenter, { ...centerProps, admin });
    const metrics = indicators(html, "Indicadores de la operación");
    assert.deepEqual(metrics.labels, ["Créditos activos", "Recaudado del período"]);
    assert.deepEqual(metrics.values, ["32", "$ 123.456"]);
    assert.match(metrics.html, /class="metrics allyMetrics"/);
    assert.doesNotMatch(html, /Saldo de cartera|Mora actual|987\.654\.321|87,65%|Porcentaje del saldo pendiente|Saldo pendiente actual/);
    assert.match(html, /href="\/dashboard\/reportes\/abonos"/);
    assert.match(html, /aria-label="Sede"/);
  }
});

test("Centro central conserva cuatro indicadores y valores completos, incluido cero", () => {
  const html = render(ReportCenter, { ...centerProps, adminCentral: true, metrics: { ...centerProps.metrics, mora: "0%" } });
  const metrics = indicators(html, "Indicadores de la operación");
  assert.deepEqual(metrics.labels, ["Créditos activos", "Recaudado del período", "Saldo de cartera", "Mora actual"]);
  assert.deepEqual(metrics.values, ["32", "$ 123.456", "$ 987.654.321", "0%"]);
  assert.doesNotMatch(metrics.html, /allyMetrics/);
});

test("Recaudos aliado conserva tres indicadores, filtros, pagos y acciones permitidas sin los dos totales centrales", () => {
  for (const isAdmin of [true, false]) {
    const html = render(PaymentReportView, { ...paymentProps, isAdmin });
    const metrics = indicators(html, "Indicadores de recaudos");
    assert.deepEqual(metrics.labels, ["Abonos del período", "Recaudado del período", "Créditos al día"]);
    assert.deepEqual(metrics.values.map(normalize), ["12", normalize(paymentReportMoney(123456)), "21"]);
    assert.match(metrics.html, /class="metrics allyMetrics"/);
    assert.doesNotMatch(html, /Pendiente por cobrar|Recaudado general|987\.654\.321|876\.543\.210|Eliminar/);
    assert.match(html, /Cliente QA/);
    assert.match(html, /SADMIN-QA-9/);
    assert.match(html, /Exportar Excel/);
    assert.match(html, /aria-label="Fecha desde"/);
    if (isAdmin) assert.match(html, /Anular/);
    else assert.match(html, /Sin acciones disponibles/);
  }
});

test("Recaudos central mantiene cinco indicadores y no transforma un cero válido", () => {
  const html = render(PaymentReportView, { ...paymentProps, isCentralAdmin: true,
    summary: { ...paymentProps.summary, totalPendientePorCobrar: 0 } });
  const metrics = indicators(html, "Indicadores de recaudos");
  assert.deepEqual(metrics.labels, ["Abonos del período", "Recaudado del período", "Pendiente por cobrar", "Recaudado general", "Créditos al día"]);
  assert.deepEqual(metrics.values.map(normalize), ["12", normalize(paymentReportMoney(123456)), normalize(paymentReportMoney(0)), normalize(paymentReportMoney(876543210)), "21"]);
  assert.doesNotMatch(metrics.html, /allyMetrics/);
  assert.match(html, /Eliminar/);
});

test("los indicadores restringidos no se leen para el aliado y su ausencia no se convierte en cero", () => {
  const centerMetrics = { activeCredits: "32", collected: "$ 123.456" };
  const summary = { totalAbonos: 12, totalRecaudadoPeriodo: 123456, totalCreditos: 32, creditosAlDia: 21 };
  const omittedCenter = render(ReportCenter, { ...centerProps, metrics: centerMetrics });
  const omittedPayments = render(PaymentReportView, { ...paymentProps, summary });
  for (const key of ["portfolioBalance", "mora"]) Object.defineProperty(centerMetrics, key, { get() { assert.fail(`El aliado no debe leer ${key}`); } });
  for (const key of ["totalPendientePorCobrar", "totalRecaudadoGeneral"]) Object.defineProperty(summary, key, { get() { assert.fail(`El aliado no debe leer ${key}`); } });
  assert.equal(render(ReportCenter, { ...centerProps, metrics: centerMetrics }), omittedCenter);
  assert.equal(render(PaymentReportView, { ...paymentProps, summary }), omittedPayments);
  const centralMissing = indicators(render(PaymentReportView, { ...paymentProps, isCentralAdmin: true,
    summary: { totalAbonos: 12, totalRecaudadoPeriodo: 123456, totalCreditos: 32, creditosAlDia: 21 } }), "Indicadores de recaudos");
  assert.deepEqual(centralMissing.values.slice(2, 4), ["—", "—"]);
});

test("la carga de recaudos mantiene sólo los indicadores autorizados", () => {
  for (const isCentralAdmin of [false, true]) {
    const metrics = indicators(render(PaymentReportView, { ...paymentProps, isCentralAdmin, loading: true, summary: null }), "Indicadores de recaudos");
    assert.equal(metrics.labels.length, isCentralAdmin ? 5 : 3);
    assert.ok(metrics.values.every(value => value === "…"));
    if (!isCentralAdmin) assert.doesNotMatch(metrics.html, /Pendiente por cobrar|Recaudado general/);
  }
});
