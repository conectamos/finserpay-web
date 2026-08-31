import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS,
  buildSignedCreditClosePayload,
  resolveSignedCreditPolicyFinancialSettings,
} = await jiti.import("../lib/signed-credit-close.ts");
const { calculateFrenchAmortization } = await jiti.import(
  "../lib/credit-amortization.ts"
);
const { createFinancingTermsSeal } = await jiti.import(
  "../lib/credit-amortization-contract.ts"
);

test("el cierre firmado usa contrato y finanzas sellados y solo recibe evidencias nuevas", () => {
  const signed = {
    clienteDocumento: "1234567890",
    clienteNombre: "NOMBRE FIRMADO COMPLETO",
    clientePrimerNombre: "NOMBRE",
    clientePrimerApellido: "FIRMADO",
    equipoCatalogoId: 45,
    equipoMarca: "XIAOMI",
    equipoModelo: "REDMI 15C 256GB",
    imei: "123456789012345",
    valorEquipoTotal: "1200000",
    cuotaInicial: "500000",
    plazoMeses: "24",
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-15",
    dataCreditoAssessmentId: "assessment-firmado",
    financialTermsSeal: { version: "FINANCIACION_FIRMADA_V2" },
    fotoEntregaDataUrl: "data:image/jpeg;base64,anterior",
  };
  const incoming = {
    solicitudId: 450,
    firmaSeguroPasoContratos: true,
    firmaSeguroProcessUuid: "proceso-firmado",
    clienteNombre: "NOMBRE CAMBIADO",
    equipoCatalogoId: null,
    equipoModelo: "OTRO EQUIPO",
    imei: "000000000000000",
    valorEquipoTotal: "1",
    cuotaInicial: "0",
    plazoMeses: "1",
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2030-01-01",
    dataCreditoAssessmentId: "otro-assessment",
    montoCredito: "1",
    contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,frente",
    contratoCedulaFrenteCapturedAt: "2026-08-31T12:00:00.000Z",
    contratoCedulaFrenteSource: "camera",
    contratoCedulaRespaldoDataUrl: "data:image/jpeg;base64,respaldo",
    contratoCedulaRespaldoCapturedAt: "2026-08-31T12:01:00.000Z",
    contratoCedulaRespaldoSource: "camera",
    iphoneSelfieCedulaDataUrl: "data:image/jpeg;base64,selfie",
    iphoneSelfieCedulaCapturedAt: "2026-08-31T12:02:00.000Z",
    iphoneSelfieCedulaSource: "camera",
    fotoEntregaDataUrl: "data:image/jpeg;base64,entrega",
    fotoEntregaCapturedAt: "2026-08-31T12:03:00.000Z",
    fotoEntregaSource: "camera",
    fotoRemisionDataUrl: "data:image/jpeg;base64,remision",
    fotoRemisionCapturedAt: "2026-08-31T12:04:00.000Z",
    fotoRemisionSource: "camera",
  };

  const signedSnapshot = {
    documento: "1234567890",
    tipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteNombre: "NOMBRE FIRMADO COMPLETO",
    clienteTelefono: "3001234567",
    clienteCorreo: "cliente@example.com",
    clienteDireccion: "DIRECCION FIRMADA",
    equipoMarca: "XIAOMI",
    equipoModelo: "REDMI 15C 256GB",
    referenciaEquipo: "XIAOMI REDMI 15C 256GB",
    imei: "123456789012345",
    valorVenta: "1200000.000000",
    cuotaInicial: "500000.000000",
    numeroCuotas: 24,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-15",
  };
  const result = buildSignedCreditClosePayload(signed, incoming, signedSnapshot);

  for (const field of [
    "clienteDocumento",
    "clienteNombre",
    "equipoCatalogoId",
    "equipoMarca",
    "equipoModelo",
    "imei",
    "dataCreditoAssessmentId",
    "financialTermsSeal",
  ]) {
    assert.deepEqual(result[field], signed[field], `conserva ${field}`);
  }
  assert.equal(result.valorEquipoTotal, signedSnapshot.valorVenta);
  assert.equal(result.cuotaInicial, signedSnapshot.cuotaInicial);
  assert.equal(result.plazoMeses, signedSnapshot.numeroCuotas);
  assert.equal(result.frecuenciaPago, signedSnapshot.frecuenciaPago);
  assert.equal(result.fechaPrimerPago, signedSnapshot.fechaPrimerPago);
  assert.equal(result.imei, signedSnapshot.imei);
  assert.equal(result.deviceUid, signedSnapshot.imei);
  for (const field of SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS) {
    assert.deepEqual(result[field], incoming[field], `actualiza ${field}`);
  }
  assert.equal(Object.hasOwn(result, "montoCredito"), false);
});

