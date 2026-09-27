import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const paymentPlans = await jiti.import("../lib/credit-payment-plan.ts");
const principalPlans = await jiti.import("../lib/credit-principal-payment.ts");
const earlyPayoffs = await jiti.import("../lib/credit-early-payoff.ts");
const massFinancial = await jiti.import("../lib/mass-credit-financial-components.ts");
const payoffIntents = await jiti.import("../lib/wompi-early-payoff-intent.ts");
const nextPaymentDate = await jiti.import("../lib/credit-next-payment-date.ts");
const factory = await jiti.import("../lib/credit-factory.ts");
const source = readFileSync(new URL("../lib/wompi-payment-processing.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const clone = (value) => structuredClone(value);
const snapshot = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const terms = {
    montoCredito: 149_700 * 48, valorCuota: 149_700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2030-09-17", today: "2026-09-26",
  };
  const prior = [
    { id: 1, valor: 150_000, fechaAbono: new Date("2026-09-17T12:00:00Z"), observacion: "Cuota ordinaria de prueba" },
    { id: 2, valor: 300_000, fechaAbono: new Date("2026-09-20T12:00:00Z"), observacion: "Cuotas ordinarias de prueba" },
  ];
  const quote = principalPlans.createPrincipalPaymentQuote({
    plan: paymentPlans.buildCreditPaymentPlan({ ...terms, abonos: prior }),
    valor: 700_000, capitalOriginal: 3_500_000, cuotaHabitual: 149_700, abonos: prior,
    conciliacion: { capitalPendiente: 3_347_264, tasaPeriodo: 0.010881, cuotaCredito: 94_470,
      fianzaCuota: 54_180, seguroCuota: 1_050, numeroProximaCuota: 4,
      fuente: "Plan de origen verificado al corte de la prueba" },
  });
  const principalPayment = { id: 3, valor: 700_000, fechaAbono: new Date("2026-09-26T12:00:00Z"), observacion: "ABONO EXTRAORDINARIO A CAPITAL - REDUCCIÓN DE PLAZO" };
  const planCapitalVigente = principalPlans.parseCapitalPlanSnapshot({
    ...quote.planCapitalVigente,
    abonosAlCorte: [...quote.planCapitalVigente.abonosAlCorte, { id: 3, valor: 700_000 }],
  });
  const credit = {
    ...terms, id: 7, folio: "TEST-LIQUIDACION-7", clienteNombre: "Cliente sintético", clienteDocumento: "12345678",
    usuarioId: 9, vendedorId: null, sedeId: 10, deviceUid: "DEVICE-TEST-7", estado: "GENERADO",
    montoCredito: quote.montoCreditoActualizado, saldoBaseFinanciado: 3_500_000,
    valorInteres: 1_034_560, valorFianza: 2_600_640, fechaProximoPago: null, observacionAdmin: "Auditoría previa de prueba",
    pazYSalvoEmitidoAt: null, bloqueoMora: false, bloqueoMoraAt: null, planCapitalVigente,
  };
  const payments = [...prior, principalPayment];
  const payoff = earlyPayoffs.calculateCreditEarlyPayoff({ ...credit, abonos: payments });
  const intent = {
    id: 81, creditoId: credit.id, reference: "FP-7-LIQUIDACION-TEST", amount: 2_647_264,
    amountInCents: 264_726_400, currency: "COP", status: "PENDING", processedAbonoId: null,
    transactionId: null, paymentMethodType: "NEQUI", processedAt: null, payload: null,
    cuotaNumeros: earlyPayoffs.buildEarlyPayoffIntentMeta(payoff),
  };
  return { credit, payments, payoff, intent };
}

function harness(initial = fixture()) {
  const state = { ...clone(initial), caja: [], creditWrites: [], receiptWrites: [], locks: [], unlocks: new Map() };
  const intentRead = () => ({ ...clone(state.intent), credito: clone(state.credit) });
  const tx = {
    $queryRaw: async (parts) => { state.locks.push(parts.join("?")); return [{ id: 7 }]; },
    credito: {
      findUnique: async () => clone(state.credit),
      update: async (args) => {
        state.creditWrites.push(clone(args));
        Object.assign(state.credit, clone(args.data));
        return clone(state.credit);
      },
    },
    creditoAbono: {
      findMany: async () => clone(state.payments),
      findFirst: async (args) => state.payments.find((payment) => payment.observacion?.includes(args.where.observacion.contains)) || null,
      create: async (args) => {
        const payment = { id: 4 + state.receiptWrites.length, fechaAbono: new Date("2026-09-26T18:00:00Z"), ...clone(args.data) };
        state.receiptWrites.push(clone(payment));
        state.payments.push(payment);
        return clone(payment);
      },
      update: async (args) => {
        const payment = state.payments.find((item) => item.id === args.where.id);
        Object.assign(payment, clone(args.data));
        return clone(payment);
      },
    },
    cajaMovimiento: { create: async (args) => { state.caja.push(clone(args.data)); return { id: state.caja.length }; } },
    wompiPaymentIntent: {
      findUnique: async () => intentRead(),
      update: async (args) => { Object.assign(state.intent, clone(args.data)); return intentRead(); },
      updateMany: async (args) => {
        if (state.intent.processedAbonoId && args.where.processedAbonoId === null) return { count: 0 };
        Object.assign(state.intent, clone(args.data));
        return { count: 1 };
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (work) => {
      const before = clone({ credit: state.credit, payments: state.payments, caja: state.caja,
        creditWrites: state.creditWrites, receiptWrites: state.receiptWrites, intent: state.intent });
      try { return await work(tx); }
      catch (error) { Object.assign(state, before); throw error; }
    },
  };
  const enqueue = async ({ commandKey }) => {
    if (!state.unlocks.has(commandKey)) state.unlocks.set(commandKey, { id: "UNLOCK-TEST-1", status: "CONFIRMED" });
    return state.unlocks.get(commandKey);
  };
  const dependencies = {
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-payment-plan": paymentPlans,
    "@/lib/credit-next-payment-date": nextPaymentDate,
    "@/lib/credit-early-payoff": earlyPayoffs,
    "@/lib/mass-credit-financial-components": massFinancial,
    "@/lib/wompi-early-payoff-intent": payoffIntents,
    "@/lib/credit-factory": factory,
    "@/lib/digital-collection-sede": { DIGITAL_COLLECTION_CAJA_CONCEPT: "RECAUDO_DIGITAL", ensureDigitalCollectionSede: async () => ({ id: 77, nombre: "Digital prueba" }) },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/device-unlock-queue": {
      ensureDeviceUnlockCommandTable: async () => {}, enqueueDeviceUnlockCommand: enqueue,
      enqueueUnlockForCurrentCredit: enqueue, processDeviceUnlockCommand: async () => ({ status: "CONFIRMED" }),
    },
  };
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports, Date, Number,
    console: { warn() {}, error() {} },
    require(name) { assert.ok(name in dependencies, "Dependencia no simulada: " + name); return dependencies[name]; },
  }, { filename: "lib/wompi-payment-processing.ts" });
  async function process(overrides = {}) {
    const transaction = { id: "WOMPI-TRANSACTION-TEST-1", reference: state.intent.reference,
      status: "APPROVED", amount_in_cents: state.intent.amountInCents, currency: "COP", payment_method_type: "NEQUI", ...overrides };
    return loaded.exports.processApprovedWompiPayment(transaction, { data: { transaction }, event: "transaction.updated" });
  }
  return { state, initial, process, repair: () => loaded.exports.repairProcessedWompiEarlyPayoffIntent(state.intent.id) };
}

