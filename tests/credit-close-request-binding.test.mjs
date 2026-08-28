import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(
  new URL("../app/api/creditos/route.ts", import.meta.url),
  "utf8"
);
const firmaSeguroCreditSource = readFileSync(
  new URL("../lib/firmaseguro-credit.ts", import.meta.url),
  "utf8"
);
const firmaSeguroStorageSource = readFileSync(
  new URL("../lib/firmaseguro-storage.ts", import.meta.url),
  "utf8"
);
const solicitudStorageSource = readFileSync(
  new URL("../lib/solicitudes-storage.ts", import.meta.url),
  "utf8"
);

test("el cierre solo permite al admin central o al vendedor con solicitud", () => {
  const postStart = routeSource.indexOf("export async function POST");
  const postSource = routeSource.slice(postStart);

  assert.ok(postStart >= 0);
  assert.match(
    postSource,
    /!adminCentral && sellerSession\?\.tipoPerfil !== "VENDEDOR"/
  );
  assert.match(postSource, /!adminCentral && !requestedSolicitudId/);
  assert.match(postSource, /code: "SOLICITUD_REQUERIDA"/);
});

test("el reintento de una solicitud finalizada recupera su credito sin repetir efectos", () => {
  assert.match(
    routeSource,
    /getFinalizedSolicitudCreditContext\(requestedSolicitudId\)/
  );
  assert.match(
    routeSource,
    /draft\."closedReason" = 'FINALIZADA'[\s\S]*draft\."creditoId" IS NOT NULL/
  );
  assert.match(
    routeSource,
    /canRecoverFinalizedSolicitud[\s\S]*finalizedSolicitudRecoveredCreditResponse/
  );
  assert.match(
    routeSource,
    /recoverDataCreditoCredit\([\s\S]{0,180}requestedSolicitudId[\s\S]{0,180}adminCentral/
  );
  assert.match(
    routeSource,
    /completeSolicitudForCredit\([\s\S]{0,220}solicitudId/
  );
  assert.match(
    routeSource,
    /canViewSensitive \? serialized : redactCreditForNonAdmin\(serialized\)/
  );
});

test("el cierre exitoso oculta Veriff, Equality y campos sensibles al vendedor", () => {
  const successStart = routeSource.indexOf(
    "const serializedCreated = serializeCredit(created)"
  );
  const successResponse = routeSource.slice(
    successStart,
    routeSource.indexOf("} catch (error)", successStart)
  );

  assert.ok(successStart >= 0);
  assert.ok(
    successResponse.includes(
      "canViewSensitiveCredit\n        ? serializedCreated\n        : redactCreditForNonAdmin(serializedCreated)"
    ) ||
      successResponse.includes(
        "canViewSensitiveCredit\r\n        ? serializedCreated\r\n        : redactCreditForNonAdmin(serializedCreated)"
      )
  );
  assert.ok(
    successResponse.includes(
      "identityValidation: canViewSensitiveCredit"
    )
  );
  assert.ok(
    successResponse.includes(
      "equality: canViewSensitiveCredit && equalitySummary"
    )
  );
});

test("IMEI, deviceUid y plataforma quedan ligados a la solicitud antes de integraciones", () => {
  const imeiGuard = routeSource.indexOf('code: "IMEI_DEVICE_UID_DIFERENTES"');
  const canonicalGuard = routeSource.indexOf('code: "SOLICITUD_IMEI_DIFERENTE"');
  const platformGuard = routeSource.indexOf(
    'code: "SOLICITUD_PLATAFORMA_DIFERENTE"'
  );
  const dataCreditoConfig = routeSource.indexOf(
    "const dataCreditoProvider = getDataCreditoPublicConfig()"
  );

  assert.ok(imeiGuard >= 0);
  assert.ok(canonicalGuard > imeiGuard);
  assert.ok(platformGuard > canonicalGuard);
  assert.ok(dataCreditoConfig > platformGuard);
  assert.match(
    routeSource,
    /solicitudImei !== imei \|\| solicitudImei !== deviceUid/
  );
  assert.match(
    solicitudStorageSource,
    /await lockIdentity\(transaction, "imei", imei\)/
  );
  assert.match(
    solicitudStorageSource,
    /storedImei && storedImei !== imei/
  );
  assert.match(
    solicitudStorageSource,
    /"imei" = COALESCE\(NULLIF\(\$3::text, ''\), "imei"\)[\s\S]{0,320}'deviceUid', \$3::text/
  );
  assert.match(
    solicitudStorageSource,
    /SOLICITUD_IMEI_INMUTABLE/
  );
  assert.match(
    solicitudStorageSource,
    /regexp_replace\(COALESCE\("imei", ''\)[\s\S]{0,120}= \$8/
  );
  assert.match(
    solicitudStorageSource,
    /UPPER\(COALESCE\("plataforma", ''\)\) = \$9/
  );
});

test("FirmaSeguro se vincula por UUID y draft dentro de la transaccion", () => {
  assert.match(
    firmaSeguroStorageSource,
    /WHERE "processUuid" = \$1[\s\S]*AND "draftId" = \$3[\s\S]*"creditoId" IS NULL OR "creditoId" = \$2/
  );
  assert.match(
    firmaSeguroCreditSource,
    /draftId: number,[\s\S]*database: Prisma\.TransactionClient \| typeof prisma/
  );

  const transactionStart = routeSource.indexOf(
    "const createCreditWithAmortization = async"
  );
  const transactionEnd = routeSource.indexOf("let creationResult", transactionStart);
  const transactionSource = routeSource.slice(transactionStart, transactionEnd);

  assert.match(
    transactionSource,
    /linkFirmaSeguroProcessForCredit\([\s\S]*solicitudReservation\.id,[\s\S]*transaction/
  );
  assert.match(
    transactionSource,
    /markCreditoFirmaSeguroCompleted\([\s\S]*transaction/
  );
  assert.match(transactionSource, /FIRMASEGURO_LINK_CONFLICT/);

  const afterCommitSource = routeSource.slice(transactionEnd);
  assert.doesNotMatch(afterCommitSource, /linkFirmaSeguroProcessForCredit\(/);
});
