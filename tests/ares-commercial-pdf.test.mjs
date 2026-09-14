import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const folio = await jiti.import("../lib/firmaseguro-folio-pdf.ts");
const legacy = await jiti.import("../lib/firmaseguro-credit-pdf.ts");
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");

const plan = calculateFrenchAmortization({
  calculoVersion: "ARES_FRANCES_V2", valorVenta: 2_600_000,
  cuotaInicial: 780_000, numeroCuotas: 40, frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2026-10-02",
  tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40,
  seguroCuotaPorcentaje: 0.03,
});
const credit = {
  folio: "QA-ARES-V2", clienteNombre: "Cliente ficticio de pruebas",
  clienteDocumento: "1000000000", clienteTelefono: "3000000000",
  clienteCorreo: "pruebas@example.com", clienteDireccion: "Direccion de prueba",
  valorEquipoTotal: 2_600_000, cuotaInicial: 780_000,
  montoCredito: 3_634_000, valorCuota: 90_850, valorCuotaComercial: 90_850,
  calculoVersion: "ARES_FRANCES_V2", cuotaTotalExacta: plan.cuotaTotal,
  descuentoRedondeo: plan.descuentoRedondeo,
  tasaInteresEa: 29.24, tasaPeriodo: plan.tasaPeriodo,
  fianzaModalidad: "TOTAL_CREDITO", fianzaTotalPorcentaje: 75,
  fianzaCuotaPorcentaje: 75 / 40, seguroCuotaPorcentaje: 0.03,
  redondeoComercialModo: "PISO", redondeoComercialMultiplo: 50,
  valorFianza: plan.valorFianzaTotal, valorSeguro: plan.valorSeguroTotal,
  plazoMeses: 40, frecuenciaPago: "QUINCENAL", equipoMarca: "IPHONE",
  equipoModelo: "13 PRO 256GB", referenciaEquipo: "IPHONE 13 PRO 256GB",
  imei: "350000000000001", fechaCredito: "2026-09-14T17:00:00Z",
  fechaPrimerPago: "2026-10-02T17:00:00Z", contratoIp: "127.0.0.1",
  usuario: { nombre: "Asesor de pruebas", usuario: "qa" },
  sede: { nombre: "SEDE QA", codigo: "QA", aliadoId: 1 },
};

async function pdfText(buffer) {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const doc = await loading.promise;
  const text = [];
  for (let i = 1; i <= doc.numPages; i++) {
    text.push((await (await doc.getPage(i)).getTextContent()).items.map((item) => item.str).join(" "));
  }
  const count = doc.numPages;
  await loading.destroy();
  return { text: text.join(" ").replace(/\s+/g, " "), count };
}

test("disclosure V2 separa cuota pactada y referencia matemática, incluso desde snapshot", () => {
  const direct = folio.resolveFirmaSeguroFinancialDisclosure(credit);
  assert.equal(direct.isCommercialContract, true);
  assert.equal(direct.cuotaPactada, 90_850);
  assert.equal(direct.cuotaExacta, plan.cuotaTotal);
  assert.ok(direct.descuentoRedondeo > 1500);
  const persisted = folio.resolveFirmaSeguroFinancialDisclosure({
    ...credit, calculoVersion: null, cuotaTotalExacta: null, descuentoRedondeo: null,
    contratoSnapshot: { financiero: {
      calculoVersion: "ARES_FRANCES_V2", cuotaPactada: 90_850,
      cuotaTotalExacta: plan.cuotaTotal, descuentoRedondeo: plan.descuentoRedondeo,
    } },
  });
  assert.equal(persisted.cuotaExacta, plan.cuotaTotal);
  assert.equal(persisted.descuentoRedondeo, plan.descuentoRedondeo);
});

for (const [name, renderer] of [["folio", folio], ["credit", legacy]]) {
  test(`${name}: PDF V2 pacta cuotas iguales sin ajustar la última; V1 conserva texto`, async () => {
    const buffer = await renderer.buildFirmaSeguroCreditPdf(credit);
    const result = await pdfText(buffer);
    if (name === "folio") assert.equal(result.count, 6);
    assert.match(result.text, /40 cuotas iguales de \$\s*90\.850/);
    assert.match(result.text, /3\.634\.000/);
    assert.doesNotMatch(result.text, /ultima cuota (puede|podra) ajustarse/);
    assert.doesNotMatch(result.text, /plan exacto determina el recaudo/);
    const old = await pdfText(await renderer.buildFirmaSeguroCreditPdf({
      ...credit, calculoVersion: "ARES_FRANCES_V1", valorCuota: plan.cuotaTotal,
      montoCredito: plan.montoTotalExacto,
    }));
    assert.match(old.text, /ultima cuota (puede|podra) ajustarse/);
    if (process.env.ARES_PDF_QA_DIR) {
      await mkdir(process.env.ARES_PDF_QA_DIR, { recursive: true });
      await writeFile(path.join(process.env.ARES_PDF_QA_DIR, `ares-v2-${name}.pdf`), buffer);
    }
  });
}
