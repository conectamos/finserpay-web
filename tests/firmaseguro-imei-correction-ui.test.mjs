import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const factoryUrl = new URL(
  "../app/dashboard/creditos/credit-factory-console.tsx",
  import.meta.url
);

test("la fabrica expone la correccion de IMEI solo en el control central", async () => {
  const source = await readFile(factoryUrl, "utf8");
  const controlStart = source.indexOf("Control exclusivo FINSER PAY");
  const controlEnd = source.indexOf("fp-delivery-layout", controlStart);
  const control = source.slice(controlStart - 1_400, controlEnd);

  assert.ok(controlStart > 0);
  assert.match(
    control,
    /canSeeInternalPricing[\s\S]*iphoneFactory[\s\S]*firmaSeguroProcessSigned/
  );
  assert.match(control, /Corregir IMEI y volver a firmar/);
  assert.match(control, /El PDF ya firmado no se modifica/);
  assert.match(control, /Esta solicitud ya tiene un enrolamiento aprobado/);
  assert.match(control, /quedarán reemplazados y se conservarán como/);
  assert.match(control, /el especialista deberá aprobar nuevamente el/);
  assert.match(control, /las fotos activas de entrega y remisión se archivarán y limpiarán/);
  assert.match(control, /Corregir y exigir nueva firma/);
});

test("la correccion envia IMEI y motivo y vuelve al paso de contratos", async () => {
  const source = await readFile(factoryUrl, "utf8");
  const handlerStart = source.indexOf("const correctFirmaSeguroImei");
  const handlerEnd = source.indexOf("const handleFirmaSeguroStepReady", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart > 0);
  assert.match(handler, /action: "CORREGIR_IMEI"/);
  assert.match(handler, /imei: correctedImei/);
  assert.match(handler, /reason/);
  assert.match(handler, /expectedCurrentImei/);
  assert.match(handler, /expectedProcessUuid/);
  assert.match(
    handler,
    /expectedEnrollmentReviewId: iphoneEnrollmentReview\?\.id \|\| null/
  );
  assert.match(handler, /window\.confirm/);
  assert.match(handler, /IMEI firmado actual/);
  assert.match(handler, /IMEI nuevo/);
  assert.match(handler, /hadApprovedEnrollment = Boolean\(iphoneEnrollmentReview\)/);
  assert.match(
    handler,
    /enrollmentWasSuperseded =[\s\S]*hadApprovedEnrollment[\s\S]*result\.data\.enrollmentReapprovalRequired/
  );
  assert.match(handler, /El enrolamiento aprobado quedara reemplazado/);
  assert.match(handler, /debera aprobar nuevamente el enrolamiento/);
  assert.match(handler, /Las fotos activas de entrega y remision se archivaran/);
  assert.match(handler, /reason\.length < 5/);
  assert.match(handler, /setFirmaSeguroDraftProcess\(null\)/);
  assert.match(handler, /setIphoneEnrollmentVerified\(false\)/);
  assert.match(handler, /setFotoEntregaDataUrl\(""\)/);
  assert.match(handler, /setFotoRemisionDataUrl\(""\)/);
  assert.match(handler, /setWizardStep\(4\)/);
  assert.match(handler, /expediente anterior quedo como historico/);
  assert.match(handler, /firma, el enrolamiento y las fotos de entrega y remision del equipo anterior quedaron como historicos/);
  assert.match(handler, /authoritativeImei === correctedImei/);
  assert.match(handler, /confirmamos que el IMEI si fue corregido/);
});

test("un proceso ya firmado no ofrece un reenvio silencioso", async () => {
  const source = await readFile(factoryUrl, "utf8");
  const buttonStart = source.indexOf("onClick={() => void handleFirmaSeguroStepReady()}");
  const button = source.slice(buttonStart, buttonStart + 1_300);

  assert.ok(buttonStart > 0);
  assert.match(button, /firmaSeguroProcessSent/);
  assert.match(button, /firmaSeguroImeiCorrecting/);
  assert.match(button, /Firma ya completada/);
  assert.doesNotMatch(button, /Reenviar FirmaSeguro/);
});

test("la correccion invalida refrescos obsoletos y no trunca un IMEI pegado", async () => {
  const source = await readFile(factoryUrl, "utf8");
  const refreshStart = source.indexOf("const refreshFirmaSeguroDraftProcess");
  const correctionStart = source.indexOf("const correctFirmaSeguroImei");
  const correctionControlStart = source.indexOf("Control exclusivo FINSER PAY");
  const refresh = source.slice(refreshStart, correctionStart);
  const correctionControl = source.slice(correctionControlStart, correctionControlStart + 6_000);

  assert.ok(refreshStart > 0);
  assert.match(refresh, /firmaSeguroRefreshGenerationRef/);
  assert.match(refresh, /!== refreshGeneration/);
  assert.match(correctionControl, /setFirmaSeguroImeiCorrectionValue\(event\.target\.value\)/);
  assert.doesNotMatch(correctionControl, /\.slice\(0, 15\)/);
});
