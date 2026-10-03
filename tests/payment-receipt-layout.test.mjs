import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { buildClientPaymentReceiptPdf } = await jiti.import("../lib/client-payment-receipt-pdf.ts");
const disclaimer = "Este comprobante confirma el pago registrado. No certifica saldo pendiente ni cierre de la obligación.";
const ordinary = {
  receiptNumber: "RP-FC-QA-428-7", creditFolio: "FC-QA-428", numeroCreditoVisible: "030000428",
  paymentDate: new Date("2026-09-26T12:15:00Z"), paymentMethod: "EFECTIVO", paymentAmount: 150000,
  clientName: "CLIENTE ANÓNIMO DE PRUEBA", clientDocument: "1234567890",
  totalPaidThroughPayment: 450000, paymentSequence: 3, paymentType: "PAYMENT", creditClosed: false,
};

async function inspect(input) {
  const snapshot = structuredClone(input);
  const loading = getDocument({ data: new Uint8Array(await buildClientPaymentReceiptPdf(input)), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const bounds = page.getViewport({ scale: 1 });
      pages.push({ width: bounds.width, height: bounds.height,
        text: content.items.map((item) => item.str).join(" ").replace(/\s+/g, " "), items: content.items });
      for (const item of content.items) {
        assert.ok(item.transform[4] >= -0.5 && item.transform[4] + item.width <= bounds.width + 0.5,
          `Texto fuera del ancho del recibo: ${item.str}`);
        assert.ok(item.transform[5] >= -0.5 && item.transform[5] + item.height <= bounds.height + 0.5,
          `Texto fuera de la altura del recibo: ${item.str}`);
      }
    }
    assert.deepEqual(input, snapshot, "Descargar un recibo no modifica su resultado ni sus datos originales");
    return { pages, text: pages.map((page) => page.text).join(" ") };
  } finally { await loading.destroy(); }
}

test("ordinary client receipt is compact A4 with real reference, amount, sequence and masked identification", async () => {
  const result = await inspect(ordinary);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].width, 595.28);
  assert.equal(result.pages[0].height, 841.89);
  for (const value of ["FINSER", "PAY", "ABONO REGISTRADO", "$ 150.000", "$ 450.000", "#3",
    "RP-FC-QA-428-7", "FC-QA-428", "030000428", "26/09/2026", "07:15", "Efectivo", "Documento terminado en 7890", disclaimer]) {
    assert.ok(result.text.includes(value), `Dato real faltante en el comprobante: ${value}`);
  }
  assert.ok(!result.text.includes(ordinary.clientDocument), "El comprobante del portal protege el documento completo");
});

test("last ordinary payment remains a receipt and does not certify closure", async () => {
  const result = await inspect({ ...ordinary, creditClosed: true, settledAt: ordinary.paymentDate });
  assert.match(result.text, /ABONO REGISTRADO/);
  assert.match(result.text, /Pagado en sistema/);
  assert.ok(result.text.includes(disclaimer));
  assert.doesNotMatch(result.text, /obligación cerrada|obligacion cerrada|Paz y salvo disponible|certifica el recaudo/i);
});

test("principal receipt displays the recorded before, applied, after and eliminated values without recomputing", async () => {
  const input = { ...ordinary, paymentAmount: 700000, totalPaidThroughPayment: 1150000, paymentType: "PRINCIPAL",
    principalPayment: { capitalBefore: 3347264, capitalApplied: 700000, capitalAfter: 2647264, eliminatedInstallments: 11 } };
  const result = await inspect(input);
  for (const value of ["ABONO A CAPITAL", "$ 700.000", "Capital anterior", "$ 3.347.264", "Capital aplicado",
    "Capital pendiente", "$ 2.647.264", "Cuotas eliminadas 11", "$ 1.150.000", disclaimer]) {
    assert.ok(result.text.includes(value), `Resultado auditado faltante: ${value}`);
  }
  assert.doesNotMatch(result.text, /ABONO REGISTRADO/);
});

test("principal receipt with zero eliminated installments keeps its actual operation type", async () => {
  const result = await inspect({ ...ordinary, paymentType: "PRINCIPAL",
    principalPayment: { capitalBefore: 2000000, capitalApplied: 150000, capitalAfter: 1850000, eliminatedInstallments: 0 } });
  assert.match(result.text, /ABONO A CAPITAL/);
  assert.match(result.text, /Cuotas eliminadas 0/);
  assert.doesNotMatch(result.text, /ABONO REGISTRADO/);
});

test("principal receipts fail closed when their recorded result is missing or invalid", async () => {
  for (const principalPayment of [undefined, { capitalBefore: 2000000, capitalApplied: 150000, capitalAfter: Number.NaN, eliminatedInstallments: 0 }]) {
    await assert.rejects(buildClientPaymentReceiptPdf({ ...ordinary, paymentType: "PRINCIPAL", principalPayment }),
      /requiere el resultado registrado/);
  }
});

