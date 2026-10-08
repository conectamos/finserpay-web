import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
const { createFinancingTermsSeal, readFinancingTermsSeal } = await jiti.import("../lib/credit-amortization-contract.ts");
const { requestDataValues } = await jiti.import("../lib/approval-request-correction-core.ts");
const { buildFrozenDraftCorrection, buildFrozenPendingContactRedirect } = await jiti.import("../lib/firmaseguro-draft-frozen.ts");
const { buildFrozenDraftClientCorrection, readFrozenClientCorrectionSource,
  verifiesFrozenClientCorrectionSource } = await jiti.import("../lib/firmaseguro-draft-client-correction-frozen.ts");

function fixture({ signed = false, version = "ARES_FRANCES_V2", firstPaymentDate = "2026-11-02", sealedFirstPaymentDate = firstPaymentDate } = {}) {
  const plan = calculateFrenchAmortization({ calculoVersion: version,
    valorVenta: 2_585_000, cuotaInicial: 775_500, numeroCuotas: 36,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 36,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", fechaPrimerPago: firstPaymentDate,
  });
  const original = {
    clienteDocumento: "77096448", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteNombre: "CARLOS RIVERA RIVERA", clientePrimerNombre: "CARLOS",
    clientePrimerApellido: "RIVERA", clienteSegundoApellido: "RIVERA",
    clienteFechaNacimiento: "1985-05-18", clienteTelefono: "3004452838",
    clienteCorreo: "rivera@example.com", clienteDireccion: "Calle 34 # 33-57 San Martin",
    clienteDepartamento: "CESAR", clienteCiudad: "Valledupar",
    equipoMarca: "IPHONE", equipoModelo: "13 PRO MAX 128GB",
    referenciaEquipo: "IPHONE 13 PRO MAX 128GB", equipoCatalogoId: 13,
    imei: "353282621632089", deviceUid: "353282621632089", plataformaDispositivo: "IPHONE",
    dataCreditoAssessmentId: "approved-offer", valorEquipoTotal: 2_585_000,
    cuotaInicial: 775_500, plazoMeses: 36, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: firstPaymentDate,
  };
  const seal = createFinancingTermsSeal({ folio: "SOL-002801", documento: original.clienteDocumento,
    contrato: { tipoDocumento: original.clienteTipoDocumento, clienteNombre: original.clienteNombre,
      clienteTelefono: original.clienteTelefono, clienteCorreo: original.clienteCorreo,
      clienteDireccion: original.clienteDireccion, equipoMarca: original.equipoMarca,
      equipoModelo: original.equipoModelo, referenciaEquipo: original.referenciaEquipo, imei: original.imei },
    amortizacion: { ...plan, cuotas: plan.cuotas.map((cuota, index) =>
      index === 0 ? { ...cuota, fechaVencimiento: sealedFirstPaymentDate } : cuota) },
    parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
      fianzaFuente: "POLITICA", tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 8, policyRevisionId: "original-policy-no-recalculation" },
  });
  original.financialTermsSeal = seal;
  const corrected = { ...original, clienteNombre: "CARLOS ANDRES RIVERA GOMEZ",
    clientePrimerNombre: "CARLOS ANDRES", clienteSegundoApellido: "GOMEZ",
    clienteFechaNacimiento: "1985-05-19", clienteTelefono: "3111234567",
    clienteCorreo: "corregido@example.com", clienteDireccion: "Carrera 7 # 12-34 Centro",
    clienteDepartamento: "TOLIMA", clienteCiudad: "Ibague" };
  delete corrected.financialTermsSeal;
  const source = { processUuid: "20000000-0000-4000-8000-000000000002",
    draftFolio: seal.snapshot.folio, draftPayload: original,
    signedDocumentBase64: signed ? Buffer.from("%PDF-1.7\nContrato firmado\n%%EOF").toString("base64") : null,
    completedAt: signed ? new Date("2026-10-08T22:00:00Z") : null,
    createdAt: new Date("2026-10-08T21:34:00Z") };
  return { plan, seal, original, corrected, source, draft: { id: 28, payload: corrected },
    correction: { correlationId: "30000000-0000-4000-8000-000000000003", draftId: 28,
      previousProcessUuid: source.processUuid, sourceSealChecksum: seal.checksum,
      before: requestDataValues(original), after: requestDataValues(corrected) } };
}

