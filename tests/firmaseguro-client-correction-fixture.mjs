import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { randomUUID } from "node:crypto";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
export const core = await jiti.import("../lib/approval-request-correction-core.ts");
export const seals = await jiti.import("../lib/credit-amortization-contract.ts");
export const frozen = await jiti.import("../lib/firmaseguro-draft-client-correction-frozen.ts");
export const statuses = await jiti.import("../lib/firmaseguro-status.ts");
export const operational = await jiti.import("../lib/approval-operations-core.ts");
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
export const load = loadReissueModule;
export const clone = value => structuredClone(value);

export function clientCorrectionCase({ signed = false } = {}) {
  const original = {
    clienteDocumento: "77096448", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteNombre: "CARLOS RIVERA RIVERA", clientePrimerNombre: "CARLOS", clientePrimerApellido: "RIVERA",
    clienteSegundoApellido: "RIVERA", clienteFechaNacimiento: "1985-05-18", clienteFechaExpedicion: "2004-03-01",
    clienteTelefono: "3004452838", clienteCorreo: "rivera@example.com",
    clienteDireccion: "Calle 34 # 33-57 San Martin", clienteDepartamento: "CESAR", clienteCiudad: "Valledupar",
    equipoMarca: "IPHONE", equipoModelo: "13 PRO MAX 128GB", referenciaEquipo: "IPHONE 13 PRO MAX 128GB",
    equipoCatalogoId: 13, imei: "353282621632089", deviceUid: "353282621632089", plataformaDispositivo: "IPHONE",
    dataCreditoAssessmentId: "approved-offer", valorEquipoTotal: 2_585_000, cuotaInicial: 775_500,
    plazoMeses: 36, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-11-02", wizardStep: 4,
    fotoEntregaDataUrl: "foto-entrega-original", fotoRemisionDataUrl: "foto-remision-original",
    contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,identidad-original",
  };
  const plan = calculateFrenchAmortization({ calculoVersion: "ARES_FRANCES_V2",
    valorVenta: original.valorEquipoTotal, cuotaInicial: original.cuotaInicial, numeroCuotas: original.plazoMeses,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / original.plazoMeses,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: original.frecuenciaPago, fechaPrimerPago: original.fechaPrimerPago });
  const seal = seals.createFinancingTermsSeal({ folio: "SOL-002801", documento: original.clienteDocumento,
    contrato: { tipoDocumento: original.clienteTipoDocumento, clienteNombre: original.clienteNombre,
      clienteTelefono: original.clienteTelefono, clienteCorreo: original.clienteCorreo, clienteDireccion: original.clienteDireccion,
      equipoMarca: original.equipoMarca, equipoModelo: original.equipoModelo,
      referenciaEquipo: original.referenciaEquipo, imei: original.imei }, amortizacion: plan,
    parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO", fianzaFuente: "POLITICA",
      tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 }, policyVersion: 8,
      policyRevisionId: "original-policy-no-recalculation" } });
  original.financialTermsSeal = seal;
  const source = { id: 1, draftId: 28, creditoId: null, draftFolio: seal.snapshot.folio,
    processUuid: randomUUID(), draftPayload: clone(original), status: signed ? "COMPLETED" : "CREATED",
    signedDocumentBase64: signed ? Buffer.from("%PDF-1.7\nContrato original firmado\n%%EOF").toString("base64") : null,
    completedAt: signed ? new Date("2026-10-08T22:00:00Z") : null,
    createdAt: new Date("2026-10-08T21:34:00Z"), supersededAt: null, lastError: null };
  const draft = { id: 28, estado: "ABIERTO", creditoId: null, currentStep: 4,
    clienteNombre: original.clienteNombre, clienteDocumento: original.clienteDocumento,
    clienteTelefono: original.clienteTelefono, payload: clone(original),
    usuarioNombre: "Asesor original", usuarioLogin: "asesor", sedeNombre: "JG Valledupar", sedeCodigo: "JV", sedeAliadoId: 3 };
  const input = core.parseRequestDataCorrection({ values: { clientePrimerNombre: "CARLOS ANDRES",
    clienteSegundoApellido: "GOMEZ", clienteTelefono: "3111234567", clienteCorreo: "corregido@example.com",
    clienteDireccion: "Carrera 7 # 12-34 Centro", clienteFechaNacimiento: "1985-05-19" },
    expectedValues: core.requestDataValues(original), expectedRevision: 0, reason: "Corrección cotejada con el cliente",
    expectedProcessUuid: source.processUuid, idempotencyKey: randomUUID(), confirmed: true });
  const corrected = core.applyRequestDataCorrection(original, input, core.REQUEST_CORRECTION_FIELDS, "Analista",
    new Date("2026-10-08T22:30:00Z"), { preserveIdentityEvidence: true });
  const lineage = { correlationId: input.idempotencyKey, draftId: draft.id, previousProcessUuid: source.processUuid,
    sourceSealChecksum: seal.checksum, before: core.requestDataValues(original), after: core.requestDataValues(corrected.payload) };
  const built = frozen.buildFrozenDraftClientCorrection({ draft: { ...draft, payload: corrected.payload }, source, correction: lineage });
  const updatedPayload = { ...corrected.payload, financialTermsSeal: built.seal,
    firmaSeguroClientCorrectionPending: true, firmaSeguroClientCorrectionId: input.idempotencyKey };
  const process = { ...source, id: 2, processUuid: randomUUID(), draftPayload: clone(updatedPayload),
    signedDocumentBase64: Buffer.from("%PDF-1.7\nContrato corregido firmado\n%%EOF").toString("base64"),
    completedAt: new Date("2026-10-08T23:00:00Z"), status: "COMPLETED" };
  return { original, plan, seal, source, draft, input, corrected, built, updatedPayload, process };
}
