import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { buildAllyPaymentSettlementPdf } = await jiti.import("../lib/ally-payment-settlement-pdf.ts");

async function pdfPagesText(buffer) {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      pages.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" "));
    }
    return pages.map(page => page.replace(/\s+/g, " "));
  } finally { await loading.destroy(); }
}

async function pdfText(buffer) {
  return (await pdfPagesText(buffer)).join(" ");
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

test("genera el comprobante horizontal de un crédito y oculta la plataforma vacía", async () => {
  const line = {
    ...sampleLine(1),
    platform: "IPHONE",
    saleValue: 4_350_000,
    initialPayment: 1_250_000,
    authorizedCredit: 3_100_000,
    intermediationPercentage: 8,
    intermediationValue: 248_000,
    payableValue: 2_852_000,
  };
  const pdf = await buildAllyPaymentSettlementPdf({
    settlementId: 104,
    allyName: "Aliado de prueba",
    periodStart: "2026-09-20",
    periodEnd: "2026-09-27",
    bankApprovalNumber: "BANCO-104",
    status: "PAGADA",
    paidAt: new Date("2026-09-27T18:45:00.000Z"),
    registeredBy: "Administración FINSER PAY",
    creditCount: 1,
    totalSaleValue: line.saleValue,
    totalInitialPayment: line.initialPayment,
    totalAuthorizedCredit: line.authorizedCredit,
    totalIntermediation: line.intermediationValue,
    totalPayable: line.payableValue,
    totalAllyCollections: 0,
    netBalance: 2_852_000,
    balanceDirection: "PAGO_ALIADO",
    platformSummary: {
      ANDROID: { creditCount: 0, intermediationPercentage: null, payableValue: 0 },
      IPHONE: { creditCount: 1, intermediationPercentage: 8, payableValue: line.payableValue },
    },
    lines: [line],
    collections: [],
  });

  const pages = await pdfPagesText(pdf);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /INNOVACIÓN FINANCIERA CON CONFIANZA/);
  assert.match(pages[0], /Total pagado al aliado/);
  assert.match(pages[0], /iPhone/);
  assert.doesNotMatch(pages[0], /Android/);
  assert.match(pages[0], /Aliado de prueba/);
  assert.match(pages[0], /Administración FINSER PAY/);
  assert.match(pages[0], /Sede Norte 2/);
  assert.match(pages[0], /2\.852\.000/);
});

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
  const pages = await pdfPagesText(pdf);
  const creditPages = pages.filter(page => /Detalle por crédito/.test(page));
  assert.ok(creditPages.length >= 2, "El detalle debe continuar en páginas adicionales");
  creditPages.forEach(page => {
    assert.match(page, /Cliente \/ cédula/);
    assert.match(page, /Comisión/);
    assert.match(page, /Estado/);
  });
  const text = await pdfText(pdf);
  assert.match(text, /000145-A/);
  assert.doesNotMatch(text, /CR-1001/);
});

test("rechaza un comprobante cuyos totales financieros no cuadran", async () => {
  const line = sampleLine(0);
  await assert.rejects(
    buildAllyPaymentSettlementPdf({
      settlementId: 999,
      allyName: "Aliado inconsistente",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-01",
      bankApprovalNumber: "ERROR-999",
      status: "PAGADA",
      paidAt: new Date("2026-09-01T15:00:00.000Z"),
      registeredBy: "Prueba",
      creditCount: 1,
      totalSaleValue: line.saleValue,
      totalInitialPayment: line.initialPayment,
      totalAuthorizedCredit: line.authorizedCredit,
      totalIntermediation: line.intermediationValue,
      totalPayable: line.payableValue,
      totalAllyCollections: 0,
      netBalance: line.payableValue + 100,
      balanceDirection: "PAGO_ALIADO",
      platformSummary: {
        ANDROID: { creditCount: 0, intermediationPercentage: null, payableValue: 0 },
        IPHONE: { creditCount: 1, intermediationPercentage: 0, payableValue: line.payableValue },
      },
      lines: [line],
      collections: [],
    }),
    /no cuadra en saldo neto/
  );
});
