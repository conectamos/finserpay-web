import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import ts from "typescript";

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

function savedSnapshot(lines, collections = []) {
  const total = (items, field) => items.reduce((sum, item) => sum + Math.round(item[field] * 100), 0) / 100;
  const totalPayable = total(lines, "payableValue");
  const totalAllyCollections = total(collections, "value");
  const netBalance = Math.round((totalPayable - totalAllyCollections) * 100) / 100;
  const bucket = platform => {
    const items = lines.filter(item => item.platform === platform);
    const percentages = [...new Set(items.map(item => item.intermediationPercentage))];
    return {
      creditCount: items.length,
      intermediationPercentage: percentages.length === 1 ? percentages[0] : null,
      payableValue: total(items, "payableValue"),
    };
  };
  return {
    settlementId: 901,
    allyName: "Aliado histórico QA",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    bankApprovalNumber: "0000-BANCO-QA",
    status: "PAGADA",
    paidAt: new Date("2026-10-01T04:05:00.000Z"),
    registeredBy: "Usuario histórico QA",
    creditCount: lines.length,
    totalSaleValue: total(lines, "saleValue"),
    totalInitialPayment: total(lines, "initialPayment"),
    totalAuthorizedCredit: total(lines, "authorizedCredit"),
    totalIntermediation: total(lines, "intermediationValue"),
    totalPayable,
    totalAllyCollections,
    netBalance,
    balanceDirection: netBalance < 0 ? "CONSIGNACION_ALIADO" : netBalance > 0 ? "PAGO_ALIADO" : "SIN_SALDO",
    platformSummary: { ANDROID: bucket("ANDROID"), IPHONE: bucket("IPHONE") },
    lines,
    collections,
  };
}

function fractionalSavedLine(index) {
  return {
    ...sampleLine(index),
    clientName: `Cliente histórico QA ${String(index).padStart(3, "0")}`,
    clientDocument: `00.12 3456${String(index).padStart(3, "0")}`,
    imei: `000012345678${String(index).padStart(3, "0")}`,
    saleValue: 1_000.25,
    initialPayment: 200,
    authorizedCredit: 800.25,
    intermediationPercentage: 5.125,
    intermediationValue: 41.01,
    payableValue: 759.24,
  };
}

function savedCollection(index, value = 12.34) {
  return {
    paymentDate: "2026-09-30T23:40:00.000Z",
    folio: `FOLIO-ININTERNO-${index}`,
    numeroCreditoVisible: `0000-SADMIN-${String(index).padStart(3, "0")}`,
    clientName: `Recaudo histórico QA ${String(index).padStart(3, "0")}`,
    clientDocument: `00.98 7654${String(index).padStart(3, "0")}`,
    siteName: "Sede guardada QA",
    paymentMethod: index % 2 ? "BANCOLOMBIA" : "BRE-B",
    value,
    status: "DESCONTADO",
  };
}

