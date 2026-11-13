import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const accessRules = await jiti.import("../lib/cut-collection-access.ts");
const monthRules = await jiti.import("../lib/dashboard-month.ts");
const roles = await jiti.import("../lib/roles.ts");
const allyRules = await jiti.import("../lib/aliados.ts");
const { outputText } = ts.transpileModule(readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
const now = "2026-11-13T14:00:00.000Z";
class DashboardDate extends Date {
  constructor(value) { super(arguments.length ? value : now); }
  static now() { return Date.parse(now); }
}
const plain = value => JSON.parse(JSON.stringify(value));
const alliedSession = { id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 2,
  aliadoAccesoNombre: "Aliado de prueba", sedeId: 20, sedeAccesoId: 20, sedeNombre: "Sede de prueba" };
const centralSession = { ...alliedSession, aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1, sedeId: 10, sedeAccesoId: 10 };
const branches = [
  { id: 10, nombre: "Central", aliadoId: 1 },
  { id: 20, nombre: "Aliado propia", aliadoId: 2 },
  { id: 21, nombre: "Aliado segunda", aliadoId: 2 },
  { id: 30, nombre: "Otro aliado", aliadoId: 3 },
];
const report = { status: "ready", cuts: ["2026-11-02", "2026-10-17", "2026-10-02"].map(cutDate => ({
  cutDate, queriedAt: now, earlyRisk: ["DPF 3", "DPF 7", "DPF 15", "40/60", "FPD MADURO"].map(label => ({
    label, cases: 1, eligible: 10, pending: 0, unavailable: 0,
  })),
})) };

function harness({ session = alliedSession, databaseRole = session?.rolNombre, seller = null, nominalAnalyst = false,
  fpdResult = report, fpdError = null } = {}) {
  const calls = { fpd: [], overview: [], branches: [], allies: [], users: [], seller: [], errors: [], redirects: [] };
  const AdminDashboard = () => null;
  const SellerDashboard = () => null;
  const ProfileAccess = () => null;
  const notFoundError = new Error("NEXT_NOT_FOUND");
  const redirectError = new Error("NEXT_REDIRECT");
  const database = {
    usuario: { findUnique: async args => {
      calls.users.push(plain(args));
      return { nombre: "Usuario de prueba", rol: { nombre: databaseRole }, sede: { nombre: "Sede de prueba" } };
    } },
    sede: { findMany: async args => {
      calls.branches.push(plain(args));
      return branches.filter(branch => !args.where.aliadoId || branch.aliadoId === args.where.aliadoId)
        .map(({ id, nombre }) => ({ id, nombre }));
    } },
    aliado: { findMany: async args => {
      calls.allies.push(plain(args));
      return [1, 2, 3].map(id => ({ id, nombre: `Aliado ${id}`, codigo: id === 1 ? "FINSERPAY" : `ALIADO${id}` }));
    } },
    sedeVendedor: { findMany: async () => [] },
    credito: { count: async () => 0, findMany: async () => [] },
    creditoAbono: { aggregate: async () => ({ _sum: { valor: 0 } }) },
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": {
      notFound() { throw notFoundError; },
      redirect(url) { calls.redirects.push(url); throw redirectError; },
    },
    "@/lib/prisma": { default: database },
    "@/lib/auth": { getSessionUser: async () => session, getNominalApprovalAnalystSessionUser: async () => nominalAnalyst ? {} : null },
    "@/lib/roles": roles,
    "@/lib/aliados": allyRules,
    "@/lib/cut-collection-access": accessRules,
    "@/lib/dashboard-month": monthRules,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/seller-auth": { getSellerSessionUser: async () => { calls.seller.push(true); return seller; } },
    "@/lib/profile-avatars": { obtenerAvatarPerfilSrc: () => "/test-avatar.svg" },
    "@/lib/vendor-profile-schema": { ensureVendorProfileVisualColumns: async () => {} },
    "@/lib/ventas-utils": {
      getTodayBogotaRange: () => ({ start: new Date("2026-11-13T05:00:00Z"), end: new Date("2026-11-14T05:00:00Z") }),
      getCurrentBogotaMonthRange: () => ({ start: new Date("2026-11-01T05:00:00Z"), end: new Date("2026-12-01T05:00:00Z") }),
    },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map() },
    "./_components/admin-central-dashboard": { default: AdminDashboard },
    "./_components/seller-commercial-dashboard": { default: SellerDashboard },
    "./_components/seller-profile-access": { default: ProfileAccess },
    "./_lib/admin-dashboard-data": { getAdminDashboardOverview: async args => {
      calls.overview.push(plain(args));
      return { fixture: "overview", monthKey: args.month };
    } },
    "./_lib/ally-dashboard-fpd": { getAllyDashboardFpd: async args => {
      calls.fpd.push(plain(args));
      if (fpdError) throw fpdError;
      return fpdResult;
    } },
  };
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, Date: DashboardDate, URLSearchParams,
    console: { error: (...args) => calls.errors.push(args.map(String)) },
    require(name) {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    },
  }, { filename: "app/dashboard/page.tsx" });
  return { calls, AdminDashboard, SellerDashboard, ProfileAccess, notFoundError, redirectError,
    render: (params = {}) => loaded.exports.default({ searchParams: Promise.resolve(params) }) };
}

