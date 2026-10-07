import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const source = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
const central = {
  id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1,
  aliadoAccesoNombre: "FINSER PAY", sedeId: 10, sedeAccesoId: 10, sedeNombre: "Central",
};
const allies = [
  { id: 1, nombre: "FINSER PAY", codigo: "FINSERPAY" },
  { id: 25, nombre: "JG COMPANY", codigo: "JGCOMPANY" },
  { id: 42, nombre: "CONECTAMOS", codigo: "CONECTAMOS" },
];
const snapshot = (value) => JSON.parse(JSON.stringify(value));

function harness({ session = central, availableAllies = allies, sellerSession = null } = {}) {
  const overviewCalls = [];
  const allyCalls = [];
  const userCalls = [];
  const sellerCalls = [];
  const auditCalls = [];
  const creditCalls = [];
  const AdminDashboard = () => null;
  const SellerDashboard = () => null;
  const ProfileAccess = () => null;
  const notFoundError = new Error("NEXT_NOT_FOUND");
  const redirects = [];
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": {
      notFound: () => { throw notFoundError; },
      redirect: (url) => { redirects.push(url); throw new Error("NEXT_REDIRECT"); },
    },
    "@/lib/prisma": { default: {
      usuario: { findUnique: async (args) => {
        userCalls.push(snapshot(args));
        return { nombre: "Administrador de prueba", rol: { nombre: session?.rolNombre }, sede: { nombre: "Sede sesión" } };
      } },
      sede: { findMany: async () => [{ id: 70, nombre: "Sede 70" }] },
      aliado: { findMany: async (args) => { allyCalls.push(snapshot(args)); return availableAllies; } },
      sedeVendedor: { findMany: async (args) => { sellerCalls.push(snapshot(args)); return []; } },
      credito: {
        count: async (args) => { creditCalls.push(snapshot(args)); return 0; },
        findMany: async (args) => { creditCalls.push(snapshot(args)); return []; },
      },
      creditoAbono: { aggregate: async (args) => { creditCalls.push(snapshot(args)); return { _sum: { valor: 0 } }; } },
    } },
    "@/lib/auth": { getSessionUser: async () => session },
    "@/lib/roles": {
      isAdminRole: (role) => role === "ADMIN",
      isApprovalAnalystRole: (role) => role === "ANALISTA_APROBACION",
    },
    "@/lib/aliados": { isFinserPayCentralAlly: (code) => code === "FINSERPAY" },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => { auditCalls.push(true); } },
    "@/lib/seller-auth": { getSellerSessionUser: async () => sellerSession },
    "@/lib/profile-avatars": { obtenerAvatarPerfilSrc: () => "/profile-avatar.svg" },
    "@/lib/vendor-profile-schema": { ensureVendorProfileVisualColumns: async () => {} },
    "@/lib/ventas-utils": {
      getTodayBogotaRange: () => ({ start: new Date("2026-09-26"), end: new Date("2026-09-27") }),
      getCurrentBogotaMonthRange: () => ({ start: new Date("2026-09-01"), end: new Date("2026-10-01") }),
    },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map() },
    "./_components/admin-central-dashboard": { default: AdminDashboard },
    "./_components/seller-commercial-dashboard": { default: SellerDashboard },
    "./_components/seller-profile-access": { default: ProfileAccess },
    "./_lib/admin-dashboard-data": {
      getAdminDashboardOverview: async (args) => {
        overviewCalls.push(snapshot(args));
        return { fixture: "real-overview-result", aliadoId: args.aliadoId };
      },
    },
  };
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports, Date, Number,
    require(name) {
      assert.ok(name in dependencies, "Dependencia del dashboard no simulada: " + name);
      return dependencies[name];
    },
  }, { filename: "app/dashboard/page.tsx" });
  return {
    render: (params = {}) => loaded.exports.default({ searchParams: Promise.resolve(params) }),
    overviewCalls, allyCalls, userCalls, sellerCalls, auditCalls, redirects, creditCalls,
    AdminDashboard, SellerDashboard, ProfileAccess, notFoundError,
  };
}

function assertCatalog(fixture) {
  assert.equal(fixture.allyCalls.length, 1, "Sólo central carga el catálogo real de aliados");
  assert.deepEqual(fixture.allyCalls[0].select, { id: true, nombre: true, codigo: true });
}

test("el administrador central conserva el consolidado y recibe el catálogo real", async () => {
  const f = harness();
  const result = await f.render({ month: "2026-09" });
  assert.equal(result.type, f.AdminDashboard);
  assert.deepEqual(f.overviewCalls, [{ aliadoId: null, month: "2026-09" }]);
  assert.equal(result.props.adminCentral, true);
  assert.equal(result.props.selectedAlly, null);
  assert.deepEqual(snapshot(result.props.allies), allies);
  assertCatalog(f);
});

test("central limita todos los datos del dashboard al aliado escogido y conserva su identidad", async () => {
  const f = harness();
  const result = await f.render({ aliadoId: "25", month: "2026-08" });
  assert.deepEqual(f.overviewCalls, [{ aliadoId: 25, month: "2026-08" }]);
  assert.deepEqual(snapshot(result.props.selectedAlly), allies[1]);
  assert.equal(result.props.adminCentral, true, "Consultar un aliado no suplanta su sesión");
  assert.equal(result.props.nombreUsuario, "Administrador de prueba");
  assert.equal(result.props.rolUsuario, "ADMIN");
  assert.equal(result.props.data.aliadoId, 25);
  assertCatalog(f);
});

test("searchParams repetidos toman un sólo aliado y un sólo mes", async () => {
  const f = harness();
  const result = await f.render({ aliadoId: ["42", "25"], month: ["2026-07", "2026-06"] });
  assert.deepEqual(f.overviewCalls, [{ aliadoId: 42, month: "2026-07" }]);
  assert.deepEqual(snapshot(result.props.selectedAlly), allies[2]);
});

