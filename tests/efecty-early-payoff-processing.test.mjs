import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const requireNode = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const paymentPlans = await jiti.import("../lib/credit-payment-plan.ts");
const principalPlans = await jiti.import("../lib/credit-principal-payment.ts");
const earlyPayoffs = await jiti.import("../lib/credit-early-payoff.ts");
const massComponents = await jiti.import("../lib/mass-credit-financial-components.ts");
const nextPaymentDate = await jiti.import("../lib/credit-next-payment-date.ts");
const factory = await jiti.import("../lib/credit-factory.ts");
const source = readFileSync(new URL("../lib/efecty-recaudos.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    esModuleInterop: true },
}).outputText;
const clone = value => structuredClone(value);
const PAYMENT_DAY = "2026-09-27";

function fixture(overrides = {}, paymentOverrides = null) {
  const credit = {
    id: 7, folio: "TEST-EFECTY-7", clienteNombre: "Cliente sintético",
    clienteDocumento: "12345678", referenciaPago: "12345678", clienteTelefono: null,
    imei: "IMEI-SINTETICO", deviceUid: "DEVICE-TEST-7", usuarioId: 9,
    sedeId: 10, sede: { id: 10, nombre: "Sede de prueba" },
    estado: "GENERADO", pazYSalvoEmitidoAt: null, bloqueoMora: false,
    bloqueoMoraAt: null, observacionAdmin: "Observación previa",
    planCapitalVigente: null, montoCredito: 12_000_000, saldoBaseFinanciado: 6_000_000,
    valorInteres: 2_000_000, valorFianza: 4_000_000,
    valorCuota: 250_000, plazoMeses: 48, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2030-01-17", fechaProximoPago: "2030-01-17",
    ...overrides,
  };
  const payments = paymentOverrides || [
    { id: 1, valor: 250_000, fechaAbono: new Date("2026-08-17T12:00:00Z") },
    { id: 2, valor: 250_000, fechaAbono: new Date("2026-09-17T12:00:00Z") },
  ];
  const payoff = earlyPayoffs.calculateCreditEarlyPayoff({ ...credit, abonos: payments,
    today: PAYMENT_DAY });
  const contractPlan = paymentPlans.buildCreditPaymentPlan({ ...credit, abonos: payments,
    today: PAYMENT_DAY });
  return { credit, payments, payoff, contractPlan };
}