test("FPD aliado recibe el alcance de sesión y el mismo mes normalizado del dashboard", async () => {
  const f = harness();
  const view = await f.render({ month: ["2026-10", "2026-09"], aliadoId: "3", scope: "aliado:3" });
  assert.equal(view.type, f.AdminDashboard);
  assert.deepEqual(f.calls.fpd, [{ access: { userId: 7, central: false, aliadoId: 2, sedeId: null },
    month: "2026-10", sedeId: null, now }]);
  assert.deepEqual(f.calls.overview, [{ aliadoId: 2, month: "2026-10" }]);
  assert.deepEqual(f.calls.branches[0].where, { aliadoId: 2 });
  assert.equal(f.calls.allies.length, 0);
  assert.equal(view.props.allyFpd, report);
  assert.equal(view.props.adminCentral, false);
  const link = new URL(view.props.fpReportHref, "https://finserpay.test");
  assert.equal(link.pathname, "/dashboard/reportes/recaudo-por-corte");
  assert.deepEqual(Object.fromEntries(link.searchParams), { status: "todos", aliadoId: "2", year: "2026", month: "11", day: "2" });
});

test("mes futuro o inválido usa el mes de Bogotá en ambos loaders", async () => {
  for (const month of ["2100-01", "invalid", "2026-13", undefined]) {
    const f = harness();
    await f.render({ month });
    assert.equal(f.calls.fpd[0].month, "2026-11");
    assert.equal(f.calls.overview[0].month, "2026-11");
    assert.equal(f.calls.fpd[0].now, now);
  }
});

test("sede autorizada restringe overview, FPD y enlace sin adoptar el aliado de la URL", async () => {
  const f = harness();
  const view = await f.render({ month: "2026-11", scope: ["sede:21", "sede:30"], aliadoId: "3" });
  assert.equal(f.calls.fpd[0].access.aliadoId, 2);
  assert.equal(f.calls.fpd[0].sedeId, 21);
  assert.deepEqual(f.calls.overview, [{ aliadoId: 2, month: "2026-11", sedeId: 21 }]);
  assert.equal(view.props.selectedSede, 21);
  const link = new URL(view.props.fpReportHref, "https://finserpay.test");
  assert.equal(link.searchParams.get("aliadoId"), "2");
  assert.equal(link.searchParams.get("sedeId"), "21");
});

test("una sede de otro aliado o inexistente se rechaza antes de cargar FPD y overview", async () => {
  for (const scope of ["sede:30", "sede:999", "sede:-1", "sede:NaN"]) {
    const f = harness();
    await assert.rejects(f.render({ scope, aliadoId: "3" }), error => error === f.notFoundError);
    assert.equal(f.calls.fpd.length, 0);
    assert.equal(f.calls.overview.length, 0);
    assert.deepEqual(f.calls.branches[0].where, { aliadoId: 2 });
  }
});

