import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { resolveCreditReportState } from "../lib/credit-report-status.ts";

const approved = { status: "APPROVED", revision: 3, approvedRevision: 3, reviewHashVersion: 2, approvedHashVersion: 2 };
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadModule(path, dependencies = {}) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    exports: loaded.exports, module: loaded, console, URL, Date, Response,
    require(name) {
      assert.ok(name in dependencies, "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: path });
  return loaded.exports;
}

const dates = loadModule("lib/colombia-date.ts");
const factory = loadModule("lib/credit-factory.ts", { "@/lib/colombia-date": dates });
const roles = loadModule("lib/roles.ts");
const allies = loadModule("lib/aliados.ts");
const scope = loadModule("lib/credit-route-lookup.ts");
const admin = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1, sedeId: 10 };

function fixture(id, changes = {}) {
  return {
    id, folio: "REPORT-" + id, clienteNombre: "Cliente " + id, clienteDocumento: "10000000" + id,
    clienteTelefono: null, imei: "00000000000000" + id, referenciaEquipo: "Equipo",
    equipoMarca: "APPLE", equipoModelo: "IPHONE", valorEquipoTotal: 1000,
    saldoBaseFinanciado: 800, montoCredito: 800, cuotaInicial: 200, valorCuota: 80,
    plazoMeses: 10, estado: "INSCRITO", aprobacionAnalista: null,
    deliverableReady: false, deliverableLabel: null,
    fechaCredito: new Date("2026-09-10T14:00:00.000Z"),
    createdAt: new Date("2026-09-10T14:00:00.000Z"), fechaPrimerPago: null, fechaProximoPago: null,
    usuario: { id: 5, nombre: "Vendedor", usuario: "vendedor" }, vendedor: null,
    sede: { id: 10, nombre: "Sede", aliadoId: 5, aliado: { id: 5, nombre: "Aliado", codigo: "ALIADO" } },
    ...changes,
  };
}

function harness(items, { user = admin, seller = null, paid = [], registrations = [] } = {}) {
  const calls = [];
  const database = {
    credito: { async findMany(query) { calls.push({ kind: "credits", query: plain(query) }); return items; } },
    creditoAbono: { async groupBy(query) { calls.push({ kind: "payments", query: plain(query) }); return paid; } },
    creditSadminRegistration: { async findMany(query) {
      calls.push({ kind: "numbers", query: plain(query) });
      return registrations.filter(row => query.where.creditoId.in.includes(row.creditoId) && row.numeroCreditoConfirmado && row.numeroCredito !== null);
    } },
  };
  const displayHelpers = loadModule("lib/credit-display-number-server.ts", {
    "server-only": {},
    "@/lib/prisma": { default: database },
    "@/lib/credit-display-number": loadModule("lib/credit-display-number.ts"),
  });
  const route = loadModule("app/api/reportes/creditos/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/seller-auth": { getSellerSessionUser: async () => seller },
    "@/lib/prisma": { default: database },
    "@/lib/roles": roles, "@/lib/aliados": allies,
    "@/lib/credit-factory": factory,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-route-lookup": scope,
    "@/lib/credit-report-status": { resolveCreditReportState },
    "@/lib/credit-display-number-server": displayHelpers,
  });
  return { calls, get: (query = "") => route.GET(new Request("https://finserpay.test/api/reportes/creditos" + query)) };
}

test("un OK de la revision vigente muestra APROBADO en estados operativos de apertura", () => {
  for (const estado of ["GENERADO", "INSCRITO", "ENTREGABLE", " inscrito "]) {
    assert.equal(resolveCreditReportState(estado, approved), "APROBADO");
  }
});

