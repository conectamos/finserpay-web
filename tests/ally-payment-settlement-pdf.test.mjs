import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { buildAllyPaymentSettlementPdf } = await jiti.import("../lib/ally-payment-settlement-pdf.ts");

async function pdfText(buffer) {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      pages.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" "));
    }
    return pages.join(" ").replace(/\s+/g, " ");
  } finally { await loading.destroy(); }
}

function sampleLine(index) {
  const percentage = index % 3 === 0 ? 0 : index % 3 === 1 ? 5 : 10;
  const authorizedCredit = 2_000_000 + index * 10_000;
  const intermediationValue = Math.round(authorizedCredit * percentage) / 100;
  return {
    creditId: 1000 + index,
    creditDate: "2026-09-01",
    allyName: "JG COMPANY",
    siteName: `Sede Norte ${index + 1}`,
    clientName: `Cliente de prueba con nombre largo ${index + 1}`,
    clientDocument: `10203040${String(index).padStart(2, "0")}`,
    equipment: `IPHONE MODELO DE PRUEBA ${index + 1} 256GB`,
    imei: `35519087449${String(index).padStart(4, "0")}`,
    platform: index % 2 === 0 ? "IPHONE" : "ANDROID",
    saleValue: authorizedCredit + 800_000,
    initialPayment: 800_000,
    authorizedCredit,
    intermediationPercentage: percentage,
    intermediationValue,
    payableValue: authorizedCredit - intermediationValue,
    status: "PAGADO",
  };
}

test("genera un comprobante PDF multipagina desde el snapshot pagado", async () => {
  const lines = Array.from({ length: 18 }, (_, index) => sampleLine(index));
  const total = (key) => lines.reduce((sum, line) => sum + line[key], 0);
  const android = lines.filter((line) => line.platform === "ANDROID");
  const iphone = lines.filter((line) => line.platform === "IPHONE");
  const pdf = await buildAllyPaymentSettlementPdf({
    settlementId: 87,
    allyName: "JG COMPANY",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    bankApprovalNumber: "APR-2026-00987",
    status: "PAGADA",
    paidAt: new Date("2026-09-02T15:30:00.000Z"),
    registeredBy: "Administrador central FINSER PAY",
    creditCount: lines.length,
    totalSaleValue: total("saleValue"),
    totalInitialPayment: total("initialPayment"),
    totalAuthorizedCredit: total("authorizedCredit"),
    totalIntermediation: total("intermediationValue"),
    totalPayable: total("payableValue"),
    totalAllyCollections: 350_000,
    netBalance: total("payableValue") - 350_000,
    balanceDirection: "PAGO_ALIADO",
    platformSummary: {
      ANDROID: {
        creditCount: android.length,
        intermediationPercentage: null,
        payableValue: android.reduce((sum, line) => sum + line.payableValue, 0),
      },
      IPHONE: {
        creditCount: iphone.length,
        intermediationPercentage: null,
        payableValue: iphone.reduce((sum, line) => sum + line.payableValue, 0),
      },
    },
    lines,
    collections: [
      {
        paymentDate: "2026-09-12T15:00:00.000Z",
        folio: "CR-1001",
        numeroCreditoVisible: "000145-A",
        clientName: "Cliente recaudo",
        clientDocument: "1010202030",
        siteName: "Sede Norte",
        paymentMethod: "EFECTIVO",
        value: 350_000,
        status: "DESCONTADO",
      },
    ],
  });

  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 6_000, "El comprobante debe contener contenido sustancial");
  const pageObjects = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || [];
  assert.ok(pageObjects.length >= 2, "El fixture debe validar paginacion");
  const text = await pdfText(pdf);
  assert.match(text, /000145-A/);
  assert.doesNotMatch(text, /CR-1001/);
});
