import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_EVIDENCE_DRAFT_FIELDS,
  isOmittedSignedDraftAutosaveValue,
  mergeDeliveryEvidenceDraftPayload,
} from "../lib/delivery-evidence-draft.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

const expectedEvidenceFields = [
  "contratoCedulaFrenteDataUrl",
  "contratoCedulaFrenteCapturedAt",
  "contratoCedulaFrenteSource",
  "contratoCedulaRespaldoDataUrl",
  "contratoCedulaRespaldoCapturedAt",
  "contratoCedulaRespaldoSource",
  "iphoneSelfieCedulaDataUrl",
  "iphoneSelfieCedulaCapturedAt",
  "iphoneSelfieCedulaSource",
  "fotoEntregaDataUrl",
  "fotoEntregaCapturedAt",
  "fotoEntregaSource",
  "fotoRemisionDataUrl",
  "fotoRemisionCapturedAt",
  "fotoRemisionSource",
];

test("la mutacion de evidencias admite exactamente cinco archivos y su auditoria", () => {
  assert.equal(DELIVERY_EVIDENCE_DRAFT_FIELDS.length, 15);
  assert.equal(new Set(DELIVERY_EVIDENCE_DRAFT_FIELDS).size, 15);
  assert.deepEqual(
    [...DELIVERY_EVIDENCE_DRAFT_FIELDS].sort(),
    [...expectedEvidenceFields].sort()
  );
});

test("el autosave postfirma actualiza solo evidencias y conserva el expediente canonico", () => {
  const stored = {
    clienteDocumento: "1048556378",
    clienteNombre: "CLIENTE DE PRUEBA",
    clienteTelefono: "3001234567",
    clienteCorreo: "cliente@example.com",
    clienteDireccion: "Direccion original",
    equipoCatalogoId: 42,
    equipoMarca: "XIAOMI",
    equipoModelo: "REDMI 15C 256GB",
    referenciaEquipo: "XIAOMI REDMI 15C 256GB",
    imei: "357491837703685",
    deviceUid: "357491837703685",
    plataformaDispositivo: "ANDROID",
    valorEquipoTotal: "1200000",
    cuotaInicial: "300000",
    plazoMeses: "24",
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-15",
    dataCreditoAssessmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    veriffValidationId: 321,
    financialTermsSeal: "sello-firmado",
    contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,frente-anterior",
    contratoCedulaFrenteCapturedAt: "2026-08-31T10:00:00.000Z",
    contratoCedulaFrenteSource: "camera",
  };
  const incoming = {
    contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,frente-nuevo",
    contratoCedulaFrenteCapturedAt: "2026-08-31T12:00:00.000Z",
    contratoCedulaFrenteSource: "upload",
    contratoCedulaRespaldoDataUrl: "data:image/png;base64,respaldo-nuevo",
    contratoCedulaRespaldoCapturedAt: "2026-08-31T12:01:00.000Z",
    contratoCedulaRespaldoSource: "camera",
    iphoneSelfieCedulaDataUrl: "data:image/jpeg;base64,selfie-nueva",
    iphoneSelfieCedulaCapturedAt: "2026-08-31T12:02:00.000Z",
    iphoneSelfieCedulaSource: "camera",
    fotoEntregaDataUrl: "data:image/jpeg;base64,entrega-nueva",
    fotoEntregaCapturedAt: "2026-08-31T12:03:00.000Z",
    fotoEntregaSource: "camera",
    fotoRemisionDataUrl: "data:image/png;base64,remision-nueva",
    fotoRemisionCapturedAt: "2026-08-31T12:04:00.000Z",
    fotoRemisionSource: "upload",
    clienteDocumento: "9999999999",
    clienteNombre: "NOMBRE ALTERADO",
    imei: "000000000000000",
    plataformaDispositivo: "IPHONE",
    valorEquipoTotal: "1",
    cuotaInicial: "0",
    plazoMeses: "1",
    dataCreditoAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    veriffValidationId: 999,
    financialTermsSeal: "sello-alterado",
    campoNoAutorizado: "no debe persistirse",
  };

  const merged = mergeDeliveryEvidenceDraftPayload(stored, incoming);

  for (const field of [
    "clienteDocumento",
    "clienteNombre",
    "clienteTelefono",
    "clienteCorreo",
    "clienteDireccion",
    "equipoCatalogoId",
    "equipoMarca",
    "equipoModelo",
    "referenciaEquipo",
    "imei",
    "deviceUid",
    "plataformaDispositivo",
    "valorEquipoTotal",
    "cuotaInicial",
    "plazoMeses",
    "frecuenciaPago",
    "fechaPrimerPago",
    "dataCreditoAssessmentId",
    "veriffValidationId",
    "financialTermsSeal",
  ]) {
    assert.equal(merged[field], stored[field], `debe conservar ${field}`);
  }

  for (const field of expectedEvidenceFields) {
    assert.equal(merged[field], incoming[field], `debe actualizar ${field}`);
  }

  assert.equal(Object.hasOwn(merged, "campoNoAutorizado"), false);
});

test("solo null, undefined y texto vacio representan un valor omitido", () => {
  for (const value of [null, undefined, "", "   ", "\n\t"]) {
    assert.equal(isOmittedSignedDraftAutosaveValue(value), true);
  }

  for (const value of [0, "0", false, "valor real", 25]) {
    assert.equal(isOmittedSignedDraftAutosaveValue(value), false);
  }
});

test("route y fabrica usan el alcance DELIVERY_EVIDENCE solo tras firma y en entrega", async () => {
  const [route, storage, factory] = await Promise.all([
    readProjectFile("app/api/creditos/borradores/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  ]);

  assert.match(route, /payloadScope\?: unknown/);
  assert.match(
    route,
    /sanitizeText\(body\.payloadScope\)\.toUpperCase\(\)\s*===\s*"DELIVERY_EVIDENCE"/
  );
  assert.match(route, /payloadScope,\s*\n?\s*\}\);/);
  assert.match(storage, /mergeDeliveryEvidenceDraftPayload/);
  assert.match(
    factory,
    /payloadScope:\s*firmaSeguroProcessSigned\s*&&\s*persistedWizardStep\s*>=\s*5\s*\?\s*"DELIVERY_EVIDENCE"\s*:\s*"FULL"/
  );
});