test("el reporte agrega números SADMIN confirmados sin alterar folios ni ampliar el alcance al buscar", async () => {
  const rows = [fixture(1), fixture(2)];
  const api = harness(rows, {
    user: { ...admin, aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 5 },
    registrations: [
      { creditoId: 1, numeroCreditoConfirmado: true, numeroCredito: "000123-A" },
      { creditoId: 2, numeroCreditoConfirmado: false, numeroCredito: "SIN-CONFIRMAR" },
      { creditoId: 99, numeroCreditoConfirmado: true, numeroCredito: "OTRO-ALIADO" },
    ],
  });
  const response = await api.get("?search=000123-A&aliadoId=99");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.items.map(row => [row.id, row.folio, row.numeroCreditoVisible]), [[1, "REPORT-1", "000123-A"], [2, "REPORT-2", "REPORT-2"]]);
  assert.equal(rows[0].folio, "REPORT-1");
  assert.equal(rows[0].numeroCreditoVisible, undefined);
  const where = api.calls.find(call => call.kind === "credits").query.where;
  assert.deepEqual(where.AND[0], { sede: { aliadoId: 5 } });
  const search = where.AND[1].OR.find(condition => condition.OR)?.OR;
  assert.deepEqual(search, [
    { folio: { contains: "000123-A", mode: "insensitive" } },
    { registroSadmin: { is: { numeroCreditoConfirmado: true, numeroCredito: { contains: "000123-A", mode: "insensitive" } } } },
  ]);
  assert.deepEqual(api.calls.find(call => call.kind === "numbers").query.where,
    { creditoId: { in: [1, 2] }, numeroCreditoConfirmado: true, numeroCredito: { not: null } });
});

test("pendientes, historicos sin revision e invalidaciones conservan el estado original", () => {
  for (const review of [undefined, null, { ...approved, status: "PENDING" },
    { ...approved, approvedRevision: null }, { ...approved, revision: 4 },
    { ...approved, revision: 0, approvedRevision: 0 }, { ...approved, status: "REJECTED" },
    { ...approved, approvedHashVersion: null }, { ...approved, approvedHashVersion: 1 }]) {
    assert.equal(resolveCreditReportState("INSCRITO", review), "INSCRITO");
  }
});

test("anulados, cancelados, pagados y bloqueados tienen precedencia sobre el OK", () => {
  for (const estado of ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA", "PAZ_Y_SALVO",
    "PAGADO", "ROBO_BLOQUEADO", "MORA_BLOQUEADO", "OTRO_ESTADO", " anulado "]) {
    assert.equal(resolveCreditReportState(estado, approved), estado);
  }
});

test("el DTO agrega la etiqueta sin sobrescribir estado, divulgar revision ni cambiar totales", async () => {
  const rows = [fixture(1), fixture(2, { estado: "ANULADO" }),
    fixture(3, { estado: "PAZ_Y_SALVO" }), fixture(4, { estado: "ENTREGABLE", deliverableReady: true })];
  const paid = [
    { creditoId: 1, _count: { _all: 1 }, _sum: { valor: 100 }, _max: { fechaAbono: null } },
    { creditoId: 3, _count: { _all: 2 }, _sum: { valor: 800 }, _max: { fechaAbono: null } },
  ];
  const prior = await (await harness(rows, { paid }).get()).json();
  const reviewed = rows.map(row => ({ ...row, aprobacionAnalista: row.id === 4 ? null : approved }));
  const before = plain(reviewed);
  const api = harness(reviewed, { paid });
  const response = await api.get();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.items.map(row => row.estado), ["INSCRITO", "ANULADO", "PAZ_Y_SALVO", "ENTREGABLE"]);
  assert.deepEqual(data.items.map(row => row.estadoReporte), ["APROBADO", "ANULADO", "PAZ_Y_SALVO", "ENTREGABLE"]);
  assert.deepEqual(data.summary, prior.summary);
  assert.equal(data.summary.totalCreditoAutorizado, 2400);
  assert.equal(data.summary.totalAbonado, 900);
  assert.equal(data.summary.totalPendiente, 1500);
  assert.equal(data.summary.creditosAnulados, 1);
  assert.equal(data.summary.creditosPagados, 1);
  assert.equal(data.summary.entregables, 1);
  const withoutDisplay = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "estadoReporte"));
  assert.deepEqual(data.items.map(withoutDisplay), prior.items.map(withoutDisplay));
  assert.deepEqual(plain(reviewed), before);
  assert.ok(data.items.every(row => !("aprobacionAnalista" in row)));
  assert.deepEqual(api.calls[0].query.include.aprobacionAnalista,
    { select: { status: true, revision: true, approvedRevision: true,
      reviewHashVersion: true, approvedHashVersion: true } });
  assert.deepEqual(api.calls.find(call => call.kind === "payments").query.where.estado, { not: "ANULADO" });
});