for (const value of ["999", "-1", "0", "25.5", "abc", "9007199254740993"]) {
  test(`central rechaza el aliado no válido ${value} antes de consultar cifras`, async () => {
    const f = harness();
    await assert.rejects(f.render({ aliadoId: value }), (error) => error === f.notFoundError);
    assert.equal(f.overviewCalls.length, 0, "No debe caer silenciosamente en cifras globales");
  });
}

test("un ID existente en otra fuente no se acepta si no está en el catálogo disponible", async () => {
  const f = harness({ availableAllies: [] });
  await assert.rejects(f.render({ aliadoId: "25" }), (error) => error === f.notFoundError);
  assert.equal(f.overviewCalls.length, 0);
});

test("el administrador aliado ignora filtros externos y mantiene su propio alcance", async () => {
  const session = { ...central, aliadoAccesoCodigo: "JGCOMPANY", aliadoAccesoId: 25, aliadoAccesoNombre: "JG COMPANY" };
  for (const aliadoId of ["42", "invalid", ["1", "42"]]) {
    const f = harness({ session });
    const result = await f.render({ aliadoId, month: "2026-09" });
    assert.deepEqual(f.overviewCalls, [{ aliadoId: 25, month: "2026-09" }]);
    assert.equal(result.props.adminCentral, false);
    assert.equal(result.props.selectedAlly, null);
    assert.deepEqual(snapshot(result.props.allies), []);
    assert.equal(f.allyCalls.length, 0, "El aliado no recibe un listado de terceros");
  }
});

test("un administrador aliado sin alcance válido falla cerrado con -1", async () => {
  for (const aliadoAccesoId of [null, 0, -10, 1.5, "not-an-id"]) {
    const f = harness({ session: { ...central, aliadoAccesoCodigo: "EXTERNO", aliadoAccesoId } });
    await f.render({ aliadoId: "25" });
    assert.equal(f.overviewCalls.length, 1);
    assert.equal(f.overviewCalls[0].aliadoId, -1);
    assert.equal(f.allyCalls.length, 0);
  }
});

test("vendedores no obtienen cifras administrativas ni catálogo mediante el parámetro", async () => {
  const f = harness({ session: { ...central, rolNombre: "VENDEDOR" } });
  const result = await f.render({ aliadoId: "42", month: "2026-09" });
  assert.equal(result.type, f.ProfileAccess);
  assert.equal(f.overviewCalls.length, 0);
  assert.equal(f.allyCalls.length, 0);
  assert.equal(f.sellerCalls.length, 1);
  assert.equal(f.sellerCalls[0].where.sedeId, central.sedeAccesoId);
});

test("los analistas continúan en aprobaciones sin cargar datos de aliados", async () => {
  const f = harness({ session: { ...central, rolNombre: "ANALISTA_APROBACION" } });
  await assert.rejects(f.render({ aliadoId: "25" }), /NEXT_REDIRECT/);
  assert.deepEqual(f.redirects, ["/dashboard/aprobaciones"]);
  assert.equal(f.allyCalls.length, 0);
  assert.equal(f.overviewCalls.length, 0);
  assert.equal(f.userCalls.length, 0);
});

test("sin sesión no se consulta catálogo ni cartera aunque se suministre aliado", async () => {
  const f = harness({ session: null });
  await f.render({ aliadoId: "25" });
  assert.equal(f.allyCalls.length, 0);
  assert.equal(f.overviewCalls.length, 0);
  assert.equal(f.userCalls.length, 0);
});
test("la sesión comercial activa conserva vendedor/sede y no adopta el aliado de la URL", async () => {
  for (const tipoPerfil of ["VENDEDOR", "SUPERVISOR"]) {
    const sellerSession = { id: 123, sedeId: 10, tipoPerfil, nombre: "Vendedor de prueba", sedeNombre: "Sede propia", avatarKey: "default", debeCambiarPin: false };
    const f = harness({ session: { ...central, rolNombre: "VENDEDOR" }, sellerSession });
    const result = await f.render({ aliadoId: "42", month: "2026-07" });
    assert.equal(result.type, f.SellerDashboard);
    assert.equal(f.allyCalls.length, 0);
    assert.equal(f.overviewCalls.length, 0);
    assert.equal(f.creditCalls.length, 6);
    for (const query of f.creditCalls) {
      assert.equal("aliadoId" in query.where, false);
      if (tipoPerfil === "SUPERVISOR") assert.equal(query.where.sedeId, sellerSession.sedeId);
      else assert.equal(query.where.vendedorId, sellerSession.id);
    }
  }
});

test("el nuevo desplegable filtra una sede sin ampliar el alcance del aliado", async () => {
  const f = harness({ session: { ...central, aliadoAccesoCodigo: "JGCOMPANY", aliadoAccesoId: 25 } });
  const result = await f.render({ scope: "sede:70", month: "2026-07" });
  assert.equal(result.props.selectedSede, 70);
  assert.equal(f.overviewCalls[0].aliadoId, 25);
  assert.equal(f.overviewCalls[0].sedeId, 70);
});

test("una sede no accesible se rechaza antes de consultar cartera", async () => {
  const f = harness();
  await assert.rejects(f.render({ scope: "sede:999" }), /NEXT_NOT_FOUND/);
  assert.equal(f.overviewCalls.length, 0);
});

test("el selector combinado conserva la selección real de aliados", async () => {
  const f = harness();
  const result = await f.render({ scope: "aliado:25", month: "2026-07" });
  assert.equal(result.props.selectedAlly.id, 25);
  assert.equal(f.overviewCalls[0].aliadoId, 25);
});
