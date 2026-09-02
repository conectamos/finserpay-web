import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isValidCreditDeviceReplacementImei } from "../lib/credit-device-replacement.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const [storage, route, schema, creditRoute, massCreditRoute] = await Promise.all([
  readProjectFile("lib/credit-device-replacement-storage.ts"),
  readProjectFile("app/api/creditos/[id]/device-replacement/route.ts"),
  readProjectFile("scripts/ensure-credit-device-replacement-schema.mjs"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("app/api/creditos/masivos/route.ts"),
]);

test("valida el IMEI de reemplazo con Luhn y exactamente 15 dígitos", () => {
  assert.equal(isValidCreditDeviceReplacementImei("355063664500617"), true);
  assert.equal(isValidCreditDeviceReplacementImei("355909998071255"), true);
  assert.equal(isValidCreditDeviceReplacementImei("490154203237518"), true);
  assert.equal(isValidCreditDeviceReplacementImei("355063664500618"), false);
  assert.equal(isValidCreditDeviceReplacementImei("35506366450061"), false);
  assert.equal(isValidCreditDeviceReplacementImei("35506366450061A"), false);
});

test("GET, POST y PATCH exigen administrador central FINSER PAY", () => {
  assert.match(route, /isAdminRole\(user\.rolNombre\)/);
  assert.match(route, /isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/);
  assert.equal(
    (route.match(/const authorization = await centralAdmin\(\)/g) || []).length,
    3
  );
  assert.match(
    route,
    /Solo el administrador central de FINSER PAY puede gestionar cambios de equipo/
  );
});

test("la API acepta únicamente los contratos de cuerpo autorizados", () => {
  assert.match(route, /hasExactKeys\(body, \["newImei", "reason"\]\)/);
  assert.match(route, /action === "COMPLETE" && hasExactKeys\(body, \["action"\]\)/);
  assert.match(
    route,
    /action === "CANCEL"[\s\S]*hasExactKeys\(body, \["action", "reason"\]\)/
  );
});

test("la creación bloquea crédito e IMEI y revisa todos los conflictos operativos", () => {
  assert.match(storage, /credit-device-replacement:credit:/);
  assert.match(storage, /credit-device-replacement:imei:/);
  assert.match(storage, /pg_advisory_xact_lock/);
  assert.match(
    storage,
    /FROM "Credito" credit[\s\S]*credit\."id" <> \$2[\s\S]*credit\."deviceUid"/
  );
  assert.match(
    storage,
    /FROM "CreditoBorrador" draft[\s\S]*draft\."estado" = 'ABIERTO'[\s\S]*draft\."creditoId" IS NULL/
  );
  assert.match(
    storage,
    /FROM "CreditDeviceReplacement" active[\s\S]*'PENDING_ENROLLMENT'[\s\S]*'ENROLLMENT_APPROVED'/
  );
  assert.match(storage, /warrantyIsActive\(row\.warrantyUntil\)/);
  assert.match(storage, /normalizedPlatform\(row\) !== "IPHONE"/);
});

test("la venta normal y el reemplazo comparten el bloqueo final del IMEI", () => {
  assert.match(
    storage,
    /export async function lockCreditDeviceReplacementImeiForCreditCreation/
  );
  assert.match(storage, /lockSolicitudIdentityMutation\(database, "imei", imei\)/);
  assert.match(
    creditRoute,
    /await lockCreditDeviceReplacementImeiForCreditCreation\(transaction, \{[\s\S]*imei,[\s\S]*solicitudId: solicitudReservation\.id/
  );
});

test("la carga masiva reserva todos los IMEI antes de crear créditos", () => {
  assert.match(
    massCreditRoute,
    /await ensureCreditDeviceReplacementSchema\(\)/
  );
  assert.match(
    massCreditRoute,
    /const rowsByImei = \[\.\.\.validation\.prepared\]\.sort\([\s\S]*left\.imei\.localeCompare\(right\.imei\)/
  );
  const lockAt = massCreditRoute.indexOf(
    "await lockCreditDeviceReplacementImeiForCreditCreation(tx"
  );
  const createAt = massCreditRoute.indexOf("await tx.credito.create");
  assert.ok(lockAt >= 0 && createAt > lockAt);
  assert.match(
    massCreditRoute,
    /imei: row\.imei,[\s\S]*solicitudId: null/
  );
  assert.match(
    storage,
    /\(\$3::integer IS NULL OR draft\."id" <> \$3\)/
  );
  assert.match(massCreditRoute, /error instanceof CreditDeviceReplacementError/);
});

test("el cierre actualiza solo el IMEI operativo y conserva contrato y validaciones", () => {
  const start = storage.indexOf(
    "export async function completeCreditDeviceReplacement"
  );
  const end = storage.indexOf(
    "export async function cancelCreditDeviceReplacement",
    start
  );
  const completion = storage.slice(start, end);

  assert.match(
    completion,
    /UPDATE "Credito"[\s\S]*SET "imei" = \$1, "deviceUid" = \$1, "updatedAt" = CURRENT_TIMESTAMP/
  );
  assert.match(completion, /row\.status !== "ENROLLMENT_APPROVED"/);
  assert.doesNotMatch(
    completion,
    /contratoSnapshot|FirmaSeguro|DataCredito|Veriff|fotoEntrega|fotoRemision/
  );
});

test("el enrolamiento del reemplazo usa revisión separada, idempotencia y la transacción exterior", () => {
  assert.match(storage, /INSERT INTO "CreditDeviceReplacementReview"/);
  assert.doesNotMatch(storage, /INSERT INTO "IphoneEnrollmentReview"/);
  assert.match(storage, /alreadyApproved: true/);
  assert.match(
    storage,
    /if \(database\) return approveReplacementWith\(input, database\)/
  );
  assert.match(
    storage,
    /SET "status" = 'ENROLLMENT_APPROVED'/
  );
  assert.match(schema, /CreditDeviceReplacementReview is append-only/);
  assert.match(schema, /CreditDeviceReplacementEvent is append-only/);
});

test("cada transición deja un evento inmutable y enmascara IMEI en respuestas", () => {
  for (const event of [
    "CREATED",
    "ENROLLMENT_APPROVED",
    "COMPLETED",
    "CANCELLED",
  ]) {
    assert.match(storage, new RegExp('eventType: "' + event + '"'));
  }
  assert.match(storage, /currentImeiMasked: maskImei/);
  assert.match(storage, /newImeiMasked: maskImei/);
  assert.match(storage, /clienteDocumentoMasked: maskDocument/);
  assert.match(storage, /previousImeiHash: hashIphoneEnrollmentImei/);
  assert.match(storage, /newImeiHash: hashIphoneEnrollmentImei/);
});