function assertNoFinancialWrite(flow) {
  assert.equal(flow.state.receiptWrites.length, 0);
  assert.equal(flow.state.caja.length, 0);
  assert.equal(flow.state.creditWrites.length, 0);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.deepEqual(snapshot(flow.state.credit.planCapitalVigente), snapshot(flow.initial.credit.planCapitalVigente));
}

test("la aprobación liquida exactamente el capital revisado sin modificar la auditoría ni reactivar cuotas", async () => {
  const flow = harness();
  assert.equal(flow.initial.payoff.capitalPendiente, 2_647_264);
  assert.equal(flow.initial.payoff.eligible, true);
  const result = await flow.process();
  assert.equal(result.applied, true);
  assert.equal(result.status, "APPROVED");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].valor, 2_647_264);
  assert.equal(flow.state.receiptWrites[0].metodoPago, "NEQUI");
  assert.equal(flow.state.receiptWrites[0].sedeId, 77);
  assert.match(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/);
  assert.equal(flow.state.caja.length, 1);
  assert.equal(flow.state.caja[0].valor, 2_647_264);
  assert.equal(flow.state.credit.montoCredito, 3_797_264);
  assert.equal(flow.state.credit.valorInteres, flow.initial.payoff.valorInteresReconocido);
  assert.equal(flow.state.credit.valorFianza, flow.initial.payoff.valorFianzaReconocida);
  assert.ok(flow.state.credit.pazYSalvoEmitidoAt);
  assert.equal(flow.state.credit.fechaProximoPago, null);
  assert.equal(flow.state.credit.bloqueoMora, false);
  assert.match(flow.state.credit.observacionAdmin, /Auditoría previa de prueba/);
  assert.deepEqual(snapshot(flow.state.credit.planCapitalVigente), snapshot(flow.initial.credit.planCapitalVigente));
  assert.deepEqual(snapshot(flow.state.intent.cuotaNumeros), snapshot(flow.initial.intent.cuotaNumeros));
  assert.equal(flow.state.intent.processedAbonoId, result.abonoId);
  assert.equal(flow.state.unlocks.size, 1);
  assert.ok(flow.state.locks.some((query) => query.includes('FROM "Credito"')));
  const settled = paymentPlans.buildCreditPaymentPlan({ ...flow.state.credit, abonos: flow.state.payments, settled: true });
  assert.equal(settled.saldoPendiente, 0);
  assert.equal(settled.saldoCapitalPendiente, 0);
  assert.equal(settled.estadoPago, "PAGADO");
  assert.equal(settled.paidCount, 37);
  assert.equal(settled.installments.filter((item) => item.eliminada).length, 11);
  assert.ok(settled.installments.filter((item) => item.eliminada).every((item) => item.valorProgramado === 0));
});

