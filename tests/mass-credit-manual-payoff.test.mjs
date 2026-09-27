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
const financial = modules["@/lib/mass-credit-financial-components"];
const early = modules["@/lib/credit-early-payoff"];
const source = readFileSync(new URL("../app/api/creditos/[id]/abonos/route.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const clone = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));

function fixture(marked = true) {
  const marker = financial.calculateMassCreditComponents({ capital: 2800000, cuota: 119350, numeroCuotas: 48, fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03 });
  const credit = {
    id: 7, folio: "TEST-MASS-7", clienteNombre: "Synthetic client", clienteDocumento: "12345678", clienteTelefono: "3001234567",
    sedeId: 10, usuarioId: 9, cuotaInicial: 0, estado: "GENERADO", equalityService: "IMPORTACION_MASIVA",
    montoCredito: marker.total, saldoBaseFinanciado: marker.capital, valorCuota: marker.cuota, plazoMeses: marker.numeroCuotas,
    valorInteres: marked ? marker.intereses : marker.total - marker.capital, valorFianza: marked ? marker.fianza : 0,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2030-09-17T12:00:00Z"), fechaProximoPago: null,
    planCapitalVigente: null, pazYSalvoEmitidoAt: null, observacionAdmin: "Original synthetic audit",
    contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA", batchId: "SYNTHETIC_BATCH", audit: "keep" },
      evidencia: { privateDocument: "MUST_NOT_LEAK" },
      financiero: marked ? { componentesMasivos: { ...marker, audit: "authorized synthetic correction" }, valorSeguro: marker.seguro } : {} },
  };
  const payments = [{ id: 1, creditoId: 7, valor: marker.cuota, metodoPago: "EFECTIVO", estado: "ACTIVO",
    fechaAbono: new Date("2026-09-20T12:00:00Z"), createdAt: new Date("2026-09-20T12:00:00Z"), usuarioId: 9, sedeId: 10 }];
  return { credit, payments };
}

function harness({ marked = true, session = { id: 9, nombre: "Test admin", rolNombre: "ADMIN", aliadoAccesoCodigo: "ALLY", aliadoAccesoId: 4, sedeId: 10 } } = {}) {
  const initial = fixture(marked);
  const state = { ...clone(initial), queries: [], creditWrites: [], receipts: [], caja: [], locks: [], errors: [] };
  const relations = { usuario: { id: 9, nombre: "Test admin", usuario: "admin" }, vendedor: null, sede: { id: 10, nombre: "Test site" } };
  const tx = {
    $queryRaw: async parts => { state.locks.push(parts.join("?")); return [{ id: 7 }]; },
    credito: {
      findFirst: async args => { state.queries.push(json(args)); return clone(state.credit); },
      findUnique: async args => { state.queries.push(json(args)); return clone(state.credit); },
      update: async args => { state.creditWrites.push(clone(args)); Object.assign(state.credit, clone(args.data)); return clone(state.credit); },
    },
    creditoAbono: {
      findMany: async () => clone(state.payments),
      create: async args => {
        const payment = { id: 2, estado: "ACTIVO", createdAt: new Date("2026-09-26T12:00:00Z"), fechaAbono: new Date("2026-09-26T12:00:00Z"), ...clone(args.data), ...clone(relations) };
        state.payments.push(payment); state.receipts.push(payment); return clone(payment);
      },
      groupBy: async () => [{ _sum: { valor: state.payments.reduce((sum, payment) => sum + payment.valor, 0) },
        _count: { _all: state.payments.length }, _max: { fechaAbono: state.payments.at(-1)?.fechaAbono ?? null } }],
    },
    cajaMovimiento: { create: async args => { state.caja.push(clone(args)); return { id: 1 }; } },
    usuario: { findMany: async () => [relations.usuario] },
    vendedor: { findMany: async () => [] },
    sede: { findMany: async () => [relations.sede] },
  };
  const prisma = { ...tx, $transaction: async work => {
    const before = clone({ credit: state.credit, payments: state.payments, creditWrites: state.creditWrites, receipts: state.receipts, caja: state.caja });
    try { return await work(tx); } catch (error) { Object.assign(state, before); throw error; }
  } };
  const dependencies = {
    ...modules,
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => session },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map([[7, "TEST-SADMIN-7"]]) },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/device-unlock-queue": { enqueueUnlockForCurrentCredit: async () => ({ id: 1, status: "CONFIRMED" }), processDeviceUnlockCommand: async () => ({ confirmed: true }) },
    "@/lib/equality-zero-touch": { isEqualityConfigured: () => false, isEqualityApiError: () => false },
    "@/lib/equality-device-meta": {},
    "@/lib/credit-lock-message": {},
  };
  const loaded = { exports: {} };
  runInNewContext(output, { module: loaded, exports: loaded.exports, Request, Response, URL, Date,
    console: { error: (...args) => state.errors.push(args.map(String).join(" ")) },
    require(name) { assert.ok(name in dependencies, `Missing mocked dependency ${name}`); return dependencies[name]; },
  });
  return { state, initial,
    get: () => loaded.exports.GET(new Request("https://test.invalid/api/creditos/7/abonos"), { params: Promise.resolve({ id: "7" }) }),
    post: () => loaded.exports.POST(new Request("https://test.invalid/api/creditos/7/abonos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ liquidacionAnticipada: true, valor: 1, metodoPago: "EFECTIVO", observacion: "Authorized synthetic close" }),
    }), { params: Promise.resolve({ id: "7" }) }),
  };
}

