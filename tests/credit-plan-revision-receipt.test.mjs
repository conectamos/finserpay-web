import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { getPaymentFrequencyLabel } = await jiti.import("../lib/credit-factory.ts");
const source = readFileSync(new URL("../app/api/creditos/[id]/abonos/[abonoId]/recibo/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const originalTerms = {
  montoCredito: 400_000, valorCuota: 100_000, plazoMeses: 4, frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2026-10-02", fechaProximoPago: "2026-10-17",
  valorInteres: 0, valorFianza: 0, tasaInteresEa: 0,
};
const revisionAt = new Date("2026-10-03T12:00:00Z");

function receiptFixture({ registeredAt = "2026-10-02T12:00:00Z", paymentAt = "2026-10-02T12:00:00Z",
  missing = false, anonymous = false, corrupt = false,
  historicalNextDue = originalTerms.fechaProximoPago } = {}) {
  const historyReads = [], pdfInputs = [], planInputs = [], scopedReads = [];
  const credit = {
    id: 17, folio: "0000017", clienteNombre: "CLIENTE SINTÉTICO", clienteDocumento: "0012345678",
    clienteTelefono: "03000000000", imei: "000000000000017", referenciaEquipo: "Equipo sintético",
    montoCredito: 640_000, valorCuota: 80_000, plazoMeses: 8, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: new Date("2026-11-17T12:00:00Z"), fechaProximoPago: new Date("2026-12-17T12:00:00Z"),
    pazYSalvoEmitidoAt: null, planCapitalVigente: null,
    sede: { nombre: "Sede sintética" },
  };
  const payment = {
    id: 7, creditoId: 17, credito: credit, valor: 100_000,
    fechaAbono: new Date(paymentAt), createdAt: new Date(registeredAt), metodoPago: "EFECTIVO",
    estado: "ACTIVO", observacion: "Prueba sin datos reales", vendedor: null,
    usuario: { nombre: "Usuario de prueba", usuario: "qa" }, sede: credit.sede,
  };
  const recordsBefore = structuredClone({ credit, payment });
  const prisma = {
    creditoAbono: {
      findFirst: async query => { scopedReads.push(query); return missing ? null : payment; },
      findMany: async () => [payment],
    },
  };
  const modules = {
    "next/server": { NextResponse: Response },
    "@/lib/client-payment-receipt-pdf": { buildClientPaymentReceiptPdf: async input => { pdfInputs.push(input); return Buffer.from("%PDF-1.7\nmock"); } },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map([[17, "000000017"]]) },
    "@/lib/auth": { getSessionUser: async () => anonymous ? null : ({ rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: input => {
      planInputs.push(input);
      return buildCreditPaymentPlan({ ...input, today: "2026-10-13" });
    } },
    "@/lib/credit-principal-payment": { parseCapitalPlanSnapshot: () => null },
    "@/lib/credit-audit-receipt": { auditedReceiptPlanView: () => null, readAuditedReceiptAllocation: async () => null },
    "@/lib/credit-factory": { getPaymentFrequencyLabel },
    "@/lib/prisma": { default: prisma },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-route-lookup": {
      buildCreditAccessWhere: () => ({ sede: { aliadoId: 1 } }),
      buildCreditLookupWhere: () => ({ id: 17 }),
      parseCreditRouteLookup: () => ({ id: 17 }),
    },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/colombia-date": { COLOMBIA_TIME_ZONE: "America/Bogota" },
    "@/lib/credit-plan-revision": {
      getCreditPlanTermsAtDate: async (creditId, at) => {
        historyReads.push({ creditId, at });
        if (corrupt) throw new Error("Corrupt historical revision");
        return at < revisionAt ? { ...structuredClone(originalTerms), fechaProximoPago: historicalNextDue } : null;
      },
    },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module ${name}`);
    return modules[name];
  }, console: { error() {} }, Date, Number, String, Uint8Array });
  return {
    historyReads, pdfInputs, planInputs, scopedReads, credit, payment, recordsBefore,
    get: () => exports.GET(new Request("https://example.test/api/creditos/17/abonos/7/recibo"), {
      params: Promise.resolve({ id: "17", abonoId: "7" }),
    }),
  };
}

test("a receipt registered before the administrative revision retains its old quota, frequency and calendar", async () => {
  const f = receiptFixture();
  assert.equal((await f.get()).status, 200);
  assert.equal(f.historyReads[0].creditId, 17);
  assert.equal(f.historyReads[0].at.toISOString(), "2026-10-02T12:00:00.000Z");
  assert.equal(f.scopedReads[0].where.id, 7);
  assert.equal(f.scopedReads[0].where.credito.AND[0].id, 17);
  assert.equal(f.planInputs[0].montoCredito, 400_000);
  assert.equal(f.planInputs[0].valorCuota, 100_000);
  assert.equal(f.planInputs[0].plazoMeses, 4);
  const receipt = f.pdfInputs[0];
  assert.equal(receipt.presentation.operationalRows.find(row => row.label === "Frecuencia").value, "Quincenal");
  assert.equal(receipt.presentation.operationalRows.find(row => row.label === "Cuotas pagadas").value, "1 DE 4");
  assert.equal(receipt.presentation.upcomingInstallments[0].number, "2/4");
  assert.equal(receipt.presentation.upcomingInstallments[0].date, "17/10/2026");
  assert.equal(receipt.presentation.upcomingInstallments[0].amount, 100_000);
  assert.equal(receipt.presentation.upcomingInstallments.reduce((sum, row) => sum + row.amount, 0), 300_000);
  assert.equal(receipt.paymentAmount, 100_000);
  assert.equal(receipt.totalPaidThroughPayment, 100_000);
  assert.equal(receipt.clientDocument, "0012345678");
  assert.equal(receipt.numeroCreditoVisible, "000000017");
  assert.deepEqual(f.credit, f.recordsBefore.credit);
  assert.deepEqual(f.payment, f.recordsBefore.payment);
});

test("a receipt registered after the revision keeps current terms even when its payment date was backdated", async () => {
  const f = receiptFixture({ registeredAt: "2026-10-04T12:00:00Z", paymentAt: "2026-10-02T12:00:00Z" });
  assert.equal((await f.get()).status, 200);
  assert.equal(f.historyReads[0].at.toISOString(), "2026-10-04T12:00:00.000Z");
  assert.equal(f.planInputs[0].montoCredito, 640_000);
  assert.equal(f.planInputs[0].valorCuota, 80_000);
  const receipt = f.pdfInputs[0];
  assert.equal(receipt.presentation.operationalRows.find(row => row.label === "Frecuencia").value, "Mensual");
  assert.equal(receipt.presentation.operationalRows.find(row => row.label === "Cuotas pagadas").value, "1 DE 8");
  assert.equal(receipt.presentation.upcomingInstallments[0].number, "2/8");
  assert.equal(receipt.presentation.upcomingInstallments[0].date, "17/12/2026");
  assert.equal(receipt.presentation.upcomingInstallments[0].amount, 60_000);
  assert.equal(receipt.paymentAmount, 100_000);
  assert.equal(receipt.paymentDate.toISOString(), "2026-10-02T12:00:00.000Z");
});

test("a later next-due override at the revision cut cannot shift the old receipt's calendar", async () => {
  const f = receiptFixture({ historicalNextDue: "2026-11-17" });
  assert.equal((await f.get()).status, 200);
  assert.equal(f.planInputs[0].fechaProximoPago, null);
  assert.equal(f.planInputs[0].fechaPrimerPago.toISOString().slice(0, 10), "2026-10-02");
  const upcoming = f.pdfInputs[0].presentation.upcomingInstallments;
  assert.equal(upcoming[0].number, "2/4");
  assert.equal(upcoming[0].date, "17/10/2026");
  assert.equal(upcoming[0].amount, 100_000);
  assert.equal(upcoming.reduce((sum, row) => sum + row.amount, 0), 300_000);
});

test("missing scoped receipts and anonymous users never read plan revision history", async () => {
  for (const [options, expected] of [[{ missing: true }, 404], [{ anonymous: true }, 401]]) {
    const f = receiptFixture(options);
    assert.equal((await f.get()).status, expected);
    assert.equal(f.historyReads.length, 0);
    assert.equal(f.pdfInputs.length, 0);
  }
});

test("an invalid historical revision cannot silently print the new operative plan", async () => {
  const f = receiptFixture({ corrupt: true });
  assert.equal((await f.get()).status, 500);
  assert.equal(f.pdfInputs.length, 0);
  assert.equal(f.planInputs.length, 0);
  assert.deepEqual(f.credit, f.recordsBefore.credit);
});
