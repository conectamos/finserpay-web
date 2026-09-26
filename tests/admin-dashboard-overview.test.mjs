import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const [{ resolveCapitalOriginal }, { buildCreditPaymentPlan }, { resolveDashboardMonth },
  { resolveAllyPaymentPlatform }, { summarizeProductPortfolioHealth }, { resolveCreditPaymentSummary }] = await Promise.all([
  jiti.import("../lib/credit-capital.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/dashboard-month.ts"), jiti.import("../lib/ally-payments-core.ts"),
  jiti.import("../lib/product-portfolio-health.ts"), jiti.import("../lib/credit-factory.ts"),
]);
const dashboardSource = await readFile(path.join(projectRoot, "app/dashboard/_lib/admin-dashboard-data.ts"), "utf8");
const executableSource = stripTypeScriptTypes(dashboardSource)
  .replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace(/^export /gm, "");
const fixedNow = Date.parse("2026-09-26T17:00:00Z");
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
}

function credit(id, options = {}) {
  const { allyId = 7, siteId = 70, ...fields } = options;
  return {
    id, estado: "GENERADO", montoCredito: 1000, saldoBaseFinanciado: 800,
    valorEquipoTotal: 900, cuotaInicial: 100, valorInteres: 100, valorFianza: 100,
    valorCuota: 500, plazoMeses: 2, frecuenciaPago: "MENSUAL",
    fechaCredito: new Date("2026-09-09T15:00:00Z"), fechaPrimerPago: new Date("2026-11-02T00:00:00Z"),
    fechaProximoPago: null, pazYSalvoEmitidoAt: null,
    clienteDocumento: String(10000000 + id), clienteNombre: "Cliente " + id,
    contratoSnapshot: { equipo: { plataforma: "IPHONE" } }, equipoMarca: "IPHONE",
    sede: { id: siteId, nombre: "Sede " + siteId, aliadoId: allyId,
      aliado: { id: allyId, nombre: "Aliado " + allyId } },
    ...fields,
  };
}

function payment(id, creditoId, valor, options = {}) {
  return { id, creditoId, valor, estado: "ACTIVO", fechaAbono: new Date("2026-09-10T15:00:00Z"),
    ...options };
}

function mockDatabase(credits, payments) {
  const creditById = new Map(credits.map(item => [item.id, item]));
  const calls = [];
  const creditMatches = (item, where = {}) => {
    if (where.sede?.aliadoId != null && item.sede.aliadoId !== where.sede.aliadoId) return false;
    if (where.estado?.not != null && item.estado === where.estado.not) return false;
    if (where.estado?.notIn?.includes(item.estado)) return false;
    if (Object.hasOwn(where, "pazYSalvoEmitidoAt") && where.pazYSalvoEmitidoAt === null && item.pazYSalvoEmitidoAt) return false;
    return true;
  };
  const paymentMatches = (item, where = {}) => {
    const associatedCredit = creditById.get(item.creditoId);
    assert.ok(associatedCredit, "El fixture del abono debe tener crédito");
    if (where.sede?.aliadoId != null && associatedCredit.sede.aliadoId !== where.sede.aliadoId) return false;
    if (where.estado?.not != null && item.estado === where.estado.not) return false;
    if (where.credito && !creditMatches(associatedCredit, where.credito)) return false;
    if (where.valor?.gt != null && item.valor <= where.valor.gt) return false;
    if (where.fechaAbono?.gte && item.fechaAbono < where.fechaAbono.gte) return false;
    if (where.fechaAbono?.lt && item.fechaAbono >= where.fechaAbono.lt) return false;
    return true;
  };
  return { calls, prisma: {
    credito: { findMany: async args => {
      calls.push({ operation: "credits", ...args });
      return credits.filter(item => creditMatches(item, args.where));
    } },
    creditoAbono: {
      groupBy: async args => {
        calls.push({ operation: "paymentTotals", ...args });
        const totals = new Map();
        for (const item of payments.filter(item => paymentMatches(item, args.where))) {
          totals.set(item.creditoId, (totals.get(item.creditoId) || 0) + item.valor);
        }
        return [...totals].map(([creditoId, valor]) => ({ creditoId, _sum: { valor } }));
      },
      findMany: async args => {
        calls.push({ operation: "monthPayments", ...args });
        return payments.filter(item => paymentMatches(item, args.where));
      },
    },
  } };
}