function harness(initial = fixture()) {
  const state = {
    credit: clone(initial.credit), payments: clone(initial.payments),
    import: null, candidateIds: [initial.credit.id], candidates: [clone(initial.credit)],
    receiptWrites: [], cajaWrites: [], creditWrites: [], locks: [], unlocks: [],
    syncMoraCalls: [], beforeTransaction: null, intent: null,
    intentLookups: [], intentConsumes: [], intentEnsures: 0,
  };
  const query = parts => {
    const sql = parts.join("?");
    if (sql.includes('FROM "EfectyRecaudoImport"') && sql.includes('"paymentKey"')) {
      return state.import ? [clone(state.import)] : [];
    }
    if (sql.includes('INSERT INTO "EfectyRecaudoImport"')) {
      if (state.import) return [];
      state.import = { id: 51, status: "PROCESANDO", message: null, abonoId: null };
      return [clone(state.import)];
    }
    if (sql.includes('FROM "Credito"') && sql.includes('REGEXP_REPLACE')) {
      return state.candidateIds.map(id => ({ id }));
    }
    throw new Error(`Consulta simulada no reconocida: ${sql.slice(0, 100)}`);
  };
  const updateImport = (parts, values) => {
    const sql = parts.join("?");
    if (!sql.includes('UPDATE "EfectyRecaudoImport"')) {
      throw new Error(`Actualización simulada no reconocida: ${sql.slice(0, 100)}`);
    }
    if (sql.includes("status = 'APLICADO'")) {
      state.import = { ...state.import, status: "APLICADO", message: "Abono aplicado automaticamente",
        creditoId: state.credit.id, abonoId: state.receiptWrites.at(-1).id };
    } else if (sql.includes("status = 'REVISION_REQUERIDA'")) {
      state.import = { ...state.import, status: "REVISION_REQUERIDA", message: values[0] };
    } else if (sql.includes("status = 'VALOR_SUPERA_SALDO'")) {
      state.import = { ...state.import, status: "VALOR_SUPERA_SALDO", message: values[0] };
    } else {
      state.import = { ...state.import, status: values[0], message: values[1],
        creditoId: values[2], abonoId: values[3] };
    }
    return 1;
  };
  const tx = {
    $queryRaw: async (parts, ...values) => {
      const sql = parts.join("?");
      state.locks.push(sql);
      if (sql.includes('FROM "Credito"') && sql.includes("FOR UPDATE")) {
        assert.equal(values[0], state.credit.clienteDocumento, "Se bloqueó otra referencia");
        return state.candidateIds.map(id => ({ id }));
      }
      if (sql.includes('FROM "EfectyRecaudoImport"') && sql.includes("FOR UPDATE")) {
        return state.import ? [clone(state.import)] : [];
      }
      return query(parts);
    },
    $executeRaw: async (parts, ...values) => updateImport(parts, values),
    credito: {
      findUnique: async () => clone(state.credit),
      update: async args => {
        state.creditWrites.push(clone(args.data));
        Object.assign(state.credit, clone(args.data));
        return clone(state.credit);
      },
    },
    creditoAbono: {
      findMany: async () => clone(state.payments),
      create: async args => {
        const payment = { id: 3 + state.receiptWrites.length, ...clone(args.data) };
        state.receiptWrites.push(clone(payment));
        state.payments.push(payment);
        return clone(payment);
      },
    },
    cajaMovimiento: { create: async args => {
      state.cajaWrites.push(clone(args.data));
      return { id: state.cajaWrites.length };
    } },
  };
  const prisma = {
    ...tx,
    $executeRawUnsafe: async () => 0,
    $queryRaw: async parts => query(parts),
    credito: {
      ...tx.credito,
      findMany: async () => state.candidates.map(candidate => ({
        ...clone(candidate), abonos: clone(state.payments),
      })),
    },
    $transaction: async work => {
      if (state.beforeTransaction) {
        const action = state.beforeTransaction;
        state.beforeTransaction = null;
        action();
      }
      const before = clone({ credit: state.credit, payments: state.payments, import: state.import,
        receiptWrites: state.receiptWrites, cajaWrites: state.cajaWrites,
        creditWrites: state.creditWrites, intent: state.intent,
        intentConsumes: state.intentConsumes });
      try { return await work(tx); }
      catch (error) { Object.assign(state, before); throw error; }
    },
  };
  const dependencies = {
    "node:crypto": requireNode("node:crypto"),
    "node:path": requireNode("node:path"),
    "ssh2-sftp-client": class FakeSftpClient {},
    "@/lib/prisma": prisma,
    "@/lib/credit-payment-plan": paymentPlans,
    "@/lib/credit-early-payoff": earlyPayoffs,
    "@/lib/mass-credit-financial-components": massComponents,
    "@/lib/credit-next-payment-date": nextPaymentDate,
    "@/lib/credit-factory": factory,
    "@/lib/credit-mora-sync": { syncCreditMora: async credit => { state.syncMoraCalls.push(clone(credit)); } },
    "@/lib/efecty-payoff-intents": {
      ensureEfectyPayoffIntentTable: async () => { state.intentEnsures += 1; },
      findEfectyPayoffIntent: async (_client, input) => {
        state.intentLookups.push(clone(input));
        const intent = state.intent;
        return intent && intent.creditoId === input.creditoId &&
          intent.referencia === String(input.referencia).replace(/\D/g, "") &&
          intent.amountInCents === input.amountInCents &&
          intent.createdAt <= input.paidAt && intent.expiresAt >= input.paidAt &&
          !intent.consumedAt ? clone(intent) : null;
      },
      consumeEfectyPayoffIntent: async (_client, id, paymentKey) => {
        state.intentConsumes.push({ id, paymentKey });
        if (!state.intent || state.intent.id !== id || state.intent.consumedAt) return false;
        state.intent.consumedAt = new Date("2026-09-27T18:00:00Z");
        state.intent.paymentKey = paymentKey;
        return true;
      },
    },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/digital-collection-sede": { DIGITAL_COLLECTION_CAJA_CONCEPT: "RECAUDO_DIGITAL",
      ensureDigitalCollectionSede: async () => ({ id: 77, nombre: "Digital prueba" }) },
    "@/lib/device-unlock-queue": {
      enqueueUnlockForCurrentCredit: async args => { state.unlocks.push(clone(args)); return { id: 5, status: "CONFIRMED" }; },
      processDeviceUnlockCommand: async () => {},
    },
  };
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports, Date, Number, Buffer, process, console: { error() {} },
    require(name) { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; },
  }, { filename: "lib/efecty-recaudos.ts" });
  async function processPayment(value = initial.payoff.capitalPendiente, reference = initial.credit.clienteDocumento) {
    const paidAt = `${PAYMENT_DAY} 12:00:00`;
    const line = `02|${reference}|${value}|${paidAt}|x|x|FINSERPAY`;
    const result = await loaded.exports.processEfectyRecaudoContent("recaudo-prueba-20260927.txt", line);
    if (result.lines[0]?.action === "ERROR") throw new Error(result.lines[0].message);
    return result;
  }
  return { state, initial, processPayment,
    parse: loaded.exports.parseEfectyRecaudoFile };
}

