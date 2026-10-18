import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const modules = {};
for (const name of ["credit-payment-plan", "credit-early-payoff", "credit-factory", "credit-next-payment-date",
  "mass-credit-financial-components", "credit-import-flags", "roles", "aliados", "credit-route-lookup", "manual-payment-amount"]) {
  modules[`@/lib/${name}`] = await jiti.import(`../lib/${name}.ts`);
}
const source = readFileSync(new URL("../app/api/creditos/[id]/abonos/route.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const copy = value => structuredClone(value);

function harness(options = {}) {
  const session = options.session === undefined
    ? { id: 9, nombre: "Test admin", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1, sedeId: 10 }
    : options.session;
  const credit = {
    id: 7, folio: "QA-PARTIAL-7", clienteNombre: "Synthetic client", clienteDocumento: "00123456789",
    clienteTelefono: "3001234567", sedeId: 10, cuotaInicial: 0, estado: "GENERADO", montoCredito: 4_604_400,
    saldoBaseFinanciado: 3_000_000, valorCuota: 127_900, plazoMeses: 36, valorInteres: 1_000_000,
    valorFianza: 604_400, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2020-09-17T12:00:00Z"),
    fechaProximoPago: new Date("2020-10-20T12:00:00Z"), planCapitalVigente: null,
    pazYSalvoEmitidoAt: null, observacionAdmin: "Keep original audit", contratoSnapshot: null,
    bloqueoMora: true, bloqueoRobo: false, ...options.credit,
  };
  const relations = { usuario: { id: 9, nombre: "Test admin", usuario: "test" }, vendedor: null,
    sede: { id: 10, nombre: "Test site" } };
  const state = { credit, payments: [1, 2].map(id => ({ id, creditoId: 7, valor: 127_900,
    metodoPago: "EFECTIVO", estado: "ACTIVO", fechaAbono: new Date(`2020-09-${id === 1 ? "17" : "20"}T12:00:00Z`),
    createdAt: new Date("2020-09-20T12:00:00Z"), usuarioId: 9, sedeId: 10, ...copy(relations) })),
    caja: [], creditWrites: [], queries: [], locks: [], failCaja: false, errors: [], unlocks: [] };
  const tx = {
    $queryRaw: async parts => { state.locks.push(parts.join("?")); return [{ id: 7 }]; },
    credito: {
      findFirst: async args => { state.queries.push(copy(args)); return options.inScope === false ? null : copy(state.credit); },
      findUnique: async () => copy(state.credit),
      update: async args => { state.creditWrites.push(copy(args.data)); Object.assign(state.credit, copy(args.data)); return copy(state.credit); },
    },
    creditoAbono: {
      findMany: async () => copy(state.payments),
      groupBy: async () => [{ _sum: { valor: state.payments.reduce((sum, item) => sum + item.valor, 0) },
        _count: { _all: state.payments.length }, _max: { fechaAbono: state.payments.at(-1)?.fechaAbono ?? null } }],
      create: async args => {
        const payment = { id: state.payments.length + 1, estado: "ACTIVO", createdAt: new Date(), fechaAbono: new Date(),
          ...copy(args.data), ...copy(relations) };
        state.payments.push(payment);
        return copy(payment);
      },
    },
    cajaMovimiento: { create: async args => {
      if (state.failCaja) throw new Error("Synthetic cash journal failure");
      state.caja.push(copy(args.data)); return { id: state.caja.length };
    } },
    usuario: { findMany: async () => [relations.usuario] },
    vendedor: { findMany: async () => [] },
    sede: { findMany: async () => [relations.sede] },
  };
  const prisma = { ...tx, $transaction: async work => {
    if (options.beforeLock) { const callback = options.beforeLock; options.beforeLock = null; callback(state); }
    const before = copy({ credit: state.credit, payments: state.payments, caja: state.caja, creditWrites: state.creditWrites });
    try { return await work(tx); } catch (error) { Object.assign(state, before); throw error; }
  } };
  const dependencies = {
    ...modules,
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => session },
    "@/lib/seller-auth": { getSellerSessionUser: async () => options.sellerSession || null },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map([[7, "QA-00007"]]) },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/device-unlock-queue": {
      enqueueUnlockForCurrentCredit: async input => { state.unlocks.push(input); return { id: 1, status: "CONFIRMED" }; },
      processDeviceUnlockCommand: async () => ({ confirmed: true }),
    },
    "@/lib/equality-zero-touch": { isEqualityConfigured: () => false },
    "@/lib/equality-device-meta": {},
  };
  const loaded = { exports: {} };
  runInNewContext(output, { module: loaded, exports: loaded.exports, Request, Response, Date,
    console: { error: (...args) => state.errors.push(args.map(String).join(" ")) },
    require(name) { assert.ok(name in dependencies, `Missing mocked dependency ${name}`); return dependencies[name]; },
  });
  const context = { params: Promise.resolve({ id: "7" }) };
  return { state,
    post: (body = {}) => loaded.exports.POST(new Request("https://test.invalid/api/creditos/7/abonos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valor: 100_000, cuotaNumeros: [3], metodoPago: "BANCOLOMBIA",
        totalAbonadoEsperado: 255_800, observacion: "Synthetic partial payment", ...body }),
    }), context),
    get: () => loaded.exports.GET(new Request("https://test.invalid/api/creditos/7/abonos"), context),
  };
}

