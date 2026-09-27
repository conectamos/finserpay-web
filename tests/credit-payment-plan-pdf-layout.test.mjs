import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { buildCreditPaymentPlanPdf, paymentPlanDateLabel } = await jiti.import("../lib/credit-payment-plan-pdf.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");
const normalize = value => String(value).replace(/\s+/g, " ").trim();
const currency = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const money = value => normalize(currency.format(Math.round(value)));
const headers = ["Cuota", "Vencimiento", "Valor", "Abonado", "Pendiente", "Estado"];

function pdfInput(plan, overrides = {}) {
  return {
    folio: "FC-CONTRATO-PLAN-QA",
    numeroCreditoVisible: "000031-A",
    clienteNombre: "CLIENTE DE PRUEBA APELLIDO COMPUESTO NOMBRE LARGO PARA VERIFICAR LA IDENTIDAD COMPLETA",
    clienteDocumento: "00123456789",
    sedeNombre: "SEDE DE PRUEBA CON NOMBRE COMERCIAL EXTENSO EN CENTRO DE DISTRIBUCION NORTE",
    equipo: "EQUIPO DE PRUEBA REFERENCIA COMPLETA MODELO PRO MAX EDICION INTERNACIONAL 512 GB GRIS",
    fechaGeneracion: new Date("2026-11-03T15:00:00.000Z"),
    valorCuota: plan.installments[0]?.valorProgramado || 0,
    frecuencia: "Quincenal",
    referenciaEfecty: "REF-PAGO-QA-00123456789",
    convenioEfecty: "113950",
    plan,
    ...overrides,
  };
}

async function readPdf(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const document = await loading.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => normalize(item.str)).map(item => ({
        text: normalize(item.str),
        x: item.transform[4],
        y: viewport.height - item.transform[5],
        width: item.width,
        height: item.height,
      }));
      pages.push({ number, width: viewport.width, height: viewport.height, items, text: normalize(items.map(item => item.text).join(" ")) });
    }
    return { pages, title: (await document.getMetadata()).info.Title };
  } finally {
    await loading.destroy();
  }
}

function rowLabel(item, plan) {
  if (item.eliminada) return "Eliminada";
  if (item.estado === "PAGO") return "Pagada";
  if (item.estaEnMora) return "En mora";
  if (item.numero === plan.nextInstallment?.numero) return "Próxima";
  return "Pendiente";
}

function tableRows(page) {
  const firstHeader = page.items.find(item => item.text === "Cuota");
  assert.ok(firstHeader, `page ${page.number} repeats the installment header`);
  const headerRow = page.items.filter(item => Math.abs(item.y - firstHeader.y) < 1.5).sort((left, right) => left.x - right.x);
  assert.deepEqual(headerRow.map(item => item.text), headers, `page ${page.number} repeats all table columns`);
  const dates = page.items.filter(item => item.y > firstHeader.y + 5 && /^\d{2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) \d{4}$/.test(item.text));
  return dates.map(date => {
    const cells = page.items.filter(item => Math.abs(item.y - date.y) < 3.1).sort((left, right) => left.x - right.x);
    return { page: page.number, cells, text: normalize(cells.map(item => item.text).join(" ")) };
  });
}

function assertCompleteLayout(content, plan) {
  const rows = content.pages.flatMap(tableRows);
  assert.equal(rows.length, plan.installments.length, "every original installment has exactly one complete row");
  for (const [index, row] of rows.entries()) {
    const installment = plan.installments[index];
    const expected = [String(installment.numero), paymentPlanDateLabel(installment.fechaVencimiento), money(installment.valorProgramado), money(installment.valorAbonado), money(installment.saldoPendiente), rowLabel(installment, plan)];
    assert.equal(row.text, expected.join(" "), `installment ${installment.numero} preserves all six values on one page`);
    assert.ok(row.cells.every(cell => cell.height >= 9.49), `installment ${installment.numero} remains legible`);
    for (let cell = 1; cell < row.cells.length; cell++) {
      assert.ok(row.cells[cell - 1].x + row.cells[cell - 1].width <= row.cells[cell].x + 1,
        `installment ${installment.numero} columns cannot overlap`);
    }
  }
  for (const page of content.pages) {
    assert.ok(Math.abs(page.width - 595.28) < 1 && Math.abs(page.height - 841.89) < 1, "the document is A4");
    assert.ok(page.items.every(item => item.x >= 0 && item.x + item.width <= page.width + 1 && item.y >= 0 && item.y <= page.height), `page ${page.number} has no text outside its bounds`);
    assert.match(page.text, new RegExp(`P[aá]gina ${page.number} de ${content.pages.length}`), "page count includes all continuation pages");
    const footer = page.items.find(item => /^P[aá]gina \d+ de \d+$/.test(item.text));
    assert.ok(footer, "a footer labels the page");
    const pageRows = rows.filter(row => row.page === page.number);
    assert.ok(pageRows.length > 0, "continuation pages are not blank");
    assert.ok(pageRows.every(row => row.cells.every(cell => cell.y + cell.height < footer.y - 8)), `page ${page.number} rows cannot collide with the footer`);
  }
  return rows;
}