test("la allowlist del cierre contiene solo vínculo operativo y cinco evidencias auditadas", () => {
  assert.equal(SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS.length, 18);
  assert.equal(new Set(SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS).size, 18);
  assert.deepEqual(SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS.slice(0, 3), [
    "solicitudId",
    "firmaSeguroPasoContratos",
    "firmaSeguroProcessUuid",
  ]);
});

test("el cierre elimina evidencias firmadas antiguas que no llegaron en la solicitud actual", () => {
  const result = buildSignedCreditClosePayload(
    {
      clienteDocumento: "1234567890",
      contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,frente-anterior",
      fotoEntregaDataUrl: "data:image/jpeg;base64,entrega-anterior",
      fotoEntregaCapturedAt: "2026-08-30T12:00:00.000Z",
      fotoEntregaSource: "camera",
    },
    {
      solicitudId: 450,
      firmaSeguroPasoContratos: true,
      firmaSeguroProcessUuid: "proceso-firmado",
      contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,frente-actual",
    }
  );

  assert.equal(
    result.contratoCedulaFrenteDataUrl,
    "data:image/jpeg;base64,frente-actual"
  );
  assert.equal(Object.hasOwn(result, "fotoEntregaDataUrl"), false);
  assert.equal(Object.hasOwn(result, "fotoEntregaCapturedAt"), false);
  assert.equal(Object.hasOwn(result, "fotoEntregaSource"), false);
});

test("convierte todos los parametros financieros firmados en la politica de cierre", () => {
  const resolved = resolveSignedCreditPolicyFinancialSettings({
    calculoVersion: "ARES_FRANCES_V1",
    tasaInteresEa: "0.420000000000",
    fianzaTotalPorcentaje: "0.180000000000",
    fianzaCuotaPorcentaje: "0.007500000000",
    fianzaModalidad: "TOTAL_CREDITO",
    fianzaFuente: "POLITICA",
    seguroCuotaPorcentaje: "0.002500000000",
    frecuenciaPago: "QUINCENAL",
    tasaPeriodoDecimales: 6,
    redondeoComercialModo: "PISO",
    redondeoComercialMultiplo: 50,
  });

  assert.deepEqual(resolved, {
    calculoVersion: "ARES_FRANCES_V1",
    tasaInteresEa: 0.42,
    fianzaTotalPorcentaje: 0.18,
    fianzaCuotaPorcentaje: 0.0075,
    fianzaModalidad: "TOTAL_CREDITO",
    seguroCuotaPorcentaje: 0.0025,
    frecuenciaPago: "QUINCENAL",
    tasaPeriodoDecimales: 6,
    redondeoComercialModo: "PISO",
    redondeoComercial: {
      modo: "PISO",
      multiplo: 50,
    },
    fianzaSource: "POLITICA",
  });
});

test("rechaza una fuente financiera no reconocida aunque el objeto tenga forma de snapshot", () => {
  assert.throws(
    () =>
      resolveSignedCreditPolicyFinancialSettings({
        calculoVersion: "FRANCES_V1",
        tasaInteresEa: "0.35",
        fianzaTotalPorcentaje: "0.12",
        fianzaCuotaPorcentaje: "0.005",
        fianzaModalidad: "POR_CUOTA",
        fianzaFuente: "FUENTE_DESCONOCIDA",
        seguroCuotaPorcentaje: "0.002",
        frecuenciaPago: "QUINCENAL",
        tasaPeriodoDecimales: 12,
        redondeoComercialModo: "REDONDEO",
        redondeoComercialMultiplo: 100,
      }),
    /fuente de fianza firmada/i
  );
});

