import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const factory = await jiti.import("../lib/credit-factory.ts");
const paymentPlan = await jiti.import("../lib/credit-payment-plan.ts");
const snapshots = await jiti.import("../lib/credit-factory-snapshot.ts");
const imports = await jiti.import("../lib/credit-import-flags.ts");
const massComponents = await jiti.import("../lib/mass-credit-financial-components.ts");
const assignedSeller = await jiti.import("../lib/credit-assigned-seller.ts");
const french = await jiti.import("../lib/credit-amortization.ts");
const source = readFileSync(path.join(root, "app/api/creditos/[id]/command/route.ts"), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const moneyFields = [
  "valorEquipoTotal", "saldoBaseFinanciado", "montoCredito", "cuotaInicial",
  "tasaInteresEa", "valorInteres", "fianzaPorcentaje", "valorFianza", "valorCuota",
];

function credit(overrides = {}) {
  return {
    id: 1, folio: "HISTORICO-TEST", clienteDocumento: "900001", clienteNombre: "Cliente de prueba",
    fechaCredito: new Date("2026-08-25T12:00:00.000Z"),
    fechaPrimerPago: new Date("2026-09-02T12:00:00.000Z"),
    fechaProximoPago: new Date("2026-09-17T12:00:00.000Z"),
    createdAt: new Date("2026-09-25T12:00:00.000Z"), updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    estado: "GENERADO", equalityService: "IMPORTACION_MASIVA",
    plazoMeses: 36, frecuenciaPago: "QUINCENAL", cuotaInicial: 0,
    valorEquipoTotal: 1_820_000, saldoBaseFinanciado: 1_820_000,
    montoCredito: 3_592_800, valorCuota: 99_800, tasaInteresEa: 0,
    valorInteres: 1_772_800, fianzaPorcentaje: 0, valorFianza: 0,
    observacionAdmin: "Importacion historica", usuario: { id: 1, nombre: "Admin", usuario: "admin" },
    sede: { id: 1, nombre: "Sede", aliadoId: 1 },
    contratoSnapshot: {
      origen: { tipo: "IMPORTACION_MASIVA", importReceipt: { normalized: { cuota: 99_800 } } },
      cliente: { cedula: "900001" }, equipo: { referencia: "Equipo", imei: "123456789012345" },
      financiero: {
        montoCredito: 3_592_800, valorCuota: 99_800, cargosIncorporados: 1_772_800,
        plazo: 36, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-02T12:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function storedFrenchPlan({ numeroCuotas = 16, frecuenciaPago = "MENSUAL" } = {}) {
  const calculated = french.calculateFrenchAmortization({
    valorVenta: 2_500_000, cuotaInicial: 500_000, numeroCuotas,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 2.083333, seguroCuotaPorcentaje: 0.03,
    frecuenciaPago, fechaPrimerPago: "2026-09-17",
  });
  return {
    id: 30, creditoId: 1, calculoVersion: calculated.version, checksum: "signed-original-checksum",
    parametrosSnapshot: { firmado: true, tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } }, aprobadoAt: "2026-08-25T12:00:00.000Z", createdAt: "2026-08-25T12:00:00.000Z",
    frecuenciaPago: calculated.frecuenciaPago, periodosPorAnio: calculated.periodosPorAno,
    numeroCuotas: calculated.numeroCuotas, valorVenta: String(calculated.valorVenta), cuotaInicial: String(calculated.cuotaInicial),
    valorFinanciado: String(calculated.valorFinanciado), tasaInteresEaPorcentaje: String(calculated.tasaInteresEa),
    tasaPeriodo: String(calculated.tasaPeriodo), fianzaCuotaPorcentaje: String(calculated.fianzaCuotaPorcentaje),
    seguroCuotaPorcentaje: String(calculated.seguroCuotaPorcentaje), cuotaCreditoExacta: String(calculated.cuotaCredito),
    cuotaFianzaExacta: String(calculated.cuotaFianza), cuotaSeguroExacta: String(calculated.cuotaSeguro),
    cuotaTotalExacta: String(calculated.cuotaTotal), cuotaComercial: String(calculated.cuotaComercial),
    totalInteres: String(calculated.valorInteresTotal), totalFianza: String(calculated.valorFianzaTotal),
    totalSeguro: String(calculated.valorSeguroTotal), totalPagar: String(calculated.montoTotal),
    cuotas: calculated.cuotas.map((cuota, index) => ({
      ...Object.fromEntries(Object.entries(cuota).map(([key, value]) => [key, key === "numero" ? value : String(value)])),
      id: index + 1, amortizacionId: 30, createdAt: "2026-08-25T12:00:00.000Z",
    })),
  };
}

function frenchCredit(overrides = {}) {
  const plan = storedFrenchPlan();
  return credit({
    equalityService: null, plazoMeses: plan.numeroCuotas, frecuenciaPago: plan.frecuenciaPago,
    valorEquipoTotal: Number(plan.valorVenta), cuotaInicial: Number(plan.cuotaInicial),
    saldoBaseFinanciado: Number(plan.valorFinanciado), montoCredito: Number(plan.totalPagar),
    valorCuota: Number(plan.cuotaComercial), valorInteres: Number(plan.totalInteres),
    valorFianza: Number(plan.totalFianza), tasaInteresEa: Number(plan.tasaInteresEaPorcentaje),
    fianzaPorcentaje: Number(plan.fianzaCuotaPorcentaje),
    fechaPrimerPago: new Date("2026-09-17T12:00:00.000Z"),
    contratoAceptadoAt: new Date("2026-08-25T12:00:00.000Z"),
    contratoSnapshot: { financiero: { selloFinanciero: { checksum: plan.checksum } }, firma: { fechaHora: "2026-08-25" } },
    ...overrides,
  });
}

async function executePlan(current, body, {
  abonos = [], amortized = false, role = "ADMIN", central = true,
  actorId = 1, originalPlan = storedFrenchPlan(), latestPlan = null,
  auditFailure = false, updateFailure = false, lockedCredit = null, pendingPayment = null,
} = {}) {
  const writes = [];
  const audits = [];
  const trace = [];
  const legacyMathCalls = [];
  const administrativeInputs = [];
  const errors = [];
  let stored = current;
  const abonosBefore = structuredClone(abonos);
  let revision = latestPlan;
  const prisma = {
    credito: {
      findUnique: async () => {
        trace.push("load-credit");
        return stored;
      },
      update: async ({ data }) => {
        trace.push("update-credit");
        if (updateFailure) throw new Error("Simulated operational update failure");
        writes.push(data);
        stored = { ...stored, ...data };
        return stored;
      },
    },
    creditoAbono: {
      findMany: async () => abonos,
      groupBy: async () => [{
        _count: { _all: abonos.length },
        _sum: { valor: abonos.reduce((sum, item) => sum + item.valor, 0) },
        _max: { fechaAbono: abonos.at(-1)?.fechaAbono || null },
      }],
    },
    wompiPaymentIntent: { findFirst: async () => pendingPayment },
  };
  const tx = {
    ...prisma,
    $queryRawUnsafe: async (query) => {
      if (/INSERT INTO "CreditPaymentPlanRevision"/.test(query)) {
        return [{ id: audits.length + 1, createdAt: "2026-10-13T12:00:00.000Z" }];
      }
      trace.push(/FOR UPDATE/i.test(query) ? "lock-credit" : "query");
      if (lockedCredit) stored = lockedCredit;
      return [{ id: current.id }];
    },
    $executeRawUnsafe: async () => 1,
  };
  prisma.$transaction = async (callback) => {
    trace.push("begin");
    const before = stored;
    const beforeRevision = revision;
    const writeCount = writes.length;
    const auditCount = audits.length;
    try {
      const result = await callback(tx);
      trace.push("commit");
      return result;
    } catch (error) {
      stored = before;
      revision = beforeRevision;
      writes.splice(writeCount);
      audits.splice(auditCount);
      trace.push("rollback");
      throw error;
    }
  };
  const amortizationStorage = {
    hasCreditAmortization: async () => amortized,
    getCreditAmortizationByCreditId: async () => amortized ? originalPlan : null,
  };
  const revisionSource = readFileSync(path.join(root, "lib/credit-plan-revision.ts"), "utf8");
  const revisionExports = {};
  vm.runInNewContext(ts.transpileModule(revisionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports: revisionExports, console, Date, Buffer,
    require: (name) => ({
      "@/lib/prisma": { __esModule: true, default: prisma },
      "@/lib/credit-amortization": french,
      "@/lib/credit-factory": factory,
      "@/lib/credit-amortization-storage": amortizationStorage,
    })[name] || require(name),
  }, { filename: "credit-plan-revision.cjs" });
  const revisionModule = {
    ensureCreditPlanRevisionSchema: async () => {},
    createAdministrativeAmortization: (plan, options) => {
      administrativeInputs.push({ plan, options });
      return revisionExports.createAdministrativeAmortization(plan, options);
    },
    getLatestCreditPlanAmortization: async () => revision,
    insertCreditPlanRevision: async (transaction, input) => {
      assert.equal(transaction, tx, "revision and operational update must share the transaction");
      trace.push("audit");
      if (auditFailure) throw new Error("Simulated audit failure");
      const saved = await revisionExports.insertCreditPlanRevision(transaction, input);
      audits.push(input);
      revision = input.amortizationSnapshot;
      return saved;
    },
  };
  const modules = {
    "next/server": require("next/server"),
    "@/lib/auth": { getSessionUser: async () => ({ id: actorId, nombre: "Admin central", usuario: "central", rolNombre: role, aliadoAccesoId: 1, aliadoAccesoCodigo: central ? "FINSERPAY" : "OTRO" }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => ({ tipoPerfil: "SUPERVISOR" }) },
    "@/lib/prisma": { __esModule: true, default: prisma },
    "@/lib/credit-factory": { ...factory, calculateCreditCharges: (...args) => { legacyMathCalls.push(args); return factory.calculateCreditCharges(...args); } },
    "@/lib/credit-payment-plan": paymentPlan,
    "@/lib/credit-factory-snapshot": snapshots,
    "@/lib/credit-import-flags": imports,
    "@/lib/mass-credit-financial-components": massComponents,
    "@/lib/credit-assigned-seller": assignedSeller,
    "@/app/generated/prisma/client": { Prisma: { JsonNull: null, DbNull: null, PrismaClientKnownRequestError: class extends Error {} } },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-amortization-storage": amortizationStorage,
    "@/lib/credit-plan-revision": revisionModule,
    "@/lib/ally-payment-annulments": {},
    "@/lib/ally-payment-central-collection-adjustments": {},
    "@/lib/roles": { isAdminRole: (value) => value === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: (value) => value === "FINSERPAY" },
    "@/lib/equality-device-meta": {}, "@/lib/equality-zero-touch": { isEqualityApiError: () => false }, "@/lib/credit-lock-message": {},
  };
  const exports = {};
  vm.runInNewContext(transpiled, {
    exports, console: { ...console, error: (...args) => errors.push(args) }, Date, Request, Response,
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected module ${name}`);
      return modules[name];
    },
  }, { filename: "credit-command-route.cjs" });
  const response = await exports.POST(
    new Request("https://finserpay.test/api/creditos/1/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "update-plan", ...body }),
    }),
    { params: Promise.resolve({ id: "1" }) },
  );
  assert.deepEqual(abonos, abonosBefore, "read-only payment allocation must preserve registered payments");
  return { status: response.status, data: await response.json(), writes, stored, audits, trace, legacyMathCalls, administrativeInputs, revision, errors };
}

const dateOnly = { plazoMeses: 36, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17" };

test("correcting an imported first payment preserves its 99800 installment and all embedded charges", async () => {
  const before = credit();
  const { status, data, writes, stored } = await executePlan(before, dateOnly);
  assert.equal(status, 200);
  assert.equal(writes.length, 1);
  for (const field of moneyFields) {
    assert.equal(stored[field], before[field], `${field} must remain unchanged`);
    assert.equal(Object.hasOwn(writes[0], field), false, `${field} must not be written`);
  }
  assert.equal(data.item.valorCuota, 99_800);
  assert.equal(data.item.montoCredito, 3_592_800);
  assert.equal(data.item.fechaPrimerPago.slice(0, 10), "2026-09-17");
  assert.equal(data.item.fechaProximoPago.slice(0, 10), "2026-09-17");
  const expectedSnapshot = structuredClone(before.contratoSnapshot);
  expectedSnapshot.financiero.fechaPrimerPago = stored.fechaPrimerPago.toISOString();
  assert.deepEqual(JSON.parse(JSON.stringify(stored.contratoSnapshot)), expectedSnapshot);
  assert.equal(before.contratoSnapshot.financiero.fechaPrimerPago, "2026-09-02T12:00:00.000Z");
});

test("a paid 99800 installment moves the next unpaid date to October 2 without reducing the quota", async () => {
  const { status, data } = await executePlan(credit(), dateOnly, {
    abonos: [{ valor: 99_800, fechaAbono: new Date("2026-09-20T12:00:00.000Z") }],
  });
  assert.equal(status, 200);
  assert.equal(data.item.fechaPrimerPago.slice(0, 10), "2026-09-17");
  assert.equal(data.item.fechaProximoPago.slice(0, 10), "2026-10-02");
  assert.equal(data.item.valorCuota, 99_800);
  assert.equal(data.item.totalAbonado, 99_800);
  assert.equal(data.item.cuotasPagadas, 1);
  assert.equal(data.item.saldoPendiente, 3_493_000);
});

test("date-only edits preserve ordinary negotiated amounts as well", async () => {
  const before = credit({ equalityService: null, contratoSnapshot: null, tasaInteresEa: 29.24, fianzaPorcentaje: 20 });
  const { status, stored, writes } = await executePlan(before, dateOnly);
  assert.equal(status, 200);
  for (const field of moneyFields) assert.equal(stored[field], before[field]);
  assert.equal(Object.hasOwn(writes[0], "contratoSnapshot"), false);
});

for (const changes of [{ plazoMeses: 35 }, { frecuenciaPago: "MENSUAL" }]) {
  test(`unsupported imported restructuring returns 409 without any writes: ${JSON.stringify(changes)}`, async () => {
    const { status, data, writes } = await executePlan(credit(), { ...dateOnly, ...changes });
    assert.equal(status, 409);
    assert.equal(data.code, "HISTORICAL_PLAN_RESTRUCTURING_UNSUPPORTED");
    assert.equal(writes.length, 0);
  });
}

test("ordinary changed plans retain the existing rate-based financial recalculation", async () => {
  const current = credit({ equalityService: null, contratoSnapshot: null, tasaInteresEa: 29.24, fianzaPorcentaje: 20 });
  const expected = factory.calculateCreditCharges({
    saldoBaseFinanciado: current.saldoBaseFinanciado, cuotas: 24, tasaInteresEa: 29.24,
    fianzaPorcentaje: 20, frecuenciaPago: "MENSUAL",
  });
  const { status, data, writes } = await executePlan(current, { ...dateOnly, plazoMeses: 24, frecuenciaPago: "MENSUAL" });
  assert.equal(status, 200);
  assert.equal(data.item.valorCuota, expected.valorCuota);
  assert.equal(data.item.montoCredito, expected.montoCreditoTotal);
  assert.equal(data.item.valorInteres, expected.valorInteres);
  assert.equal(writes[0].valorCuota, expected.valorCuota);
});

test("an allied administrator cannot revise an approved French plan", async () => {
  const { status, data, writes } = await executePlan(credit(), dateOnly, { amortized: true, central: false });
  assert.equal(status, 409);
  assert.match(data.error, /amortizacion francesa inmutable/);
  assert.equal(writes.length, 0);
});

test("supervisors cannot change a payment plan", async () => {
  const { status, writes } = await executePlan(credit(), dateOnly, { role: "SUPERVISOR" });
  assert.equal(status, 403);
  assert.equal(writes.length, 0);
});
for (const signature of ["accepted", "seal", "snapshot-signature"]) {
  test(`legacy signed or sealed contracts keep their original snapshot: ${signature}`, async () => {
    const snapshot = structuredClone(credit().contratoSnapshot);
    const overrides = { equalityService: null, contratoSnapshot: snapshot };
    if (signature === "accepted") overrides.contratoAceptadoAt = new Date("2026-08-25T12:00:00.000Z");
    if (signature === "seal") snapshot.financiero.selloFinanciero = { snapshot: { fechaPrimerPago: "2026-09-02" } };
    if (signature === "snapshot-signature") snapshot.firma = { fechaHora: "2026-08-25T12:00:00.000Z" };
    const current = credit(overrides);
    const { status, stored, writes } = await executePlan(current, dateOnly);
    assert.equal(status, 200);
    assert.equal(Object.hasOwn(writes[0], "contratoSnapshot"), false);
    assert.equal(stored.contratoSnapshot, snapshot);
    assert.equal(stored.fechaPrimerPago.toISOString().slice(0, 10), "2026-09-17");
    assert.equal(stored.valorCuota, 99_800);
  });
}

function centralAdjustment(current, overrides = {}) {
  return {
    plazoMeses: 24, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17",
    observacionAdmin: "Corrección autorizada de calendario y plazo.",
    expectedUpdatedAt: current.updatedAt.toISOString(),
    ...overrides,
  };
}

test("central admin revises French plan from stored financial terms and records an atomic audit", async () => {
  const originalPlan = storedFrenchPlan();
  // Current profile/catalog rates must never replace the approved plan's rates.
  const before = frenchCredit({ tasaInteresEa: 80, fianzaPorcentaje: 99 });
  const snapshotBefore = structuredClone(before.contratoSnapshot);
  const planBefore = structuredClone(originalPlan);
  const body = centralAdjustment(before);
  const expected = french.calculateFrenchAmortization({
    valorVenta: 2_500_000, cuotaInicial: 500_000, numeroCuotas: 24,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 2.083333, seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17",
  });
  const result = await executePlan(before, body, { amortized: true, originalPlan });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.writes.length, 1);
  assert.equal(result.stored.plazoMeses, 24);
  assert.equal(result.stored.frecuenciaPago, "QUINCENAL");
  assert.equal(result.stored.montoCredito, Number(expected.montoTotal.toFixed(6)));
  assert.equal(result.stored.valorCuota, Number(expected.cuotaTotal.toFixed(6)));
  assert.equal(result.stored.valorInteres, Number(expected.valorInteresTotal.toFixed(6)));
  assert.equal(result.stored.valorFianza, Number(expected.valorFianzaTotal.toFixed(6)));
  assert.equal(result.legacyMathCalls.length, 0, "central revisions must not use legacy charge formulas");
  assert.equal(result.administrativeInputs.length, 1);
  assert.equal(result.administrativeInputs[0].plan, originalPlan);
  assert.deepEqual(before.contratoSnapshot, snapshotBefore);
  assert.deepEqual(originalPlan, planBefore);
  assert.equal(Object.hasOwn(result.writes[0], "contratoSnapshot"), false);
  assert.equal(Object.hasOwn(result.writes[0], "contratoAceptadoAt"), false);
  assert.equal(result.audits.length, 1);
  assert.equal(result.audits[0].creditoId, before.id);
  assert.equal(result.audits[0].usuarioId, 1);
  assert.equal(result.audits[0].motivo, body.observacionAdmin);
  assert.ok(result.audits[0].beforeSnapshot);
  assert.ok(result.audits[0].afterSnapshot);
  assert.equal(result.audits[0].amortizationSnapshot.numeroCuotas, 24);
  assert.ok(result.trace.indexOf("lock-credit") > result.trace.indexOf("begin"));
  assert.ok(result.trace.indexOf("load-credit", result.trace.indexOf("lock-credit")) > result.trace.indexOf("lock-credit"));
  assert.equal(result.trace.at(-1), "commit");
});

test("central date-only French correction preserves every agreed amount and registered payments", async () => {
  const before = frenchCredit();
  const originalPlan = storedFrenchPlan();
  const abonos = [
    { id: 1, valor: before.valorCuota, fechaAbono: new Date("2026-09-20T12:00:00.000Z") },
    { id: 2, valor: 20_000, fechaAbono: new Date("2026-10-02T12:00:00.000Z") },
  ];
  const result = await executePlan(before, centralAdjustment(before, {
    plazoMeses: before.plazoMeses, frecuenciaPago: before.frecuenciaPago,
  }), { amortized: true, originalPlan, abonos });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  for (const field of moneyFields) {
    assert.equal(result.stored[field], before[field], `${field} stays agreed`);
    assert.equal(Object.hasOwn(result.writes[0], field), false, `${field} is not rewritten`);
  }
  assert.equal(result.data.item.totalAbonado, before.valorCuota + 20_000);
  assert.equal(result.data.item.abonosCount, 2);
  assert.equal(result.stored.fechaPrimerPago.toISOString().slice(0, 10), "2026-10-17");
  assert.notEqual(result.stored.fechaProximoPago.toISOString().slice(0, 10), "2026-10-17", "paid installments remain allocated");
  for (const field of ["totalPagar", "totalInteres", "totalFianza", "totalSeguro", "cuotaComercial"]) {
    assert.equal(result.audits[0].amortizationSnapshot[field], originalPlan[field]);
  }
});

test("a second central revision is based on the latest approved administrative schedule", async () => {
  const originalPlan = storedFrenchPlan();
  const latestPlan = storedFrenchPlan({ numeroCuotas: 20, frecuenciaPago: "QUINCENAL" });
  const before = frenchCredit({ plazoMeses: 20, frecuenciaPago: "QUINCENAL" });
  const result = await executePlan(before, centralAdjustment(before), { amortized: true, originalPlan, latestPlan });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.administrativeInputs[0].plan, latestPlan);
});

for (const invalid of [
  { plazoMeses: 0 }, { plazoMeses: 61 }, { plazoMeses: 16.5 }, { plazoMeses: "abc" },
  { plazoMeses: true }, { plazoMeses: "0x10" },
  { frecuenciaPago: "DIARIA" }, { frecuenciaPago: "" },
  { fechaPrimerPago: "2026-02-30" }, { fechaPrimerPago: "17/10/2026" }, { fechaPrimerPago: "" },
  { observacionAdmin: "" }, { observacionAdmin: "corto" }, { observacionAdmin: "x".repeat(1001) },
]) {
  test(`central French adjustment rejects invalid input without writes: ${JSON.stringify(invalid).slice(0, 100)}`, async () => {
    const before = frenchCredit();
    const result = await executePlan(before, centralAdjustment(before, invalid), { amortized: true });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.equal(result.writes.length, 0);
    assert.equal(result.audits.length, 0);
  });
}

for (const expectedUpdatedAt of [undefined, "invalid", "2026-09-24T12:00:00.000Z"]) {
  test(`missing or stale revision token cannot change a French plan: ${expectedUpdatedAt}`, async () => {
    const before = frenchCredit();
    const result = await executePlan(before, centralAdjustment(before, { expectedUpdatedAt }), { amortized: true });
    assert.ok([400, 409].includes(result.status), JSON.stringify(result.data));
    assert.equal(result.writes.length, 0);
    assert.equal(result.audits.length, 0);
  });
}

test("server rechecks concurrent changes after acquiring the credit lock", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), {
    amortized: true,
    lockedCredit: { ...before, updatedAt: new Date("2026-10-13T12:00:00.000Z") },
  });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.ok(result.trace.includes("lock-credit"));
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
});

test("central revision requires an identifiable authenticated actor", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), { amortized: true, actorId: null });
  assert.ok([400, 403].includes(result.status), JSON.stringify(result.data));
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
});

for (const protectedState of [
  { planCapitalVigente: { version: 1 } },
  { pazYSalvoEmitidoAt: new Date("2026-10-10T12:00:00.000Z") },
  { estado: "ANULADO" },
]) {
  test(`central authority preserves settled, annulled and principal-payment protections: ${Object.keys(protectedState)[0]}`, async () => {
    const before = frenchCredit(protectedState);
    const result = await executePlan(before, centralAdjustment(before), { amortized: true });
    assert.ok([400, 409].includes(result.status), JSON.stringify(result.data));
    assert.equal(result.writes.length, 0);
    assert.equal(result.audits.length, 0);
  });
}

test("audit persistence failure rolls back the operational French plan adjustment", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), { amortized: true, auditFailure: true });
  assert.equal(result.status, 500);
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
  assert.equal(result.stored, before);
  assert.ok(result.trace.includes("rollback"));
  assert.equal(result.trace.includes("commit"), false);
});

test("failed credit update rolls back the revision that was inserted earlier in the transaction", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), { amortized: true, updateFailure: true });
  assert.equal(result.status, 500);
  assert.ok(result.trace.indexOf("update-credit") > result.trace.indexOf("audit"));
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0, "the audit insert is rolled back together with the failed update");
  assert.equal(result.revision, null);
  assert.equal(result.stored, before);
  assert.ok(result.trace.includes("rollback"));
});

test("central adjustment refuses an already paid credit", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), {
    amortized: true, abonos: [{ valor: 10_000_000, fechaAbono: new Date("2026-10-10T12:00:00.000Z") }],
  });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.match(result.data.error, /ya está pagado/i);
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
});

test("central adjustment refuses a reduced plan below payments even when the current plan still has a balance", async () => {
  const before = frenchCredit({ montoCredito: 9_000_000 });
  const result = await executePlan(before, centralAdjustment(before), {
    amortized: true, abonos: [{ valor: 8_000_000, fechaAbono: new Date("2026-10-10T12:00:00.000Z") }],
  });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.match(result.data.error, /saldo pendiente/i);
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
});

test("a pending electronic payment blocks central administrative changes", async () => {
  const before = frenchCredit();
  const result = await executePlan(before, centralAdjustment(before), {
    amortized: true, pendingPayment: { id: 80 },
  });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.match(result.data.error, /pago electrónico pendiente/i);
  assert.equal(result.writes.length, 0);
  assert.equal(result.audits.length, 0);
});

for (const protectedState of [
  { planCapitalVigente: { version: 1 } },
  { pazYSalvoEmitidoAt: new Date("2026-10-10T12:00:00.000Z") },
  { estado: "ANULADO" },
]) {
  test(`a concurrent protected state is rechecked under the lock: ${Object.keys(protectedState)[0]}`, async () => {
    const before = frenchCredit();
    const result = await executePlan(before, centralAdjustment(before), {
      amortized: true, lockedCredit: { ...before, ...protectedState },
    });
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(result.trace.includes("lock-credit"));
    assert.equal(result.writes.length, 0);
    assert.equal(result.audits.length, 0);
  });
}

test("central administration can revise an allied credit while another ally remains scoped out", async () => {
  const before = frenchCredit({ sede: { id: 9, aliadoId: 99, nombre: "Sede de otro aliado" } });
  const allowed = await executePlan(before, centralAdjustment(before), { amortized: true });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.equal(allowed.audits.length, 1);
  const denied = await executePlan(before, centralAdjustment(before), { amortized: true, central: false });
  assert.equal(denied.status, 404);
  assert.equal(denied.writes.length, 0);
  assert.equal(denied.audits.length, 0);
});
