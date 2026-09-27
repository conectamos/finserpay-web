import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = fileURLToPath(new URL("../output/pdf/", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { buildAllyPaymentSettlementPdf } = await jiti.import("../lib/ally-payment-settlement-pdf.ts");

function line(index, platform, percentage, overrides = {}) {
  const saleValue = 3_250_000 + index * 135_000;
  const initialPayment = 850_000 + (index % 3) * 125_000;
  const authorizedCredit = saleValue - initialPayment;
  const intermediationValue = Math.round(authorizedCredit * percentage / 100);
  return {
    creditId: 5_000 + index,
    creditDate: `2026-09-${String(10 + (index % 15)).padStart(2, "0")}`,
    allyName: "Aliado demostración FINSER",
    siteName: index % 4 === 0 ? "Sede Centro Comercial Principal" : `Sede ${index + 1}`,
    clientName: index % 5 === 0 ? `Cliente con nombre extenso de demostración ${index + 1}` : `Cliente demostración ${index + 1}`,
    clientDocument: `103245${String(8000 + index)}`,
    equipment: index % 3 === 0 ? "iPhone 17 Pro Max 256 GB edición especial" : "Equipo móvil de demostración 256 GB",
    imei: `35987654321${String(1000 + index)}`,
    platform,
    saleValue,
    initialPayment,
    authorizedCredit,
    intermediationPercentage: percentage,
    intermediationValue,
    payableValue: authorizedCredit - intermediationValue,
    status: "PAGADO",
    ...overrides,
  };
}

function settlement({ id, allyName, lines, collections = [], approval }) {
  const total = (key) => lines.reduce((sum, item) => sum + item[key], 0);
  const totalAllyCollections = collections.reduce((sum, item) => sum + item.value, 0);
  const totalPayable = total("payableValue");
  const bucket = (platform) => {
    const items = lines.filter((item) => item.platform === platform);
    const rates = new Set(items.map((item) => item.intermediationPercentage));
    return {
      creditCount: items.length,
      intermediationPercentage: rates.size === 1 ? [...rates][0] : null,
      payableValue: items.reduce((sum, item) => sum + item.payableValue, 0),
    };
  };
  return {
    settlementId: id,
    allyName,
    periodStart: "2026-09-10",
    periodEnd: "2026-09-27",
    bankApprovalNumber: approval,
    status: "PAGADA",
    paidAt: new Date("2026-09-27T18:47:00.000Z"),
    registeredBy: "Administrador central FINSER PAY",
    creditCount: lines.length,
    totalSaleValue: total("saleValue"),
    totalInitialPayment: total("initialPayment"),
    totalAuthorizedCredit: total("authorizedCredit"),
    totalIntermediation: total("intermediationValue"),
    totalPayable,
    totalAllyCollections,
    netBalance: totalPayable - totalAllyCollections,
    balanceDirection: totalPayable >= totalAllyCollections ? "PAGO_ALIADO" : "CONSIGNACION_ALIADO",
    platformSummary: { ANDROID: bucket("ANDROID"), IPHONE: bucket("IPHONE") },
    lines,
    collections,
  };
}

const singleLine = line(1, "IPHONE", 8, {
  saleValue: 4_350_000,
  initialPayment: 1_250_000,
  authorizedCredit: 3_100_000,
  intermediationValue: 248_000,
  payableValue: 2_852_000,
  clientName: "María Fernanda Demostración",
  siteName: "Sede Norte",
  equipment: "iPhone 17 Pro 256 GB",
});

const manyLines = Array.from({ length: 18 }, (_, index) =>
  line(index, index % 2 === 0 ? "IPHONE" : "ANDROID", index % 3 === 0 ? 7.5 : 10)
);
const collections = [
  {
    paymentDate: "2026-09-20T15:30:00.000Z",
    folio: "INTERNO-5100",
    numeroCreditoVisible: "000510-A",
    clientName: "Cliente recaudo uno",
    clientDocument: "1032458701",
    siteName: "Sede Centro",
    paymentMethod: "EFECTIVO",
    value: 625_000,
    status: "DESCONTADO",
  },
  {
    paymentDate: "2026-09-24T19:15:00.000Z",
    folio: "INTERNO-5101",
    numeroCreditoVisible: "000511-A",
    clientName: "Cliente recaudo dos con nombre extenso",
    clientDocument: "1032458702",
    siteName: "Sede Centro Comercial Principal",
    paymentMethod: "TRANSFERENCIA",
    value: 845_000,
    status: "DESCONTADO",
  },
];

await mkdir(outputDir, { recursive: true });
const outputs = [
  [
    "comprobante-liquidacion-aliado-un-credito.pdf",
    settlement({ id: 201, allyName: "Aliado demostración individual", lines: [singleLine], approval: "APR-DEMO-201" }),
  ],
  [
    "comprobante-liquidacion-aliado-varios-creditos.pdf",
    settlement({ id: 202, allyName: "Aliado demostración multipágina", lines: manyLines, collections, approval: "APR-DEMO-202" }),
  ],
];

for (const [name, data] of outputs) {
  await writeFile(new URL(name, `file:///${outputDir.replaceAll("\\", "/")}/`), await buildAllyPaymentSettlementPdf(data));
  console.log(name);
}
