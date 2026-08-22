import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  buildFirmaSeguroCreditPdf,
  buildFirmaSeguroFolioFileName,
  resolveFirmaSeguroFinancialDisclosure,
} = await jiti.import("../lib/firmaseguro-folio-pdf.ts");

const sampleCredit = {
  folio: "FC-TEST-001",
  clienteTipoDocumento: "CC",
  clienteNombre: "Cliente de prueba",
  clienteDocumento: "1000000000",
  clienteTelefono: "3000000000",
  clienteCorreo: "cliente@example.com",
  clienteDireccion: "Direccion de prueba",
  referenciaEquipo: "EQUIPO MODELO 128GB",
  equipoMarca: "MARCA",
  equipoModelo: "MODELO 128GB",
  imei: "350000000000001",
  deviceUid: "350000000000001",
  valorEquipoTotal: 1_000_000,
  cuotaInicial: 200_000,
  montoCredito: 1_120_000,
  valorCuota: 146_885.56475169587,
  valorCuotaComercial: 146_850,
  tasaInteresEa: 29.66,
  fianzaCuotaPorcentaje: 75 / 16,
  fianzaTotalPorcentaje: 75,
  fianzaModalidad: "TOTAL_CREDITO",
  seguroCuotaPorcentaje: 0.03,
  redondeoComercialModo: "PISO",
  redondeoComercialMultiplo: 50,
  plazoMeses: 12,
  frecuenciaPago: "MENSUAL",
  fechaCredito: new Date("2026-08-12T14:30:00-05:00"),
  fechaPrimerPago: new Date("2026-09-12T12:00:00-05:00"),
  contratoIp: "127.0.0.1",
  usuario: { nombre: "Usuario prueba", usuario: "pruebas" },
  vendedor: { nombre: "Asesor prueba" },
  sede: { nombre: "SEDE PRUEBA", codigo: "TST", aliadoId: 1 },
};

test("nombra el archivo como talonario y conserva el folio", () => {
  assert.equal(
    buildFirmaSeguroFolioFileName("FC 2026/001"),
    "TALONARIO_FINSERPAY_FC-2026-001.pdf"
  );
});

test("genera las seis paginas fuente que FirmaSeguro debe firmar", async () => {
  const pdf = await buildFirmaSeguroCreditPdf(sampleCredit);
  const rawPdf = pdf.toString("latin1");
  const pages = rawPdf.match(/\/Type\s*\/Page\b/g) || [];

  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(pages.length, 6);
  assert.equal(rawPdf.includes("/Count 6"), true);
});

test("resuelve cuota exacta y comercial tanto del borrador como del snapshot persistido", () => {
  const direct = resolveFirmaSeguroFinancialDisclosure(sampleCredit);
  assert.equal(direct.cuotaExacta, 146_885.56475169587);
  assert.equal(direct.cuotaComercial, 146_850);
  assert.equal(direct.fianzaTotalPorcentaje, 75);
  assert.equal(direct.fianzaCuotaPorcentaje, 75 / 16);
  assert.equal(direct.redondeoComercialModo, "PISO");
  assert.equal(direct.redondeoComercialMultiplo, 50);

  const persisted = resolveFirmaSeguroFinancialDisclosure({
    ...sampleCredit,
    valorCuotaComercial: null,
    tasaInteresEa: null,
    fianzaCuotaPorcentaje: null,
    fianzaTotalPorcentaje: null,
    fianzaModalidad: null,
    seguroCuotaPorcentaje: null,
    redondeoComercialModo: null,
    redondeoComercialMultiplo: null,
    contratoSnapshot: {
      financiero: {
        tasaInteresEa: 29.66,
        fianzaCuotaPorcentaje: 75 / 16,
        fianzaTotalPorcentaje: 75,
        fianzaModalidad: "TOTAL_CREDITO",
        seguroCuotaPorcentaje: 0.03,
        cuotaComercial: 146_850,
        redondeoComercial: { modo: "PISO", multiplo: 50 },
      },
    },
  });
  assert.equal(persisted.cuotaExacta, 146_885.56475169587);
  assert.equal(persisted.cuotaComercial, 146_850);
  assert.equal(persisted.tasaInteresEa, 29.66);
  assert.equal(persisted.fianzaModalidad, "TOTAL_CREDITO");
  assert.equal(persisted.seguroCuotaPorcentaje, 0.03);
  assert.equal(persisted.redondeoComercialMultiplo, 50);
});
