import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { calculateFrenchAmortization, ARES_COMMERCIAL_AMORTIZATION_VERSION } =
  await jiti.import("../lib/credit-amortization.ts");
const { createFinancingTermsSeal, readFinancingTermsSeal, resealFinancingTermsIdentity } =
  await jiti.import("../lib/credit-amortization-contract.ts");
const { buildFrozenPendingContactRedirect } =
  await jiti.import("../lib/firmaseguro-draft-frozen.ts");

test("cambiar IMEI y contacto vuelve a sellar identidad sin cambiar cifras, plazo ni fecha", () => {
  const amortizacion = calculateFrenchAmortization({
    calculoVersion: ARES_COMMERCIAL_AMORTIZATION_VERSION,
    valorVenta: 2_600_000, cuotaInicial: 780_000, numeroCuotas: 40,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-10-02",
  });
  const original = createFinancingTermsSeal({
    folio: "FP-ORIGINAL", documento: "1234567890",
    contrato: { tipoDocumento: "CC", clienteNombre: "Cliente Prueba",
      clienteTelefono: "3000000000", clienteCorreo: "original@example.com",
      clienteDireccion: "Calle 1", equipoMarca: "IPHONE", equipoModelo: "13 PRO",
      referenciaEquipo: "IPHONE 13 PRO", imei: "123456789012345" },
    amortizacion,
    parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
      fianzaFuente: "POLITICA", tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 1, policyRevisionId: "policy-original" },
  });
  const changed = resealFinancingTermsIdentity(original, {
    folio: "FP-CORREGIDO", clienteTelefono: "3111111111",
    clienteCorreo: "nuevo@example.com", imei: "543210987654321",
    fechaPrimerPago: original.snapshot.fechaPrimerPago,
  });
  assert.equal(readFinancingTermsSeal(changed)?.checksum, changed.checksum);
  assert.equal(readFinancingTermsSeal(original)?.checksum, original.checksum);
  assert.notEqual(changed.checksum, original.checksum);
  for (const field of ["valorVenta", "cuotaInicial", "valorFinanciado", "numeroCuotas",
    "frecuenciaPago", "fechaPrimerPago", "tasaInteresEa", "tasaPeriodo",
    "cuotaPactada", "cuotaTotalExacta", "cuotaComercial", "totalPagar",
    "policyVersion", "policyRevisionId"]) {
    assert.equal(changed.snapshot[field], original.snapshot[field], field);
  }
  assert.equal(changed.snapshot.imei, "543210987654321");
  assert.equal(changed.snapshot.clienteTelefono, "3111111111");
  assert.equal(readFinancingTermsSeal({ ...changed, snapshot: { ...changed.snapshot,
    totalPagar: "1.000000" } }), null);
});

test("corregir el nombre legal conserva los términos financieros del contrato firmado", () => {
  const amortizacion = calculateFrenchAmortization({
    calculoVersion: ARES_COMMERCIAL_AMORTIZATION_VERSION,
    valorVenta: 2_600_000, cuotaInicial: 780_000, numeroCuotas: 40,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-10-17",
  });
  const original = createFinancingTermsSeal({
    folio: "FP-NOMBRE", documento: "1234567890",
    contrato: { tipoDocumento: "CC", clienteNombre: "NOMBRE ANTIGUO",
      clienteTelefono: "3000000000", clienteCorreo: "cliente@example.com",
      clienteDireccion: "Calle 1", equipoMarca: "IPHONE", equipoModelo: "17 PRO",
      referenciaEquipo: "IPHONE 17 PRO", imei: "123456789012345" },
    amortizacion,
    parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
      fianzaFuente: "POLITICA", tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 1, policyRevisionId: "policy-original" },
  });
  const corrected = resealFinancingTermsIdentity(original, {
    folio: original.snapshot.folio,
    clienteNombre: "NOMBRE CORRECTO APELLIDO SEGUNDO",
    clienteTelefono: original.snapshot.clienteTelefono,
    clienteCorreo: original.snapshot.clienteCorreo,
    imei: original.snapshot.imei,
  });
  assert.equal(readFinancingTermsSeal(corrected)?.checksum, corrected.checksum);
  assert.equal(corrected.snapshot.clienteNombre, "NOMBRE CORRECTO APELLIDO SEGUNDO");
  assert.equal(original.snapshot.clienteNombre, "NOMBRE ANTIGUO");
  const { clienteNombre: _before, ...originalOtherTerms } = original.snapshot;
  const { clienteNombre: _after, ...correctedOtherTerms } = corrected.snapshot;
  assert.notEqual(_before, _after);
  assert.deepEqual(correctedOtherTerms, originalOtherTerms);
});