test("ARES mixed receipt prints its audited quota, extraordinary capital and mora on A4 and POS", async () => {
  const aresPayment = { document: "R0100001108", ordinaryInstallment: 158500,
    extraordinaryPrincipal: 241449, additionalInterest: 0, lateFee: 51 };
  for (const presentation of [undefined, { format: "POS", showFullDocument: true,
    historicalPlanNotice: "Recaudo histórico ARES conciliado en FINSER.",
    operationalRows: [{ label: "Conciliado por", value: "ADMIN DE PRUEBA" }] }]) {
    const result = await inspect({ ...ordinary, paymentAmount: 400000, totalPaidThroughPayment: 400000,
      paymentType: "ARES_RECONCILED", aresPayment, presentation });
    for (const value of ["CUOTA Y ABONO A CAPITAL", "DISTRIBUCIÓN SEGÚN ARES", "Cuota ordinaria", "$ 158.500",
      "Capital extraordinario", "$ 241.449", "Mora", "$ 51", "R0100001108", "$ 400.000"]) {
      assert.ok(result.text.includes(value), `Falta el desglose ARES: ${value}`);
    }
    assert.doesNotMatch(result.text, /ABONO REGISTRADO|Comprobante anterior al abono a capital/);
    if (presentation) {
      assert.equal(result.pages[0].width, 226.77);
      assert.match(result.text, /Recaudo histórico ARES conciliado en FINSER/);
      assert.match(result.text, /Conciliado por ADMIN DE PRUEBA/);
    }
  }
});

test("ARES second receipt identifies its additional interest and mora without inventing capital", async () => {
  const result = await inspect({ ...ordinary, paymentAmount: 160000,
    paymentType: "ARES_RECONCILED", aresPayment: { document: "R0100001393",
      ordinaryInstallment: 158500, extraordinaryPrincipal: 0, additionalInterest: 1442, lateFee: 58 } });
  for (const value of ["CUOTA Y CARGOS", "Cuota ordinaria", "$ 158.500", "Interés adicional", "$ 1.442",
    "Mora", "$ 58", "R0100001393"]) {
    assert.ok(result.text.includes(value), `Falta la distribución de la segunda cuota: ${value}`);
  }
  assert.doesNotMatch(result.text, /Capital extraordinario|ABONO REGISTRADO/);
});

test("ARES receipt fails closed if its allocation is missing or does not sum to the recorded cash", async () => {
  for (const aresPayment of [undefined, { document: "R0100001108", ordinaryInstallment: 158500,
    extraordinaryPrincipal: 241449, additionalInterest: 0, lateFee: 50 }]) {
    await assert.rejects(buildClientPaymentReceiptPdf({ ...ordinary, paymentAmount: 400000,
      paymentType: "ARES_RECONCILED", aresPayment }), /distribución auditada/);
  }
});

test("early payoff remains a distinct receipt and preserves the non-certification disclaimer", async () => {
  const result = await inspect({ ...ordinary, paymentType: "EARLY_PAYOFF", creditClosed: true });
  assert.match(result.text, /LIQUIDACIÓN ANTICIPADA/);
  assert.ok(result.text.includes(disclaimer));
  assert.doesNotMatch(result.text, /ABONO A CAPITAL|ABONO REGISTRADO|obligación cerrada/i);
});

test("POS uses the same identity and full authorized ID while wrapping long operational data without truncation", async () => {
  const clientName = "CLIENTE CON NOMBRES Y APELLIDOS COMPLETOS QUE SE CONSERVAN EN EL COMPROBANTE IMPRESO";
  const receiptNumber = "RP-FC-REFERENCIA-CONTRACTUAL-LARGA-QUE-NO-SE-DEBE-TRUNCAR-2026-428-7";
  const observation = "Observación operativa completa de prueba. El comprobante debe conservar toda esta información incluso cuando necesita varias líneas al imprimirse en un rollo de ochenta milímetros.";
  const input = { ...ordinary, clientName, receiptNumber, presentation: { format: "POS", showFullDocument: true,
    status: "ACTIVO", observation, operationalRows: [{ label: "Sede", value: "SEDE ANÓNIMA DE PRUEBA" },
      { label: "Cajero", value: "OPERADOR ANÓNIMO DE PRUEBA" }, { label: "IMEI", value: "350000000000428" }],
    upcomingInstallments: [{ number: "4/40", date: "02/10/2026", amount: 150000 }] } };
  const result = await inspect(input);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].width, 226.77);
  for (const value of [clientName, observation, ordinary.clientDocument, "ACTIVO", "SEDE ANÓNIMA DE PRUEBA", "OPERADOR ANÓNIMO DE PRUEBA", "350000000000428", "4/40", "02/10/2026", disclaimer]) {
    assert.ok(result.text.includes(value), `Dato operativo faltante: ${value}`);
  }
  assert.equal(result.text.replace(/\s+/g, "").includes(receiptNumber), true, "La referencia contractual no se acorta");
  assert.doesNotMatch(result.text, /\.\.\./);
});

test("an annulled POS receipt preserves annulment data and does not invent an active payment sequence", async () => {
  const result = await inspect({ ...ordinary, presentation: { format: "POS", showFullDocument: true,
    status: "ANULADO", hidePaymentSequence: true, annulment: { date: "2026-09-26T14:00:00Z", reason: "Registro duplicado de prueba" } } });
  assert.match(result.text, /RECIBO ANULADO/);
  assert.match(result.text, /Registro duplicado de prueba/);
  assert.doesNotMatch(result.text, /Secuencia de recaudo|#3/);
});
