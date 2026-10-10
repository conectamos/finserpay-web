import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { projectFirmaSeguroContractIdentity } = await jiti.import("../lib/firmaseguro-contract-identity.ts");
const { resolveFirmaSeguroFullNameIdentity } = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const folio = await jiti.import("../lib/firmaseguro-folio-pdf.ts");
const packet = await jiti.import("../lib/firmaseguro-credit-pdf.ts");
const canonical = "NOMBRE ORIGINAL DE DATACREDITO";
const providerName = "MARCOS ANDRES PATINO GOMEZ";

function fixture(nameMode = "FULL_NAME_ONLY") {
  return {
    folio: "FC-IDENTITY-TEST", clienteTipoDocumento: "CC", clienteNombre: canonical,
    clienteDocumento: "001234567", clienteTelefono: "3001234567", clienteCorreo: "fixture@example.com",
    clienteDireccion: "Direccion de prueba", referenciaEquipo: "iPhone 13 128GB", equipoMarca: "IPHONE",
    equipoModelo: "iPhone 13 128GB", imei: "000000000000001", valorEquipoTotal: 2500000,
    cuotaInicial: 500000, montoCredito: 2000000, valorCuota: 128900, valorCuotaComercial: 128900,
    plazoMeses: 30, frecuenciaPago: "QUINCENAL", fechaCredito: new Date("2026-10-10T12:00:00Z"),
    fechaPrimerPago: new Date("2026-11-02T12:00:00Z"),
    usuario: { nombre: "Usuario de prueba" }, sede: { nombre: "Sede de prueba", codigo: "TST" },
    contratoSnapshot: {
      firmaSeguroContractNameVersion: 1,
      dataCreditoIdentity: { effective: { nameMode, fullName: canonical } },
      firmaSeguroIdentity: resolveFirmaSeguroFullNameIdentity({ fullName: canonical,
        documentNumber: "001234567", veriffDocumentNumber: "001234567", validationId: 42,
        firstName: "MARCOS ANDRES", lastName: "PATINO GOMEZ" }),
    },
  };
}

test("contrato usa los nombres reales de Veriff en ambos modos DC sin modificar datos ni sello", () => {
  for (const mode of ["FULL_NAME_ONLY", "STRUCTURED"]) {
    const credit = fixture(mode); const before = JSON.stringify(credit);
    const projected = projectFirmaSeguroContractIdentity(credit);
    assert.equal(projected.clienteNombre, providerName);
    assert.equal(projected.clienteDocumento, "001234567");
    assert.equal(projected.contratoSnapshot.dataCreditoIdentity.effective.fullName, canonical);
    assert.equal(projected.contratoSnapshot, credit.contratoSnapshot);
    assert.equal(JSON.stringify(credit), before);
  }
});

test("documentos anteriores sin marcador conservan su nombre; metadata nueva inválida no cae en nombres DC", () => {
  const legacy = fixture(); delete legacy.contratoSnapshot.firmaSeguroContractNameVersion;
  assert.equal(projectFirmaSeguroContractIdentity(legacy), legacy);
  for (const mutate of [
    credit => { credit.clienteDocumento = "999999999"; },
    credit => { credit.clienteNombre = "OTRA SOLICITUD"; },
    credit => { delete credit.contratoSnapshot.firmaSeguroIdentity; },
  ]) { const credit = fixture(); mutate(credit); assert.throws(() => projectFirmaSeguroContractIdentity(credit)); }
});

test("PDF fuente y paquete documental muestran el nombre Veriff en todas las páginas de identidad", async () => {
  for (const [name, builder] of [["talonario", folio.buildFirmaSeguroCreditPdf], ["paquete", packet.buildFirmaSeguroCreditPdf]]) {
    const credit = fixture(); const before = JSON.stringify(credit);
    const buffer = await builder(credit);
    const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const pdf = await loading.promise;
    let content = "";
    try {
      for (let page = 1; page <= pdf.numPages; page++) {
        const text = await (await pdf.getPage(page)).getTextContent();
        content += text.items.map(item => item.str || "").join(" ") + "\n";
      }
      assert.ok(content.includes(providerName), name);
      assert.ok(!content.includes(canonical), `${name} must not print the DataCrédito name`);
      assert.ok(content.includes("001234567"), `${name} preserves the document's leading zeros`);
      assert.equal(JSON.stringify(credit), before);
      if (process.env.FINSER_PDF_QA_OUTPUT) {
        mkdirSync(process.env.FINSER_PDF_QA_OUTPUT, { recursive: true });
        writeFileSync(path.join(process.env.FINSER_PDF_QA_OUTPUT, `${name}-veriff-name.pdf`), buffer);
      }
    } finally { await loading.destroy(); }
  }
});