test("el mismo pago aprobado repetido no duplica abono, caja, liquidación ni snapshot", async () => {
  const flow = harness();
  const first = await flow.process();
  assert.equal(first.applied, true);
  const closedCredit = snapshot(flow.state.credit);
  const second = await flow.process();
  assert.equal(second.applied, false);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(second.abonoId, first.abonoId);
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.caja.length, 1);
  assert.deepEqual(snapshot(flow.state.credit), closedCredit);
  assert.deepEqual(snapshot(flow.state.credit.planCapitalVigente), snapshot(flow.initial.credit.planCapitalVigente));
});

test("otra transacción aprobada para la misma referencia se remite a revisión sin otro recaudo", async () => {
  const flow = harness();
  assert.equal((await flow.process()).applied, true);
  const closedCredit = snapshot(flow.state.credit);
  const duplicate = await flow.process({ id: "WOMPI-DUPLICATE-TEST-2" });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.status, "APPROVED_DUPLICATE_REVIEW_REQUIRED");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.caja.length, 1);
  assert.deepEqual(snapshot(flow.state.credit), closedCredit);
});

test("un abono posterior que reduce capital invalida el importe antiguo bajo el bloqueo", async () => {
  const flow = harness();
  flow.state.payments.push({ id: 4, valor: 148_800, fechaAbono: new Date("2026-09-26T13:00:00Z"), observacion: "Pago ordinario posterior de prueba" });
  const result = await flow.process();
  assert.equal(result.applied, false);
  assert.equal(result.status, "APPROVED_REVIEW_REQUIRED");
  assertNoFinancialWrite(flow);
});

test("el cliente en mora después de cotizar no se liquida automáticamente", async () => {
  const flow = harness();
  flow.state.credit.fechaProximoPago = new Date("2000-01-01T12:00:00Z");
  const result = await flow.process();
  assert.equal(result.applied, false);
  assert.equal(result.status, "APPROVED_REVIEW_REQUIRED");
  assertNoFinancialWrite(flow);
});

test("un importe aprobado distinto de la intención no cierra ni registra recaudos", async () => {
  const flow = harness();
  const result = await flow.process({ amount_in_cents: 264_726_401 });
  assert.equal(result.applied, false);
  assert.equal(result.status, "AMOUNT_MISMATCH");
  assertNoFinancialWrite(flow);
});

