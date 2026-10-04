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