test("redirigir una firma pendiente cambia solo el contacto y conserva el cierre financiero sellado", () => {
  const amortizacion = calculateFrenchAmortization({
    calculoVersion: ARES_COMMERCIAL_AMORTIZATION_VERSION,
    valorVenta: 3_100_000, cuotaInicial: 930_000, numeroCuotas: 40,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-10-17",
  });
  const seal = createFinancingTermsSeal({
    folio: "SOL-REDIRECT-1", documento: "1052962070",
    contrato: { tipoDocumento: "CC", clienteNombre: "ISABEL CESPEDES",
      clienteTelefono: "3218928117", clienteCorreo: "isabel@example.com",
      clienteDireccion: "Calle 1", equipoMarca: "IPHONE", equipoModelo: "17 PRO MAX 256GB",
      referenciaEquipo: "IPHONE 17 PRO MAX 256GB", imei: "358015864286170" },
    amortizacion,
    parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
      fianzaFuente: "POLITICA", tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 },
      policyVersion: 1, policyRevisionId: "policy-redirect" },
  });
  const payload = {
    clienteDocumento: "1052962070", clienteTipoDocumento: "CC", clienteNombre: "ISABEL CESPEDES",
    clientePrimerNombre: "ISABEL", clientePrimerApellido: "CESPEDES", clienteDireccion: "Calle 1",
    clienteTelefono: "3218928117", clienteCorreo: "isabel@example.com",
    equipoMarca: "IPHONE", equipoModelo: "17 PRO MAX 256GB",
    referenciaEquipo: "IPHONE 17 PRO MAX 256GB", equipoCatalogoId: 17,
    valorEquipoTotal: 3_100_000, cuotaInicial: 930_000, plazoMeses: 40,
    dataCreditoAssessmentId: 81, plataformaDispositivo: "IPHONE",
    imei: "358015864286170", deviceUid: "358015864286170", financialTermsSeal: seal,
  };
  const draft = { id: 31, payload: { ...payload }, usuarioNombre: "Asesor", usuarioLogin: "asesor",
    vendedorId: 4, vendedorNombre: "Asesor", vendedorDocumento: "1000", vendedorTelefono: "3000000000",
    vendedorEmail: "asesor@example.com", sedeNombre: "Sede", sedeCodigo: "S1", sedeAliadoId: 9 };
  const source = { processUuid: "20000000-0000-4000-8000-000000000002", draftFolio: "SOL-REDIRECT-1",
    draftPayload: { ...payload }, signedDocumentBase64: null, completedAt: null,
    createdAt: new Date("2026-10-05T20:27:00Z") };

  const redirected = buildFrozenPendingContactRedirect({
    draft, source, phone: "3119876543", email: "isabel@example.com",
  });
  assert.equal(redirected.credit.clienteTelefono, "3119876543");
  assert.equal(redirected.credit.clienteCorreo, "isabel@example.com");
  assert.equal(redirected.credit.imei, seal.snapshot.imei);
  assert.equal(redirected.credit.folio, seal.snapshot.folio);
  assert.equal(redirected.credit.valorEquipoTotal, Number(seal.snapshot.valorVenta));
  assert.equal(redirected.credit.cuotaInicial, Number(seal.snapshot.cuotaInicial));
  assert.equal(redirected.credit.valorCuota, Number(seal.snapshot.cuotaPactada));
  const expectedInsurance = Number(seal.snapshot.cuotaSeguroExacta) * seal.snapshot.numeroCuotas;
  assert.ok(expectedInsurance > 0, "la prueba debe usar un seguro contractual no nulo");
  assert.equal(redirected.credit.valorSeguro, expectedInsurance,
    "el objeto exacto entregado al renderer conserva el total de seguro del sello");
  assert.equal(redirected.credit.seguroCuotaPorcentaje,
    Number(seal.snapshot.seguroCuotaPorcentaje),
    "el PDF recibe también el porcentaje de seguro original, no cero");
  assert.equal(redirected.credit.plazoMeses, seal.snapshot.numeroCuotas);
  assert.equal(redirected.credit.fechaPrimerPago, seal.snapshot.fechaPrimerPago);
  assert.equal(redirected.seal.snapshot.clienteTelefono, "3119876543");
  for (const field of ["valorVenta", "cuotaInicial", "valorFinanciado", "numeroCuotas",
    "frecuenciaPago", "fechaPrimerPago", "tasaInteresEa", "tasaPeriodo", "cuotaPactada",
    "cuotaSeguroExacta", "cuotaTotalExacta", "cuotaComercial", "totalPagar",
    "policyVersion", "policyRevisionId"]) {
    assert.equal(redirected.seal.snapshot[field], seal.snapshot[field], field);
  }
  assert.throws(() => buildFrozenPendingContactRedirect({
    draft: { ...draft, payload: { ...payload, cuotaInicial: 1 } }, source,
    phone: "3119876543", email: "isabel@example.com",
  }), /FIRMASEGURO_SIGNED_TERMS_CHANGED/);
  assert.throws(() => buildFrozenPendingContactRedirect({
    draft, source: { ...source, signedDocumentBase64: Buffer.from("%PDF-1.7").toString("base64") },
    phone: "3119876543", email: "isabel@example.com",
  }), /FIRMASEGURO_SOURCE_ALREADY_SIGNED/);
});