test("la politica reconstruida reproduce exactamente el checksum financiero firmado", () => {
  const contrato = {
    tipoDocumento: "CC",
    clienteNombre: "CLIENTE DE PRUEBA",
    clienteTelefono: "3001234567",
    clienteCorreo: "cliente@example.com",
    clienteDireccion: "CALLE 1",
    equipoMarca: "XIAOMI",
    equipoModelo: "REDMI 15C 256GB",
    referenciaEquipo: "XIAOMI REDMI 15C 256GB",
    imei: "123456789012345",
  };
  const original = createFinancingTermsSeal({
    folio: "FP-CIERRE-FIRMADO",
    documento: "1234567890",
    contrato,
    amortizacion: calculateFrenchAmortization({
      calculoVersion: "ARES_FRANCES_V1",
      tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 },
      valorVenta: 1_800_000,
      cuotaInicial: 529_500,
      numeroCuotas: 16,
      tasaInteresEa: 29.66,
      fianzaCuotaPorcentaje: 75 / 16,
      seguroCuotaPorcentaje: 0.03,
      frecuenciaPago: "QUINCENAL",
      fechaPrimerPago: "2026-09-17",
    }),
    parametros: {
      fianzaTotalPorcentaje: 75,
      fianzaModalidad: "TOTAL_CREDITO",
      fianzaFuente: "POLITICA",
      tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 3,
      policyRevisionId: "policy-revision-test",
    },
  });
  const resolved = resolveSignedCreditPolicyFinancialSettings(
    original.snapshot
  );
  const reconstructed = createFinancingTermsSeal({
    folio: original.snapshot.folio,
    documento: original.snapshot.documento,
    contrato: original.snapshot,
    amortizacion: calculateFrenchAmortization({
      calculoVersion: resolved.calculoVersion,
      tasaPeriodoDecimales: resolved.tasaPeriodoDecimales,
      redondeoComercial: resolved.redondeoComercial,
      valorVenta: Number(original.snapshot.valorVenta),
      cuotaInicial: Number(original.snapshot.cuotaInicial),
      numeroCuotas: original.snapshot.numeroCuotas,
      tasaInteresEa: resolved.tasaInteresEa,
      fianzaCuotaPorcentaje: resolved.fianzaCuotaPorcentaje,
      seguroCuotaPorcentaje: resolved.seguroCuotaPorcentaje,
      frecuenciaPago: resolved.frecuenciaPago,
      fechaPrimerPago: original.snapshot.fechaPrimerPago,
    }),
    parametros: {
      fianzaTotalPorcentaje: resolved.fianzaTotalPorcentaje,
      fianzaModalidad: resolved.fianzaModalidad,
      fianzaFuente: resolved.fianzaSource,
      tasaPeriodoDecimales: resolved.tasaPeriodoDecimales,
      redondeoComercial: resolved.redondeoComercial,
      policyVersion: original.snapshot.policyVersion,
      policyRevisionId: original.snapshot.policyRevisionId,
    },
  });

  assert.equal(reconstructed.checksum, original.checksum);
  assert.deepEqual(reconstructed.snapshot, original.snapshot);
});

test("la ruta canonicaliza el expediente válido antes de refrescar y exige firma al finalizar", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/api/creditos/route.ts"),
    "utf8"
  );

  assert.match(source, /preloadedFirmaSeguroProcess\.draftId === preloadedSolicitudId/);
  assert.match(source, /!preloadedFirmaSeguroProcess\.creditoId/);
  assert.match(source, /signedSeal/);
  assert.match(source, /buildSignedCreditClosePayload\(/);
  assert.match(source, /await refreshFirmaSeguroProcess\(storedFirmaSeguroProcess\)/);
  assert.match(
    source,
    /!firmaSeguroProcess\?\.completedAt\s*&&\s*!firmaSeguroProcess\?\.signedDocumentBase64/
  );
  assert.match(
    source,
    /const clienteNombreFinal =\s*authoritativeSignedTerms/
  );
  assert.match(source, /clienteNombre\s*\|\|\s*clienteNombreDesdePartes/);
});