test("el PDF conserva centavos, tasas guardadas y todos los créditos y recaudos más allá de diez filas", async () => {
  const lines = Array.from({ length: 13 }, (_, index) => fractionalSavedLine(index));
  const collections = Array.from({ length: 17 }, (_, index) => savedCollection(index));
  const input = savedSnapshot(lines, collections);
  const before = structuredClone(input);
  const pages = await pdfPagesText(await buildAllyPaymentSettlementPdf(input));
  const text = pages.join(" ");
  const money = value => new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: 0, maximumFractionDigits: 20,
  }).format(value);

  assert.ok(pages.filter(page => /Detalle por crédito/.test(page)).length > 1);
  assert.ok(pages.filter(page => /Recaudos aplicados/.test(page)).length > 1);
  for (const line of lines) {
    assert.ok(text.includes(line.clientName), `Falta el crédito ${line.creditId}.`);
    assert.ok(text.includes(line.imei), `IMEI completo con ceros: ${line.imei}.`);
    assert.ok(text.includes(line.clientDocument.replace(/[.\s]/g, "")));
    assert.ok(!text.includes(line.clientDocument), "La cédula no conserva puntos ni espacios.");
  }
  for (const collection of collections) {
    assert.ok(text.includes(collection.clientName), `Falta el recaudo ${collection.numeroCreditoVisible}.`);
    assert.ok(text.includes(collection.numeroCreditoVisible), "Sadmin conserva sus ceros iniciales.");
    assert.ok(text.includes(collection.clientDocument.replace(/[.\s]/g, "")));
  }
  for (const amount of [1_000.25, 800.25, 41.01, 759.24, 12.34,
    input.totalIntermediation, input.totalAllyCollections, input.netBalance]) {
    assert.ok(text.includes(money(amount)), `Valor guardado sin redondear: ${money(amount)}.`);
  }
  assert.match(text, /5,125 %/);
  assert.match(text, /0000-BANCO-QA/);
  assert.match(text, /Usuario histórico QA/);
  assert.match(text, /30\/09\/2026/); // Hora Colombia: el pago fue antes de la medianoche local.
  assert.deepEqual(input, before, "Imprimir no modifica los datos históricos.");
});

test("el PDF conserva el sentido histórico de consignación del aliado y saldo cero", async t => {
  const lines = [fractionalSavedLine(0)];
  for (const scenario of [
    { value: 1_000.01, headline: /Total a consignar por el aliado/, amount: /240,77/, direction: "CONSIGNACION_ALIADO" },
    { value: 759.24, headline: /Liquidación conciliada/, amount: /Neto conciliado/, direction: "SIN_SALDO" },
  ]) {
    await t.test(scenario.direction, async () => {
      const input = savedSnapshot(lines, [savedCollection(0, scenario.value)]);
      assert.equal(input.balanceDirection, scenario.direction);
      const text = await pdfText(await buildAllyPaymentSettlementPdf(input));
      assert.match(text, scenario.headline);
      assert.match(text, scenario.amount);
      assert.doesNotMatch(text, /Total pagado al aliado/);
      assert.match(text, /0000-SADMIN-000/);
    });
  }
});

function pdfRouteFixture(snapshot, access) {
  const calls = [];
  const settlement = {
    id: snapshot.settlementId,
    aliado: { id: 7, nombre: snapshot.allyName },
    periodoInicio: snapshot.periodStart, periodoFin: snapshot.periodEnd,
    numeroAprobacionBancaria: snapshot.bankApprovalNumber,
    estado: snapshot.status, pagadoAt: snapshot.paidAt.toISOString(), registradoPorNombre: snapshot.registeredBy,
    numeroCreditos: snapshot.creditCount, totalValorVenta: snapshot.totalSaleValue,
    totalCuotaInicial: snapshot.totalInitialPayment, totalCreditoAutorizado: snapshot.totalAuthorizedCredit,
    totalIntermediacion: snapshot.totalIntermediation, totalPagar: snapshot.totalPayable,
    totalRecaudosAliado: snapshot.totalAllyCollections, saldoNeto: snapshot.netBalance,
    direccionSaldo: snapshot.balanceDirection,
    summary: Object.fromEntries(Object.entries(snapshot.platformSummary).map(([platform, bucket]) => [platform, {
      numeroCreditos: bucket.creditCount, porcentajeIntermediacion: bucket.intermediationPercentage,
      totalPagar: bucket.payableValue,
    }])),
    items: snapshot.lines.map(line => ({
      creditoId: line.creditId, fechaCredito: line.creditDate, sede: { nombre: line.siteName },
      clienteNombre: line.clientName, clienteDocumento: line.clientDocument, equipo: line.equipment,
      imei: line.imei, plataforma: line.platform, valorVenta: line.saleValue, cuotaInicial: line.initialPayment,
      creditoAutorizado: line.authorizedCredit, porcentajeIntermediacion: line.intermediationPercentage,
      valorIntermediacion: line.intermediationValue, valorPagar: line.payableValue, estado: line.status,
    })),
    recaudos: snapshot.collections.map((item, index) => ({
      creditoId: index + 1000, fechaAbono: item.paymentDate, folio: item.folio,
      clienteNombre: item.clientName, clienteDocumento: item.clientDocument, sedeNombre: item.siteName,
      metodoPago: item.paymentMethod, valor: item.value, estado: item.status,
    })),
  };
  class NextResponse extends Response {
    static json(body, init) {
      return new NextResponse(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
    }
  }
  class AllyPaymentNotFoundError extends Error {}
  class AllyPaymentValidationError extends Error {}
  const dependencies = {
    "next/server": { NextResponse },
    "@/lib/ally-payment-access": { getAllyPaymentAccess: async () => access },
    "@/lib/ally-payments": {
      AllyPaymentNotFoundError, AllyPaymentValidationError,
      getAllyPaymentDetail: async input => { calls.push(["detail", input]); return settlement; },
    },
    "@/lib/credit-display-number-server": {
      getCreditDisplayNumbers: async ids => new Map(ids.map((id, index) => [id, snapshot.collections[index].numeroCreditoVisible])),
    },
    "@/lib/ally-payment-settlement-pdf": {
      buildAllyPaymentSettlementPdf: async input => { calls.push(["pdf", input]); return buildAllyPaymentSettlementPdf(input); },
    },
  };
  const source = readFileSync(new URL("../app/api/pagos-aliados/[id]/comprobante/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, Date, URL, Uint8Array, console,
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name]; },
  });
  return { get: loadedModule.exports.GET, calls };
}