test("manual close computes server principal and persists a matching insured marker without changing imported terms", async () => {
  const flow = harness();
  const expected = early.calculateCreditEarlyPayoff({ ...flow.initial.credit, abonos: flow.initial.payments });
  const response = await flow.post();
  assert.equal(response.status, 200, flow.state.errors.join("\n"));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(flow.state.receipts.length, 1);
  assert.equal(flow.state.receipts[0].valor, expected.capitalPendiente, "submitted value 1 cannot replace the server quote");
  assert.equal(flow.state.caja[0].data.valor, expected.capitalPendiente);
  assert.equal(flow.state.credit.montoCredito, expected.montoCreditoLiquidado);
  const marker = financial.readMassCreditComponents(flow.state.credit.contratoSnapshot, flow.state.credit);
  assert.ok(marker && marker.liquidacionAnticipada);
  assert.equal(marker.seguro, expected.valorSeguroReconocido);
  assert.equal(marker.cuota, 119350);
  assert.equal(marker.numeroCuotas, 48);
  assert.equal(flow.state.credit.fechaPrimerPago.getTime(), flow.initial.credit.fechaPrimerPago.getTime());
  assert.deepEqual(flow.state.credit.contratoSnapshot.origen, flow.initial.credit.contratoSnapshot.origen);
  assert.equal(marker.total, Math.round((marker.capital + marker.fianza + marker.seguro + marker.intereses) * 100) / 100);
  assert.equal(flow.state.credit.valorCuota, flow.initial.credit.valorCuota);
  assert.equal(flow.state.credit.plazoMeses, flow.initial.credit.plazoMeses);
  assert.ok(flow.state.credit.pazYSalvoEmitidoAt);
  assert.ok(flow.state.locks.some(query => query.includes('FROM "Credito"')));
  assert.doesNotMatch(JSON.stringify(data), /MUST_NOT_LEAK|contratoSnapshot/);
});

for (const marked of [true, false]) {
  test(`GET payment history omits the contract snapshot for ${marked ? "marked" : "unmarked"} credits`, async () => {
    const flow = harness({ marked });
    const response = await flow.get();
    assert.equal(response.status, 200, flow.state.errors.join("\n"));
    const data = await response.json();
    assert.equal("contratoSnapshot" in data.credito, false);
    assert.doesNotMatch(JSON.stringify(data), /MUST_NOT_LEAK/);
    assert.deepEqual(flow.state.queries[0].where, { AND: [{ id: 7 }, { sede: { aliadoId: 4 } }] });
    assert.equal(flow.state.queries[0].select.contratoSnapshot, true);
    if (marked) {
      assert.equal(data.credito.valorSeguro, 40320);
      assert.equal(data.credito.seguroCuotaPorcentaje, 0.03);
    } else {
      assert.equal("valorSeguro" in data.credito, false);
      assert.equal("seguroCuotaPorcentaje" in data.credito, false);
    }
  });
}

test("manual close of an unmarked imported credit preserves the previous snapshot and charge allocation", async () => {
  const flow = harness({ marked: false });
  const expected = early.calculateCreditEarlyPayoff({ ...flow.initial.credit, abonos: flow.initial.payments });
  const response = await flow.post();
  assert.equal(response.status, 200, flow.state.errors.join("\n"));
  assert.deepEqual(flow.state.credit.contratoSnapshot, flow.initial.credit.contratoSnapshot);
  assert.equal("contratoSnapshot" in flow.state.creditWrites[0].data, false);
  assert.equal(flow.state.credit.valorInteres, expected.valorInteresReconocido);
  assert.equal(flow.state.credit.valorFianza, expected.valorFianzaReconocida);
  assert.equal(flow.state.credit.montoCredito, expected.montoCreditoLiquidado);
});

for (const [name, session, status] of [["missing session", null, 401], ["ordinary seller", { id: 9, rolNombre: "VENDEDOR" }, 403]]) {
  test(`manual insured close retains existing denial for ${name}`, async () => {
    const flow = harness({ session });
    const before = clone(flow.state.credit);
    const response = await flow.post();
    assert.equal(response.status, status);
    assert.equal(flow.state.receipts.length, 0);
    assert.equal(flow.state.creditWrites.length, 0);
    assert.deepEqual(flow.state.credit, before);
  });
}