function longPlan() {
  return buildCreditPaymentPlan({
    montoCredito: 1234567890 * 120,
    valorCuota: 1234567890,
    plazoMeses: 120,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-10-02",
    today: "2026-11-03",
    abonos: [{ valor: 1234567890 + 12345 }],
  });
}

function revisedPlan(settled = false) {
  const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const abonos = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
  const quote = createPrincipalPaymentQuote({ plan: buildCreditPaymentPlan({ ...terms, abonos }),
    valor: 700000, capitalOriginal: 3500000, cuotaHabitual: 149700, abonos,
    conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
      fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliacion documental anonimizada de prueba" } });
  abonos.push({ id: 3, valor: 700000 });
  const snapshot = parseCapitalPlanSnapshot({ ...quote.planCapitalVigente, abonosAlCorte: abonos });
  if (settled) abonos.push({ id: 4, valor: 2647264 });
  return buildCreditPaymentPlan({ ...terms, montoCredito: settled ? 3797264 : quote.montoCreditoActualizado,
    planCapitalVigente: snapshot, abonos, settled });
}

test("a long downloadable plan repeats its headers and renders all 120 installments completely", async () => {
  const plan = longPlan();
  const input = pdfInput(plan);
  const before = structuredClone(input);
  const content = await readPdf(await buildCreditPaymentPlanPdf(input));
  assert.ok(content.pages.length > 2, "several page breaks are exercised");
  assertCompleteLayout(content, plan);
  assert.deepEqual(input, before, "presentation cannot mutate amounts, dates or installment statuses");
});

test("PDF identity, SADMIN number and Efecty references come from the input without truncating long names", async () => {
  const input = pdfInput(longPlan());
  const content = await readPdf(await buildCreditPaymentPlanPdf(input));
  assert.equal(content.title, `Plan de pagos ${input.numeroCreditoVisible}`);
  assert.ok(content.pages.every(page => page.text.includes(input.numeroCreditoVisible)), "visible SADMIN number is present on every page");
  for (const value of [input.clienteNombre, input.clienteDocumento, input.sedeNombre, input.equipo, input.referenciaEfecty, input.convenioEfecty, input.folio]) {
    assert.ok(content.pages[0].text.includes(value), `dynamic value is complete: ${value}`);
  }
  assert.match(content.pages[0].text, /Folio original: FC-CONTRATO-PLAN-QA/);
  assert.match(content.pages[0].text, /Efecty · Convenio 113950 · Referencia REF-PAGO-QA-00123456789/);
  assert.match(content.pages[0].text, /Conserva este documento para consultar tus fechas de pago\./);
  assert.doesNotMatch(content.pages[0].text.toLowerCase(), /saldo contractual/);
});

test("the payment reference and configured agreement are independent of the displayed credit number", async () => {
  const plan = buildCreditPaymentPlan({ montoCredito: 900, valorCuota: 100, plazoMeses: 9,
    fechaPrimerPago: "2026-10-02", today: "2026-09-26", abonos: [] });
  const input = pdfInput(plan, { folio: "FC-LEGACY-REAL", numeroCreditoVisible: undefined,
    referenciaEfecty: "REF-DINAMICA-002468", convenioEfecty: "998877", clienteDocumento: "002468" });
  const content = await readPdf(await buildCreditPaymentPlanPdf(input));
  assert.equal(content.title, "Plan de pagos FC-LEGACY-REAL");
  assert.match(content.pages[0].text, /FC-LEGACY-REAL/);
  assert.match(content.pages[0].text, /REF-DINAMICA-002468/);
  assert.match(content.pages[0].text, /998877/);
  assert.doesNotMatch(content.pages[0].text, /113950|000031-A/);
  const rows = assertCompleteLayout(content, plan);
  assert.match(rows[0].text, /Próxima$/);
});

test("an overdue next installment is labeled in arrears while preserving its partial payment", async () => {
  const plan = longPlan();
  assert.equal(plan.estadoPago, "MORA");
  assert.equal(plan.nextInstallment.numero, 2);
  const content = await readPdf(await buildCreditPaymentPlanPdf(pdfInput(plan)));
  const rows = assertCompleteLayout(content, plan);
  assert.match(rows[0].text, /Pagada$/);
  assert.match(rows[1].text, /\$ 12\.345 .* En mora$/);
  assert.match(rows[2].text, /En mora$/);
  assert.match(rows[3].text, /Pendiente$/);
});

for (const settled of [false, true]) {
  test(`a ${settled ? "settled" : "current"} revised plan preserves all original rows and distinguishes eliminated installments`, async () => {
    const plan = revisedPlan(settled);
    const before = structuredClone(plan);
    const content = await readPdf(await buildCreditPaymentPlanPdf(pdfInput(plan, { valorCuota: 149700 })));
    const rows = assertCompleteLayout(content, plan);
    assert.equal(rows.length, 48);
    assert.equal(rows.filter(row => row.text.endsWith("Eliminada")).length, 11);
    assert.ok(rows.slice(37).every(row => row.text.includes("$ 0 $ 0 $ 0 Eliminada")));
    assert.equal(rows.filter(row => row.text.endsWith("Pagada")).length, settled ? 37 : 3);
    assert.equal(plan.totalPaid, settled ? 3797264 : 1150000, "PDF creation preserves actual cash even after settlement");
    if (settled) {
      assert.equal(plan.estadoPago, "PAGADO");
      assert.equal(plan.nextInstallment, null);
      assert.ok(plan.installments.every(item => item.saldoPendiente === 0));
    } else {
      assert.equal(plan.nextInstallment.numero, 4);
      assert.match(rows[3].text, /\$ 149\.700 \$ 900 \$ 148\.800 Próxima$/);
    }
    assert.deepEqual(plan, before);
  });
}
test("drawing final footers never appends pages containing only a generation note", async () => {
  const plan = buildCreditPaymentPlan({ montoCredito: 2400000, valorCuota: 100000, plazoMeses: 24,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02", today: "2026-09-26", abonos: [] });
  const input = pdfInput(plan, { clienteNombre: "CLIENTE DE PRUEBA", sedeNombre: "SEDE DE PRUEBA",
    equipo: "EQUIPO DE PRUEBA", fechaGeneracion: new Date("2026-09-26T12:00:00.000Z") });
  const content = await readPdf(await buildCreditPaymentPlanPdf(input));
  assert.ok(content.pages.length >= 2, "the fixture crosses a page boundary");
  assertCompleteLayout(content, plan);
  assert.ok(content.pages.every(page => page.text.includes("Generado 26 sep 2026")),
    "the note stays on each existing page, not a new footer-only page");
});
test("an ordinary fully paid credit displays finalization instead of treating the last paid row as the next installment", async () => {
  const plan = buildCreditPaymentPlan({ montoCredito: 1200000, valorCuota: 100000, plazoMeses: 12,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02", today: "2027-05-20",
    abonos: [{ valor: 1200000 }] });
  assert.equal(plan.estadoPago, "PAGADO");
  assert.equal(plan.nextInstallment.numero, 12, "the existing financial helper keeps its last-row fallback");
  const before = structuredClone(plan);
  const content = await readPdf(await buildCreditPaymentPlanPdf(pdfInput(plan)));
  const rows = assertCompleteLayout(content, plan);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.text.endsWith("Pagada")));
  assert.match(content.pages[0].text, /Crédito finalizado/);
  assert.match(content.pages[0].text, /Sin cuotas pendientes/);
  assert.doesNotMatch(content.pages[0].text, /Próxima cuota|Cuota vencida/);
  assert.deepEqual(plan, before, "fixing the paid presentation cannot change the calendar or actual payments");
});