test("imprimir y descargar consultan el snapshot completo con el mismo alcance, independientemente de la página visible", async t => {
  const snapshot = savedSnapshot(
    Array.from({ length: 13 }, (_, index) => fractionalSavedLine(index)),
    Array.from({ length: 17 }, (_, index) => savedCollection(index)),
  );
  for (const [kind, allyId] of [["CENTRAL_ADMIN", null], ["ALLY_ADMIN", 7]]) {
    await t.test(kind, async () => {
      const api = pdfRouteFixture(snapshot, { ok: true, kind, allyId });
      for (const download of [false, true]) {
        const response = await api.get(new Request(`https://qa.invalid/api/pagos-aliados/901/comprobante?page=2&pageSize=10${download ? "&download=1" : ""}`), {
          params: Promise.resolve({ id: "901" }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Content-Type"), "application/pdf");
        assert.ok(response.headers.get("Content-Disposition").startsWith(download ? "attachment;" : "inline;"));
        assert.match(response.headers.get("Cache-Control"), /private, no-store/);
        const text = await pdfText(Buffer.from(await response.arrayBuffer()));
        for (const line of snapshot.lines) assert.ok(text.includes(line.imei));
        for (const collection of snapshot.collections) assert.ok(text.includes(collection.numeroCreditoVisible));
      }
      for (const [name, input] of api.calls) {
        if (name === "detail") {
          assert.equal(input.id, snapshot.settlementId);
          assert.equal(input.allyId, allyId);
        } else {
          assert.equal(input.lines.length, 13);
          assert.equal(input.collections.length, 17);
          assert.equal(input.netBalance, snapshot.netBalance);
          assert.equal(input.bankApprovalNumber, snapshot.bankApprovalNumber);
          assert.equal(input.lines[12].intermediationPercentage, snapshot.lines[12].intermediationPercentage);
        }
      }
    });
  }
});

test("el comprobante rechaza sesiones sin autorización antes de consultar el histórico o generar PDF", async () => {
  for (const status of [401, 403]) {
    const api = pdfRouteFixture(savedSnapshot([fractionalSavedLine(0)]), { ok: false, status });
    const response = await api.get(new Request("https://qa.invalid/api/pagos-aliados/901/comprobante"), {
      params: Promise.resolve({ id: "901" }),
    });
    assert.equal(response.status, status);
    assert.deepEqual(api.calls, []);
  }
});
