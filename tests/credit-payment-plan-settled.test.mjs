import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
  },
});
const { buildCreditPaymentPlan } = await jiti.import(
  "../lib/credit-payment-plan.ts"
);
const { calculateCreditEarlyPayoff } = await jiti.import(
  "../lib/credit-early-payoff.ts"
);

test("un credito liquidado conserva el recaudo y cierra las 16 cuotas", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 1_146_110.92,
    valorCuota: 121_841,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-03-02",
    today: "2026-08-01",
    abonos: [{ valor: 300_000 }, { valor: 846_110.92 }],
    settled: true,
  });

  assert.equal(plan.estadoPago, "PAGADO");
  assert.equal(plan.paidCount, 16);
  assert.equal(plan.pendingCount, 0);
  assert.equal(plan.overdueCount, 0);
  assert.equal(plan.saldoPendiente, 0);
  assert.equal(plan.nextInstallment, null);
  assert.equal(plan.totalPaid, 1_146_110.92);
  assert.equal(plan.installments.every((item) => item.estado === "PAGO"), true);
});

test("la liquidacion recalcula cargos sin alterar el efectivo recibido", () => {
  const payoff = calculateCreditEarlyPayoff({
    saldoBaseFinanciado: 1_000_000,
    valorInteres: 349_456,
    valorFianza: 600_000,
    montoCredito: 1_949_456,
    valorCuota: 121_841,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-15",
    today: "2026-08-01",
    abonos: [{ valor: 300_000 }],
  });

  assert.equal(payoff.eligible, true);
  assert.equal(payoff.totalAbonado, 300_000);
  assert.equal(payoff.capitalPendiente, 846_110.92);
  assert.equal(payoff.montoCreditoLiquidado, 1_146_110.92);
  assert.equal(payoff.interesFianzaCondonado, 803_345.08);
  assert.equal(payoff.valorInteresReconocido, 53_777.47);
  assert.equal(payoff.valorFianzaReconocida, 92_333.45);
});

test("el PDF del plan oculta saldo contractual y conserva Efecty y el calendario", async () => {
  const { buildCreditPaymentPlanPdf, paymentPlanDateLabel } = await jiti.import("../lib/credit-payment-plan-pdf.ts");
  const plan = buildCreditPaymentPlan({ montoCredito: 1949456, valorCuota: 121841,
    plazoMeses: 16, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02",
    today: "2026-09-26", abonos: [{ valor: 300000 }] });
  const buffer = await buildCreditPaymentPlanPdf({ folio: "FC-PDF-PRUEBA", numeroCreditoVisible: "000-PDF-31",
    clienteNombre: "CLIENTE DE PRUEBA", clienteDocumento: "0000012345", sedeNombre: "SEDE DE PRUEBA",
    equipo: "EQUIPO DE PRUEBA", fechaGeneracion: new Date("2026-09-26T12:00:00Z"),
    valorCuota: 121841, frecuencia: "Quincenal", convenioEfecty: "113950",
    referenciaEfecty: "0000012345", plan });
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  let text;
  try {
    const document = await loading.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      pages.push((await (await document.getPage(number)).getTextContent()).items.map(item => item.str).join(" "));
    }
    text = pages.join(" ").replace(/\s+/g, " ");
  } finally {
    await loading.destroy();
  }
  const labels = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  assert.ok(labels.includes("VALOR"));
  assert.ok(labels.includes("ABONADO"));
  assert.ok(labels.includes("PROXIMA CUOTA"));
  assert.equal(labels.includes("SALDO CONTRACTUAL"), false);
  assert.ok(text.includes("113950"));
  assert.ok(text.includes("0000012345"));
  assert.ok(text.includes("Efecty · Convenio 113950 · Referencia 0000012345"));
  assert.ok(text.includes("Conserva este documento para consultar tus fechas de pago."));
  assert.ok(text.includes("$ 65.523"), "la proxima cuota muestra el saldo real tras el abono parcial");
  for (const item of plan.installments) {
    assert.ok(text.includes(paymentPlanDateLabel(item.fechaVencimiento)), `se conserva el vencimiento de cuota ${item.numero}`);
  }
  const routeSource = await readFile(path.join(projectRoot, "app/api/creditos/[id]/plan-pagos/route.ts"), "utf8");
  assert.ok(routeSource.includes('process.env.EFECTY_CONVENIO_FINSER_PAY || "113950"'));
  assert.ok(routeSource.includes("referenciaEfecty: credito.clienteDocumento || credito.folio"));
});