const mutableSealFields = new Set(["clienteNombre", "clienteTelefono", "clienteCorreo", "clienteDireccion"]);

for (const signed of [false, true]) {
  test(`corrige los datos del cliente con una nueva firma ${signed ? "desde contrato firmado" : "desde contrato pendiente"} y conserva TODOS los términos`, () => {
    const f = fixture({ signed });
    const originalState = JSON.stringify(f);
    const frozen = buildFrozenDraftClientCorrection(f);
    assert.notEqual(frozen.seal.checksum, f.seal.checksum);
    assert.equal(readFinancingTermsSeal(frozen.seal)?.checksum, frozen.seal.checksum);
    assert.equal(readFinancingTermsSeal(f.seal)?.checksum, f.seal.checksum);
    assert.deepEqual(Object.keys(frozen.seal.snapshot).sort(), Object.keys(f.seal.snapshot).sort());
    for (const key of Object.keys(f.seal.snapshot)) {
      if (!mutableSealFields.has(key)) assert.equal(frozen.seal.snapshot[key], f.seal.snapshot[key], key);
    }
    assert.equal(frozen.seal.snapshot.clienteNombre, f.corrected.clienteNombre);
    assert.equal(frozen.seal.snapshot.clienteDireccion, f.corrected.clienteDireccion.toUpperCase());
    assert.equal(frozen.seal.snapshot.clienteTelefono, f.corrected.clienteTelefono);
    assert.equal(frozen.seal.snapshot.clienteCorreo, f.corrected.clienteCorreo);
    assert.equal(frozen.credit.clienteNombre, f.corrected.clienteNombre);
    assert.equal(frozen.credit.clientePrimerNombre, f.corrected.clientePrimerNombre);
    assert.equal(frozen.credit.clientePrimerApellido, f.original.clientePrimerApellido);
    assert.equal(frozen.credit.clienteDocumento, f.original.clienteDocumento);
    assert.equal(frozen.credit.clienteTelefono, f.corrected.clienteTelefono);
    assert.equal(frozen.credit.clienteCorreo, f.corrected.clienteCorreo);
    assert.equal(frozen.credit.clienteDireccion, f.corrected.clienteDireccion.toUpperCase());
    assert.equal(frozen.credit.imei, f.original.imei);
    assert.equal(frozen.credit.fechaPrimerPago, f.original.fechaPrimerPago);
    assert.equal(frozen.firstPaymentDateKey, f.original.fechaPrimerPago);
    assert.equal(frozen.credit.fechaCredito.toISOString(), f.source.createdAt.toISOString());
    assert.equal(frozen.credit.valorSeguro, Number(f.seal.snapshot.cuotaSeguroExacta) * f.original.plazoMeses);
    assert.equal(frozen.credit.valorFianza, Number(f.seal.snapshot.cuotaFianzaExacta) * f.original.plazoMeses);
    assert.equal(frozen.credit.valorCuota, Number(f.seal.snapshot.cuotaPactada));
    assert.equal(frozen.credit.contratoSnapshot.financiero.totalPagarExacto, Number(f.seal.snapshot.totalPagarExacto));
    assert.equal(frozen.credit.contratoSnapshot.financiero.descuentoRedondeo, Number(f.seal.snapshot.descuentoRedondeo));
    assert.equal(JSON.stringify(f), originalState, "ni el borrador ni el contrato archivado se mutan");
    assert.deepEqual(readFrozenClientCorrectionSource(frozen.frozenClientCorrectionSource, frozen.seal), frozen.frozenClientCorrectionSource);
    assert.equal(verifiesFrozenClientCorrectionSource({ ...f, target: frozen.seal, marker: frozen.frozenClientCorrectionSource }), true);
  });
}