test("el siguiente GET refleja la invalidacion sin convertirla en un cambio financiero", async () => {
  const row = fixture(1, { aprobacionAnalista: approved });
  const api = harness([row]);
  assert.equal((await (await api.get()).json()).items[0].estadoReporte, "APROBADO");
  row.aprobacionAnalista = { status: "PENDING", revision: 4, approvedRevision: null,
    reviewHashVersion: 2, approvedHashVersion: null };
  const refreshed = (await (await api.get()).json()).items[0];
  assert.equal(refreshed.estadoReporte, "INSCRITO");
  assert.equal(refreshed.estado, "INSCRITO");
});

test("filtros, alcance y limite del reporte no dependen de la nueva etiqueta", async () => {
  const api = harness([fixture(1, { aprobacionAnalista: approved })], {
    user: { ...admin, aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 5 },
  });
  const data = await (await api.get("?search=100.000.001&aliadoId=99&sedeId=10&from=2026-09-10&to=2026-09-11")).json();
  const query = api.calls[0].query;
  assert.deepEqual(query.where.AND[0], { sede: { aliadoId: 5 } });
  assert.deepEqual(query.where.AND[1], { sedeId: 10 });
  assert.deepEqual(query.where.AND[2], { fechaCredito: { gte: "2026-09-10T05:00:00.000Z", lte: "2026-09-12T04:59:59.999Z" } });
  assert.ok(query.where.AND[3].OR.some(item => item.clienteDocumento?.contains === "100000001"));
  assert.ok(query.where.AND[3].OR.every(item => !("estado" in item) && !("estadoReporte" in item)));
  assert.equal(query.take, 500);
  assert.deepEqual(query.orderBy, { createdAt: "desc" });
  assert.equal(data.filters.aliadoId, 5);
});

test("el reporte conserva los permisos de administrador y supervisor", async (t) => {
  for (const [name, options, status] of [
    ["sin sesion", { user: null }, 401],
    ["vendedor", { user: { ...admin, rolNombre: "VENDEDOR" }, seller: { tipoPerfil: "VENDEDOR" } }, 403],
    ["analista", { user: { ...admin, rolNombre: "ANALISTA_APROBACION" } }, 403],
  ]) await t.test(name, async () => {
    const api = harness([], options);
    assert.equal((await api.get()).status, status);
    assert.equal(api.calls.length, 0);
  });
  const supervisor = harness([], { user: { ...admin, rolNombre: "VENDEDOR", aliadoAccesoId: 5 },
    seller: { tipoPerfil: "SUPERVISOR", sedeId: 10 } });
  assert.equal((await supervisor.get("?aliadoId=99&sedeId=99")).status, 200);
  assert.deepEqual(supervisor.calls[0].query.where.AND, [{ sede: { aliadoId: 5 } }, { sedeId: 10 }]);
});

test("movil y escritorio usan la etiqueta visual y las acciones conservan el estado operativo", () => {
  const source = readFileSync(new URL("../app/dashboard/reportes/creditos/reporte-creditos-client.tsx", import.meta.url), "utf8");
  assert.equal(source.split('<StatusPill tone={creditStatusTone(item.estadoReporte ?? item.estado)}>{item.estadoReporte ?? item.estado}</StatusPill>').length - 1, 2);
  assert.match(source, /normalized === "APROBADO".*return "positive"/);
  assert.match(source, /const canAnnul = isAdmin && item.estado !== "ANULADO"/);
});
