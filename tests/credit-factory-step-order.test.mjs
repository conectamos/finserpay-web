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

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  assert.ok(end > start, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

test("la fábrica presenta cuatro pasos sin migrar la numeración histórica", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const steps = sourceBlock(
    source,
    "const factorySteps = [",
    "const completedFactorySteps"
  );

  assert.match(steps, /id: 1,[\s\S]*label: "Cliente"[\s\S]*"DataCrédito y datos"/);
  assert.match(steps, /id: 2,[\s\S]*label: "Equipo"/);
  assert.match(steps, /id: 4,[\s\S]*label: "Identidad y firma"[\s\S]*"Veriff y contrato"/);
  assert.match(steps, /id: 5,[\s\S]*label: "Enrolamiento y entrega"/);
  assert.match(steps, /id: 3,/);
  assert.match(
    steps,
    /const visibleFactorySteps = hideIdentityWizardStep[\s\S]*step\.id !== 3/
  );
});

test("DataCrédito aprobado despliega los datos del cliente en el mismo paso 1", async () => {
  const [factory, gate] = await Promise.all([
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
    readProjectFile(
      "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
    ),
  ]);

  assert.match(factory, /const clienteFormUnlocked = dataCreditoFlowReady;/);
  assert.match(factory, /const showIdentityClientForm = clienteFormUnlocked;/);
  assert.match(factory, />\s*Información del cliente\s*</);
  assert.match(factory, /La cédula y el primer apellido corresponden a la consulta[\s\S]*DataCrédito/);
  assert.match(gate, />\s*Consulta aprobada\s*</);
  assert.match(gate, /Continuar con los datos/);
  assert.doesNotMatch(gate, /Continuar a validación/);
});

test("el paso 2 no exige Veriff y el paso 3 exige Veriff más FirmaSeguro", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const goToStep = sourceBlock(source, "const goToStep =", "const advanceToStep =");
  const advanceToStep = sourceBlock(
    source,
    "const advanceToStep =",
    "const createWhatsAppOtp"
  );

  for (const navigation of [goToStep, advanceToStep]) {
    assert.doesNotMatch(
      navigation,
      /targetStep > 1 && dataCreditoRequiresVeriff && !veriffApproved/
    );
    assert.match(navigation, /wizardStep === 2 && !stepEquipoReady/);
    assert.match(navigation, /wizardStep === 4 && !stepIdentityContractReady/);
    assert.match(
      navigation,
      /targetStep > nextVisibleWizardStep\(wizardStep\)/
    );
  }

  assert.match(
    source,
    /const stepIdentityContractReady = stepContratoReady && stepSignatureReady;/
  );
  assert.match(source, />\s*Identidad con Veriff\s*</);
  assert.match(
    source,
    /Aprueba primero la identidad con Veriff antes de enviar el contrato a FirmaSeguro/
  );
  assert.match(source, /disabled=\{futureStepLocked\}/);
  assert.match(
    source,
    /step\.id > nextVisibleWizardStep\(wizardStep\)/
  );
});

test("una solicitud sin Veriff conserva el avance y reintenta en el paso 3", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const restore = sourceBlock(
    source,
    "if (restoredDraftSnapshot.veriffValidationId) {",
    "} finally {"
  );
  const retry = sourceBlock(
    source,
    "const retryRestoredVeriffValidation = async () => {",
    "const goToStep ="
  );

  assert.match(restore, /restoredDraftSnapshot\.wizardStep >= 4[\s\S]*\? 4/);
  assert.doesNotMatch(restore, /setWizardStep\(1\)/);
  assert.match(retry, /failure\.targetStep >= 4 \? 4 : failure\.targetStep/);
  assert.doesNotMatch(retry, /approvalRecovered[\s\S]{0,100}: 1/);
});

test("Veriff solo inicia con DataCrédito vigente y el equipo completo", async () => {
  const route = await readProjectFile("app/api/creditos/veriff/route.ts");
  const readiness = route.indexOf("validateDraftReadyForVeriff(draft, platform)");
  const reuse = route.indexOf("getReusableVeriffValidationForDraft({");
  const provider = route.indexOf("await veriffCreateSession({");

  assert.match(route, /d\."currentStep", d\."payload"/);
  assert.match(route, /Number\(draft\.currentStep \|\| 0\) < 4/);
  assert.match(route, /\^\\d\{15\}\$/);
  assert.match(route, /equipmentValue - initialPayment > 0/);
  assert.match(route, /PAYMENT_FREQUENCY_OPTIONS\.some\(/);
  assert.match(route, /option\.value === paymentFrequency/);

  const policy = await readProjectFile("lib/credit-factory.ts");
  assert.match(
    policy,
    /PAYMENT_FREQUENCY_OPTIONS\s*=\s*\[\s*\{ value: "SEMANAL"[\s\S]*\{ value: "CATORCENAL"[\s\S]*\{ value: "QUINCENAL"[\s\S]*\{ value: "MENSUAL"/
  );
  assert.match(route, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  assert.match(route, /if \(!dataCreditoConfig\.enabled\)/);
  assert.match(route, /getApprovedDataCreditoAssessmentForCredit\(\{/);
  assert.match(route, /VERIFF_DATACREDITO_NOT_APPROVED/);
  assert.ok(readiness >= 0);
  assert.ok(reuse > readiness);
  assert.ok(provider > reuse);
});

test("FirmaSeguro exige la última aprobación Veriff de la misma solicitud", async () => {
  const route = await readProjectFile(
    "app/api/creditos/borradores/[id]/firma-seguro/route.ts"
  );
  const guard = route.indexOf(
    "await requireApprovedVeriffBeforeFirmaSeguro(lockedAuthorized.row)"
  );
  const build = route.indexOf("const built = await buildDraftCredit(lockedAuthorized.row)");

  assert.match(route, /getVeriffValidationById\(validationId\)/);
  assert.match(
    route,
    /getDataCreditoPublicConfig\(\)\.enabled \|\| isVeriffRequired\(\)/
  );
  assert.match(route, /validation\.draftId !== row\.id/);
  assert.match(route, /!isVeriffApproved\(validation\)/);
  assert.match(route, /ORDER BY validation\."id" DESC[\s\S]*LIMIT 1/);
  assert.match(route, /FIRMASEGURO_VERIFF_SUPERSEDED/);
  assert.ok(guard >= 0);
  assert.ok(build > guard);
});
