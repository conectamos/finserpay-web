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

test("audited mixed receipt shows the documented split on A4 and POS", async () => {
  const auditedPayment = { document: "SYN-A", ordinaryInstallment: 180000,
    extraordinaryPrincipal: 330200, additionalInterest: 0, lateFee: 100 };
  for (const presentation of [undefined, { format: "POS", showFullDocument: true,
    historicalPlanNotice: "Recaudo histórico conciliado. Consulta el plan vigente para los próximos pagos.",
    operationalRows: [{ label: "Conciliado por", value: "OPERADOR DE PRUEBA" }] }]) {
    const result = await inspect({ ...ordinary, paymentAmount: 510300, totalPaidThroughPayment: 510300,
      paymentType: "AUDITED_RECONCILIATION", auditedPayment, presentation });
    for (const value of ["CUOTA Y ABONO A CAPITAL", "DISTRIBUCIÓN AUDITADA", "Cuota ordinaria", "$ 180.000",
      "Capital extraordinario", "$ 330.200", "Mora", "$ 100", "SYN-A", "$ 510.300"]) {
      assert.ok(result.text.includes(value), `Falta el dato auditado: ${value}`);
    }
    assert.doesNotMatch(result.text, /ABONO REGISTRADO|Comprobante anterior al abono a capital/);
    if (presentation) {
      assert.equal(result.pages[0].width, 226.77);
      assert.match(result.text, /Conciliado por OPERADOR DE PRUEBA/);
    }
  }
});

test("audited later receipt shows its interest and late charge without inventing capital", async () => {
  const result = await inspect({ ...ordinary, paymentAmount: 181250,
    paymentType: "AUDITED_RECONCILIATION", auditedPayment: { document: "SYN-B",
      ordinaryInstallment: 180000, extraordinaryPrincipal: 0, additionalInterest: 1200, lateFee: 50 } });
  for (const value of ["CUOTA CONCILIADA", "Cuota ordinaria", "$ 180.000", "Interés adicional", "$ 1.200",
    "Mora", "$ 50", "SYN-B"]) assert.ok(result.text.includes(value));
  assert.doesNotMatch(result.text, /Capital extraordinario|ABONO REGISTRADO/);
});

test("exact source categories override broad allocations on A4 and POS", async () => {
  const auditedPayment = { document: "SYN-C", ordinaryInstallment: 0,
    extraordinaryPrincipal: 87000, additionalInterest: 0, lateFee: 0, otherCharges: 6250,
    sourceType: "CAPITAL", sourceComponents: {
      capital: 87000, interes: 0, mora: 0, otros: 6250, seguro: 0,
    } };
  for (const presentation of [undefined, { format: "POS", showFullDocument: true }]) {
    const result = await inspect({ ...ordinary, paymentAmount: 93250,
      paymentType: "AUDITED_RECONCILIATION", auditedPayment, presentation });
    for (const value of ["ABONO A CAPITAL CONCILIADO", "DISTRIBUCIÓN AUDITADA",
      "Capital", "$ 87.000", "Otros", "$ 6.250", "SYN-C"]) {
      assert.ok(result.text.includes(value), `Falta componente documentado: ${value}`);
    }
    assert.doesNotMatch(result.text, /Capital extraordinario|Cuota ordinaria|Interés adicional/);
  }
  const plural = await inspect({ ...ordinary, paymentAmount: 93250,
    paymentType: "AUDITED_RECONCILIATION",
    auditedPayment: { ...auditedPayment, sourceType: "CUOTAS" } });
  assert.match(plural.text, /CUOTAS CONCILIADAS/);
});

test("exact source categories reject an incomplete or inconsistent source breakdown", async () => {
  const base = { document: "SYN-C", ordinaryInstallment: 0, extraordinaryPrincipal: 87000,
    additionalInterest: 0, lateFee: 0, otherCharges: 6250,
    sourceType: "CAPITAL", sourceComponents: {
      capital: 87000, interes: 0, mora: 0, otros: 6250, seguro: 0,
    } };
  for (const auditedPayment of [
    { ...base, sourceComponents: { ...base.sourceComponents, otros: 6249 } },
    { ...base, sourceComponents: { ...base.sourceComponents, seguro: undefined } },
    { ...base, sourceType: "UNKNOWN" },
    { ...base, otherCharges: 6249 },
  ]) {
    await assert.rejects(buildClientPaymentReceiptPdf({ ...ordinary, paymentAmount: 93250,
      paymentType: "AUDITED_RECONCILIATION", auditedPayment }), /desglose auditado/);
  }
});

test("audited receipt fails closed if its components do not sum to payment amount", async () => {
  for (const auditedPayment of [undefined, { document: "SYN-A", ordinaryInstallment: 180000,
    extraordinaryPrincipal: 330200, additionalInterest: 0, lateFee: 99 }]) {
    await assert.rejects(buildClientPaymentReceiptPdf({ ...ordinary, paymentAmount: 510300,
      paymentType: "AUDITED_RECONCILIATION", auditedPayment }), /desglose auditado/);
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