async function overview(credits, payments = [], options = { aliadoId: 7, month: "2026-09" }) {
  const { prisma, calls } = mockDatabase(credits, payments);
  const getOverview = runInNewContext(executableSource + "\ngetAdminDashboardOverview", {
    prisma, Date: FixedDate, resolveCapitalOriginal, buildCreditPaymentPlan,
    resolveDashboardMonth, resolveAllyPaymentPlatform, summarizeProductPortfolioHealth, resolveCreditPaymentSummary,
  });
  const result = await getOverview(options);
  return { result, calls };
}

test("cuenta un crédito pagado al 100% sin paz y salvo y conserva su capital invertido", async () => {
  const { result } = await overview([credit(1)], [payment(1, 1, 300), payment(2, 1, 700)]);
  assert.equal(result.closedCredits, 1);
  assert.equal(result.totalCredits, 1);
  assert.equal(result.investedCapital, 800);
  assert.equal(result.activePlacedCapital, 0);
  assert.equal(result.activeCredits, 0);
  assert.equal(result.healthyBalance + result.earlyBalance + result.criticalBalance, 0);
});

test("un abono parcial mantiene crédito activo y el abono anulado no lo cierra", async () => {
  const { result } = await overview([credit(2)], [payment(1, 2, 400), payment(2, 2, 600, { estado: "ANULADO" })]);
  assert.equal(result.closedCredits, 0);
  assert.equal(result.totalCredits, 1);
  assert.equal(result.activeCredits, 1);
  assert.equal(result.investedCapital, 800);
  assert.equal(result.activePlacedCapital, 800);
  assert.equal(result.healthyBalance, 600);
  assert.equal(result.healthyPercent, 100);
  assert.equal(result.earlyBalance, 0);
  assert.equal(result.criticalBalance, 0);
  assert.equal(result.monthlyCollection, 400);
  assert.equal(result.monthlyPaymentCount, 1);
});

test("no presenta una obligación de monto cero como crédito cerrado al 100%", async () => {
  const { result } = await overview([credit(3, {
    montoCredito: 0, saldoBaseFinanciado: 0, valorEquipoTotal: 0, cuotaInicial: 0,
    valorInteres: 0, valorFianza: 0, valorCuota: 0,
  })]);
  assert.equal(result.closedCredits, 0);
  assert.equal(result.investedCapital, 0);
  assert.equal(result.activeCredits, 0);
});

test("conserva el cierre mediante paz y salvo cuando hubo liquidación anticipada", async () => {
  const { result } = await overview([credit(4, { montoCredito: 600, valorCuota: 300,
    pazYSalvoEmitidoAt: new Date("2026-09-15T15:00:00Z") })],
    [payment(1, 4, 600)]);
  assert.equal(result.closedCredits, 1);
  assert.equal(result.totalCredits, 1);
  assert.equal(result.investedCapital, 800);
  assert.equal(result.activeCredits, 0);
  assert.equal(result.healthyBalance, 0);
});

test("un certificado sin pago completo no cuenta como cierre y conserva salud existente", async () => {
  const { result } = await overview([credit(6, { pazYSalvoEmitidoAt: new Date("2026-09-15T15:00:00Z") })],
    [payment(1, 6, 400)]);
  assert.equal(result.closedCredits, 0);
  assert.equal(result.totalCredits, 1);
  assert.equal(result.investedCapital, 800);
  assert.equal(result.activeCredits, 0);
  assert.equal(result.healthyBalance, 0);
});

test("una cuota residual subpeso no se confunde con 100% redondeado o saldo del plan", async () => {
  const { result } = await overview([credit(7)], [payment(1, 7, 999.5)]);
  assert.equal(resolveCreditPaymentSummary({ montoCredito: 1000, totalAbonado: 999.5 }).porcentajeRecaudado, 100);
  assert.equal(result.closedCredits, 0);
  assert.equal(result.investedCapital, 800);
  // The existing plan suppresses subpeso remainders, so closure needs the
  // repayment summary rather than inferring completion from portfolio health.
  assert.equal(result.activeCredits, 0);
  const { result: centsPending } = await overview([credit(7)], [payment(1, 7, 999.99)]);
  assert.equal(centsPending.closedCredits, 0);
  const { result: fullyPaid } = await overview([credit(7)], [payment(1, 7, 1000)]);
  assert.equal(fullyPaid.closedCredits, 1);
});

