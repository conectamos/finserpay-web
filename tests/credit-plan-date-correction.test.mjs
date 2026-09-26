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

async function executePlan(current, body, { abonos = [], amortized = false, role = "ADMIN" } = {}) {
  const writes = [];
  let stored = current;
  const prisma = {
    credito: {
      findUnique: async () => stored,
      update: async ({ data }) => {
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
  };
  const modules = {
    "next/server": require("next/server"),
    "@/lib/auth": { getSessionUser: async () => ({ rolNombre: role, aliadoAccesoId: 1 }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => ({ tipoPerfil: "SUPERVISOR" }) },
    "@/lib/prisma": { __esModule: true, default: prisma },
    "@/lib/credit-factory": factory,
    "@/lib/credit-payment-plan": paymentPlan,
    "@/lib/credit-factory-snapshot": snapshots,
    "@/lib/credit-import-flags": imports,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-amortization-storage": { hasCreditAmortization: async () => amortized },
    "@/lib/roles": { isAdminRole: (value) => value === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/equality-device-meta": {}, "@/lib/equality-zero-touch": {}, "@/lib/credit-lock-message": {},
  };
  const exports = {};
  vm.runInNewContext(transpiled, {
    exports, console, Date, Request, Response,
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
  return { status: response.status, data: await response.json(), writes, stored };
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

test("French amortization remains immutable even for date-only edits", async () => {
  const { status, data, writes } = await executePlan(credit(), dateOnly, { amortized: true });
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