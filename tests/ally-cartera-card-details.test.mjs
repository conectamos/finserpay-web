import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { nodes, text, ui } from "./cartera-ui-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const modules = Object.fromEntries(await Promise.all([
  "portfolio-profit", "credit-capital", "credit-payment-plan", "credit-outstanding-balance",
  "ally-payments-core", "credit-factory", "cartera-access", "credit-display-number", "aliados",
].map(async name => [`@/lib/${name}`, await jiti.import(`../lib/${name}.ts`)])));
const output = ts.transpileModule(readFileSync(new URL("../app/dashboard/cartera/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const now = new Date("2026-11-13T17:00:00Z");
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
const allies = [1, 2].map(id => ({ id, nombre: `Aliado ${id}`, codigo: `ALIADO${id}`,
  redescuentoPorcentaje: 10, redescuentoAndroidPorcentaje: 10, redescuentoIphonePorcentaje: 10 }));
const styles = new Proxy({}, { get: (_, name) => String(name) });
const Icon = () => jsxRuntime.jsx("svg", {});
const Link = ({ children, href, ...props }) => jsxRuntime.jsx("a", { ...props, href, children });
const plain = value => JSON.parse(JSON.stringify(value));

function credit(id, firstDue, { ally = 1, paid = false, platform = "IPHONE" } = {}) {
  const capital = 1_000_000 + id * 1_000;
  const total = 1_700_000 + id * 101;
  return { id, folio: `QA-${id}`, clienteNombre: `Cliente de prueba ${id}`, clienteDocumento: `DOC-${id}`,
    clienteTelefono: "3000000000", estado: "ACTIVO", referenciaEquipo: `Equipo ${id}`,
    equipoMarca: platform === "IPHONE" ? "Apple" : "Samsung", contratoSnapshot: { equipo: { plataforma: platform } },
    cuotaInicial: 0, saldoBaseFinanciado: capital, valorEquipoTotal: capital, valorFianza: 0, valorInteres: total - capital,
    montoCredito: total, valorCuota: 301_000 + id * 17, plazoMeses: 4, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: firstDue, fechaProximoPago: null, pazYSalvoEmitidoAt: paid ? now : null,
    abonos: [{ valor: paid ? total : 12_345, fechaAbono: now }],
    sede: { nombre: `Sede ${ally}`, aliado: allies[ally - 1] }, vendedor: null,
    liquidacionAliadoCredito: { valorPagar: capital * .9, valorIntermediacion: capital * .1,
      estado: "PAGADO", liquidacion: { estado: "PAGADA" } } };
}
const fixtures = () => [credit(1, "2026-11-08"), credit(2, "2026-10-24"), credit(3, "2026-09-29"),
  credit(4, "2026-12-02", { platform: "ANDROID" }), credit(5, "2026-10-17", { paid: true }),
  credit(99, "2026-09-01", { ally: 2 })];

async function render({ central = false, rows = fixtures(), params = {} } = {}) {
  const calls = { allies: [], credits: [], expenses: [], profit: [], navigation: [] };
  const fits = (row, where) => !where ||
    ((!where.sede || row.sede.aliado.id === where.sede.aliadoId) &&
      (!where.id || where.id.in.includes(row.id)) && (!where.AND || where.AND.every(part => fits(row, part))));
  const prisma = {
    aliado: { findMany: async args => { calls.allies.push(plain(args)); return allies.filter(ally => !args.where.id || ally.id === args.where.id); } },
    credito: { findMany: async args => { calls.credits.push(plain(args)); return rows.filter(row => fits(row, args.where)); } },
    gastoCartera: { findMany: async args => { calls.expenses.push(plain(args)); return [{ valor: 17_283 }]; } },
  };
  const dependencies = {
    ...modules, "react/jsx-runtime": jsxRuntime, "next/link": { default: Link },
    "next/navigation": { redirect() { throw new Error("Unexpected redirect"); } },
    "lucide-react": new Proxy({}, { get: () => Icon }), "@/lib/prisma": { default: prisma },
    "@/lib/credit-assigned-seller": { resolveCreditAssignedAdministrator: () => null },
    "@/lib/dashboard-access": { requireAdminDashboardAccess: async () => ({ session: {
      id: 7, nombre: "Administrador de prueba", rolNombre: "ADMIN", aliadoAccesoId: 1,
      aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO1",
    } }) },
    "@/lib/aliados": { ...modules["@/lib/aliados"], ensureAliadoSchema: async () => {} },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map(), withCreditDisplayNumber: row => row },
    "@/app/_components/finser-ui": ui,
    "../_components/finser-navigation": { default: props => { calls.navigation.push(props); return null; } },
    "./cartera.module.css": { default: styles },
    "./push-massive-panel": { default: () => null },
    "./cuotavencida-whatsapp-button": { default: () => null },
    "./portfolio-profit-breakdown": { default: props => { calls.profit.push(props); return null; } },
  };
  const loaded = { exports: {} };
  runInNewContext(output, { module: loaded, exports: loaded.exports, Date: FixedDate, Intl, URLSearchParams,
    require(name) { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; } });
  const element = await loaded.exports.default({ searchParams: Promise.resolve(params) });
  const html = renderToStaticMarkup(element);
  return { element, html, calls };
}

const forbidden = /Cartera al dia|Cartera en mora|Recuperado|Detalle financiero|Inversión acumulada|Capital comprometido|Ganancia estimada|Saldo por cobrar|Saldo total/;
const treePayload = tree => JSON.stringify(tree, (key, value) => key === "_owner" ? undefined : typeof value === "function" ? `[${value.name}]` : value);
const bucketNodes = tree => nodes(tree, node => ["Temprana", "Mayor", "Avanzada"].includes(node.props?.title));
const tableNode = tree => nodes(tree, node => node.type === "table")[0];

test("el aliado no recibe tarjetas ni Detalle financiero en HTML, atributos ocultos o props RSC", async () => {
  const result = await render();
  assert.doesNotMatch(result.html, forbidden);
  assert.doesNotMatch(treePayload(result.element), forbidden);
  assert.equal(nodes(result.element, node => node.props?.["aria-label"] === "Resumen de cartera").length, 0);
  assert.equal(nodes(result.element, node => node.props?.className === "financialDetails").length, 0);
  assert.equal(result.calls.profit.length, 0);
  assert.equal(result.calls.navigation[0].adminCentral, false);
});

test("el riesgo del aliado conserva rangos y clientes sin importes, porcentajes ni progress en DOM o props", async () => {
  const { element } = await render();
  const buckets = bucketNodes(element);
  assert.equal(buckets.length, 3);
  assert.deepEqual(buckets.map(node => ({ title: node.props.title, subtitle: node.props.subtitle, clients: node.props.clients })), [
    { title: "Temprana", subtitle: "1 a 15 dias", clients: 1 },
    { title: "Mayor", subtitle: "16 a 30 dias", clients: 1 },
    { title: "Avanzada", subtitle: "Mas de 30 dias", clients: 1 },
  ]);
  for (const bucket of buckets) {
    assert.equal("value" in bucket.props, false, "No enviar el saldo mediante props aunque no se pinte");
    assert.equal("percentValue" in bucket.props, false);
    const html = renderToStaticMarkup(bucket);
    assert.doesNotMatch(html, /\$|%|progressbar|aria-valuenow|aria-valuemax|del saldo/);
    assert.match(html, /bucketClients[^>]*>1</);
    assert.ok(html.includes(bucket.props.subtitle));
  }
});

test("la tabla del aliado omite Saldo total y conserva capital pendiente, cuota e identificación", async () => {
  const { element, html } = await render();
  const table = tableNode(element);
  const headers = nodes(table, node => node.type === "th").map(text);
  assert.equal(headers.length, 11);
  assert.equal(headers.includes("Saldo total"), false);
  for (const label of ["Documento", "Celular", "Ref. familiar", "Número crédito", "Equipo", "Mora", "Capital pendiente", "Cuota"]) {
    assert.ok(headers.includes(label), `Columna operativa conservada: ${label}`);
  }
  const rows = nodes(table, node => node.type === "tr" && nodes(node, child => child.type === "td").length > 0);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const cells = nodes(row, node => node.type === "td");
    assert.equal(cells.length, headers.length);
    assert.match(text(cells[headers.indexOf("Capital pendiente")]), /\$/);
    assert.match(text(cells[headers.indexOf("Cuota")]), /\$/);
  }
  assert.doesNotMatch(html, /Cliente de prueba 99|DOC-99/);
});

test("central conserva tarjetas, Detalle financiero, tasas y saldos de los tres rangos", async () => {
  const result = await render({ central: true, params: { aliadoId: "1" } });
  for (const label of ["Cartera al dia", "Cartera en mora", "Recuperado", "Detalle financiero", "Inversión acumulada", "Saldo total"]) {
    assert.ok(result.html.includes(label), `Central conserva ${label}`);
  }
  assert.equal(result.calls.profit.length, 1);
  assert.equal(result.calls.navigation[0].adminCentral, true);
  const buckets = bucketNodes(result.element);
  assert.equal(buckets.length, 3);
  for (const bucket of buckets) {
    assert.ok(bucket.props.value > 0);
    assert.ok(bucket.props.percentValue > 0);
    const html = renderToStaticMarkup(bucket);
    assert.match(html, /\$/);
    assert.match(html, /% del saldo/);
    assert.match(html, /role="progressbar"/);
  }
  const table = tableNode(result.element);
  assert.equal(nodes(table, node => node.type === "th").length, 12);
  for (const row of nodes(table, node => node.type === "tr" && nodes(node, child => child.type === "td").length > 0)) {
    assert.equal(nodes(row, node => node.type === "td").length, 12);
  }
});

test("las tablas vacías ajustan colspan a las columnas autorizadas", async () => {
  for (const central of [false, true]) {
    const { element, html } = await render({ central, rows: [] });
    const table = tableNode(element);
    const columns = nodes(table, node => node.type === "th").length;
    assert.equal(columns, central ? 12 : 11);
    const cells = nodes(table, node => node.type === "td");
    assert.equal(cells.length, 1);
    assert.equal(cells[0].props.colSpan, columns);
    assert.match(html, /No hay creditos en mora para mostrar/);
  }
});

test("parámetros falsificados no revelan datos financieros ni cambian el aliado de sesión", async () => {
  for (const params of [
    { aliadoId: "2", adminCentral: "true", aliadoAccesoCodigo: "FINSERPAY", codigo: "FINSERPAY", central: "true" },
    { aliadoId: ["2", "1"], plataforma: "IPHONE", adminCentral: "true", aliadoAccesoCodigo: "FINSERPAY" },
  ]) {
    const result = await render({ params });
    assert.doesNotMatch(result.html, forbidden);
    assert.doesNotMatch(treePayload(result.element), forbidden);
    assert.doesNotMatch(result.html, /Cliente de prueba 99|DOC-99/);
    assert.equal(result.calls.allies[0].where.id, 1);
    for (const call of result.calls.credits) assert.equal((call.where.AND?.[0] ?? call.where).sede.aliadoId, 1);
    assert.equal(result.calls.expenses[0].where.sede.aliadoId, 1);
    assert.equal(result.calls.navigation[0].adminCentral, false);
    const exports = [...result.html.matchAll(/href="([^"]*\/api\/dashboard\/cartera\/export[^"]*)"/g)]
      .map(match => new URL(match[1].replaceAll("&amp;", "&"), "https://finserpay.test"));
    assert.ok(exports.length >= 1);
    assert.ok(exports.every(url => url.searchParams.get("aliadoId") === "1"));
    if (params.plataforma) assert.ok(exports.every(url => url.searchParams.get("plataforma") === "IPHONE"));
  }
});