test("capital histórico incluye todas las sedes del aliado y conserva filtros mensuales y salud", async () => {
  const credits = [
    credit(1), credit(2, { siteId: 71 }),
    credit(3, { siteId: 72, fechaCredito: new Date("2026-08-09T15:00:00Z") }),
    credit(4, { allyId: 8, siteId: 80, saldoBaseFinanciado: 90000 }),
    credit(5, { estado: "ANULADO", saldoBaseFinanciado: 70000 }),
    credit(6, { estado: "ANULADA", saldoBaseFinanciado: 70000 }),
    credit(7, { estado: "CANCELADO", saldoBaseFinanciado: 70000 }),
    credit(8, { estado: "CANCELADA", saldoBaseFinanciado: 70000 }),
  ];
  const payments = [payment(1, 1, 1000), payment(2, 2, 400),
    payment(3, 3, 1000, { fechaAbono: new Date("2026-08-10T15:00:00Z") }), payment(4, 4, 1000)];
  const { result, calls } = await overview(credits, payments);
  assert.equal(result.investedCapital, 2400);
  assert.equal(result.totalCredits, 3);
  assert.equal(result.closedCredits, 2);
  assert.equal(result.activeCredits, 1);
  assert.equal(result.activePlacedCapital, 800);
  assert.equal(result.healthyBalance, 600);
  assert.equal(result.monthlyCreditCount, 2);
  assert.equal(result.monthlyPlacedCapital, 1600);
  assert.equal(result.monthlyCollection, 1400);
  assert.equal(result.monthlyPaymentCount, 2);
  assert.equal(result.daily.length, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(result.creditPerformance)), [
    { name: "Sede 70", units: 1, value: 800 }, { name: "Sede 71", units: 1, value: 800 },
  ]);
  const monthCall = calls.find(item => item.operation === "monthPayments");
  assert.equal(monthCall.where.fechaAbono.gte.toISOString(), "2026-09-01T05:00:00.000Z");
  assert.equal(monthCall.where.fechaAbono.lt.toISOString(), "2026-10-01T05:00:00.000Z");
  const { result: august } = await overview(credits, payments, { aliadoId: 7, month: "2026-08" });
  assert.equal(august.investedCapital, 2400);
  assert.equal(august.closedCredits, 2);
  assert.equal(august.activePlacedCapital, 800);
  assert.equal(august.healthyBalance, 600);
  assert.equal(august.monthlyCreditCount, 1);
  assert.equal(august.monthlyPlacedCapital, 800);
  assert.equal(august.monthlyCollection, 1000);
});

test("capital invertido central conserva alcance de todos los aliados", async () => {
  const { result } = await overview([credit(1), credit(2, { allyId: 8, siteId: 80 })],
    [payment(1, 1, 1000)], { month: "2026-09" });
  assert.equal(result.investedCapital, 1600);
  assert.equal(result.totalCredits, 2);
  assert.equal(result.closedCredits, 1);
  assert.equal(result.activePlacedCapital, 800);
  assert.deepEqual(JSON.parse(JSON.stringify(result.creditPerformance)), [
    { name: "Aliado 7", units: 1, value: 800 }, { name: "Aliado 8", units: 1, value: 800 },
  ]);
});


test("los nuevos totales no sustituyen saldos de salud ni mezclan mora temprana y crítica", async () => {
  const { result } = await overview([
    credit(1),
    credit(2, { fechaPrimerPago: new Date("2026-09-17T00:00:00Z") }),
    credit(3, { fechaPrimerPago: new Date("2026-08-02T00:00:00Z") }),
  ], [payment(1, 1, 400), payment(2, 2, 400)]);
  assert.equal(result.investedCapital, 2400);
  assert.equal(result.activePlacedCapital, 2400);
  assert.equal(result.closedCredits, 0);
  assert.equal(result.healthyBalance, 600);
  assert.equal(result.earlyBalance, 600);
  assert.equal(result.criticalBalance, 1000);
  assert.equal(result.healthyBalance + result.earlyBalance + result.criticalBalance, 2200);
  assert.equal(result.productHealth.IPHONE.totalBalance, 2200);
});