function setPayoffIntent(flow, overrides = {}) {
  flow.state.intent = {
    id: 301, creditoId: flow.initial.credit.id,
    referencia: flow.initial.credit.clienteDocumento,
    amountInCents: Math.round(flow.initial.payoff.capitalPendiente * 100),
    quote: earlyPayoffs.buildEarlyPayoffIntentMeta(flow.initial.payoff),
    createdAt: new Date("2026-09-26T12:00:00Z"),
    expiresAt: new Date("2026-09-28T12:00:00Z"),
    consumedAt: null, paymentKey: null,
    ...overrides,
  };
  return flow.state.intent;
}

function assertNoFinancialWrite(flow) {
  assert.equal(flow.state.receiptWrites.length, 0);
  assert.equal(flow.state.cajaWrites.length, 0);
  assert.equal(flow.state.creditWrites.length, 0);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
}

test("los horarios 00:30 y 23:59 del archivo Efecty se interpretan en Bogotá", () => {
  const flow = harness();
  const lines = flow.parse([
    "02|12345678|1000|2026-09-27 00:30:00|x|x|FINSERPAY",
    "02|12345678|1000|2026-09-27 23:59:00|x|x|FINSERPAY",
  ].join("\n"), "horarios-prueba.txt");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].paidAt.toISOString(), "2026-09-27T05:30:00.000Z");
  assert.equal(lines[1].paidAt.toISOString(), "2026-09-28T04:59:00.000Z");
});

test("la elegibilidad cambia en la frontera de mora del día colombiano, no del UTC", () => {
  const flow = harness();
  const lines = flow.parse([
    "02|12345678|1000|2026-09-26 23:59:00|x|x|FINSERPAY",
    "02|12345678|1000|2026-09-27 00:01:00|x|x|FINSERPAY",
  ].join("\n"), "frontera-prueba.txt");
  const credit = { ...flow.initial.credit, fechaProximoPago: "2026-09-26" };
  const before = earlyPayoffs.calculateCreditEarlyPayoff({
    ...credit, abonos: flow.initial.payments, today: lines[0].paidAt,
  });
  const after = earlyPayoffs.calculateCreditEarlyPayoff({
    ...credit, abonos: flow.initial.payments, today: lines[1].paidAt,
  });
  assert.equal(lines[0].paidAt.toISOString(), "2026-09-27T04:59:00.000Z");
  assert.equal(lines[1].paidAt.toISOString(), "2026-09-27T05:01:00.000Z");
  assert.equal(before.estadoPago, "AL_DIA");
  assert.equal(before.eligible, true);
  assert.equal(after.estadoPago, "MORA");
  assert.equal(after.eligible, false);
});