test("100000 sobre una cuota de 127900 guarda abono, caja e historial y deja 27900 pendientes", async () => {
  const flow = harness();
  const originals = copy(flow.state.payments);
  const response = await flow.post();
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.item.valor, 100_000);
  assert.equal(result.item.metodoPago, "BANCOLOMBIA");
  assert.equal(result.item.usuario.id, 9);
  assert.equal(result.item.sede.id, 10);
  assert.match(result.item.observacion, /^Cuotas 3/);
  assert.equal(flow.state.caja.length, 1);
  assert.equal(flow.state.caja[0].valor, 100_000);
  assert.deepEqual(flow.state.payments.slice(0, 2), originals);
  assert.equal(result.summary.paidCount, 2);
  assert.equal(result.summary.plan[2].valorAbonado, 100_000);
  assert.equal(result.summary.plan[2].saldoPendiente, 27_900);
  assert.equal(result.summary.plan[2].estado, "PENDIENTE");
  assert.equal(result.summary.plan[2].estaEnMora, true);
  assert.equal(result.summary.estadoPago, "MORA");
  assert.equal(result.summary.nextInstallment.numero, 3);
  assert.equal(result.summary.nextInstallment.fechaVencimiento, "2020-10-20");
  assert.equal(flow.state.credit.fechaProximoPago.toISOString(), "2020-10-20T12:00:00.000Z");
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.unlocks.length, 0);
  assert.ok(flow.state.locks.some(query => /FOR UPDATE/.test(query)));
  const history = await (await flow.get()).json();
  assert.equal(history.items.length, 3);
  assert.ok(history.items.some(item => item.valor === 100_000 && item.id === result.item.id));
});

test("completar el remanente avanza solo entonces a la cuota siguiente", async () => {
  const flow = harness();
  assert.equal((await flow.post()).status, 200);
  const response = await flow.post({ valor: 27_900, totalAbonadoEsperado: 355_800 });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.summary.paidCount, 3);
  assert.equal(result.summary.plan[2].saldoPendiente, 0);
  assert.equal(result.summary.nextInstallment.numero, 4);
  assert.equal(flow.state.credit.fechaProximoPago.toISOString(), "2020-11-02T12:00:00.000Z");
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.caja.length, 2);
});

test("un parcial de varias cuotas se aplica cronológicamente sin pagar cuotas posteriores antes", async () => {
  const flow = harness();
  const response = await flow.post({ valor: 180_000, cuotaNumeros: [4, 3] });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.summary.plan[2].saldoPendiente, 0);
  assert.equal(result.summary.plan[3].valorAbonado, 52_100);
  assert.equal(result.summary.plan[3].saldoPendiente, 75_800);
  assert.equal(result.summary.plan[4].valorAbonado, 0);
  assert.equal(result.summary.nextInstallment.numero, 4);
});

test("el consumidor que omite el importe conserva el pago completo de la selección", async () => {
  const flow = harness();
  const response = await flow.post({ valor: undefined });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.item.valor, 127_900);
  assert.equal(result.summary.paidCount, 3);
  assert.equal(result.summary.plan[2].saldoPendiente, 0);
});