for (const status of ["PENDING", "DECLINED", "ERROR", "VOIDED"]) {
  test(`el estado ${status} no constituye confirmación y no puede cerrar el crédito`, async () => {
    const flow = harness();
    const result = await flow.process({ status });
    assert.equal(result.applied, false);
    assertNoFinancialWrite(flow);
  });
}
test("un recaudo posterior de cargos invalida la cotización aunque el capital no cambie", async () => {
  const flow = harness();
  flow.state.payments.push({ id: 4, valor: 5_000, fechaAbono: new Date("2026-09-26T13:00:00Z"), observacion: "Pago parcial posterior de prueba" });
  const updatedPayoff = earlyPayoffs.calculateCreditEarlyPayoff({ ...flow.state.credit, abonos: flow.state.payments });
  assert.equal(updatedPayoff.capitalPendiente, flow.initial.payoff.capitalPendiente);
  assert.equal(updatedPayoff.totalAbonado, flow.initial.payoff.totalAbonado + 5_000);
  const result = await flow.process();
  assert.equal(result.applied, false);
  assert.equal(result.status, "APPROVED_REVIEW_REQUIRED");
  assert.match(result.reason, /plan o los recaudos cambiaron/i);
  assertNoFinancialWrite(flow);
});

test("una revisión distinta invalida la cotización aunque conserve el importe de capital", async () => {
  const flow = harness();
  flow.state.credit.planCapitalVigente.revision += 1;
  const updatedPayoff = earlyPayoffs.calculateCreditEarlyPayoff({ ...flow.state.credit, abonos: flow.state.payments });
  assert.equal(updatedPayoff.capitalPendiente, flow.initial.payoff.capitalPendiente);
  assert.notEqual(updatedPayoff.planRevision, flow.initial.payoff.planRevision);
  const result = await flow.process();
  assert.equal(result.applied, false);
  assert.equal(result.status, "APPROVED_REVIEW_REQUIRED");
  assert.equal(flow.state.receiptWrites.length, 0);
  assert.equal(flow.state.caja.length, 0);
  assert.equal(flow.state.creditWrites.length, 0);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
});

test("una intención antigua sin revisión ni total al corte no liquida un snapshot revisado", async () => {
  const flow = harness();
  delete flow.state.intent.cuotaNumeros.planRevision;
  delete flow.state.intent.cuotaNumeros.totalAbonado;
  const result = await flow.process();
  assert.equal(result.applied, false);
  assert.equal(result.status, "APPROVED_REVIEW_REQUIRED");
  assertNoFinancialWrite(flow);
});
const checkoutSource = readFileSync(new URL("../app/api/clientes/wompi-checkout/route.ts", import.meta.url), "utf8");
const checkoutOutput = ts.transpileModule(checkoutSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function checkoutHarness(changeLockedState = () => {}) {
  const initial = fixture();
  const locked = { credit: clone(initial.credit), payments: clone(initial.payments) };
  changeLockedState(locked);
  const intents = [];
  const providerCalls = [];
  const scopedReads = [];
  const locks = [];
  const tx = {
    $queryRaw: async (parts) => { locks.push(parts.join("?")); return [{ id: 7 }]; },
    credito: { findUnique: async () => clone(locked.credit) },
    creditoAbono: { findMany: async () => clone(locked.payments) },
    wompiPaymentIntent: {
      findMany: async () => [],
      create: async (args) => {
        const created = { id: 81, ...clone(args.data) };
        intents.push(created);
        return clone(created);
      },
    },
  };
  const prisma = {
    credito: { findFirst: async (args) => {
      scopedReads.push(snapshot(args.where));
      return { ...clone(initial.credit), abonos: clone(initial.payments) };
    } },
    wompiPaymentIntent: { update: async (args) => {
      const intent = intents.find((item) => item.id === args.where.id);
      Object.assign(intent, clone(args.data));
      return clone(intent);
    } },
    $transaction: async (work) => work(tx),
  };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-payment-plan": paymentPlans,
    "@/lib/credit-early-payoff": earlyPayoffs,
    "@/lib/credit-factory": factory,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/wompi-payment-processing": { processApprovedWompiPayment: async () => { throw new Error("El proveedor simulado devuelve PENDING"); } },
    "@/lib/wompi": {
      isWompiConfigured: () => true, isWompiDirectApiConfigured: () => true,
      buildWompiCheckoutUrl: () => { throw new Error("Esta prueba usa Nequi directo"); },
      createWompiNequiTransaction: async (args) => {
        providerCalls.push(snapshot(args));
        return { id: "WOMPI-PENDING-TEST-1", status: "PENDING", payment_method_type: "NEQUI" };
      },
    },
  };
  const loaded = { exports: {} };
  runInNewContext(checkoutOutput, {
    module: loaded, exports: loaded.exports, Date, Number, Request, Response, URL,
    process: { env: {} }, console: { error() {} },
    require(name) { assert.ok(name in dependencies, "Dependencia de checkout no simulada: " + name); return dependencies[name]; },
  }, { filename: "app/api/clientes/wompi-checkout/route.ts" });
  const post = () => loaded.exports.POST(new Request("https://finser.test/api/clientes/wompi-checkout", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creditoId: 7, documento: initial.credit.clienteDocumento,
      paymentMethod: "NEQUI", paymentMode: "LIQUIDACION_ANTICIPADA", nequiPhone: "3001234567", acceptWompiTerms: true, cuotaNumeros: [] }),
  }));
  return { initial, locked, intents, providerCalls, scopedReads, locks, post };
}