test("Efecty exacto a la liquidación vigente cierra como liquidación y conserva el recaudo real", async () => {
  const flow = harness();
  assert.equal(flow.initial.payoff.eligible, true);
  assert.ok(flow.initial.payoff.capitalPendiente > 0);
  assert.ok(flow.initial.payoff.capitalPendiente < flow.initial.contractPlan.saldoPendiente);

  const result = await flow.processPayment();
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].valor, flow.initial.payoff.capitalPendiente);
  assert.equal(flow.state.receiptWrites[0].metodoPago, "EFECTY");
  assert.match(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
  assert.equal(flow.state.cajaWrites.length, 1);
  assert.equal(flow.state.cajaWrites[0].valor, flow.initial.payoff.capitalPendiente);
  assert.equal(flow.state.credit.montoCredito, flow.initial.payoff.montoCreditoLiquidado);
  assert.equal(flow.state.credit.valorInteres, flow.initial.payoff.valorInteresReconocido);
  assert.equal(flow.state.credit.valorFianza, flow.initial.payoff.valorFianzaReconocida);
  assert.equal(flow.state.credit.estado, "PAZ_Y_SALVO");
  assert.ok(flow.state.credit.pazYSalvoEmitidoAt);
  assert.equal(flow.state.credit.fechaProximoPago, null);
  assert.ok(flow.state.locks.some(sql => sql.includes('FROM "Credito"') && sql.includes("FOR UPDATE")));
  assert.ok(flow.state.locks.some(sql => sql.includes('FROM "EfectyRecaudoImport"') && sql.includes("FOR UPDATE")));
  assert.equal(flow.state.unlocks.length, 1);
  assert.equal(flow.state.syncMoraCalls.length, 1);
});

test("el mismo giro Efecty no duplica recibo, caja ni cierre", async () => {
  const flow = harness();
  assert.equal((await flow.processPayment()).lines[0].action, "APLICADO");
  const firstCredit = clone(flow.state.credit);
  const second = await flow.processPayment();
  assert.equal(second.lines[0].action, "DUPLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.cajaWrites.length, 1);
  assert.deepEqual(flow.state.credit, firstCredit);
  assert.equal(flow.state.unlocks.length, 1);
});

test("el pago ordinario de cuota por Efecty conserva capital y cargos originales", async () => {
  const flow = harness();
  const installment = flow.initial.contractPlan.nextInstallment.saldoPendiente;
  const result = await flow.processPayment(installment);
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.cajaWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].valor, installment);
  assert.equal(flow.state.receiptWrites[0].metodoPago, "EFECTY");
  assert.doesNotMatch(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
  assert.equal(flow.state.credit.montoCredito, flow.initial.credit.montoCredito);
  assert.equal(flow.state.credit.valorInteres, flow.initial.credit.valorInteres);
  assert.equal(flow.state.credit.valorFianza, flow.initial.credit.valorFianza);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
});

test("si cuota y liquidación tienen igual valor, sin intención explícita se aplica solo la cuota", async () => {
  const initial = fixture({
    montoCredito: 1_000_000, saldoBaseFinanciado: 500_000,
    valorCuota: 250_000, plazoMeses: 4,
    valorInteres: 150_000, valorFianza: 350_000,
  });
  assert.equal(initial.payoff.eligible, true);
  assert.equal(initial.payoff.capitalPendiente, 250_000);
  assert.equal(initial.contractPlan.nextInstallment.saldoPendiente, 250_000);
  assert.equal(initial.contractPlan.saldoPendiente, 500_000);
  const flow = harness(initial);
  const result = await flow.processPayment(250_000);
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].metodoPago, "EFECTY");
  assert.equal(flow.state.receiptWrites[0].valor, 250_000);
  assert.doesNotMatch(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
  assert.equal(flow.state.credit.montoCredito, 1_000_000);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.cajaWrites.length, 1);
});