test("central conserva Salud de cartera sin cargar FPD incluso filtrando un aliado o sede", async () => {
  for (const params of [{}, { aliadoId: "2" }, { scope: "aliado:2" }, { scope: "sede:21" }]) {
    const f = harness({ session: centralSession });
    const view = await f.render(params);
    assert.equal(view.type, f.AdminDashboard);
    assert.equal(view.props.adminCentral, true);
    assert.equal(view.props.allyFpd, undefined);
    assert.equal(view.props.fpReportHref, undefined);
    assert.equal(f.calls.fpd.length, 0);
    assert.equal(f.calls.overview.length, 1);
  }
});

test("vendedor, supervisor y perfil sin seleccionar nunca cargan FPD administrativo", async () => {
  for (const tipoPerfil of [null, "VENDEDOR", "SUPERVISOR"]) {
    const seller = tipoPerfil ? { id: 80, sedeId: 20, tipoPerfil, nombre: "Perfil de prueba", sedeNombre: "Sede de prueba" } : null;
    const f = harness({ session: { ...alliedSession, rolNombre: "VENDEDOR" }, seller });
    const view = await f.render({ month: "2026-11", scope: "aliado:3" });
    assert.equal(view.type, seller ? f.SellerDashboard : f.ProfileAccess);
    assert.equal(f.calls.fpd.length, 0);
    assert.equal(f.calls.overview.length, 0);
    assert.equal(f.calls.allies.length, 0);
  }
  const revokedAdmin = harness({ databaseRole: "VENDEDOR" });
  assert.equal((await revokedAdmin.render()).type, revokedAdmin.ProfileAccess);
  assert.equal(revokedAdmin.calls.fpd.length, 0, "El rol actual de la base prevalece para cargar el panel");
});

test("sin sesión o con rol analista se detiene antes de consultar FPD", async () => {
  const anonymous = harness({ session: null });
  await anonymous.render({ scope: "aliado:2" });
  assert.equal(anonymous.calls.fpd.length, 0);
  assert.equal(anonymous.calls.users.length, 0);
  for (const nominalAnalyst of [false, true]) {
    const f = harness({ session: { ...alliedSession, rolNombre: "ANALISTA_APROBACION" }, nominalAnalyst });
    await assert.rejects(f.render({ notifications: "1" }), error => error === f.redirectError);
    assert.deepEqual(f.calls.redirects, [nominalAnalyst ? "/dashboard/aprobaciones/centro?notifications=1" : "/dashboard/aprobaciones?notifications=1"]);
    assert.equal(f.calls.fpd.length, 0);
    assert.equal(f.calls.users.length, 0);
  }
});

test("aliado ausente o inválido queda no disponible sin consultar FPD global", async () => {
  for (const aliadoAccesoId of [null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    const f = harness({ session: { ...alliedSession, aliadoAccesoId } });
    const view = await f.render({ aliadoId: "3" });
    assert.equal(f.calls.fpd.length, 0);
    assert.deepEqual(plain(view.props.allyFpd), { status: "unavailable", cuts: [] });
    assert.equal(f.calls.errors.length, 1);
  }
});

test("fallo del loader no convierte riesgo en cero ni divulga el error interno", async () => {
  const f = harness({ fpdError: new Error("sensitive-query-detail") });
  const view = await f.render({ scope: "sede:21" });
  assert.deepEqual(plain(view.props.allyFpd), { status: "unavailable", cuts: [] });
  assert.equal(f.calls.fpd.length, 1);
  assert.equal(f.calls.overview.length, 1);
  assert.doesNotMatch(JSON.stringify(view.props), /sensitive-query-detail/);
  assert.doesNotMatch(JSON.stringify(f.calls.errors), /sensitive-query-detail/);
  const link = new URL(view.props.fpReportHref, "https://finserpay.test");
  assert.equal(link.searchParams.get("aliadoId"), "2");
  assert.equal(link.searchParams.get("sedeId"), "21");
  assert.equal(link.searchParams.has("day"), false);
});