test("la reserva durable impide doble envío y no afirma firma antes de evidencia", async () => {
  const [ledger, route] = await Promise.all([
    read("lib/firmaseguro-draft-dispatch-ledger.ts"),
    read("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
  ]);
  assert.match(ledger, /CREATE UNIQUE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatch_one_unresolved"/);
  assert.match(ledger, /"status" IN \('PREPARING','DISPATCHING','UNCERTAIN'\)/);
  assert.match(ledger, /WHERE "id"=\$1::uuid AND "status"='PREPARING' RETURNING/);
  assert.ok(ledger.indexOf('"status"=\'DISPATCHING\'') <
    ledger.indexOf("const acknowledged = await prepared.sendOnce()"));
  assert.match(ledger, /INSERT INTO "FirmaSeguroProcess"[\s\S]*"processUuid"/);
  assert.match(ledger, /"status"='UNCERTAIN'/);
  assert.match(ledger, /BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchEvent"/);
  assert.match(ledger, /BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatch"/);
  assert.match(route, /body\.id !== input\.idempotencyKey \|\| body\.status !== "AWAITING_SIGNATURE"/);
  assert.doesNotMatch(route, /createFirmaSeguroProcessForDraft\(/);
});

test("el analista nominal usa el mismo núcleo con relectura de alcance y sin Request sintético", async () => {
  const [route, facade] = await Promise.all([
    read("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
    read("lib/firmaseguro-draft-safe-request.ts"),
  ]);
  assert.match(route, /getApprovalSharedRequestActor\(\)/);
  assert.match(route, /getCreditApprovalSessionUser\(\)/);
  assert.match(route, /user\.id !== input\.actor\.id/);
  assert.match(route, /scope === "operational"[\s\S]*readOperationalDraft\(draftId, actorUser\.id\)/);
  assert.match(route, /d\."currentStep" IN \(3,4\)/);
  assert.match(route, /UPPER\(COALESCE\(d\."plataforma"[\s\S]*='IPHONE'/);
  assert.match(facade, /requestSafeDraftSignatureFromRoute\(input\)/);
  assert.doesNotMatch(route, /new Request\("http:\/\/internal/);
});

test("autosave y corrección IMEI esperan cuando el envío durable no está resuelto", async () => {
  const [autosave, correction] = await Promise.all([
    read("lib/solicitudes-storage.ts"),
    read("lib/firmaseguro-imei-correction.ts"),
  ]);
  const autosaveLock = autosave.indexOf("await lockSolicitudOperationMutation(transaction, targetId)");
  const autosaveGuard = autosave.indexOf("getUnresolvedDraftDispatch(targetId, transaction)", autosaveLock);
  const autosaveWrite = autosave.indexOf('UPDATE "CreditoBorrador"', autosaveGuard);
  assert.ok(autosaveLock >= 0 && autosaveGuard > autosaveLock && autosaveWrite > autosaveGuard);
  const correctionLock = correction.indexOf("await lockSolicitudOperationMutation(transaction, input.draftId)");
  const correctionGuard = correction.indexOf("getUnresolvedDraftDispatch(input.draftId, transaction)", correctionLock);
  const correctionWrite = correction.indexOf('UPDATE "CreditoBorrador"', correctionGuard);
  assert.ok(correctionLock >= 0 && correctionGuard > correctionLock && correctionWrite > correctionGuard);
});
