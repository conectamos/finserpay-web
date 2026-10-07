import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { projectDashboardDelinquency } = await jiti.import("../lib/dashboard-delinquency-view.ts");
const central = { nombre: "Central", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1 };
const ally = { nombre: "Aliado", rolNombre: "ADMIN", aliadoAccesoCodigo: "JG", aliadoAccesoId: 7, aliadoAccesoNombre: "JG COMPANY" };
const allies = [{ id: 7, nombre: "JG COMPANY", codigo: "JG" }, { id: 8, nombre: "Otro aliado", codigo: "OTRO" }];
const Empty = () => null;
function load(file, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loaded = { exports: {} };
  runInNewContext(outputText, { module: loaded, exports: loaded.exports, Date, URL, URLSearchParams, Number, Response, Uint8Array, console,
    require(name) { assert.ok(name in dependencies, `Dependencia sin simular: ${name}`); return dependencies[name]; } });
  return loaded.exports;
}
const roles = { isAdminRole: role => role === "ADMIN" };
const allyRules = { isFinserPayCentralAlly: code => code === "FINSERPAY" };
const access = load("lib/delinquency-detail-access.ts", { "@/lib/roles": roles, "@/lib/aliados": allyRules });
const group = { key: "sede:70", name: "Sede Centro", context: "JG COMPANY", unassigned: false, activeCredits: 3, overdueCredits: 1, overdueBalance: 84_661_777, overduePercent: 33, overdueSharePercent: 100, overduePortfolioPercent: 6 };
const raw = { activeCredits: 3, overdueCredits: 1, overduePercent: 33, totalBalance: 1_400_000_000, overdueBalance: 84_661_777, overduePortfolioPercent: 6, sites: [group], sellers: [{ ...group, key: "vendedor:2", name: "Ana" }] };
const credit = { id: 21, folio: "FC-21", clienteNombre: "Cliente", clienteDocumento: "100", sedeKey: "sede:70", sedeNombre: "Sede Centro", sellerKey: "vendedor:2", sellerNombre: "Ana", aliadoNombre: "JG COMPANY", diasMora: 8 };
function harness(session = ally) {
  const calls = { data: [], catalog: [], workbook: [], numbers: [] };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, "next/link": { default: Empty },
    "next/navigation": { notFound() { throw new Error("NOT_FOUND"); }, redirect() { throw new Error("REDIRECT"); } },
    "next/server": { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    "@/app/_components/finser-ui": { AppShell: Empty, Button: Empty, Card: Empty, DataTable: Empty, Select: Empty },
    "@/lib/dashboard-access": { requireAdminDashboardAccess: async () => { if (!session) throw new Error("REDIRECT"); return { session }; } },
    "@/lib/auth": { getSessionUser: async () => session }, "@/lib/roles": roles,
    "@/lib/aliados": allyRules, "@/lib/delinquency-detail-access": access,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/prisma": { default: { aliado: { findMany: async args => { calls.catalog.push(args); return allies; } } } },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async ids => { calls.numbers.push([...ids]); return new Map([[21, "0100000021"]]); } },
    "@/lib/dashboard-delinquency-view": { exportDashboardDelinquencyWorkbook: async (detail, permission) => { calls.workbook.push({ detail, permission }); return Buffer.from("fixture XLSX"); } },
    "../../_components/admin-sidebar": { default: Empty }, "../../_components/admin-workspace-topbar": { default: Empty }, "./delinquency-workspace": { default: Empty },
  };
  const data = { getDelinquencyDetailData: async (aliadoId, viewingCentral) => {
    calls.data.push({ aliadoId, viewingCentral });
    return { detail: projectDashboardDelinquency(raw, { viewingCentral }), credits: [credit], updatedAt: "2026-10-07T00:00:00.000Z" };
  } };
  dependencies["../../_lib/delinquency-detail-data"] = data;
  dependencies["@/app/dashboard/_lib/delinquency-detail-data"] = data;
  const page = load("app/dashboard/cartera/detalle-mora/page.tsx", dependencies).default;
  const route = load("app/api/dashboard/cartera/detalle-mora/export/route.ts", dependencies).GET;
  return { calls, render: params => page({ searchParams: Promise.resolve(params || {}) }), get: query => route(new Request(`https://finserpay.test/api/dashboard/cartera/detalle-mora/export${query || ""}`)) };
}
function nodes(node) { return !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }

test("scope aliado ignora URL ajena y falla cerrado sin aliado; roles no admin denegados", () => {
  assert.equal(access.resolveDelinquencyDetailScope(ally, "8", allies).aliadoId, 7);
  assert.throws(() => access.resolveDelinquencyDetailScope({ ...ally, aliadoAccesoId: null }, "8", allies), error => error.status === 403);
  for (const rolNombre of ["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"]) assert.throws(() => access.resolveDelinquencyDetailScope({ ...central, rolNombre }, "7", allies), error => error.status === 403);
  for (const query of ["8e0", "0", "-1", "999", "NaN"]) assert.throws(() => access.resolveDelinquencyDetailScope(central, query, allies), error => error.status === 404);
});

test("pantalla aliado recibe DTO sin saldos aunque fuerce permiso o alias central", async () => {
  const f = harness(); const tree = await f.render({ aliadoId: "8", includeAmounts: "true" });
  assert.deepEqual(f.calls.data, [{ aliadoId: 7, viewingCentral: false }]); assert.equal(f.calls.catalog.length, 0);
  const workspace = nodes(tree).find(node => node.props?.detail && node.props?.exportHref);
  assert.equal(workspace.props.canViewBalances, false);
  assert.doesNotMatch(JSON.stringify(workspace.props), /overdueBalance|totalBalance|84661777|1400000000/);
  assert.match(workspace.props.creditLinks["sede:70"], /aliadoId=7.*tipo=sede.*grupo=sede%3A70#creditos-en-mora/);
  assert.match(workspace.props.creditLinks["seller:vendedor:2"], /tipo=vendedor.*grupo=vendedor%3A2/);
});

test("central con aliado seleccionado conserva importes y central sin filtro ve consolidado", async () => {
  for (const params of [{ aliadoId: "7" }, {}]) {
    const f = harness(central); const tree = await f.render(params);
    assert.deepEqual(f.calls.data, [{ aliadoId: params.aliadoId ? 7 : null, viewingCentral: true }]);
    const workspace = nodes(tree).find(node => node.props?.detail && node.props?.exportHref);
    assert.equal(workspace.props.detail.overdueBalance, 84_661_777); assert.equal(workspace.props.canViewBalances, true);
  }
});

test("drilldown devuelve sólo créditos del grupo de su scope con número visible; grupo ajeno404", async () => {
  const f = harness(); const tree = await f.render({ aliadoId: "8", tipo: "sede", grupo: "sede:70" });
  assert.deepEqual(f.calls.numbers, [[21]]); assert.match(JSON.stringify(tree), /0100000021/);
  assert.doesNotMatch(JSON.stringify(tree), /84661777|1400000000/);
  await assert.rejects(() => harness().render({ tipo: "sede", grupo: "sede:80" }), /NOT_FOUND/);
});

test("exporta aliado sin dinero; URL no eleva permiso y central filtrado mantiene permiso", async () => {
  const f = harness(); const response = await f.get("?aliadoId=8&viewingCentral=true&includeAmounts=true");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-type"), /spreadsheetml/);
  assert.deepEqual(f.calls.data, [{ aliadoId: 7, viewingCentral: false }]);
  assert.equal(f.calls.workbook[0].permission.viewingCentral, false);
  assert.doesNotMatch(JSON.stringify(f.calls.workbook[0].detail), /overdueBalance|84661777/);
  const c = harness(central); assert.equal((await c.get("?aliadoId=7")).status, 200);
  assert.equal(c.calls.workbook[0].permission.viewingCentral, true); assert.equal(c.calls.workbook[0].detail.overdueBalance, 84_661_777);
});

test("exportación niega sesión ausente, no admins, aliado sin alcance y filtro central inválido", async () => {
  for (const [session, query, status] of [[null, "", 401], [{ ...central, rolNombre: "ANALISTA_APROBACION" }, "", 403], [{ ...ally, aliadoAccesoId: null }, "?aliadoId=8", 403], [central, "?aliadoId=999", 404]]) {
    const f = harness(session); assert.equal((await f.get(query)).status, status); assert.equal(f.calls.data.length, 0); assert.equal(f.calls.workbook.length, 0);
  }
});