test("si cuota y liquidación coinciden, una intención Efecty vigente permite cerrar la obligación", async () => {
  const initial = fixture({
    montoCredito: 1_000_000, saldoBaseFinanciado: 500_000,
    valorCuota: 250_000, plazoMeses: 4,
    valorInteres: 150_000, valorFianza: 350_000,
  });
  const flow = harness(initial);
  setPayoffIntent(flow);
  const result = await flow.processPayment(250_000);
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.match(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
  assert.equal(flow.state.credit.montoCredito, initial.payoff.montoCreditoLiquidado);
  assert.equal(flow.state.credit.estado, "PAZ_Y_SALVO");
  assert.ok(flow.state.credit.pazYSalvoEmitidoAt);
  assert.equal(flow.state.cajaWrites.length, 1);
  assert.equal(flow.state.intentConsumes.length, 1);
  assert.equal(flow.state.intent.consumedAt instanceof Date, true);
  assert.equal(flow.state.intentConsumes[0].id, 301);
  assert.equal((await flow.processPayment(250_000)).lines[0].action, "DUPLICADO");
  assert.equal(flow.state.intentConsumes.length, 1);
  assert.equal(flow.state.receiptWrites.length, 1);
});

test("una intención Efecty identifica un crédito entre dos con la misma referencia y cotización", async () => {
  const flow = harness();
  flow.state.candidateIds = [7, 8];
  flow.state.candidates.push({ ...clone(flow.state.credit), id: 8, folio: "TEST-EFECTY-8" });
  setPayoffIntent(flow);
  const result = await flow.processPayment();
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(result.lines[0].creditoId, 7);
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.equal(flow.state.receiptWrites[0].creditoId, 7);
  assert.equal(flow.state.intentConsumes.length, 1);
});

test("una intención vencida no convierte una cuota de igual importe en liquidación", async () => {
  const initial = fixture({
    montoCredito: 1_000_000, saldoBaseFinanciado: 500_000,
    valorCuota: 250_000, plazoMeses: 4,
    valorInteres: 150_000, valorFianza: 350_000,
  });
  const flow = harness(initial);
  setPayoffIntent(flow, { expiresAt: new Date("2026-09-27T04:00:00Z") });
  const result = await flow.processPayment(250_000);
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites.length, 1);
  assert.doesNotMatch(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
  assert.equal(flow.state.credit.montoCredito, initial.credit.montoCredito);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.intentConsumes.length, 0);
});

test("una intención vigente con cotización obsoleta exige conciliación sin aplicar el giro", async () => {
  const initial = fixture({
    montoCredito: 1_000_000, saldoBaseFinanciado: 500_000,
    valorCuota: 250_000, plazoMeses: 4,
    valorInteres: 150_000, valorFianza: 350_000,
  });
  const flow = harness(initial);
  const quote = earlyPayoffs.buildEarlyPayoffIntentMeta(initial.payoff);
  setPayoffIntent(flow, { quote: { ...quote, saldoObligacion: quote.saldoObligacion + 1 } });
  const result = await flow.processPayment(250_000);
  assert.equal(result.lines[0].action, "REVISION_REQUERIDA");
  assert.equal(flow.state.import.status, "REVISION_REQUERIDA");
  assertNoFinancialWrite(flow);
  assert.equal(flow.state.intentConsumes.length, 0);
});

test("cubrir todo el saldo contractual por Efecty cierra sin recalcularlo como descuento anticipado", async () => {
  const flow = harness();
  const balance = flow.initial.contractPlan.saldoPendiente;
  assert.notEqual(balance, flow.initial.payoff.capitalPendiente);
  const result = await flow.processPayment(balance);
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.credit.estado, "PAZ_Y_SALVO");
  assert.ok(flow.state.credit.pazYSalvoEmitidoAt);
  assert.equal(flow.state.credit.montoCredito, flow.initial.credit.montoCredito);
  assert.equal(flow.state.credit.valorInteres, flow.initial.credit.valorInteres);
  assert.equal(flow.state.credit.valorFianza, flow.initial.credit.valorFianza);
  assert.equal(flow.state.receiptWrites[0].valor, balance);
  assert.doesNotMatch(flow.state.receiptWrites[0].observacion, /Liquidacion anticipada/i);
});

test("liquidar crédito masivo conserva la auditoría y reconcilia interés, fianza y seguro", async () => {
  const marker = massComponents.calculateMassCreditComponents({
    capital: 2_800_000, cuota: 119_350, numeroCuotas: 48,
    fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03,
  });
  const snapshot = {
    origen: { tipo: "IMPORTACION_MASIVA", audit: "conservar" },
    financiero: { componentesMasivos: { ...marker, audit: "original" }, valorSeguro: marker.seguro },
  };
  const flow = harness(fixture({
    montoCredito: marker.total, saldoBaseFinanciado: marker.capital,
    valorCuota: marker.cuota, plazoMeses: marker.numeroCuotas,
    valorInteres: marker.intereses, valorFianza: marker.fianza,
    contratoSnapshot: snapshot,
  }));
  assert.equal(flow.initial.payoff.eligible, true);
  assert.ok(flow.initial.payoff.valorSeguroReconocido > 0);
  const result = await flow.processPayment();
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.credit.valorInteres, flow.initial.payoff.valorInteresReconocido);
  assert.equal(flow.state.credit.valorFianza, flow.initial.payoff.valorFianzaReconocida);
  assert.equal(flow.state.credit.contratoSnapshot.origen.audit, "conservar");
  assert.equal(flow.state.credit.contratoSnapshot.financiero.componentesMasivos.audit, "original");
  assert.equal(massComponents.getMassCreditInsurance(flow.state.credit),
    flow.initial.payoff.valorSeguroReconocido);
});

