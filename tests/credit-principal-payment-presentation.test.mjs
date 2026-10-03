import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import { ARES_20261003_RECEIPTS, buildAres20261003Snapshot } from "../scripts/lib/ares-20261003-reconciliation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const core = await jiti.import("../lib/credit-principal-payment.ts");
const plans = await jiti.import("../lib/credit-payment-plan.ts");
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");
const { buildCreditPaymentPlanPdf } = await jiti.import("../lib/credit-payment-plan-pdf.ts");
const { buildClientPaymentReceiptPdf } = await jiti.import("../lib/client-payment-receipt-pdf.ts");
const aresReceipts = await jiti.import("../lib/ares-reconciliation-receipt.ts");

function fixture() {
  const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const payments = [{ id: 1, valor: 150000, fechaAbono: new Date("2026-09-16T12:00:00Z") },
    { id: 2, valor: 300000, fechaAbono: new Date("2026-09-26T12:00:00Z") }];
  const quote = core.createPrincipalPaymentQuote({ plan: plans.buildCreditPaymentPlan({ ...terms, abonos: payments }),
    valor: 700000, capitalOriginal: 3500000, cuotaHabitual: 149700, abonos: payments,
    conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
      fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliacion de prueba sin datos personales" } });
  payments.push({ id: 3, valor: 700000, fechaAbono: new Date("2026-09-26T12:01:00Z") });
  const snapshot = core.parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
    abonosAlCorte: payments.map(({ id, valor }) => ({ id, valor })) });
  const plan = plans.buildCreditPaymentPlan({ ...terms, montoCredito: quote.montoCreditoActualizado,
    planCapitalVigente: snapshot, abonos: payments });
  return { terms, payments, quote, snapshot, plan };
}

function checkPdf(buffer, name) {
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  if (process.env.CAPITAL_PDF_QA_DIR) {
    fs.mkdirSync(process.env.CAPITAL_PDF_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CAPITAL_PDF_QA_DIR, `${name}.pdf`), buffer);
  }
}

test("revised portfolio uses exact pending components, not a proportional principal estimate", () => {
  const f = fixture();
  const result = splitOutstandingBalance({ montoCredito: f.quote.montoCreditoActualizado,
    saldoBaseFinanciado: 3500000, saldoPendiente: f.plan.saldoPendiente, valorEquipoTotal: 4500000,
    cuotaInicial: 1000000, valorFianza: 2600640, valorInteres: 1000000,
    planCapitalVigente: f.snapshot, totalAbonado: 1150000 });
  assert.equal(result.saldoCapital, 2647264);
  assert.equal(result.saldoSeguro, 34 * 1050);
  assert.equal(Object.values(result).reduce((sum, value) => sum + value, 0), f.plan.saldoPendiente);
});

test("client counts and PDF labels distinguish eliminated installments from paid ones", () => {
  const sources = ["app/clientes/page.tsx", "app/clientes/client-credit-panel.tsx", "app/clientes/paid-credit-dashboard.tsx"];
  for (const file of sources) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /filter\(\(item\) => !item\.eliminada\)/);
  }
  assert.match(fs.readFileSync(path.join(root, "lib/credit-payment-plan-pdf.ts"), "utf8"), /if \(item\.eliminada\) return "Eliminada"/);
  const route = fs.readFileSync(path.join(root, "app/api/creditos/[id]/abonos/route.ts"), "utf8");
  assert.match(route, /abonos: \[\{ valor: plan\?\.totalPaid \?\? summary\.totalAbonado \}\]/);
  assert.doesNotMatch(route, /abonos: activePaymentItems\.map/);
});

test("renders the reduced plan with original numbering and zero eliminated rows", async () => {
  const f = fixture();
  const buffer = await buildCreditPaymentPlanPdf({ folio: "QA-CAPITAL", clienteNombre: "CLIENTE DE PRUEBA",
    clienteDocumento: "0000000000", sedeNombre: "SEDE DE PRUEBA", equipo: "EQUIPO DE PRUEBA",
    fechaGeneracion: new Date("2026-09-26T12:00:00Z"), valorCuota: 149700, frecuencia: "Quincenal",
    referenciaEfecty: "0000000000", convenioEfecty: "PRUEBA", plan: f.plan });
  checkPdf(buffer, "capital-plan");
});

test("renders client capital receipt with the immutable breakdown", async () => {
  const buffer = await buildClientPaymentReceiptPdf({ receiptNumber: "RP-QA-3", paymentDate: new Date("2026-09-26T12:01:00Z"),
    paymentMethod: "EFECTIVO", paymentAmount: 700000, clientName: "CLIENTE DE PRUEBA", clientDocument: "0000000000",
    creditFolio: "QA-CAPITAL", totalPaidThroughPayment: 1150000, paymentSequence: 3, paymentType: "PRINCIPAL",
    creditClosed: false, principalPayment: { capitalBefore: 3347264, capitalApplied: 700000, capitalAfter: 2647264,
      eliminatedInstallments: 11 } });
  checkPdf(buffer, "capital-client-receipt");
});