test("también conserva las cifras y formato histórico V1 sin inventar campos comerciales V2", () => {
  const f = fixture({ version: "ARES_FRANCES_V1", signed: true, firstPaymentDate: "2025-10-17" });
  const frozen = buildFrozenDraftClientCorrection(f);
  assert.equal(frozen.firstPaymentDateKey, "2025-10-17", "no deriva la fecha del día de reenvío");
  for (const key of Object.keys(f.seal.snapshot)) {
    if (!mutableSealFields.has(key)) assert.equal(frozen.seal.snapshot[key], f.seal.snapshot[key], key);
  }
  assert.equal("cuotaPactada" in frozen.seal.snapshot, false);
  assert.equal("totalPagarExacto" in frozen.seal.snapshot, false);
  assert.equal(frozen.credit.valorCuota, Number(f.seal.snapshot.cuotaTotalExacta));
});

test("no permite cambiar la cédula, primer apellido, equipo, IMEI ni ninguna condición financiera del borrador", () => {
  for (const [field, value] of [
    ["clienteDocumento", "1111111111"], ["clienteTipoDocumento", "CC"], ["clientePrimerApellido", "GOMEZ"],
    ["imei", "543210987654321"], ["deviceUid", "543210987654321"], ["equipoMarca", "SAMSUNG"],
    ["equipoModelo", "14"], ["referenciaEquipo", "IPHONE 14"], ["equipoCatalogoId", 14],
    ["plataformaDispositivo", "ANDROID"], ["dataCreditoAssessmentId", "another-offer"],
    ["valorEquipoTotal", 3_000_000], ["cuotaInicial", 900_000], ["plazoMeses", 40],
    ["frecuenciaPago", "MENSUAL"], ["fechaPrimerPago", "2026-11-17"],
    ["tasaInteresEa", 30], ["valorCuota", 99_999], ["montoCredito", 9_999_999],
    ["cuotaPactada", 99_999], ["totalPagarExacto", 9_999_999], ["seguroCuotaPorcentaje", 0],
  ]) {
    const f = fixture();
    f.draft.payload[field] = value;
    if (field === "clientePrimerApellido") {
      f.correction.after[field] = value;
      f.draft.payload.clienteNombre = f.correction.after.clienteNombre = "CARLOS ANDRES GOMEZ GOMEZ";
    }
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_CLIENT_CORRECTION_/, field);
  }
});

test("detecta cifras alteradas en origen aunque ambas copias del payload coincidan entre sí", () => {
  for (const field of ["valorEquipoTotal", "cuotaInicial", "plazoMeses"]) {
    const f = fixture();
    f.source.draftPayload[field] = f.draft.payload[field] = 1;
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_CLIENT_CORRECTION_/, field);
  }
  for (const field of ["clienteDocumento", "equipoModelo", "imei"]) {
    const f = fixture();
    f.source.draftPayload[field] = f.draft.payload[field] = "543210987654321";
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_CLIENT_CORRECTION_/, field);
  }
  for (const [field, altered] of [["valorCuota", 1], ["tasaInteresEa", 10], ["seguroCuotaPorcentaje", 0],
    ["cuotaPactada", 1], ["totalPagarExacto", 1]]) {
    const f = fixture();
    f.source.draftPayload[field] = f.draft.payload[field] = altered;
    assert.throws(() => buildFrozenDraftClientCorrection(f), /TERMS_CHANGED/, field);
  }
});