test("Efecty liquida el capital vigente del plan revisado sin reactivar cuotas eliminadas", async () => {
  const prior = [
    { id: 1, valor: 150_000, fechaAbono: new Date("2026-09-17T12:00:00Z") },
    { id: 2, valor: 300_000, fechaAbono: new Date("2026-09-20T12:00:00Z") },
  ];
  const terms = { montoCredito: 149_700 * 48, valorCuota: 149_700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2030-09-17" };
  const quote = principalPlans.createPrincipalPaymentQuote({
    plan: paymentPlans.buildCreditPaymentPlan({ ...terms, abonos: prior,
      today: PAYMENT_DAY }),
    valor: 700_000, capitalOriginal: 3_500_000, cuotaHabitual: 149_700, abonos: prior,
    conciliacion: { capitalPendiente: 3_347_264, tasaPeriodo: 0.010881,
      cuotaCredito: 94_470, fianzaCuota: 54_180, seguroCuota: 1_050,
      numeroProximaCuota: 4, fuente: "Plan original conciliado en la prueba" },
  });
  const capitalPayment = { id: 3, valor: 700_000,
    fechaAbono: new Date("2026-09-26T12:00:00Z") };
  const snapshot = principalPlans.parseCapitalPlanSnapshot({
    ...quote.planCapitalVigente,
    abonosAlCorte: [...quote.planCapitalVigente.abonosAlCorte, { id: 3, valor: 700_000 }],
  });
  const initial = fixture({
    ...terms, planCapitalVigente: snapshot, montoCredito: quote.montoCreditoActualizado,
    saldoBaseFinanciado: 3_500_000, valorInteres: 1_034_560,
    valorFianza: 2_600_640,
  }, [...prior, capitalPayment]);
  assert.equal(initial.payoff.eligible, true);
  assert.ok(initial.payoff.planRevision !== undefined);
  const flow = harness(initial);
  const originalSnapshot = clone(flow.state.credit.planCapitalVigente);
  const result = await flow.processPayment();
  assert.equal(result.lines[0].action, "APLICADO");
  assert.equal(flow.state.receiptWrites[0].valor, initial.payoff.capitalPendiente);
  assert.equal(flow.state.credit.montoCredito, initial.payoff.montoCreditoLiquidado);
  assert.deepEqual(flow.state.credit.planCapitalVigente, originalSnapshot);
  const plan = paymentPlans.buildCreditPaymentPlan({
    ...flow.state.credit, abonos: flow.state.payments, settled: true,
  });
  assert.equal(plan.saldoPendiente, 0);
  assert.ok(plan.installments.some(item => item.eliminada));
  assert.ok(plan.installments.filter(item => item.eliminada).every(item => item.valorProgramado === 0));
});

for (const delta of [-1, 1]) {
  test(`un importe distinto en ${delta} COP no se interpreta como liquidación anticipada`, async () => {
    const flow = harness();
    const result = await flow.processPayment(flow.initial.payoff.capitalPendiente + delta);
    assert.notEqual(result.lines[0].action, "ERROR");
    assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
    assert.equal(flow.state.credit.montoCredito, flow.initial.credit.montoCredito);
    assert.equal(flow.state.credit.valorInteres, flow.initial.credit.valorInteres);
    assert.equal(flow.state.credit.valorFianza, flow.initial.credit.valorFianza);
    assert.equal(flow.state.unlocks.length, 0);
  });
}

test("una cotización que dejó de estar al día no liquida bajo el bloqueo transaccional", async () => {
  const flow = harness();
  flow.state.credit.fechaPrimerPago = "2000-01-01";
  flow.state.credit.fechaProximoPago = "2000-01-01";
  flow.state.candidates[0].fechaPrimerPago = "2000-01-01";
  flow.state.candidates[0].fechaProximoPago = "2000-01-01";
  const invalidQuote = earlyPayoffs.calculateCreditEarlyPayoff({ ...flow.state.credit,
    abonos: flow.state.payments, today: PAYMENT_DAY });
  assert.equal(invalidQuote.eligible, false);
  const result = await flow.processPayment();
  assert.notEqual(result.lines[0].action, "ERROR");
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.credit.montoCredito, flow.initial.credit.montoCredito);
  assert.equal(flow.state.unlocks.length, 0);
});