async function adminReceipt(paymentId, laterRevision = false, ares = false) {
  const f = ares ? {
    terms: { montoCredito: 2461700, valorCuota: 158500, plazoMeses: 17,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17" },
    payments: [
      { id: 101, valor: 160000, fechaAbono: new Date("2026-10-03T12:00:00Z") },
      { id: 202, valor: 400000, fechaAbono: new Date("2026-09-18T12:00:00Z") },
    ],
    snapshot: buildAres20261003Snapshot([
      { id: 101, valor: 160000 }, { id: 202, valor: 400000 },
    ]),
    quote: null,
  } : fixture();
  let planCalls = 0;
  const revisionsRead = [];
  let latestSnapshot = f.snapshot;
  if (laterRevision) {
    f.payments.push({ id: 4, valor: 149700, fechaAbono: new Date("2026-11-02T12:00:00Z") });
    const quote = core.createPrincipalPaymentQuote({
      plan: plans.buildCreditPaymentPlan({ ...f.terms, planCapitalVigente: f.snapshot, abonos: f.payments }),
      planCapitalVigente: f.snapshot, valor: 100000, capitalOriginal: 3500000,
      cuotaHabitual: 149700, abonos: f.payments,
    });
    f.payments.push({ id: 5, valor: 100000, fechaAbono: new Date("2026-11-02T12:01:00Z") });
    latestSnapshot = core.parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
      abonosAlCorte: f.payments.map(({ id, valor }) => ({ id, valor })) });
  }
  const credit = { ...f.terms, planCapitalVigente: latestSnapshot,
    montoCredito: ares ? 2461700 : f.quote.montoCreditoActualizado,
    id: ares ? 386 : 7, folio: ares ? "FC-ARES-QA" : "QA-CAPITAL",
    clienteNombre: "CLIENTE DE PRUEBA", clienteDocumento: "0000000000",
    clienteTelefono: "0000000000", referenciaEquipo: "EQUIPO DE PRUEBA", imei: "000000000000000",
    pazYSalvoEmitidoAt: null, sede: { nombre: "SEDE DE PRUEBA" } };
  const payment = { ...f.payments.find((item) => item.id === paymentId), creditoId: credit.id, credito: credit,
    metodoPago: "EFECTIVO", estado: "ACTIVO", observacion: "Pago de prueba", sede: credit.sede,
    usuario: { nombre: "CAJERO DE PRUEBA", usuario: "prueba" }, vendedor: null };
  const prisma = { creditoAbono: { findFirst: async () => payment, findMany: async () => f.payments },
    $queryRaw: async () => !ares && paymentId >= 3
      ? [{ abonoId: 3, snapshotAfter: f.snapshot, resultado: { quote: f.quote } }] : [] };
  const aresAudit = ares ? { abonoId: 202, snapshotAfter: f.snapshot,
    allocations: { receipts: ARES_20261003_RECEIPTS } } : null;
  const imports = {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getSessionUser: async () => ({ rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map() },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-factory": { getPaymentFrequencyLabel: () => "Quincenal" },
    "@/lib/client-payment-receipt-pdf": { buildClientPaymentReceiptPdf },
    "@/lib/ares-reconciliation-receipt": {
      readAresReconciledReceipt: async (_db, creditId, id, amount) => ares
        ? (assert.equal(creditId, 386), aresReceipts.parseAresReconciledReceipt(aresAudit, id, amount))
        : null,
      aresReceiptPlanView: aresReceipts.aresReceiptPlanView,
    },
    "@/lib/credit-principal-payment": core,
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: (input) => {
      planCalls++;
      revisionsRead.push(input.planCapitalVigente?.revision);
      return plans.buildCreditPaymentPlan(input);
    } },
    "@/lib/credit-route-lookup": { buildCreditAccessWhere: () => ({}), buildCreditLookupWhere: () => ({ id: credit.id }), parseCreditRouteLookup: () => ({ id: credit.id }) },
    "@/lib/colombia-date": { COLOMBIA_TIME_ZONE: "America/Bogota" },
    "node:path": { default: path },
    pdfkit: { default: require("pdfkit") },
  };
  const source = fs.readFileSync(path.join(root, "app/api/creditos/[id]/abonos/[abonoId]/recibo/route.ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(`${code}\nmodule.exports.dateLabelForTest = dateLabel;`, { module: mod, exports: mod.exports,
    require: (name) => name in imports ? imports[name] : require(name), console, process, Buffer, Date, Number, String, Uint8Array });
  const response = await mod.exports.GET(new Request("https://example.test"), { params: Promise.resolve({ id: String(credit.id), abonoId: String(paymentId) }) });
  assert.equal(response.status, 200);
  assert.equal(mod.exports.dateLabelForTest("2026-11-02"), "02/11/2026");
  return { buffer: Buffer.from(await response.arrayBuffer()), planCalls, revisionsRead };
}

test("capital POS receipt uses its recorded revision and exact before/after balance", async () => {
  const result = await adminReceipt(3);
  assert.equal(result.planCalls, 1);
  checkPdf(result.buffer, "capital-pos-receipt");
});

test("historical POS receipt does not replay the later principal cut", async () => {
  const result = await adminReceipt(2);
  assert.equal(result.planCalls, 0);
  checkPdf(result.buffer, "capital-historical-pos-receipt");
});

test("ordinary receipt between two revisions uses the revision active at its payment", async () => {
  const result = await adminReceipt(4, true);
  assert.equal(result.planCalls, 1);
  assert.deepEqual(result.revisionsRead, [1]);
  assert.ok(result.buffer.length > 1000);
});

test("ARES POS receipt for 400000 does not replay the later 03/10 capital snapshot", async () => {
  const result = await adminReceipt(202, false, true);
  assert.equal(result.planCalls, 0);
  checkPdf(result.buffer, "ares-mixed-pos-receipt");
});

test("ARES POS receipt for 160000 displays the documented post-03/10 plan", async () => {
  const result = await adminReceipt(101, false, true);
  assert.equal(result.planCalls, 1);
  assert.deepEqual(result.revisionsRead, [1]);
  checkPdf(result.buffer, "ares-ordinary-pos-receipt");
});
