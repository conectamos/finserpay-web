import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8"
);

function sourceBlock(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  assert.notEqual(startIndex, -1, `No se encontro el inicio: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("solo el administrador central FINSERPAY puede inspeccionar libremente la fabrica", () => {
  assert.match(
    source,
    /const canAdminMoveFreelyInFactory\s*=\s*canSeeInternalPricing\s*&&\s*createClientMode/
  );
  assert.doesNotMatch(
    source,
    /const canAdminMoveFreelyInFactory\s*=\s*canAdmin\s*&&/
  );
});

test("la navegacion central se resuelve antes de las guardas secuenciales", () => {
  const advance = sourceBlock("const advanceToStep", "const createWhatsAppOtp");
  const centralGuard = advance.indexOf("if (canAdminMoveFreelyInFactory)");
  const clientGuard = advance.indexOf("wizardStep === 1 && !stepClienteReady");
  const equipmentGuard = advance.indexOf("wizardStep === 2 && !stepEquipoReady");
  const identityAndSignatureGuard = advance.indexOf(
    "wizardStep === 4 && !stepIdentityContractReady"
  );

  assert.notEqual(centralGuard, -1);
  assert.notEqual(clientGuard, -1);
  assert.notEqual(equipmentGuard, -1);
  assert.notEqual(identityAndSignatureGuard, -1);
  assert.ok(centralGuard < clientGuard);
  assert.ok(centralGuard < equipmentGuard);
  assert.ok(centralGuard < identityAndSignatureGuard);
  assert.match(advance, /wizardStep === 1 && !stepClienteReady/);
  assert.match(advance, /wizardStep === 2 && !stepEquipoReady/);
  assert.match(advance, /wizardStep === 4 && !stepIdentityContractReady/);
  assert.match(advance, /targetStep > nextVisibleWizardStep\(wizardStep\)/);
  assert.doesNotMatch(
    advance,
    /targetStep > 1 && dataCreditoRequiresVeriff|wizardStep === 2 && !veriffApproved/
  );
});

test("el flujo Veriff visible conserva los pasos internos 1, 2, 4 y 5", () => {
  const factorySteps = sourceBlock("const factorySteps = [", "const draftStatusLabel");

  assert.match(factorySteps, /id: 1,[\s\S]*label: "Cliente"[\s\S]*DataCrédito y datos/);
  assert.match(factorySteps, /id: 2,[\s\S]*label: "Equipo"/);
  assert.match(
    factorySteps,
    /id: 4,[\s\S]*label: "Identidad y firma"[\s\S]*ready: stepIdentityContractReady/
  );
  assert.match(factorySteps, /id: 5,[\s\S]*label: "Enrolamiento y entrega"/);
  assert.match(
    factorySteps,
    /const visibleFactorySteps = hideIdentityWizardStep[\s\S]*factorySteps\.filter\(\(step\) => step\.id !== 3\)/
  );
});

test("la precalificacion bloquea el flujo normal pero no la inspeccion central", () => {
  assert.match(
    source,
    /const showDataCreditoGate\s*=\s*dataCreditoGatePending\s*&&\s*\(draftResumeHydrating \|\|\s*!canAdminMoveFreelyInFactory \|\|\s*wizardStep === 1\)/
  );
  assert.match(source, /\{showDataCreditoGate \? \(/);
});

test("una inspeccion administrativa no persiste un paso ficticio", () => {
  const autosave = sourceBlock("const saveDraft = async", "const handleDataCreditoBypass");

  assert.match(
    autosave,
    /const persistedWizardStep = canAdminMoveFreelyInFactory\s*\? nextFactoryStep\.id\s*:\s*wizardStep/
  );
  assert.match(autosave, /currentStep: persistedWizardStep/);
  assert.match(autosave, /wizardStep: persistedWizardStep/);
});

test("el permiso de inspeccion no participa en las validaciones de cierre", () => {
  for (const [start, end] of [
    ["const ventaLista", "const factorySteps"],
    ["const createCredit", "const handleFirmaSeguroStepReady"],
    ["const finalizeFirmaSeguroDelivery", "const registerPayment"],
  ]) {
    const block = sourceBlock(start, end);
    assert.doesNotMatch(block, /canAdminMoveFreelyInFactory/);
  }
});
