import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": fileURLToPath(new URL("../", import.meta.url)),
    "server-only": fileURLToPath(new URL("../node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
  },
});
const { buildCreditPaymentPlanPdf } = await jiti.import("../lib/credit-payment-plan-pdf.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { buildCreditPazYSalvoPdf } = await jiti.import("../lib/credit-paz-y-salvo-pdf.ts");
const { buildClientPaymentReceiptPdf } = await jiti.import("../lib/client-payment-receipt-pdf.ts");

async function pdfContent(buffer) {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      pages.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" ").replace(/\s+/g, " "));
    }
    return { pages, title: (await pdf.getMetadata()).info.Title };
  } finally { await loading.destroy(); }
}

const originalFolio = "FC-CONTRATO-31";
const visibleNumber = "000031-A";
const today = new Date("2026-09-17T15:00:00.000Z");

test("plan PDF muestra SADMIN en encabezados y conserva la referencia contractual y de recaudo", async () => {
  const input = {
    folio: originalFolio, numeroCreditoVisible: visibleNumber,
    clienteNombre: "Cliente QA", clienteDocumento: "1000031", sedeNombre: "Sede QA",
    equipo: "Equipo QA", fechaGeneracion: today, valorCuota: 100000,
    frecuencia: "Quincenal", referenciaEfecty: "REF-RECAUDO-31", convenioEfecty: "CONVENIO-QA",
    plan: buildCreditPaymentPlan({ montoCredito: 2400000, valorCuota: 100000, plazoMeses: 24,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02", abonos: [], today }),
  };
  const snapshot = structuredClone(input);
  const content = await pdfContent(await buildCreditPaymentPlanPdf(input));
  assert.ok(content.pages.length >= 2, "El plan valida también los encabezados de continuación");
  assert.ok(content.pages.every(page => page.includes(visibleNumber)));
  assert.match(content.pages[0], /Folio original: FC-CONTRATO-31/);
  assert.match(content.pages[0], /REF-RECAUDO-31/);
  assert.equal(content.title, `Plan de pagos ${visibleNumber}`);
  assert.deepEqual(input, snapshot);
});

test("paz y salvo PDF prioriza SADMIN y conserva el folio original en trazabilidad", async () => {
  const input = {
    folio: originalFolio, numeroCreditoVisible: visibleNumber,
    clienteNombre: "Cliente QA", clienteDocumento: "1000031", sedeNombre: "Sede QA",
    equipo: "Equipo QA", estado: "PAZ_Y_SALVO", issuedAt: today, issuer: "FINSER PAY",
    referenciaPago: "REF-PAGO-31", imei: "350000000000031",
  };
  const snapshot = structuredClone(input);
  const content = await pdfContent(await buildCreditPazYSalvoPdf(input));
  assert.equal(content.title, `Paz y salvo ${visibleNumber}`);
  assert.match(content.pages.join(" "), /000031-A/);
  assert.match(content.pages.join(" "), /FC-CONTRATO-31/);
  assert.match(content.pages.join(" "), /REF-PAGO-31/);
  assert.deepEqual(input, snapshot);
});

test("recibo PDF muestra SADMIN y conserva el número original del comprobante", async () => {
  const input = {
    receiptNumber: `RP-${originalFolio}-11`, creditFolio: originalFolio, numeroCreditoVisible: visibleNumber,
    paymentDate: today, paymentMethod: "EFECTIVO", paymentAmount: 100000,
    clientName: "Cliente QA", clientDocument: "1000031", totalPaidThroughPayment: 100000,
    paymentSequence: 1, paymentType: "PAYMENT", creditClosed: false,
  };
  const snapshot = structuredClone(input);
  const content = await pdfContent(await buildClientPaymentReceiptPdf(input));
  assert.match(content.pages.join(" "), /000031-A/);
  assert.match(content.pages.join(" "), /RP-FC-CONTRATO-31-11/);
  assert.deepEqual(input, snapshot);
  const legacy = await pdfContent(await buildClientPaymentReceiptPdf({ ...input, numeroCreditoVisible: undefined }));
  assert.match(legacy.pages.join(" "), /CRÉDITO FC-CONTRATO-31/);
});