test("checkout crea una intención por capital real revisado y guarda revisión y recaudo cotizados", async () => {
  const flow = checkoutHarness();
  const result = await flow.post();
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.amount, 2_647_264);
  assert.equal(data.amountInCents, 264_726_400);
  assert.equal(data.paymentMode, "NEQUI_DIRECT");
  assert.equal(data.status, "PENDING");
  assert.equal(flow.intents.length, 1);
  assert.deepEqual(snapshot(flow.intents[0].cuotaNumeros), snapshot(earlyPayoffs.buildEarlyPayoffIntentMeta(flow.initial.payoff)));
  assert.equal(flow.intents[0].cuotaNumeros.planRevision, 1);
  assert.equal(flow.intents[0].cuotaNumeros.totalAbonado, 1_150_000);
  assert.equal(flow.providerCalls.length, 1);
  assert.equal(flow.providerCalls[0].amountInCents, 264_726_400);
  assert.deepEqual(flow.scopedReads[0], { id: 7, clienteDocumento: "12345678", estado: { not: "ANULADO" } });
  assert.ok(flow.locks.some((query) => query.includes('FROM "Credito"')));
});

for (const scenario of [
  { name: "capital reducido por otro pago", change: (locked) => locked.payments.push({ id: 4, valor: 148_800, fechaAbono: new Date("2026-09-26T13:00:00Z") }) },
  { name: "pago parcial sin cambio de capital", change: (locked) => locked.payments.push({ id: 4, valor: 5_000, fechaAbono: new Date("2026-09-26T13:00:00Z") }) },
  { name: "revisión distinta con igual capital", change: (locked) => { locked.credit.planCapitalVigente.revision += 1; } },
  { name: "paz y salvo emitido concurrentemente", change: (locked) => { locked.credit.pazYSalvoEmitidoAt = new Date("2026-09-26T13:00:00Z"); } },
]) {
  test(`checkout rechaza ${scenario.name} entre lectura y bloqueo sin crear ni enviar intención`, async () => {
    const flow = checkoutHarness(scenario.change);
    const result = await flow.post();
    assert.equal(result.status, 409);
    assert.equal(flow.intents.length, 0);
    assert.equal(flow.providerCalls.length, 0);
    assert.ok(flow.locks.some((query) => query.includes('FROM "Credito"')));
  });
}