for (const valor of [0, -1, "0", "-100000", "-$ 100.000", "", "abc", null]) {
  test(`no convierte el importe inválido ${JSON.stringify(valor)} en una cuota completa`, async () => {
    const flow = harness();
    const response = await flow.post({ valor });
    assert.equal(response.status, 400);
    assert.equal(flow.state.payments.length, 2);
    assert.equal(flow.state.caja.length, 0);
  });
}

test("no acepta un resumen esperado negativo ni inválido", async () => {
  for (const totalAbonadoEsperado of [-1, "no es un importe"]) {
    const flow = harness();
    assert.equal((await flow.post({ totalAbonadoEsperado })).status, 400);
    assert.equal(flow.state.payments.length, 2);
    assert.equal(flow.state.caja.length, 0);
  }
});

for (const body of [{ valor: 4_348_601 }, { cuotaNumeros: [2] }, { cuotaNumeros: [99] }]) {
  test(`rechaza sobrepago o cuota inválida: ${JSON.stringify(body)}`, async () => {
    const flow = harness();
    const response = await flow.post(body);
    assert.equal(response.status, 400);
    assert.equal(flow.state.payments.length, 2);
    assert.equal(flow.state.caja.length, 0);
  });
}

test("un reintento con el mismo resumen confirmado no duplica un abono parcial", async () => {
  const flow = harness();
  assert.equal((await flow.post()).status, 200);
  const response = await flow.post();
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.match(result.error, /abonos del credito cambiaron/);
  assert.equal(result.code, "PAYMENT_PLAN_CHANGED");
  assert.equal(flow.state.payments.length, 3);
  assert.equal(flow.state.caja.length, 1);
});

test("revalida el resumen dentro del bloqueo si otro recaudo llegó tras la consulta", async () => {
  const flow = harness({ beforeLock: state => state.payments.push({ ...copy(state.payments[0]), id: 3, valor: 10_000 }) });
  const response = await flow.post();
  assert.equal(response.status, 409);
  assert.equal(flow.state.payments.length, 3, "solo conserva el otro recaudo, no crea el parcial");
  assert.equal(flow.state.caja.length, 0);
});

test("una cuota pagada por otra operación no admite un parcial aunque no envíe resumen esperado", async () => {
  const flow = harness({ beforeLock: state => state.payments.push({ ...copy(state.payments[0]), id: 3, valor: 127_900 }) });
  const response = await flow.post({ totalAbonadoEsperado: undefined });
  assert.equal(response.status, 409);
  assert.equal(flow.state.payments.length, 3);
  assert.equal(flow.state.caja.length, 0);
});

test("si falla la caja se revierte todo y permite reintentar sin pérdida ni duplicación", async () => {
  const flow = harness();
  flow.state.failCaja = true;
  assert.equal((await flow.post()).status, 500);
  assert.equal(flow.state.payments.length, 2);
  assert.equal(flow.state.caja.length, 0);
  assert.equal(flow.state.creditWrites.length, 0);
  flow.state.failCaja = false;
  assert.equal((await flow.post()).status, 200);
  assert.equal(flow.state.payments.length, 3);
  assert.equal(flow.state.caja.length, 1);
});

test("la liquidación anticipada sigue bloqueada en mora y no se convierte en parcial", async () => {
  const flow = harness();
  const response = await flow.post({ liquidacionAnticipada: true, valor: 1 });
  assert.equal(response.status, 400);
  assert.equal(flow.state.payments.length, 2);
  assert.equal(flow.state.caja.length, 0);
});

test("el parcial conserva autenticación, rol y alcance del aliado", async () => {
  for (const options of [{ session: null },
    { session: { id: 9, rolNombre: "VENDEDOR", sedeId: 10 } },
    { session: { id: 9, rolNombre: "VENDEDOR", sedeId: 10 }, sellerSession: { id: 5, tipoPerfil: "VENDEDOR", sedeId: 10 } }]) {
    const flow = harness(options);
    assert.ok([401, 403].includes((await flow.post()).status));
    assert.equal(flow.state.payments.length, 2);
  }
  const session = { id: 9, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALLY", aliadoAccesoId: 4, sedeId: 10 };
  const own = harness({ session });
  assert.equal((await own.post()).status, 200);
  assert.deepEqual(own.state.queries[0].where, { AND: [{ id: 7 }, { sede: { aliadoId: 4 } }] });
  const foreign = harness({ session, inScope: false });
  assert.equal((await foreign.post()).status, 404);
  assert.equal(foreign.state.payments.length, 2);
});
