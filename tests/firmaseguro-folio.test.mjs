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
  valorCuota: 93_334,
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