function markedMassFixture() {
  const initial = fixture();
  const marker = massFinancial.calculateMassCreditComponents({
    capital: 2800000, cuota: 119350, numeroCuotas: 48,
    fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03,
  });
  initial.credit = {
    ...initial.credit, montoCredito: marker.total, valorCuota: marker.cuota,
    saldoBaseFinanciado: marker.capital, plazoMeses: marker.numeroCuotas,
    valorInteres: marker.intereses, valorFianza: marker.fianza,
    planCapitalVigente: null, fechaPrimerPago: new Date("2030-09-17T12:00:00Z"),
    contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA", audit: "authorized synthetic correction" },
      financiero: { componentesMasivos: { ...marker, audit: "keep" } } },
  };
  initial.payments = [{ id: 1, valor: marker.cuota, fechaAbono: new Date("2026-09-20T12:00:00Z"), observacion: "Synthetic receipt" }];
  initial.payoff = earlyPayoffs.calculateCreditEarlyPayoff({ ...initial.credit, abonos: initial.payments });
  initial.intent = { ...initial.intent, amount: initial.payoff.capitalPendiente,
    amountInCents: Math.round(initial.payoff.capitalPendiente * 100),
    cuotaNumeros: earlyPayoffs.buildEarlyPayoffIntentMeta(initial.payoff) };
  return initial;
}

function assertClosedMassMarker(flow) {
  const marker = massFinancial.readMassCreditComponents(flow.state.credit.contratoSnapshot, flow.state.credit);
  assert.ok(marker, "closed financial marker must match every persisted component");
  assert.equal(marker.liquidacionAnticipada, true);
  assert.equal(marker.seguro, flow.initial.payoff.valorSeguroReconocido);
  assert.ok(marker.seguro > 0);
  assert.equal(marker.cuota, 119350);
  assert.equal(marker.numeroCuotas, 48);
  assert.equal(marker.total, flow.initial.payoff.montoCreditoLiquidado);
  assert.equal(Math.round((marker.capital + marker.fianza + marker.intereses + marker.seguro) * 100), Math.round(marker.total * 100));
  assert.equal(flow.state.credit.contratoSnapshot.financiero.componentesMasivos.audit, "keep");
  assert.deepEqual(snapshot(flow.state.credit.contratoSnapshot.origen), snapshot(flow.initial.credit.contratoSnapshot.origen));
  assert.equal(flow.state.credit.valorCuota, 119350);
  assert.equal(flow.state.credit.plazoMeses, 48);
  assert.deepEqual(flow.state.credit.fechaPrimerPago, flow.initial.credit.fechaPrimerPago);
}

test("approved Wompi closes a marked imported credit preserving insurance, quota, term and audit", async () => {
  const flow = harness(markedMassFixture());
  const result = await flow.process();
  assert.equal(result.applied, true);
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].valor, flow.initial.payoff.capitalPendiente);
  assert.equal(flow.state.caja[0].valor, flow.initial.payoff.capitalPendiente);
  assert.equal(flow.state.creditWrites.length, 1);
  assertClosedMassMarker(flow);
  const before = snapshot(flow.state.credit);
  const duplicate = await flow.process();
  assert.equal(duplicate.alreadyProcessed, true);
  assert.deepEqual(snapshot(flow.state.credit), before);
  assert.equal(flow.state.receiptWrites.length, 1);
});

test("repairing an already processed Wompi payoff retains the marked insurance without registering cash twice", async () => {
  const initial = markedMassFixture();
  initial.payments.push({ id: 5, valor: initial.payoff.capitalPendiente,
    fechaAbono: new Date("2026-09-26T12:00:00Z"), observacion: "Wompi payoff captured but not yet finalized" });
  initial.intent = { ...initial.intent, status: "APPROVED", processedAbonoId: 5, transactionId: "WOMPI-TRANSACTION-TEST-1" };
  const flow = harness(initial);
  const result = await flow.repair();
  assert.equal(result.action, "REPAIRED");
  assert.equal(flow.state.creditWrites.length, 1);
  assert.equal(flow.state.receiptWrites.length, 0);
  assert.equal(flow.state.caja.length, 0);
  assertClosedMassMarker(flow);
});

for (const status of ["PENDING", "DECLINED", "ERROR"]) {
  test(`a marked credit with provider status ${status} retains its original components`, async () => {
    const flow = harness(markedMassFixture());
    const before = snapshot(flow.state.credit);
    const result = await flow.process({ status });
    assert.equal(result.applied, false);
    assert.equal(flow.state.creditWrites.length, 0);
    assert.equal(flow.state.receiptWrites.length, 0);
    assert.deepEqual(snapshot(flow.state.credit), before);
  });
}