test("un abono concurrente que cambia la cotización se detecta al releer el crédito bloqueado", async () => {
  const flow = harness();
  flow.state.beforeTransaction = () => {
    flow.state.payments.push({ id: 99, valor: 150_000, fechaAbono: new Date("2026-09-27T11:00:00Z") });
  };
  const result = await flow.processPayment();
  const updated = earlyPayoffs.calculateCreditEarlyPayoff({ ...flow.state.credit,
    abonos: flow.state.payments, today: PAYMENT_DAY });
  assert.notEqual(updated.capitalPendiente, flow.initial.payoff.capitalPendiente);
  assert.equal(result.lines[0].action, "REVISION_REQUERIDA");
  assert.equal(flow.state.import.status, "REVISION_REQUERIDA");
  assert.equal(flow.state.receiptWrites.length, 0);
  assert.equal(flow.state.cajaWrites.length, 0);
  assert.equal(flow.state.credit.pazYSalvoEmitidoAt, null);
  assert.equal(flow.state.credit.montoCredito, flow.initial.credit.montoCredito);
  assert.equal(flow.state.unlocks.length, 0);
});

test("un giro fechado antes de otro abono posterior se concilia, sin registrarlo como cuota ordinaria", async () => {
  const flow = harness();
  const laterPayment = { id: 99, valor: 150_000,
    fechaAbono: new Date("2026-09-28T11:00:00Z") };
  flow.state.payments.push(laterPayment);
  const quoteAtTransfer = earlyPayoffs.calculateCreditEarlyPayoff({
    ...flow.initial.credit, abonos: flow.initial.payments,
    today: new Date("2026-09-27T12:00:00Z"),
  });
  assert.equal(quoteAtTransfer.capitalPendiente, flow.initial.payoff.capitalPendiente);
  const currentQuote = earlyPayoffs.calculateCreditEarlyPayoff({
    ...flow.state.credit, abonos: flow.state.payments, today: PAYMENT_DAY,
  });
  assert.notEqual(currentQuote.capitalPendiente, quoteAtTransfer.capitalPendiente);
  const result = await flow.processPayment(quoteAtTransfer.capitalPendiente);
  assert.equal(result.lines[0].action, "REVISION_REQUERIDA");
  assert.equal(flow.state.import.status, "REVISION_REQUERIDA");
  assertNoFinancialWrite(flow);
  assert.equal(flow.state.unlocks.length, 0);
  const reread = await flow.processPayment(quoteAtTransfer.capitalPendiente);
  assert.equal(reread.lines[0].action, "REVISION_REQUERIDA");
  assert.equal(flow.state.import.status, "REVISION_REQUERIDA");
  assertNoFinancialWrite(flow);
});

test("sin crédito para la referencia Efecty no se asigna recaudo ni modifica cartera", async () => {
  const flow = harness();
  flow.state.candidateIds = [];
  flow.state.candidates = [];
  const result = await flow.processPayment();
  assert.equal(result.lines[0].action, "SIN_CREDITO");
  assertNoFinancialWrite(flow);
});

test("una referencia Efecty que coincide con varios créditos no se asigna arbitrariamente", async () => {
  const flow = harness();
  flow.state.candidateIds = [7, 8];
  flow.state.candidates.push({ ...clone(flow.state.credit), id: 8, folio: "TEST-EFECTY-8" });
  const result = await flow.processPayment();
  assert.notEqual(result.lines[0].action, "APLICADO");
  assertNoFinancialWrite(flow);
});
