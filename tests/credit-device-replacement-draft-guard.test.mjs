import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const [solicitudesStorage, correction] = await Promise.all([
  readProjectFile("lib/solicitudes-storage.ts"),
  readProjectFile("lib/firmaseguro-imei-correction.ts"),
]);

test("la reserva y el autoguardado no toman un IMEI reservado por un cambio activo", () => {
  assert.match(
    solicitudesStorage,
    /export async function assertImeiNotReservedByActiveDeviceReplacement/
  );
  assert.match(
    solicitudesStorage,
    /FROM "CreditDeviceReplacement" replacement[\s\S]*replacement\."newImei" = \$1[\s\S]*'PENDING_ENROLLMENT'[\s\S]*'ENROLLMENT_APPROVED'/
  );
  assert.doesNotMatch(
    solicitudesStorage,
    /from "@\/lib\/credit-device-replacement-storage"/
  );

  const reserve = solicitudesStorage.slice(
    solicitudesStorage.indexOf("export async function reserveSolicitudForIdentity"),
    solicitudesStorage.indexOf("export async function saveSolicitudDraft")
  );
  const reserveLock = reserve.indexOf(
    'await lockIdentity(transaction, "imei", imei)'
  );
  const reserveGuard = reserve.indexOf(
    "await assertImeiNotReservedByActiveDeviceReplacement(transaction, imei)"
  );
  assert.ok(reserveLock >= 0 && reserveGuard > reserveLock);

  const save = solicitudesStorage.slice(
    solicitudesStorage.indexOf("export async function saveSolicitudDraft"),
    solicitudesStorage.indexOf("export class SolicitudDataCreditoLinkError")
  );
  const canonicalImei = save.indexOf("const canonicalImei =");
  const canonicalLock = save.indexOf(
    'await lockIdentity(transaction, "imei", canonicalImei)',
    canonicalImei
  );
  const canonicalGuard = save.indexOf(
    "await assertImeiNotReservedByActiveDeviceReplacement(",
    canonicalImei
  );
  const update = save.indexOf('UPDATE "CreditoBorrador"', canonicalImei);
  assert.ok(canonicalImei >= 0);
  assert.ok(canonicalLock > canonicalImei);
  assert.ok(canonicalGuard > canonicalLock);
  assert.ok(update > canonicalGuard);
});

test("la corrección firmada rechaza con error 409 el IMEI de un cambio activo", () => {
  assert.match(
    correction,
    /assertImeiNotReservedByActiveDeviceReplacement/
  );
  const locks = correction.indexOf(
    "for (const identityImei of [previousImei, imei].sort())"
  );
  const guard = correction.indexOf(
    "await assertImeiNotReservedByActiveDeviceReplacement(",
    locks
  );
  const reread = correction.indexOf(
    "const draft = await readDraft(transaction, input.draftId, true)",
    guard
  );
  assert.ok(locks >= 0 && guard > locks && reread > guard);
  assert.match(correction, /"IMEI_RESERVADO_CAMBIO_GARANTIA"/);
  assert.match(
    correction,
    /new FirmaSeguroImeiCorrectionError\([\s\S]{0,240}409/
  );
});