test("la corrección exige valores antes/después y linaje del historial exactos", () => {
  for (const mutate of [
    (f) => { f.correction.draftId = 999; },
    (f) => { f.correction.previousProcessUuid = "otro-proceso"; },
    (f) => { f.correction.sourceSealChecksum = "0".repeat(64); },
    (f) => { f.correction.correlationId = "sin-auditoria"; },
    (f) => { f.correction.before.clienteNombre = "NOMBRE DISTINTO"; },
    (f) => { f.correction.before.clienteDocumento = "1111111111"; },
    (f) => { f.correction.after.clienteDocumento = "1111111111"; },
    (f) => { f.correction.before.clienteCorreo = "otro@example.com"; },
    (f) => { f.correction.before.clienteFechaNacimiento = "1980-01-01"; },
    (f) => { f.correction.after.clienteCiudad = "Cali"; },
    (f) => { delete f.correction.after.clienteFechaNacimiento; },
    (f) => { f.draft.payload.clienteNombre = f.correction.after.clienteNombre = "NOMBRE NO COMPUESTO"; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_CLIENT_CORRECTION_/);
  }
});

test("rechaza sello manipulado y fuente firmada sin documento íntegro", () => {
  for (const mutate of [
    (f) => { f.source.draftPayload.financialTermsSeal.snapshot.totalPagar = "1.000000"; },
    (f) => { f.source.draftFolio = "otro-folio"; },
    (f) => { f.source.signedDocumentBase64 = Buffer.from("no es un pdf").toString("base64"); },
    (f) => { f.source.signedDocumentBase64 = null; },
    (f) => { f.source.completedAt = null; },
    (f) => { f.source.createdAt = "fecha-invalida"; },
  ]) {
    const f = fixture({ signed: true }); mutate(f);
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_CLIENT_CORRECTION_SOURCE_INVALID/);
  }
  const f = fixture();
  f.draft.payload.financialTermsSeal = { ...f.seal, checksum: "0".repeat(64) };
  assert.throws(() => buildFrozenDraftClientCorrection(f), /TERMS_CHANGED/);
});

test("rechaza una fecha imposible aunque el checksum del sello sea válido", () => {
  for (const invalidDate of ["2026-02-30", "2026-2-17", "2026-13-02"]) {
    const f = fixture({ firstPaymentDate: "2026-02-17", sealedFirstPaymentDate: invalidDate });
    assert.equal(readFinancingTermsSeal(f.seal)?.checksum, f.seal.checksum);
    assert.throws(() => buildFrozenDraftClientCorrection(f), /FIRMASEGURO_FIRST_PAYMENT_DATE_INVALID/);
  }
});

test("el verificador no acepta un marcador fabricado ni valores financieros cambiados", () => {
  const f = fixture(); const frozen = buildFrozenDraftClientCorrection(f);
  const input = { ...f, target: frozen.seal, marker: frozen.frozenClientCorrectionSource };
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input, correction: null }), false);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input, source: null }), false);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    marker: { ...input.marker, sourceChecksum: "0".repeat(64) } }), false);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    marker: { ...input.marker, correlationId: "40000000-0000-4000-8000-000000000004" } }), false);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    target: { ...frozen.seal, snapshot: { ...frozen.seal.snapshot, fechaPrimerPago: "2026-12-17" } } }), false);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    draft: { ...f.draft, payload: { ...f.draft.payload, cuotaInicial: 1 } } }), false);
});

test("el verificador reconstruye el contrato reservado con su nuevo sello exacto y rechaza un tercer sello", () => {
  const f = fixture(); const frozen = buildFrozenDraftClientCorrection(f);
  const input = { ...f, target: frozen.seal, marker: frozen.frozenClientCorrectionSource,
    draft: { ...f.draft, payload: { ...f.draft.payload, financialTermsSeal: frozen.seal } } };
  assert.equal(verifiesFrozenClientCorrectionSource(input), true);
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    draft: { ...input.draft, payload: { ...input.draft.payload,
      financialTermsSeal: { ...frozen.seal, checksum: "0".repeat(64) } } } }), false);
  const third = fixture({ firstPaymentDate: "2026-11-17" }).seal;
  assert.equal(verifiesFrozenClientCorrectionSource({ ...input,
    draft: { ...input.draft, payload: { ...input.draft.payload, financialTermsSeal: third } } }), false);
});

test("los builders previos conservan sus restricciones y no permiten correcciones sin el nuevo historial", () => {
  const pending = fixture();
  assert.throws(() => buildFrozenPendingContactRedirect({ ...pending,
    phone: pending.corrected.clienteTelefono, email: pending.corrected.clienteCorreo }), /SIGNED_TERMS_CHANGED/);
  const signed = fixture({ signed: true });
  assert.throws(() => buildFrozenDraftCorrection({ ...signed,
    folio: signed.source.draftFolio, imei: signed.original.imei }), /SIGNED_TERMS_CHANGED/);
});
